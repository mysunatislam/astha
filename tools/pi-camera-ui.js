// The paired transport owns ImageBitmaps; this adapter owns the pairing form, the optional
// preview for sighted helpers, and the spoken connection feedback.
const AsthaPiCamera = (() => {
  const STATUS_KEYS = { stopped: 'pi_stopped', connecting: 'pi_connecting', connected: 'pi_connected', reconnecting: 'pi_reconnecting',
    reconnected: 'pi_reconnected', paused: 'pi_paused', pairing_rejected: 'pi_pairing_rejected', stale_frame: 'pi_stale_frame',
    frame_timeout: 'pi_frame_timeout', connection_lost: 'pi_connection_lost', invalid_origin: 'pi_invalid_origin',
    invalid_pairing_token: 'pi_invalid_pairing_token', models: 'pi_models', error: 'pi_error' };
  let generation = 0, currentStatus = 'stopped', booted = false, deviceLine = '', quietAttempt = false;
  const listeners = new Set();
  const SENSOR_KEYS = { ok: 'pi_sensor_ok', out_of_range: 'pi_sensor_out_of_range', no_echo_start: 'pi_sensor_no_echo_start', error: 'pi_sensor_error', no_data: 'pi_sensor_no_data' };
  let sensorStatus = 'no_data', sensorMetres = null, sensorExpiry = null;
  const element = id => document.getElementById(id);
  const key = status => STATUS_KEYS[Object.hasOwn(STATUS_KEYS, status) ? status : 'error'];
  const label = status => t(key(status));
  const failure = code => Object.assign(new Error(code), { code });
  // The remembered-kit manager follows every change. A listener that returns true has
  // spoken about the change itself, so the generic sentence is not said as well.
  function emit(state, code = null, quiet = false) {
    let claimed = false;
    for (const listener of listeners) { try { claimed = listener({ state, code, quiet }) === true || claimed; } catch {} }
    return claimed;
  }
  function renderSensor() {
    for (const prefix of ['pi-camera', 'vision']) {
      const status = element(prefix + '-sensor-status'), value = element(prefix + '-sensor-value');
      const text = t(SENSOR_KEYS[sensorStatus]);
      if (status && status.textContent !== text) status.textContent = text;
      if (value) {
        value.hidden = sensorMetres == null;
        let cm = String(Math.round(sensorMetres * 1000) / 10);
        if (typeof uiLang !== 'undefined' && uiLang === 'bn') cm = cm.replace(/\d/g, digit => '০১২৩৪৫৬৭৮৯'[digit]);
        const number = sensorMetres == null ? '' : t('pi_sensor_value', { cm });
        if (value.textContent !== number) value.textContent = number;
      }
    }
  }
  function clearSensor(status = 'no_data') {
    clearTimeout(sensorExpiry); sensorExpiry = null;
    sensorStatus = status; sensorMetres = null;
    if (typeof AsthaSensors !== 'undefined') AsthaSensors.clear('front');
    if (typeof invalidateMeasuredDistances === 'function') invalidateMeasuredDistances();
    renderSensor();
  }
  // A picture from before the link dropped must never look live to a sighted helper either.
  function clearPreview() {
    const preview = element('pi-preview');
    if (preview) { preview.getContext('2d')?.clearRect(0, 0, preview.width, preview.height); preview.hidden = true; }
  }
  // Connection changes are spoken: a blind user cannot see the status line change.
  function speakStatus(status, important) {
    if (typeof announce !== 'function' || typeof I18N === 'undefined') return;
    if (!important && typeof AsthaExperience !== 'undefined' && !AsthaExperience.admit('medium', 'pi:' + status, 5000)) return;
    announce(I18N.en[key(status)], I18N.bn[key(status)], 'system');
  }
  function refreshLabels() {
    const status = element('pi-camera-status'); if (status) status.textContent = label(currentStatus);
    const pending = currentStatus === 'connecting';
    const paired = typeof PiCamera !== 'undefined' && PiCamera.paired();
    const form = element('pi-camera-form'); if (form) form.setAttribute('aria-busy', String(pending));
    if (element('pi-camera-connect')) element('pi-camera-connect').disabled = pending;
    if (element('pi-camera-stop')) element('pi-camera-stop').disabled = !pending && !paired;
    if (element('pi-camera-origin')) element('pi-camera-origin').readOnly = pending;
    const device = element('pi-camera-device'); if (device) { device.textContent = deviceLine; device.hidden = !deviceLine; }
    renderSensor();
  }
  function setStatus(next) { currentStatus = Object.hasOwn(STATUS_KEYS, next) ? next : 'error'; refreshLabels(); }
  function stop({ clearSource = true, quietly = false } = {}) {
    // A background reconnection attempt that never produced a picture owns nothing yet:
    // failing it must not cut off speech or work that belongs to the user's current task.
    const owned = currentStatus === 'connecting' && !quietAttempt || typeof state !== 'undefined' && state.source === 'pi';
    const wasActive = currentStatus !== 'stopped';
    generation++;
    if (typeof PiCamera !== 'undefined') PiCamera.stop();
    // A distance from a camera that is no longer connected says nothing about now.
    clearSensor();
    const token = element('pi-camera-token'); if (token) token.value = '';
    clearPreview();
    deviceLine = '';
    if (owned) {
      stopLiveLoop();
      state.pendingAction = null;
      if (typeof AsthaExperience !== 'undefined') AsthaExperience.invalidate();
      if (typeof AsthaAgent !== 'undefined') AsthaAgent.cancel?.();
      if (typeof stopAllSpeech === 'function') stopAllSpeech();
      if (clearSource && state.source === 'pi') showSource(null);
      if (typeof setCaption === 'function') setCaption(t('pi_title'), label('stopped'), 'system');
    }
    quietAttempt = false;
    setStatus('stopped');
    if (wasActive && !quietly) emit('stopped');
  }
  // Connects to one camera address with a pairing code. Resolves once a fresh picture has
  // been decoded; rejects with a code otherwise. A quiet attempt is a background
  // reconnection: it never replaces another source and never speaks a failure.
  async function open({ origin, token, quiet = false } = {}) {
    if (quiet && (currentStatus === 'connecting' || typeof state !== 'undefined' && (state.source && state.source !== 'pi' || state.cameraPending))) throw failure('busy');
    // The user's own Connect replaces a background attempt that has not produced a picture.
    if (!quiet && currentStatus === 'connecting' && !quietAttempt) throw failure('busy');
    const interval = element('pi-camera-saver')?.checked ? 1000 : 250;
    // Stop the previous source first. A new frame is the only way to activate Pi mode.
    if ((!quiet || typeof state !== 'undefined' && state.source) && typeof stopCamera === 'function') stopCamera();
    stop({ quietly: true });
    const mine = ++generation;
    quietAttempt = quiet;
    setStatus('connecting');
    let initialized = false, wasLost = false, finalCode = null;
    try {
      if (typeof PiCamera === 'undefined') throw failure('error');
      await PiCamera.connect({ origin, token, interval,
        onFrame(bitmap) {
          if (mine !== generation || document.hidden) return;
          const preview = element('pi-preview');
          if (!preview) throw new Error('preview unavailable');
          if (preview.width !== bitmap.width || preview.height !== bitmap.height) { preview.width = bitmap.width; preview.height = bitmap.height; }
          preview.getContext('2d').drawImage(bitmap, 0, 0);
          preview.hidden = false;
          if (!initialized) {
            initialized = true; quietAttempt = false;
            state.sceneKey = null;
            showSource('pi'); preview.hidden = false;
            // The existing detector/CLIP loops consume the same captureFrame path.
            Promise.resolve(ensureVisionModels()).then(ready => {
              if (mine !== generation || state.source !== 'pi' || document.hidden || !PiCamera.active()) return;
              if (ready) { if (!state.busy && !state.liveLoop?.active) startLiveLoop(); }
              else setStatus('models');
            }).catch(() => { if (mine === generation && !document.hidden) setStatus('models'); });
          } else if (state.source === 'pi' && PiCamera.active() && !state.busy && !state.liveLoop?.active && engine.coco.status === 'ready') {
            // A fresh post-resume frame, rather than visibility alone, restarts recognition.
            startLiveLoop();
          }
        },
        // The ultrasonic sensor beside the Pi camera. Its reading is dated by its own age.
        onTelemetry(reading) {
          if (mine !== generation || document.hidden || state.source !== 'pi' || typeof AsthaSensors === 'undefined') return;
          if (reading?.status !== 'ok') {
            clearSensor(['out_of_range', 'no_echo_start', 'error'].includes(reading?.status) ? reading.status : 'no_data'); return;
          }
          if (!Number.isFinite(reading.ageMs) || reading.ageMs < 0 || reading.ageMs > 1000 ||
              !AsthaSensors.report('front', reading.distanceM, 'ultrasonic', Date.now() - reading.ageMs)) { clearSensor(); return; }
          clearTimeout(sensorExpiry);
          sensorStatus = 'ok'; sensorMetres = reading.distanceM; renderSensor();
          sensorExpiry = setTimeout(() => { sensorExpiry = null; if (mine === generation) clearSensor(); }, 1001 - reading.ageMs);
        },
        onStatus(status) {
          if (mine !== generation) return;
          if (status.state === 'connected') {
            setStatus('connected');
            const claimed = emit('connected', wasLost ? 'reconnected' : null, quiet && !wasLost);
            if (!claimed) speakStatus(wasLost ? 'reconnected' : 'connected', true);
            wasLost = false;
            if (!deviceLine && typeof PiCamera.describe === 'function') PiCamera.describe().then(info => {
              if (mine !== generation || !info) return;
              deviceLine = [info.model, info.backend, info.width && info.height ? info.width + '×' + info.height : '',
                info.telemetry ? t('pi_distance_sensor') : ''].filter(Boolean).join(' · ');
              refreshLabels();
            });
          } else if (status.state === 'reconnecting') {
            clearSensor(); clearPreview();
            // A picture taken before the link dropped must not answer a question asked now.
            if (typeof AsthaExperience !== 'undefined') AsthaExperience.invalidate();
            setStatus('reconnecting');
            emit('reconnecting', status.code);
            if (!wasLost && status.code !== 'resumed') speakStatus('reconnecting', false);
            wasLost = true;
          } else if (status.state === 'paused') {
            if (state.source === 'pi') {
              stopLiveLoop();
              if (typeof stopAllSpeech === 'function') stopAllSpeech();
              clearSensor();
              // Invalidate pre-pause vision and pending answers without ending the pairing.
              showSource('pi');
              clearPreview();
            }
            if (typeof AsthaExperience !== 'undefined') AsthaExperience.invalidate();
            setStatus('paused');
            emit('paused');
          } else if (status.state === 'error') {
            finalCode = status.code;
            const silent = quietAttempt && !initialized;
            stop({ quietly: true }); setStatus(status.code);
            const claimed = emit('error', status.code);
            if (!silent && !claimed) speakStatus(status.code, true);
          }
        },
      });
      if (mine !== generation) throw failure('stopped');
      return true;
    } catch (error) {
      const code = finalCode || (typeof error.code === 'string' ? error.code : 'error');
      if (mine === generation) {
        const silent = quiet && !initialized;
        stop({ quietly: true }); setStatus(code);
        if (!silent) speakStatus(code, true);
      }
      throw failure(code);
    }
  }
  // The pairing form. With "remember" ticked, a code that worked is sealed on this device
  // so ASTHA can reconnect by itself next time. With a ClipCam already remembered, an empty
  // code means "this is its new address": the sealed code is used and never retyped.
  async function connect(event) {
    event?.preventDefault();
    if (currentStatus === 'connecting' && !quietAttempt) return;
    const origin = element('pi-camera-origin')?.value.trim();
    let token = element('pi-camera-token')?.value.trim();
    if (element('pi-camera-token')) element('pi-camera-token').value = '';
    const remember = element('pi-camera-remember')?.checked === true;
    const kit = typeof AsthaCameraKit !== 'undefined' ? AsthaCameraKit : null;
    try {
      if (!token && kit?.remembered()) { await kit.useAddress(origin); return; }
      await open({ origin, token });
      if (remember && kit) await kit.remember({ origin, token });
    } catch {} finally { token = ''; }
  }
  function boot() {
    if (booted) return;
    booted = true;
    const preview = element('pi-preview'), viewport = element('viewport');
    if (preview && viewport) viewport.insertBefore(preview, element('overlay'));
    element('pi-camera-form')?.addEventListener('submit', connect);
    element('pi-camera-stop')?.addEventListener('click', () => {
      if (typeof AsthaCameraKit !== 'undefined') AsthaCameraKit.userStopped();
      stop(); element('pi-camera-connect')?.focus();
    });
    window.addEventListener('pagehide', () => stop());
    refreshLabels();
  }
  return { boot, connect, open, stop, refreshLabels, subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    frame: () => typeof PiCamera !== 'undefined' ? PiCamera.getFrame() : null,
    sourceLabel: () => t('pi_source'), get status() { return currentStatus; } };
})();
