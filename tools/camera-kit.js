// "Remember this ASTHA kit". After one authorised pairing ASTHA finds the same ClipCam again
// by itself: after the app or the Pi restarts, after a Wi-Fi drop, and at a new address on a
// reachable network. It looks for the camera's .local name first and uses addresses that have
// worked before only as fallbacks; an address is never treated as the camera's identity. The
// pairing code stays sealed on this device (paired-camera-store.js) and is never spoken,
// shown, logged or sent anywhere but to the camera. Searching happens only while ASTHA is on
// screen, and never takes over a phone camera or photo the user chose.
const AsthaCameraKit = (() => {
  const RETRY_MS = [3000, 6000, 12000, 20000, 30000];
  const PHASE_KEYS = { none: 'kit_none', saved: 'kit_saved', looking: 'kit_looking', connected: 'kit_connected',
    interrupted: 'kit_interrupted', waiting: 'kit_waiting', unavailable: 'kit_camera_unavailable', paused: 'kit_paused',
    rejected: 'kit_rejected', mismatch: 'kit_mismatch', other: 'kit_other_source', storage: 'kit_storage_failed' };
  const CAMERA_CODES = new Set(['camera_unavailable', 'stale_frame', 'frame_timeout', 'invalid_frame', 'frame_too_large']);
  let summary = null, phase = 'none', generation = 0, timer = null, attempt = 0, userStop = false, searching = false,
    episodeSpoken = false, forgetAskedAt = 0, booted = false, loaded = false;
  const element = id => document.getElementById(id);
  const store = () => typeof window.AsthaPairingStore !== 'undefined' ? window.AsthaPairingStore : null;
  const transport = () => typeof PiCamera !== 'undefined' ? PiCamera : null;
  const failure = code => Object.assign(new Error(code), { code });
  function profile() {
    const id = window.ASTHA_LOCAL_ACCOUNT_ID;
    return typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id) ? id : null;
  }
  const owner = profile;
  const sameOwner = who => Boolean(who && who === owner());
  const privateMode = () => typeof privacyMode !== 'undefined' && privacyMode || typeof privacyTransition !== 'undefined' && privacyTransition;
  const operationCurrent = (mine, who) => mine === generation && sameOwner(who) && !document.hidden && !privateMode();
  function say(key) {
    if (typeof announce === 'function' && typeof I18N !== 'undefined') announce(I18N.en[key], I18N.bn[key], 'system');
  }
  const host = origin => { try { return new URL(origin).host; } catch { return ''; } };
  const otherSource = () => typeof state !== 'undefined' && (Boolean(state.source && state.source !== 'pi') || Boolean(state.cameraPending));
  const sessionOpen = () => Boolean(transport()?.paired());

  function render() {
    const put = (id, text) => { const node = element(id); if (node && node.textContent !== text) node.textContent = text; };
    put('camera-kit-status', t(PHASE_KEYS[phase] || 'kit_none'));
    const device = summary?.device || {};
    const name = device.name ? device.name + '.local' : host(summary?.origin || '');
    put('camera-kit-detail', summary ? t('kit_detail', { address: name, model: device.model || t('kit_model_unknown') }) : '');
    const kind = summary?.storage || store()?.kind?.() || null;
    put('camera-kit-storage', t(kind === 'android-keystore' ? 'kit_storage_android' : kind === 'browser' ? 'kit_storage_browser' : 'kit_storage_none'));
    const busy = searching || phase === 'connected';
    const connect = element('camera-kit-connect'); if (connect) connect.disabled = !summary || busy;
    const disconnect = element('camera-kit-disconnect'); if (disconnect) disconnect.disabled = !summary || !(searching || sessionOpen() || timer);
    const forgetButton = element('camera-kit-forget'); if (forgetButton) forgetButton.disabled = !summary;
    const auto = element('camera-kit-auto'); if (auto) { auto.checked = summary?.autoConnect === true; auto.disabled = !summary; }
    const actions = element('camera-kit-actions'); if (actions) actions.hidden = !summary;
    // With a ClipCam remembered, the form can take only a new address; the code is not retyped.
    const code = element('pi-camera-token'); if (code) code.required = !summary;
    put('pi-camera-token-help', t(summary ? 'kit_code_optional' : 'kit_code_required'));
  }
  function setPhase(next, { speak = false } = {}) {
    phase = Object.hasOwn(PHASE_KEYS, next) ? next : 'none';
    render();
    if (speak) say(PHASE_KEYS[phase]);
  }
  function cancelSearch() {
    generation++; searching = false;
    clearTimeout(timer); timer = null;
  }
  function schedule() {
    clearTimeout(timer); timer = null;
    if (!summary?.autoConnect || userStop || document.hidden) return;
    const delay = RETRY_MS[Math.min(attempt++, RETRY_MS.length - 1)];
    timer = setTimeout(() => { timer = null; search('retry'); }, delay);
    render();
  }
  async function refresh() {
    const mine = generation, who = owner();
    const kit = store();
    if (!who) { summary = null; loaded = true; setPhase('none'); return null; }
    if (!kit?.kind?.()) { summary = null; loaded = true; setPhase('none'); return null; }
    try {
      const value = await kit.summary(who, () => sameOwner(who) && mine === generation);
      if (!sameOwner(who) || mine !== generation) return summary;
      summary = value; loaded = true;
      if (!summary && phase !== 'rejected') setPhase('none');
      else if (summary && ['none', 'storage'].includes(phase)) setPhase(sessionOpen() ? 'connected' : 'saved');
      else render();
    } catch { if (sameOwner(who) && mine === generation) { summary = null; loaded = true; setPhase('storage'); } }
    return summary;
  }
  // Addresses in order: the paired address (normally the Pi's .local name), the Pi's own
  // name if it reports one, then addresses that worked before, newest first.
  function candidates(record) {
    const list = [record.origin];
    if (record.device?.name) {
      try {
        const port = new URL(record.origin).port;
        list.push('https://' + record.device.name + '.local' + (port ? ':' + port : ''));
      } catch {}
    }
    for (const origin of record.fallbacks || []) list.push(origin);
    return [...new Set(list)];
  }
  // One address. The camera must prove it holds the code (when it can) before it is sent.
  async function attempt1(origin, record, current) {
    const pi = transport();
    let identity;
    try { identity = await pi.verify({ origin, token: record.token, deviceId: record.device?.id }); }
    catch (error) { return { result: error?.code === 'identity_mismatch' ? 'mismatch' : 'unreachable' }; }
    if (!current()) return { result: 'cancelled' };
    if (!identity.reachable) return { result: 'unreachable' };
    if (record.device?.proof && !identity.supported) return { result: identity.reachable ? 'mismatch' : 'unreachable' };
    // A legacy kit is trusted only at the address the user explicitly paired over TLS.
    // Never disclose its saved code to a new/fallback address that cannot prove possession.
    if (!identity.supported && origin !== record.origin) return { result: 'mismatch' };
    try {
      await AsthaPiCamera.open({ origin, token: record.token, quiet: true });
      return current() ? { result: 'connected', identity } : { result: 'cancelled' };
    } catch (error) {
      const code = error?.code;
      if (!current() || code === 'busy' || code === 'stopped') return { result: 'cancelled' };
      // A refused code is only believed from the camera's own name or a proven identity;
      // an unrelated device at an old address must not make ASTHA forget the pairing.
      if (code === 'pairing_rejected') return { result: identity.supported || origin === record.origin ? 'rejected' : 'mismatch' };
      return { result: identity.reachable && CAMERA_CODES.has(code) ? 'camera' : 'unreachable' };
    }
  }
  async function connected(record, origin, identity, current) {
    if (!current()) return false;
    const changes = {};
    if (!record.autoConnect) changes.autoConnect = true;
    if (origin !== record.origin) changes.fallbacks = [origin, ...(record.fallbacks || []).filter(item => item !== origin)];
    const info = await transport()?.describe?.().catch(() => null);
    if (!current()) return false;
    const device = { ...(record.device || {}) };
    if (identity?.supported) { device.id = identity.deviceId; device.proof = true; }
    if (info?.model) device.model = info.model;
    if (info?.backend) device.backend = info.backend;
    if (info?.name) device.name = info.name;
    if (JSON.stringify(device) !== JSON.stringify(record.device || {})) changes.device = device;
    if (Object.keys(changes).length) {
      const who = owner();
      try {
        const saved = await store().update(who, changes, current);
        if (!current()) return false;
        summary = saved || summary;
      } catch { if (!current()) return false; }
    }
    if (!current()) return false;
    attempt = 0; episodeSpoken = false; searching = false; userStop = false;
    setPhase('connected');
    return true;
  }
  async function forgetRejected() {
    cancelSearch();
    const mine = generation, who = owner(), current = () => mine === generation && sameOwner(who);
    if (!who) { summary = null; setPhase('none'); return; }
    try { await store()?.forget(who, current); } catch { if (current()) setPhase('storage', { speak: true }); return; }
    if (!current()) return;
    summary = null; setPhase('rejected', { speak: true });
  }
  // reason: 'startup', 'user', 'retry', 'visible', 'online' or 'auto'.
  async function search(reason) {
    if (privateMode()) { privacyEntered(); return false; }
    if (!owner()) { summary = null; setPhase('none'); return false; }
    if (!summary) await refresh();
    if (!summary) { if (reason === 'user') say(phase === 'storage' ? 'kit_storage_failed' : 'kit_none'); return false; }
    if (reason !== 'user' && (userStop || !summary.autoConnect)) return false;
    if (document.hidden) { setPhase('paused'); return false; }
    if (sessionOpen() && AsthaPiCamera.status !== 'stopped') {
      if (reason === 'user') say(statusKey());
      return true;
    }
    if (otherSource()) {
      if (reason !== 'user') { setPhase('other'); return false; }
      // The user asked for the ClipCam, so the phone camera or photo gives way to it.
      if (typeof stopCamera === 'function') stopCamera();
    }
    cancelSearch();
    const mine = generation, who = owner();
    const current = () => operationCurrent(mine, who);
    searching = true;
    if (reason === 'user') { userStop = false; episodeSpoken = false; attempt = 0; setPhase('looking', { speak: true }); }
    else setPhase(phase === 'connected' ? 'looking' : ['waiting', 'unavailable', 'mismatch'].includes(phase) ? phase : 'looking');
    let record;
    try { record = await store().load(who, current); }
    catch { if (current()) { searching = false; setPhase('storage', { speak: reason === 'user' }); } return false; }
    if (!current()) return false;
    if (!record) { summary = null; searching = false; setPhase('none', { speak: reason === 'user' }); return false; }
    const outcomes = new Set();
    try {
      for (const origin of candidates(record)) {
        const outcome = await attempt1(origin, record, current);
        if (outcome.result === 'cancelled' || !current()) { if (mine === generation) searching = false; render(); return false; }
        if (outcome.result === 'connected') {
          if (!await connected(record, origin, outcome.identity, current)) return false;
          say('kit_connected');
          return true;
        }
        outcomes.add(outcome.result);
        if (outcome.result === 'rejected') { await forgetRejected(); return false; }
      }
    } finally { record.token = ''; record = null; }
    searching = false;
    const next = outcomes.has('mismatch') ? 'mismatch' : outcomes.has('camera') ? 'unavailable' : 'waiting';
    // Each kind of trouble is said once per episode; quiet retries follow.
    const speak = !episodeSpoken || phase !== next;
    episodeSpoken = true;
    setPhase(next, { speak });
    schedule();
    return false;
  }
  function statusKey() {
    if (!summary) return loaded && phase === 'storage' ? 'kit_storage_failed' : 'kit_none';
    if (phase === 'connected') return transport()?.active() ? 'kit_status_live' : 'kit_status_no_fresh';
    return PHASE_KEYS[phase] || 'kit_saved';
  }
  // Transport changes, from the adapter. Returning true means this module spoke about it.
  function follow({ state: change, code, quiet }) {
    if (!summary) return false;
    if (change === 'connected') {
      const ours = quiet && searching;
      if (!ours) { attempt = 0; episodeSpoken = false; setPhase('connected'); }
      return ours;   // the search announces its own success
    }
    if (change === 'reconnecting') { setPhase(code === 'resumed' ? 'looking' : 'interrupted'); return false; }
    if (change === 'paused') { setPhase('paused'); return false; }
    if (change === 'stopped') {
      if (document.hidden) { cancelSearch(); setPhase('paused'); }
      else if (!searching) setPhase(otherSource() ? 'other' : 'saved');
      else { cancelSearch(); setPhase(otherSource() ? 'other' : 'saved'); }
      return false;
    }
    if (change === 'error') {
      if (searching) return false;   // a search attempt reports through its own result
      if (code === 'pairing_rejected') { forgetRejected(); return true; }
      if (!summary.autoConnect || userStop || document.hidden) { setPhase(document.hidden ? 'paused' : 'saved'); return false; }
      attempt = 0; episodeSpoken = true;
      setPhase(CAMERA_CODES.has(code) ? 'unavailable' : 'waiting');
      say('kit_lost_keep_looking');
      schedule();
      return true;
    }
    return false;
  }
  // ---- Actions from the Devices page, the pairing form and voice ----
  async function remember({ origin, token }) {
    if (privateMode()) return false;
    const kit = store(), pi = transport();
    if (!kit?.kind?.() || !pi) { setPhase('storage', { speak: true }); return false; }
    cancelSearch();
    const mine = generation, who = owner(), current = () => operationCurrent(mine, who);
    if (!current()) return false;
    let identity = null;
    try { identity = await pi.verify({ origin, token }); } catch {}
    if (!current()) return false;
    const info = await pi.describe?.().catch(() => null);
    if (!current()) return false;
    const device = {};
    if (identity?.supported) { device.id = identity.deviceId; device.proof = true; }
    if (info?.model) device.model = info.model;
    if (info?.backend) device.backend = info.backend;
    if (info?.name) device.name = info.name;
    try {
      const saved = await kit.save(who, { origin, token, device }, current);
      if (!current()) return false;
      summary = saved;
    } catch { if (current()) setPhase('storage', { speak: true }); return false; }
    userStop = false; attempt = 0; episodeSpoken = false;
    setPhase(sessionOpen() ? 'connected' : 'saved');
    say('kit_remembered');
    return true;
  }
  // The user typed a new address for the remembered ClipCam and left the code empty.
  async function useAddress(origin) {
    if (privateMode()) { privacyEntered(); return false; }
    let address;
    try { address = new URL(origin).origin; if (!/^https:$/.test(new URL(origin).protocol)) throw failure('invalid_origin'); }
    catch { say('pi_invalid_origin'); return false; }
    if (!summary) await refresh();
    if (!summary) { say('kit_none'); return false; }
    if (otherSource() && typeof stopCamera === 'function') stopCamera();
    cancelSearch();
    const mine = generation, who = owner();
    const current = () => operationCurrent(mine, who);
    searching = true; userStop = false; setPhase('looking', { speak: true });
    let record;
    try { record = await store().load(who, current); } catch { record = null; }
    if (!record || !current()) {
      if (current()) { searching = false; setPhase('storage', { speak: true }); }
      return false;
    }
    try {
      const outcome = await attempt1(address, record, current);
      if (outcome.result === 'connected') {
        if (!await connected({ ...record, origin: address, fallbacks: record.fallbacks }, address, outcome.identity, current)) return false;
        try {
          const saved = await store().update(who, { origin: address }, current);
          if (!current()) return false;
          summary = saved || summary;
        } catch { if (!current()) return false; }
        render(); say('kit_connected');
        return true;
      }
      if (outcome.result === 'cancelled') { if (mine === generation) searching = false; render(); return false; }
      searching = false;
      // A refusal at an address the user typed proves nothing about the remembered camera.
      setPhase(outcome.result === 'rejected' || outcome.result === 'mismatch' ? 'mismatch' : outcome.result === 'camera' ? 'unavailable' : 'waiting', { speak: true });
      return false;
    } finally { record.token = ''; }
  }
  function connectNow() { return search('user'); }
  async function disconnect({ speak = true } = {}) {
    userStop = true; cancelSearch();
    const mine = generation, who = owner(), current = () => mine === generation && sameOwner(who);
    if (typeof AsthaPiCamera !== 'undefined' && AsthaPiCamera.status !== 'stopped') AsthaPiCamera.stop();
    setPhase(summary ? 'saved' : 'none');
    if (speak) say(summary ? 'kit_disconnected' : 'kit_none');
    // Explicitly disabling access remains available in private mode. It reduces a saved
    // preference; it never saves a new observation or pairing credential.
    if (!who || !store()?.kind?.()) return;
    try {
      const saved = await store().update(who, { autoConnect: false }, current);
      if (current()) { summary = saved; render(); }
    } catch { if (current()) setPhase('storage', { speak: true }); }
  }
  async function forget() {
    const who = owner();
    cancelSearch(); userStop = true;
    const mine = generation, current = () => mine === generation && sameOwner(who);
    if (typeof AsthaPiCamera !== 'undefined' && AsthaPiCamera.status !== 'stopped') AsthaPiCamera.stop();
    if (!who) { summary = null; setPhase('none'); return true; }
    try { await store()?.forget(who, current); }
    catch { if (current()) setPhase('storage', { speak: true }); return false; }
    if (!current()) return false;
    summary = null; setPhase('none');
    say('kit_forgotten');
    return true;
  }
  async function setAuto(enabled) {
    if (privateMode() && enabled !== false) { render(); return false; }
    if (!summary) return false;
    cancelSearch();
    const mine = generation, who = owner(), current = () => mine === generation && sameOwner(who);
    if (!who) return false;
    try {
      const saved = await store().update(who, { autoConnect: enabled === true }, current);
      if (!current()) return false;
      summary = saved || summary;
    } catch { if (current()) setPhase('storage', { speak: true }); return false; }
    if (!summary.autoConnect) { clearTimeout(timer); timer = null; }
    render();
    say(summary.autoConnect ? 'kit_auto_on' : 'kit_auto_off');
    if (summary.autoConnect && !sessionOpen()) { userStop = false; search('auto'); }
    return true;
  }
  // ---- Voice ----
  const DEVICE = '(?:my |the |this )?(?:astha )?(?:clip ?-?cam(?:era)?|clip-on camera|wi-?fi camera|camera kit|astha kit|kit|device|camera)';
  const BN_DEVICE = '(?:ক্যামেরা|ক্লিপক্যাম|ক্লিপ ক্যামেরা|ডিভাইস|কিট)';
  const FORGET = new RegExp('^forget ' + DEVICE + '$');
  const DISCONNECT = new RegExp('^(?:please )?disconnect(?: from)? ' + DEVICE + '$');
  const STATUS = new RegExp('^(?:is|are) ' + DEVICE + '(?: still)? (?:connected|on|working|online|live|there)$|^(?:clip ?cam|camera|device|kit|connection) status$|^(?:what is|what\'s) (?:the )?(?:status of )?' + DEVICE + '(?: status)?$');
  const CONNECT = new RegExp('^(?:please )?(?:re)?connect(?: to| with)? ' + DEVICE + '(?: again)?$|^(?:use|switch to|find) (?:my |the )?(?:astha )?(?:clip ?cam|wi-?fi camera|camera kit)$');
  function route(query) {
    const q = String(query || '').normalize('NFC').toLowerCase().replace(/^(?:hey\s+|ok\s+)?astha[,!.\s]*|^আস্থা[,।\s]*/i, '').replace(/[.!?।\s]+$/, '').trim();
    if (forgetAskedAt) {
      const pending = Date.now() - forgetAskedAt < 15000;
      forgetAskedAt = 0;
      if (pending && /^(?:yes|yes,? forget(?: it)?|forget it|confirm|হ্যাঁ|হ্যা|জি|জি হ্যাঁ|ভুলে যাও)$/.test(q)) { forget(); return true; }
      if (pending && /^(?:no|cancel|keep it|don't|do not|না|থাক|রেখে দাও|বাতিল)$/.test(q)) { say('kit_forget_cancelled'); return true; }
    }
    const bn = new RegExp(BN_DEVICE).test(q);
    if (FORGET.test(q) || bn && /ভুলে যাও|ভুলে যান|মুছে দাও/.test(q)) {
      if (!summary) { say('kit_none'); return true; }
      forgetAskedAt = Date.now(); say('kit_forget_confirm'); return true;
    }
    if (DISCONNECT.test(q) || bn && /বিচ্ছিন্ন|ডিসকানেক্ট|সংযোগ বন্ধ|সংযোগ কেটে/.test(q)) {
      // Plain "disconnect the camera" while the phone camera is on stays with the phone camera.
      if (!summary && !sessionOpen()) return false;
      disconnect(); return true;
    }
    if (STATUS.test(q) || bn && /(?:কি|কী) .*(?:সংযুক্ত|যুক্ত|চালু|কানেক্টেড)|(?:সংযুক্ত|যুক্ত|কানেক্টেড) (?:কি|কী|আছে)|অবস্থা/.test(q)) {
      if (!summary && !sessionOpen() && !/clip ?cam|ক্লিপ/.test(q)) return false;
      say(statusKey()); return true;
    }
    if (CONNECT.test(q) || bn && /(?:সংযোগ|কানেক্ট|যুক্ত) (?:করো|করুন|কর|দাও)|খুঁজে (?:নাও|বের করো)/.test(q)) {
      connectNow(); return true;
    }
    return false;
  }
  function accountCleared() {
    cancelSearch(); summary = null; userStop = false; attempt = 0; loaded = false;
    if (typeof AsthaPiCamera !== 'undefined' && AsthaPiCamera.status !== 'stopped') AsthaPiCamera.stop();
    setPhase('none');
  }
  // Privacy entry cancels in-flight credential/metadata writes and stops automatic camera
  // use without saving a new preference. Leaving privacy alone cannot restart the camera.
  function privacyEntered() {
    cancelSearch(); userStop = true; forgetAskedAt = 0;
    if (typeof AsthaPiCamera !== 'undefined' && AsthaPiCamera.status !== 'stopped') AsthaPiCamera.stop();
    setPhase(summary ? 'saved' : 'none');
  }
  // What the diagnostics panel may show. No address, code or identity value.
  function diagnostics() {
    return { remembered: Boolean(summary), phase, storage: summary?.storage || store()?.kind?.() || null,
      autoConnect: summary?.autoConnect === true, identityProven: summary?.device?.proof === true,
      transport: typeof AsthaPiCamera !== 'undefined' ? AsthaPiCamera.status : 'stopped', live: Boolean(transport()?.active()) };
  }
  function boot() {
    if (booted) return;
    booted = true;
    if (typeof AsthaPiCamera !== 'undefined') AsthaPiCamera.subscribe(follow);
    element('camera-kit-connect')?.addEventListener('click', () => connectNow());
    element('camera-kit-disconnect')?.addEventListener('click', () => disconnect());
    element('camera-kit-forget')?.addEventListener('click', () => {
      // A visual confirmation stands in for the spoken one; TalkBack reads the dialog.
      if (typeof window.confirm !== 'function' || window.confirm(t('kit_forget_dialog'))) forget();
    });
    element('camera-kit-auto')?.addEventListener('change', event => setAuto(event.target.checked));
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) { cancelSearch(); return; }
      if (summary?.autoConnect && !userStop && !sessionOpen() && ['waiting', 'unavailable', 'mismatch', 'paused', 'looking'].includes(phase)) search('visible');
    });
    // Back on Wi-Fi, or on another network: look straight away instead of waiting.
    window.addEventListener('online', () => {
      if (summary?.autoConnect && !userStop && !sessionOpen() && !document.hidden && phase !== 'connected') { attempt = 0; search('online'); }
    });
    render();
    refresh().then(value => { if (value?.autoConnect && !document.hidden) search('startup'); });
  }
  return { boot, route, render, remember, useAddress, connect: connectNow, disconnect, forget, setAuto, accountCleared, privacyEntered, diagnostics,
    manualStart: () => disconnect({ speak: false }),
    userStopped: () => disconnect({ speak: false }), remembered: () => Boolean(summary),
    get phase() { return phase; } };
})();
