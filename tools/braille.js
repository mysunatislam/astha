// Six-key Braille controller support, ready for hardware that does not exist yet.
//
//   transport  ->  key masks  ->  chord decoder  ->  command map / text entry  ->  LUNEYRA action
//
// A transport only reports which keys are down. Everything after that is shared, so the
// planned ESP32 controller needs a transport and nothing else. Today the keyboard practice
// transport is the only one exercised; the Bluetooth transport is written against the
// planned firmware contract and has never met a real device.
const AsthaBraille = (() => {
  // Dot n is bit n-1, so a chord is a number from 1 to 63.
  const dots = mask => [1, 2, 3, 4, 5, 6].filter(dot => mask & (1 << (dot - 1)));
  const maskOf = list => list.reduce((mask, dot) => mask | (1 << (dot - 1)), 0);
  const FULL_CELL = 63;
  // Uncontracted English letters. A Bangla table must be reviewed by a Braille reader before
  // it is added; none is guessed here.
  const LETTERS = { 1: 'a', 3: 'b', 9: 'c', 25: 'd', 17: 'e', 11: 'f', 27: 'g', 19: 'h', 10: 'i', 26: 'j', 5: 'k', 7: 'l', 13: 'm',
    29: 'n', 21: 'o', 15: 'p', 31: 'q', 23: 'r', 14: 's', 30: 't', 37: 'u', 39: 'v', 58: 'w', 45: 'x', 61: 'y', 53: 'z' };
  const TEXT_SPACE = maskOf([3, 6]), TEXT_DELETE = maskOf([4, 5, 6]);

  const call = name => { if (typeof globalThis[name] === 'function') globalThis[name](); };
  const COMMANDS = {
    stop: { label: 'brl_cmd_stop', run: () => call('stopAllSpeech') },
    listen: { label: 'brl_cmd_listen', run: () => call('toggleListening') },
    describe: { label: 'brl_cmd_describe', run: () => call('describeScene') },
    read: { label: 'brl_cmd_read', run: () => call('readText') },
    find: { label: 'brl_cmd_find', run: () => call('findItems') },
    repeat: { label: 'brl_cmd_repeat', run: () => call('repeatResponse') },
    camera: { label: 'brl_cmd_camera', run: () => call('toggleCamera') },
    home: { label: 'brl_cmd_home', run: () => { if (typeof AsthaExperience !== 'undefined') AsthaExperience.showPage('home'); } },
    mode: { label: 'brl_cmd_mode', run: () => {
      if (typeof AsthaExperience === 'undefined') return;
      const order = ['ask', 'road', 'classroom'].filter(name => AsthaExperience.preferences.modes.includes(name));
      AsthaExperience.setContext(order[(order.indexOf(AsthaExperience.mode) + 1) % order.length]);
    } },
    text: { label: 'brl_cmd_text', run: () => setTextMode(!textMode) },
  };
  // The full cell is the easiest chord to find in a hurry, so it always stops LUNEYRA.
  const DEFAULT_MAP = Object.freeze({ [FULL_CELL]: 'stop', 7: 'listen', 25: 'describe', 23: 'read', 11: 'find', 1: 'repeat', 9: 'camera', 19: 'home', 13: 'mode', 30: 'text' });
  const MAP_KEY = 'astha.braille.map.v1';
  let mapping = { ...DEFAULT_MAP };

  // Returns the cleaned mapping, or null. Stop must stay reachable on some chord.
  function validateMapping(candidate) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null;
    const clean = {};
    for (const [chord, command] of Object.entries(candidate)) {
      const mask = Number(chord);
      if (!Number.isInteger(mask) || mask < 1 || mask > FULL_CELL || !Object.hasOwn(COMMANDS, command)) return null;
      clean[mask] = command;
    }
    return Object.values(clean).includes('stop') ? clean : null;
  }
  function setMapping(candidate) {
    const clean = validateMapping(candidate);
    if (!clean) return false;
    mapping = clean;
    try { localStorage.setItem(MAP_KEY, JSON.stringify(clean)); } catch {}
    renderCommands();
    return true;
  }
  function resetMapping() { mapping = { ...DEFAULT_MAP }; try { localStorage.removeItem(MAP_KEY); } catch {} renderCommands(); }

  // Keys pressed together or rolled count as one chord, entered when the last key is released.
  function createDecoder(onChord, { stuckAfter = 5000 } = {}) {
    let held = 0, chord = 0, changedAt = 0;
    return {
      keys(mask, now = Date.now()) {
        mask &= FULL_CELL;
        // A key that never reports its release must not hold the controller hostage.
        if (held && now - changedAt > stuckAfter) { held = 0; chord = 0; }
        changedAt = now;
        if (mask) { held = mask; chord |= mask; return; }
        const entered = chord; held = 0; chord = 0;
        if (entered) onChord(entered);
      },
      reset() { held = 0; chord = 0; },
    };
  }

  let textMode = false, status = 'off', transport = null, lastUnknown = -Infinity;
  const STATUS_KEYS = { off: 'braille_status_off', practice: 'braille_status_practice', connecting: 'braille_status_connecting',
    connected: 'braille_status_connected', reconnecting: 'braille_status_reconnecting', error: 'braille_status_error' };
  const element = id => typeof document !== 'undefined' ? document.getElementById(id) : null;
  const speakPair = (en, bn) => { if (typeof announce === 'function') announce(en, bn, 'system'); };
  function setTextMode(on) {
    textMode = Boolean(on);
    speakPair(textMode ? 'Braille typing on. Dots 3 6 for a space, dots 4 5 6 to delete, all six keys to send.' : 'Braille typing off.',
      textMode ? 'ব্রেইলে লেখা চালু। ফাঁকের জন্য ডট ৩ ৬, মুছতে ডট ৪ ৫ ৬, পাঠাতে ছয়টি চাবি একসাথে।' : 'ব্রেইলে লেখা বন্ধ।');
  }
  // What a chord means right now, without doing it. Kept separate so it can be tested.
  function interpret(mask, typing = textMode) {
    if (typing) {
      if (mask === FULL_CELL) return { type: 'submit' };
      if (mask === TEXT_SPACE) return { type: 'character', value: ' ' };
      if (mask === TEXT_DELETE) return { type: 'delete' };
      return Object.hasOwn(LETTERS, mask) ? { type: 'character', value: LETTERS[mask] } : { type: 'unknown' };
    }
    return Object.hasOwn(mapping, mask) ? { type: 'command', value: mapping[mask] } : { type: 'unknown' };
  }
  function handleChord(mask) {
    const action = interpret(mask);
    const input = element('command-input');
    if (action.type === 'command') COMMANDS[action.value].run();
    else if (action.type === 'character' && input) input.value = (input.value + action.value).slice(0, 500);
    else if (action.type === 'delete' && input) input.value = input.value.slice(0, -1);
    else if (action.type === 'submit') { textMode = false; if (typeof submitCommand === 'function') submitCommand(); }
    else if (action.type === 'unknown' && Date.now() - lastUnknown > 4000) {
      lastUnknown = Date.now();
      speakPair('That key combination is not assigned.', 'এই চাবির সমন্বয়ে কোনো কাজ দেওয়া নেই।');
    }
    return action;
  }

  /* ---- Transports ------------------------------------------------------------------- */
  // Practice on a computer keyboard in the usual six-key layout: S D F and J K L.
  const KEYBOARD_DOTS = { f: 1, d: 2, s: 3, j: 4, k: 5, l: 6 };
  function keyboardTransport() {
    let held = 0, onKeys = null;
    const typingTarget = target => Boolean(target?.closest?.('input, textarea, select, [contenteditable=""], [contenteditable="true"]'));
    const change = (event, down) => {
      const dot = KEYBOARD_DOTS[String(event.key || '').toLowerCase()];
      if (!dot || event.ctrlKey || event.altKey || event.metaKey || typingTarget(event.target)) return;
      event.preventDefault();
      const bit = 1 << (dot - 1);
      held = down ? held | bit : held & ~bit;
      onKeys(held);
    };
    const down = event => { if (!event.repeat) change(event, true); }, up = event => change(event, false);
    const release = () => { held = 0; onKeys?.(0); };
    return { name: 'keyboard',
      start(keys, report) { onKeys = keys; document.addEventListener('keydown', down); document.addEventListener('keyup', up); window.addEventListener('blur', release); report('practice'); },
      stop() { document.removeEventListener('keydown', down); document.removeEventListener('keyup', up); window.removeEventListener('blur', release); held = 0; } };
  }
  // Planned ESP32 firmware contract: one notifying characteristic whose first byte is the
  // key mask (bit 0 = dot 1 ... bit 5 = dot 6). Untested: no controller has been built.
  const BLE = Object.freeze({ service: 'a57a0001-6b72-4c1e-9d2a-415354484101', keys: 'a57a0002-6b72-4c1e-9d2a-415354484101', retries: 5 });
  function bleTransport(bluetooth = typeof navigator !== 'undefined' ? navigator.bluetooth : undefined) {
    let device = null, characteristic = null, onKeys = null, report = null, stopped = false, attempt = 0, timer = null;
    const notified = event => { const view = event.target.value; if (view && view.byteLength) onKeys(view.getUint8(0)); };
    async function link() {
      const server = await device.gatt.connect();
      const service = await server.getPrimaryService(BLE.service);
      characteristic = await service.getCharacteristic(BLE.keys);
      characteristic.addEventListener('characteristicvaluechanged', notified);
      await characteristic.startNotifications();
      attempt = 0; report('connected');
    }
    // Keys cannot stay "held" across a dropped link, and a few quiet retries cover a
    // controller that drifted out of range or woke from sleep.
    function dropped() {
      onKeys(0);
      if (stopped) return;
      if (attempt >= BLE.retries) { report('error'); return; }
      report('reconnecting');
      timer = setTimeout(() => link().catch(dropped), Math.min(8000, 500 * 2 ** attempt++));
    }
    return { name: 'ble',
      async start(keys, status) {
        onKeys = keys; report = status; stopped = false;
        if (!bluetooth || typeof bluetooth.requestDevice !== 'function') { report('error'); throw new Error('bluetooth_unavailable'); }
        report('connecting');
        try {
          device = await bluetooth.requestDevice({ filters: [{ services: [BLE.service] }] });
          device.addEventListener('gattserverdisconnected', dropped);
          await link();
        } catch (error) { report('error'); throw error; }
      },
      stop() {
        stopped = true; clearTimeout(timer);
        characteristic?.removeEventListener('characteristicvaluechanged', notified);
        device?.removeEventListener('gattserverdisconnected', dropped);
        try { device?.gatt?.disconnect(); } catch {}
        device = null; characteristic = null;
      } };
  }
  const TRANSPORTS = { keyboard: keyboardTransport, ble: bleTransport };

  function renderStatus() {
    const line = element('braille-status'); if (line) line.textContent = t(STATUS_KEYS[status]);
    const button = element('braille-practice');
    if (button) { const on = status === 'practice'; button.setAttribute('aria-pressed', String(on)); button.textContent = t(on ? 'braille_practice_on' : 'braille_practice_off'); }
  }
  function renderCommands() {
    const list = element('braille-command-list'); if (!list) return;
    list.textContent = '';
    for (const [mask, command] of Object.entries(mapping).sort((a, b) => Number(a[0]) - Number(b[0]))) {
      const item = document.createElement('li');
      item.textContent = t('braille_dots') + ' ' + dots(Number(mask)).join(' ') + ' — ' + t(COMMANDS[command].label);
      list.appendChild(item);
    }
  }
  function setStatus(next) {
    const changed = next !== status;
    status = Object.hasOwn(STATUS_KEYS, next) ? next : 'error';
    renderStatus();
    if (changed && typeof I18N !== 'undefined') speakPair(I18N.en[STATUS_KEYS[status]], I18N.bn[STATUS_KEYS[status]]);
  }
  function stop() {
    transport?.stop(); transport = null; textMode = false;
    if (status !== 'off') setStatus('off');
  }
  async function start(name = 'keyboard', ...options) {
    if (!Object.hasOwn(TRANSPORTS, name)) return false;
    stop();
    const decoder = createDecoder(handleChord);
    transport = TRANSPORTS[name](...options);
    try { await transport.start(mask => decoder.keys(mask), setStatus); return true; }
    catch { transport?.stop(); transport = null; return false; }
  }
  function boot() {
    try { const saved = validateMapping(JSON.parse(localStorage.getItem(MAP_KEY) || 'null')); if (saved) mapping = saved; } catch {}
    element('braille-practice')?.addEventListener('click', () => { if (status === 'practice') stop(); else start('keyboard'); });
    renderStatus(); renderCommands();
  }
  return { boot, start, stop, handleChord, interpret, createDecoder, validateMapping, setMapping, resetMapping, setTextMode,
    dots, maskOf, LETTERS, DEFAULT_MAP, BLE, transports: TRANSPORTS,
    refreshLabels() { renderStatus(); renderCommands(); },
    get status() { return status; }, get mapping() { return { ...mapping }; }, get textMode() { return textMode; } };
})();
