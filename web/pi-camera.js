// Optional paired LAN source. Frames and pairing tokens stay on this phone/Pi link.
// Only the newest frame is kept; analysis samples it when it needs one, so a slow model
// never builds a queue of old pictures.
(function (win) {
  'use strict';
  const MAX_BYTES = 2 * 1024 * 1024;
  const MAX_AGE = 2500;
  const TIMEOUT = 3000;
  const DEFAULT_INTERVAL = 250;
  // A dropped Wi-Fi link is retried quietly for this long before the camera is given up.
  const RETRY_WINDOW = 45000;
  const RETRY_DELAYS = [500, 1000, 2000, 4000];
  const TRANSIENT = new Set(['frame_timeout', 'camera_unavailable', 'stale_frame', 'connection_failed']);
  let generation = 0, session = null;
  const fail = code => Object.assign(new Error(code), { code });
  const errorCode = error => typeof error?.code === 'string' ? error.code : 'connection_failed';
  const clock = () => performance.now();
  function notify(current, state, code) {
    if (current?.status === state && current?.statusCode === (code || null)) return;
    if (current) { current.status = state; current.statusCode = code || null; }
    try { current?.onStatus?.({ state, code: code || null }); } catch {}
  }
  function dropFrame(current) {
    current.frame?.close();
    current.frame = null; current.connected = false; current.freshUntil = 0;
  }
  function stop(code = 'stopped') {
    generation++;
    const previous = session;
    session = null;
    if (!previous) return;
    previous.token = '';
    clearTimeout(previous.timer);
    previous.controller?.abort();
    dropFrame(previous);
    notify(previous, code === 'stopped' ? 'stopped' : 'error', code);
  }
  function jpegSize(bytes) {
    if (bytes[0] !== 0xff || bytes[1] !== 0xd8) throw fail('invalid_frame');
    let offset = 2;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset++] !== 0xff) throw fail('invalid_frame');
      while (bytes[offset] === 0xff) offset++;
      const marker = bytes[offset++];
      if ([0xd8, 0x01].includes(marker) || marker >= 0xd0 && marker <= 0xd7) continue;
      if ([0xd9, 0xda].includes(marker) || offset + 2 > bytes.length) break;
      const length = bytes[offset] * 256 + bytes[offset + 1];
      if (length < 2 || offset + length > bytes.length) throw fail('invalid_frame');
      if ([0xc0, 0xc1, 0xc2].includes(marker)) {
        if (length < 8) throw fail('invalid_frame');
        const height = bytes[offset + 3] * 256 + bytes[offset + 4];
        const width = bytes[offset + 5] * 256 + bytes[offset + 6];
        if (!width || !height || width > 1280 || height > 720) throw fail('frame_too_large');
        return { width, height };
      }
      offset += length;
    }
    throw fail('invalid_frame');
  }
  async function boundedBytes(response) {
    const length = response.headers.get('content-length');
    if (length && (!/^[0-9]+$/.test(length) || Number(length) > MAX_BYTES)) throw fail('frame_too_large');
    if (!response.body?.getReader) throw fail('unsupported_transport');
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_BYTES) throw fail('frame_too_large');
        chunks.push(value);
      }
    } catch (error) { await reader.cancel().catch(() => {}); throw error; }
    finally { reader.releaseLock(); }
    if (!total || length && Number(length) !== total) throw fail('invalid_frame');
    const result = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
    return result;
  }
  async function pull(current) {
    if (session !== current) throw fail('stopped');
    const controller = new AbortController();
    current.controller = controller;
    const timeout = setTimeout(() => controller.abort(), TIMEOUT);
    const began = clock();
    let decoded;
    let rejectAborted;
    const aborted = new Promise((_, reject) => { rejectAborted = reject; });
    const onAbort = () => rejectAborted(fail(session === current ? 'frame_timeout' : 'stopped'));
    controller.signal.addEventListener('abort', onAbort, { once: true });
    const work = (async () => { try {
      const endpoint = new URL('/frame', current.origin);
      // After a lost link the camera may have restarted and be counting from one again.
      if (current.sequence && !current.resync) endpoint.searchParams.set('after', String(current.sequence));
      const response = await win.fetch(endpoint.href, {
        method: 'GET', mode: 'cors', credentials: 'omit', cache: 'no-store', redirect: 'error',
        headers: { Authorization: 'Bearer ' + current.token, Accept: 'image/jpeg' }, signal: controller.signal,
      });
      if (response.status === 401 || response.status === 403) throw fail('pairing_rejected');
      if (!response.ok || response.redirected || response.url && response.url !== endpoint.href) throw fail('camera_unavailable');
      if ((response.headers.get('content-type') || '').split(';')[0].toLowerCase() !== 'image/jpeg') throw fail('invalid_frame');
      const sequenceValue = response.headers.get('x-astha-frame-sequence');
      const ageValue = response.headers.get('x-astha-frame-age-ms');
      if (!/^[1-9][0-9]{0,15}$/.test(sequenceValue || '') || !/^[0-9]{1,5}$/.test(ageValue || '')) throw fail('invalid_frame');
      const sequence = Number(sequenceValue), age = Number(ageValue);
      const cameraRun = (response.headers.get('x-astha-camera-run') || '').slice(0, 64);
      const restarted = Boolean(current.resync && cameraRun && cameraRun !== current.cameraRun);
      if (!Number.isSafeInteger(sequence) || !restarted && sequence <= current.sequence || age + clock() - began > MAX_AGE) throw fail('stale_frame');
      const bytes = await boundedBytes(response);
      const size = jpegSize(bytes);
      if (controller.signal.aborted || session !== current) throw fail('stopped');
      decoded = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
      if (decoded.width !== size.width || decoded.height !== size.height) throw fail('invalid_frame');
      if (controller.signal.aborted || session !== current || current.generation !== generation || current.paused) throw fail('stopped');
      if (age + clock() - began > MAX_AGE) throw fail('stale_frame');
      current.frame?.close();
      current.frame = decoded; decoded = null;
      current.sequence = sequence; current.cameraRun = cameraRun; current.resync = false;
      current.freshUntil = began + MAX_AGE - age;
      current.connected = true; current.everConnected = true;
      current.retry = 0; current.lostAt = 0;
      current.onFrame?.(current.frame);
      notify(current, 'connected');
    } finally {
      decoded?.close();
    } })();
    try { await Promise.race([work, aborted]); }
    finally {
      clearTimeout(timeout);
      controller.signal.removeEventListener('abort', onAbort);
      if (current.controller === controller) current.controller = null;
    }
  }
  // Pairing, protocol and first-connection failures are final. A link that worked and then
  // dropped is retried with backoff, and no old picture is offered for analysis meanwhile.
  function recover(current, code) {
    if (!current.everConnected || !TRANSIENT.has(code)) { stop(code); return; }
    const now = clock();
    if (!current.lostAt) current.lostAt = now;
    if (now - current.lostAt > RETRY_WINDOW) { stop('connection_lost'); return; }
    dropFrame(current);
    current.resync = true;
    notify(current, 'reconnecting', code);
    schedule(current, RETRY_DELAYS[Math.min(current.retry++, RETRY_DELAYS.length - 1)]);
  }
  function schedule(current, delay = current.interval) {
    current.timer = setTimeout(async () => {
      if (session !== current || current.paused) return;
      try { await pull(current); if (session === current && !current.paused) schedule(current); }
      catch (error) { if (session === current && !current.paused) recover(current, errorCode(error)); }
    }, delay);
  }
  async function connect({ origin, token, onFrame, onStatus, interval } = {}) {
    stop();
    let endpoint;
    try { endpoint = new URL(origin); } catch { throw fail('invalid_origin'); }
    if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.pathname !== '/' || endpoint.search || endpoint.hash) throw fail('invalid_origin');
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43,128}$/.test(token)) throw fail('invalid_pairing_token');
    if (onFrame != null && typeof onFrame !== 'function' || onStatus != null && typeof onStatus !== 'function') throw fail('invalid_callback');
    if (typeof createImageBitmap !== 'function') throw fail('unsupported_decoder');
    const pace = Number.isFinite(interval) ? Math.min(5000, Math.max(DEFAULT_INTERVAL, Math.round(interval))) : DEFAULT_INTERVAL;
    const current = { origin: endpoint.origin, token, onFrame, onStatus, generation, sequence: 0, connected: false, everConnected: false,
      frame: null, freshUntil: 0, interval: pace, retry: 0, lostAt: 0, resync: false, paused: false, cameraRun: '' };
    session = current;
    notify(current, 'connecting');
    try { await pull(current); if (session === current) schedule(current); }
    catch (error) { if (session === current) stop(errorCode(error)); throw fail(errorCode(error)); }
  }
  // No images are requested while ASTHA is in the background. The pairing stays in memory
  // so returning to the app does not ask a blind user to type the code again.
  function pause() {
    const current = session;
    if (!current || current.paused) return;
    current.paused = true;
    clearTimeout(current.timer);
    current.controller?.abort();
    dropFrame(current);
    notify(current, 'paused');
  }
  function resume() {
    const current = session;
    if (!current || !current.paused) return;
    current.paused = false; current.resync = true; current.retry = 0; current.lostAt = clock();
    notify(current, 'reconnecting', 'resumed');
    schedule(current, 0);
  }
  // What the camera reports about itself, for the connection status line. Display only.
  async function describe() {
    const current = session;
    if (!current?.connected) return null;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT);
    try {
      const endpoint = new URL('/status', current.origin);
      const response = await win.fetch(endpoint.href, {
        method: 'GET', mode: 'cors', credentials: 'omit', cache: 'no-store', redirect: 'error',
        headers: { Authorization: 'Bearer ' + current.token, Accept: 'application/json' }, signal: controller.signal,
      });
      if (!response.ok || session !== current) return null;
      const body = await response.text();
      if (body.length > 2048) return null;
      const raw = JSON.parse(body), info = {};
      for (const key of ['model', 'os', 'backend']) if (typeof raw[key] === 'string') info[key] = raw[key].replace(/[^\x20-\x7e]/g, '').slice(0, 80);
      for (const key of ['width', 'height', 'fps']) if (Number.isFinite(raw[key]) && raw[key] > 0 && raw[key] < 10000) info[key] = raw[key];
      return info;
    } catch { return null; }
    finally { clearTimeout(timeout); }
  }
  const fresh = () => Boolean(session?.connected && !session.paused && clock() < session.freshUntil);
  win.PiCamera = Object.freeze({ connect, stop: () => stop(), pause, resume, describe, active: fresh,
    paired: () => Boolean(session), status: () => session?.status || 'stopped',
    getFrame: () => fresh() ? session.frame : null });
  win.addEventListener('pagehide', () => stop());
  document.addEventListener('visibilitychange', () => { if (document.hidden) pause(); else resume(); });
})(window);
