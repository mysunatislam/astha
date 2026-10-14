// Six-key Braille controller layer. Everything here is simulated: no controller hardware
// exists, and the Bluetooth transport is exercised only against a stand-in GATT device.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../tools/braille.js', import.meta.url), 'utf8');
const sensorSource = fs.readFileSync(new URL('../tools/sensors.js', import.meta.url), 'utf8');
const strings = JSON.parse(fs.readFileSync(new URL('../tools/i18n.json', import.meta.url), 'utf8')).strings;
// Standard uncontracted letters, written out independently of the implementation.
const ALPHABET = { a: [1], b: [1, 2], c: [1, 4], d: [1, 4, 5], e: [1, 5], f: [1, 2, 4], g: [1, 2, 4, 5], h: [1, 2, 5], i: [2, 4], j: [2, 4, 5],
  k: [1, 3], l: [1, 2, 3], m: [1, 3, 4], n: [1, 3, 4, 5], o: [1, 3, 5], p: [1, 2, 3, 4], q: [1, 2, 3, 4, 5], r: [1, 2, 3, 5], s: [2, 3, 4], t: [2, 3, 4, 5],
  u: [1, 3, 6], v: [1, 2, 3, 6], w: [2, 4, 5, 6], x: [1, 3, 4, 6], y: [1, 3, 4, 5, 6], z: [1, 3, 5, 6] };

function harness({ modes = ['ask', 'road', 'classroom'] } = {}) {
  const calls = [], spoken = [], storage = new Map(), listeners = { document: new Map(), window: new Map() }, timers = [];
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, { id, value: '', textContent: '', children: [], attributes: {}, listeners: {},
      setAttribute(key, value) { this.attributes[key] = value; }, addEventListener(name, fn) { this.listeners[name] = fn; },
      appendChild(child) { this.children.push(child); } });
    return elements.get(id);
  };
  for (const id of ['braille-practice', 'braille-status', 'braille-command-list', 'command-input']) element(id);
  const command = name => () => calls.push(name);
  const experience = { mode: 'ask', preferences: { modes }, page: 'tools', setContext(next) { this.mode = next; calls.push('mode:' + next); }, showPage(next) { this.page = next; calls.push('page:' + next); } };
  const context = vm.createContext({
    console, Promise, Date: class extends Date { static now() { return context.now; } }, now: 1000,
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimeout() {},
    stopAllSpeech: command('stop'), toggleListening: command('listen'), describeScene: command('describe'), readText: command('read'),
    findItems: command('find'), repeatResponse: command('repeat'), toggleCamera: command('camera'), submitCommand: command('submit'),
    AsthaExperience: experience, announce: (en, bn) => spoken.push([en, bn]), uiLang: 'en',
    I18N: { en: Object.fromEntries(Object.entries(strings).map(([key, pair]) => [key, pair[0]])), bn: Object.fromEntries(Object.entries(strings).map(([key, pair]) => [key, pair[1]])) },
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    document: { getElementById: id => elements.get(id) || null, createElement: () => ({ textContent: '' }),
      addEventListener: (name, fn) => listeners.document.set(name, fn), removeEventListener: name => listeners.document.delete(name) },
    window: { addEventListener: (name, fn) => listeners.window.set(name, fn), removeEventListener: name => listeners.window.delete(name) },
  });
  context.t = key => context.I18N[context.uiLang][key];
  vm.runInContext(source + '\nglobalThis.braille = AsthaBraille;', context);
  const key = (type, letter, extra = {}) => listeners.document.get(type)?.({ key: letter, preventDefault() {}, target: { closest: () => null }, ...extra });
  return { braille: context.braille, context, calls, spoken, storage, listeners, timers, elements, experience, key,
    chord(letters) { for (const letter of letters) key('keydown', letter); for (const letter of letters) key('keyup', letter); } };
}

test('the letter table matches standard uncontracted Braille and dots convert both ways', () => {
  const { braille } = harness();
  assert.equal(Object.keys(braille.LETTERS).length, 26);
  for (const [letter, dots] of Object.entries(ALPHABET)) {
    const mask = braille.maskOf(dots);
    assert.equal(braille.LETTERS[mask], letter, letter); assert.deepEqual([...braille.dots(mask)], dots);
  }
  assert.equal(braille.maskOf([1, 2, 3, 4, 5, 6]), 63);
});

test('keys pressed together or rolled make one chord, entered on the last release', () => {
  const { braille } = harness(), entered = [];
  const decoder = braille.createDecoder(mask => entered.push(mask));
  decoder.keys(1); decoder.keys(3); decoder.keys(2); assert.deepEqual(entered, []);
  decoder.keys(0); assert.deepEqual(entered, [3]);
  // Rolled: dot 1 is already up when dot 4 goes down, but nothing was fully released between.
  decoder.keys(1); decoder.keys(9); decoder.keys(8); decoder.keys(0);
  assert.deepEqual(entered, [3, 9]);
  decoder.keys(0); assert.deepEqual(entered, [3, 9], 'a release with nothing held is not a chord');
  decoder.keys(64 | 4); decoder.keys(0); assert.deepEqual(entered, [3, 9, 4], 'bits outside the six dots are ignored');
});

test('a key that never reports its release cannot keep the controller locked', () => {
  const { braille } = harness(), entered = [];
  const decoder = braille.createDecoder(mask => entered.push(mask));
  decoder.keys(1, 0);
  decoder.keys(2, 6000);   // the stuck dot 1 is discarded before this press
  decoder.keys(0, 6100);
  assert.deepEqual(entered, [2]);
});

test('default chords run ASTHA commands and all six keys always stop', () => {
  const h = harness();
  for (const [dots, expected] of [[[1, 2, 3, 4, 5, 6], 'stop'], [[1, 2, 3], 'listen'], [[1, 4, 5], 'describe'], [[1, 2, 3, 5], 'read'],
    [[1, 2, 4], 'find'], [[1], 'repeat'], [[1, 4], 'camera']]) {
    assert.equal(h.braille.handleChord(h.braille.maskOf(dots)).value, expected);
    assert.equal(h.calls.at(-1), expected);
  }
  h.braille.handleChord(h.braille.maskOf([1, 2, 5])); assert.equal(h.calls.at(-1), 'page:home');
  assert.equal(h.braille.interpret(h.braille.maskOf([2, 6])).type, 'unknown');
});

test('an unassigned chord is explained once, not on every press', () => {
  const h = harness(), unknown = h.braille.maskOf([2, 6]);
  h.braille.handleChord(unknown); h.braille.handleChord(unknown);
  assert.equal(h.spoken.length, 1); assert.match(h.spoken[0][0], /not assigned/); assert.equal(h.calls.length, 0);
  h.context.now += 4001; h.braille.handleChord(unknown); assert.equal(h.spoken.length, 2);
});

test('the mode chord cycles only through the kinds of help the user kept in setup', () => {
  const h = harness({ modes: ['ask', 'classroom'] }), chord = h.braille.maskOf([1, 3, 4]);
  h.braille.handleChord(chord); h.braille.handleChord(chord);
  assert.deepEqual(h.calls, ['mode:classroom', 'mode:ask']);
});

test('typing mode writes letters into the request field and all six keys send it', () => {
  const h = harness(), input = h.elements.get('command-input'), type = dots => h.braille.handleChord(h.braille.maskOf(dots));
  type([2, 3, 4, 5]); assert.equal(h.braille.textMode, true); assert.match(h.spoken.at(-1)[0], /typing on/);
  for (const letter of 'read') type(ALPHABET[letter]);
  type([3, 6]); for (const letter of 'thiz') type(ALPHABET[letter]);
  type([4, 5, 6]); type(ALPHABET.s);
  assert.equal(input.value, 'read this'); assert.deepEqual(h.calls, [], 'letters are text, not commands, while typing');
  type([2, 6]); assert.equal(input.value, 'read this', 'an unknown cell types nothing');
  type([1, 2, 3, 4, 5, 6]);
  assert.deepEqual(h.calls, ['submit']); assert.equal(h.braille.textMode, false);
  type([1, 2, 3, 4, 5, 6]); assert.equal(h.calls.at(-1), 'stop', 'outside typing the full cell is Stop again');
});

test('a custom mapping is validated, must keep Stop reachable, and persists', () => {
  const h = harness();
  for (const bad of [null, [], { 64: 'stop' }, { 0: 'stop' }, { 1.5: 'stop' }, { 63: 'format-disk' }, { 1: 'listen' }]) assert.equal(h.braille.setMapping(bad), false, JSON.stringify(bad));
  assert.deepEqual({ ...h.braille.mapping }, { ...h.braille.DEFAULT_MAP });
  assert.equal(h.braille.setMapping({ 63: 'stop', 1: 'describe' }), true);
  assert.equal(h.braille.interpret(1).value, 'describe'); assert.equal(h.braille.interpret(7).type, 'unknown');
  assert.equal(JSON.parse(h.storage.get('astha.braille.map.v1'))[1], 'describe');
  const reloaded = harness(); reloaded.storage.set('astha.braille.map.v1', h.storage.get('astha.braille.map.v1')); reloaded.braille.boot();
  assert.equal(reloaded.braille.interpret(1).value, 'describe');
  reloaded.storage.set('astha.braille.map.v1', '{"1":"listen"}');
  const rejected = harness(); rejected.storage.set('astha.braille.map.v1', '{"1":"listen"}'); rejected.braille.boot();
  assert.equal(rejected.braille.interpret(63).value, 'stop', 'a stored mapping without Stop is ignored');
  h.braille.resetMapping(); assert.equal(h.braille.interpret(7).value, 'listen'); assert.equal(h.storage.has('astha.braille.map.v1'), false);
});

test('keyboard practice turns S D F J K L into chords without hijacking typing or shortcuts', async () => {
  const h = harness(); h.braille.boot();
  assert.equal(h.elements.get('braille-status').textContent, strings.braille_status_off[0]);
  assert.equal(h.elements.get('braille-command-list').children.length, 10);
  assert.match(h.elements.get('braille-command-list').children.at(-1).textContent, /^Dots 1 2 3 4 5 6 — Stop/);
  await h.elements.get('braille-practice').listeners.click();
  assert.equal(h.braille.status, 'practice'); assert.equal(h.elements.get('braille-practice').attributes['aria-pressed'], 'true');
  assert.match(h.spoken.at(-1)[0], /No controller is connected/, 'practice is never described as a connected device');
  h.chord(['f', 'd', 's']); assert.deepEqual(h.calls, ['listen']);
  h.chord(['F', 'J', 'K']); assert.deepEqual(h.calls, ['listen', 'describe'], 'capital letters work with Caps Lock');
  h.key('keydown', 'f', { target: { closest: () => ({}) } }); h.key('keyup', 'f', { target: { closest: () => ({}) } });
  h.key('keydown', 'f', { ctrlKey: true }); h.key('keyup', 'f', { ctrlKey: true });
  h.key('keydown', 'f', { repeat: true }); h.key('keydown', 'x'); h.key('keyup', 'x');
  assert.equal(h.calls.length, 2);
  // Switching window mid-chord releases the keys instead of leaving them held.
  h.key('keydown', 'f'); h.listeners.window.get('blur')(); h.chord(['d']);
  assert.deepEqual(h.calls.slice(2), ['repeat'], 'the abandoned key was entered on its own, not merged into the next chord');
  await h.elements.get('braille-practice').listeners.click();
  assert.equal(h.braille.status, 'off'); assert.equal(h.listeners.document.size, 0);
});

function fakeController() {
  const device = { listeners: {}, connects: 0, failNext: 0,
    addEventListener(name, fn) { this.listeners[name] = fn; }, removeEventListener(name) { delete this.listeners[name]; },
    gatt: { disconnected: 0, disconnect() { this.disconnected++; },
      async connect() { device.connects++; if (device.failNext > 0) { device.failNext--; throw new Error('out of range'); } return { getPrimaryService: async uuid => { device.service = uuid; return { getCharacteristic: async id => { device.characteristicId = id; return device.characteristic; } }; } }; } } };
  device.characteristic = { listeners: {}, started: 0, addEventListener(name, fn) { this.listeners[name] = fn; }, removeEventListener(name) { delete this.listeners[name]; },
    async startNotifications() { this.started++; },
    send(mask) { this.listeners.characteristicvaluechanged({ target: { value: { byteLength: 1, getUint8: () => mask } } }); } };
  return { device, bluetooth: { filters: null, async requestDevice(options) { this.filters = options.filters; return device; } } };
}

test('the planned Bluetooth transport delivers chords, retries a dropped link and reports when it gives up (stand-in device)', async () => {
  const h = harness(), { device, bluetooth } = fakeController();
  assert.equal(await h.braille.start('ble', bluetooth), true);
  assert.equal(h.braille.status, 'connected');
  assert.deepEqual(JSON.parse(JSON.stringify(bluetooth.filters)), [{ services: [h.braille.BLE.service] }]);
  assert.equal(device.characteristicId, h.braille.BLE.keys); assert.equal(device.characteristic.started, 1);
  device.characteristic.send(7); device.characteristic.send(0);
  assert.deepEqual(h.calls, ['listen']);
  // The link drops with keys held: they are released, and reconnection is attempted with backoff.
  device.characteristic.send(1); device.failNext = 1;
  device.listeners.gattserverdisconnected();
  assert.deepEqual(h.calls, ['listen', 'repeat']); assert.equal(h.braille.status, 'reconnecting');
  assert.equal(h.timers.at(-1).ms, 500);
  h.timers.at(-1).fn(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.timers.at(-1).ms, 1000, 'a failed retry backs off');
  h.timers.at(-1).fn(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.braille.status, 'connected');
  assert.deepEqual(h.spoken.map(pair => pair[0]).filter(text => /controller/i.test(text)),
    [strings.braille_status_connecting[0], strings.braille_status_connected[0], strings.braille_status_reconnecting[0], strings.braille_status_connected[0]]);
  // A controller that stays away is reported, not retried forever.
  device.failNext = 99;
  device.listeners.gattserverdisconnected();
  for (let attempt = 0; attempt < h.braille.BLE.retries; attempt++) { h.timers.at(-1).fn(); await new Promise(resolve => setImmediate(resolve)); }
  assert.equal(h.braille.status, 'error');
  h.braille.stop(); assert.equal(device.gatt.disconnected, 1); assert.equal(h.braille.status, 'off');
});

test('without Bluetooth support the controller reports an error instead of pretending to pair', async () => {
  const h = harness();
  assert.equal(await h.braille.start('ble', undefined), false);
  assert.equal(h.braille.status, 'error'); assert.equal(h.spoken.at(-1)[0], strings.braille_status_error[0]);
  assert.equal(await h.braille.start('usb'), false, 'an unknown transport is refused');
});

test('range sensor interface prefers a fresh measurement and labels image guesses as estimates', () => {
  const context = vm.createContext({});
  vm.runInContext(sensorSource + '\nglobalThis.sensors = AsthaSensors;', context);
  const { sensors } = context;
  assert.equal(sensors.connected, false); assert.equal(sensors.measured('front', 1000), null);
  assert.deepEqual({ ...sensors.fuse(2.4, 'front', 1000) }, { metres: 2.4, source: 'image', measured: false });
  assert.equal(sensors.fuse(undefined, 'front', 1000), null, 'no measurement and no estimate means no distance is stated');
  for (const [channel, metres] of [['front', NaN], ['front', -1], ['front', 0.001], ['front', 40], ['Front!', 1], [7, 1]]) assert.equal(sensors.report(channel, metres, 'ultrasonic', 1000), false);
  assert.equal(sensors.report('front', 1.25, 'ultrasonic', 1000), true);
  assert.deepEqual({ ...sensors.fuse(2.4, 'front', 1500) }, { metres: 1.25, source: 'ultrasonic', measured: true });
  assert.equal(sensors.measured('left', 1500), null);
  assert.deepEqual({ ...sensors.fuse(2.4, 'front', 2001) }, { metres: 2.4, source: 'image', measured: false }, 'a stale reading is not reported as current');
  sensors.clear(); assert.equal(sensors.connected, false);
});
