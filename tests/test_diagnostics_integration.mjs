// Actual timing helper/UI and detector/reasoning/voice hooks, with a fake monotonic clock.
// The stand-ins never open a real camera, call a provider, play audio or use persistence.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const read = name => fs.readFileSync(new URL('../' + name, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const base = read('tools/base.html'), module = read('tools/module.js'), cloud = read('tools/cloud.js');
const translations = JSON.parse(read('tools/i18n.json')).strings;
function section(source, begin, end) {
  const first = source.indexOf(begin), last = source.indexOf(end, first + begin.length);
  assert(first >= 0 && last > first, 'actual source boundary missing: ' + begin);
  return source.slice(first, last);
}
const functionSource = (source, begin) => section(source, begin, '\n}\n') + '\n}';
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const settle = async () => { for (let count = 0; count < 16; count++) await Promise.resolve(); };
const plain = value => JSON.parse(JSON.stringify(value));

function harness({ onlineVoice = false, language = 'en', native = false } = {}) {
  let now = 100;
  const nodes = new Map(), events = new Map(), timers = new Map(), audio = [], requests = [];
  const calls = { detection: 0, capture: 0, persistence: 0, native: 0, badge: 0 };
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, { open: false, hidden: false, value: '1', textContent: '', events: new Map(),
      setAttribute() {}, classList: { add() {}, remove() {}, toggle() {} },
      addEventListener(name, callback) { this.events.set(name, callback); } });
    return nodes.get(id);
  };
  const synth = {
    current: null, spoken: [], get speaking() { return Boolean(this.current); },
    speak(utterance) { this.current = utterance; this.spoken.push(utterance); },
    cancel() { const previous = this.current; this.current = null; previous?.onerror?.(); },
    finish() { const previous = this.current; this.current = null; previous?.onend?.(); },
    pause() {}, resume() {},
  };
  const i18n = { en: {}, bn: {} };
  for (const [key, value] of Object.entries(translations)) {
    i18n.en[key] = value[0]; i18n.bn[key] = value[1];
  }
  const context = vm.createContext({
    console, Promise, Map, Set, Math, JSON, Object, Array, String, Number, Boolean, RegExp, Error,
    AbortController, AbortSignal, Blob,
    performance: { now: () => now }, Date: class extends Date { static now() { return 100_000 + now; } },
    setTimeout: (fn, ms) => { const id = timers.size + 1; timers.set(id, { fn, ms }); return id; }, clearTimeout: id => timers.delete(id),
    state: { audio: true, source: 'camera', sourceEpoch: 1, world: new Map(), announced: new Map(), lastCocoPreds: [], lastClipHits: [] },
    engine: { coco: { status: 'ready', type: 'yolo26n', model: { detect: (...args) => { calls.detection++; return context.detect(...args); } } } },
    detect: async () => [], COCO_TO_ID: { cup: 'cup' },
    posFromX: () => 'ahead', proxFromArea: () => null,
    reader: { active: false }, reading: { active: false }, OfflineEar: { active: false },
    stopReader() {}, stopListening() {},
    uiLang: language, voiceLang: 'en', I18N: i18n, voices: [{ lang: 'en-US' }], refreshVoices() {},
    remoteProcessingAllowed: () => true, backendReachable: () => onlineVoice, offlineError: () => new Error('synthetic-offline'),
    apiUrl: path => path, deadlineSignal: (_ms, signal) => signal,
    fetch: (url, options) => { requests.push({ url, options }); return context.transport(url, options); },
    transport: async () => { throw new Error('unexpected mock request'); },
    Audio: class {
      constructor(src) { this.src = src; this.paused = true; this.ended = false; audio.push(this); }
      play() { this.paused = false; return Promise.resolve(); }
      pause() { this.paused = true; }
    },
    URL: { createObjectURL: () => 'blob:synthetic', revokeObjectURL() {} },
    makeUtterance: (text, lang) => ({ text, lang }), sanitizeForSpeech: value => value,
    $: node, document: { hidden: false, addEventListener: (name, callback) => events.set(name, callback), querySelectorAll: () => [] },
    localStorage: { getItem() { calls.persistence++; return null; }, setItem() { calls.persistence++; }, removeItem() { calls.persistence++; } },
    captureFrame() { calls.capture++; throw new Error('diagnostics must not capture'); },
    serverCloud: { available: true, checked: true }, cloud: { lastCallAt: 0 },
    frameToJpeg: () => 'synthetic-image', updateCloudBadge() { calls.badge++; },
    showHazard() {}, updateSourceStatus() {}, clearOverlay() {}, renderSeen() {},
    playEarcon() {}, haptic() {}, setCaption() {},
  });
  context.window = { speechSynthesis: native ? null : synth, ASTHA_ACCOUNT_ID: 'synthetic-timing-owner' };
  if (native) context.window.AsthaNative = { canSpeak: true, speak: async () => { calls.native++; return true; }, stopSpeaking() {} };
  vm.runInContext([
    read('tools/diagnostics.js'), functionSource(base, 'function t(key, params)'),
    read('tools/diagnostics-ui.js'),
    section(module, 'const AsthaCancellation = {', 'const VoiceEchoFilter = {'),
    section(module, 'const VoiceEchoFilter = {', 'function startReader('),
    functionSource(base, 'async function runCoco(frame)'), functionSource(base, 'function showSource(kind)'),
    section(cloud, 'async function gemini(', 'function parseJsonLoose('),
    section(read('tools/offline.js'), 'function stopAllSpeech()', '// ---- "Works without internet"'),
    'globalThis.diagnostics=AsthaDiagnostics;globalThis.panel=AsthaDiagnosticsUI;globalThis.voice=VoiceEngine;globalThis.cancellation=AsthaCancellation;',
  ].join('\n'), context);
  context.panel.boot();
  const open = value => { node('vision-debug').open = value; node('vision-debug').events.get('toggle')(); };
  return { context, diagnostics: context.diagnostics, panel: context.panel, voice: context.voice, synth, audio, requests,
    nodes, events, calls, timers, open, at: value => { now = value; }, settle,
    stage: name => plain(context.diagnostics.snapshot().stages[name]),
    detect: () => context.runCoco({ width: 640, height: 480 }),
    reason: () => context.gemini('Synthetic timing question', null),
    hide(value) { context.document.hidden = value; events.get('visibilitychange')(); },
  };
}

test('closed by default: actual detection runs without recording; opening measures detector latency and bilingual rendering', async () => {
  for (const language of ['en', 'bn']) {
    const h = harness({ language });
    assert.equal(h.diagnostics.snapshot().enabled, false);
    await h.detect(); assert.equal(h.stage('perception'), null);
    assert.equal(h.nodes.get('debug-perception').textContent, translations.debug_unmeasured[language === 'bn' ? 1 : 0]);
    const detected = deferred(); h.context.detect = () => detected.promise;
    h.open(true); h.at(120); const pending = h.detect();
    assert.equal(h.nodes.get('debug-perception').textContent, translations.debug_running[language === 'bn' ? 1 : 0]);
    h.at(157); detected.resolve([{ class: 'cup', score: 0.8, bbox: [1, 2, 30, 40] }]);
    const objects = await pending;
    assert.equal(objects[0].id, 'cup'); assert.equal(h.stage('perception').durationMs, 37);
    assert.equal(h.nodes.get('debug-perception').textContent, language === 'bn' ? '37 মিলিসেকেন্ড' : '37 ms');
  }
});

test('actual reasoning timing includes response-body decoding and rejects cancellation without a fabricated duration', async () => {
  const h = harness(), body = deferred(); h.open(true); h.at(200);
  h.context.transport = async () => ({ status: 200, ok: true, json: () => body.promise });
  const pending = h.reason(); await h.settle(); h.at(260);
  assert.equal(h.stage('reasoning').status, 'running'); assert.equal(h.stage('reasoning').durationMs, null);
  h.at(325); body.resolve({ en: 'Synthetic result', bn: 'পরীক্ষা' }); await pending;
  assert.equal(h.stage('reasoning').status, 'success'); assert.equal(h.stage('reasoning').durationMs, 125);
  const ignored = deferred(); h.context.transport = () => ignored.promise; h.at(400);
  const stopped = h.reason(); h.at(412); h.context.stopAllSpeech();
  await assert.rejects(stopped, error => error.cancelled === true);
  assert.equal(h.stage('reasoning').status, 'cancel'); assert.equal(h.stage('reasoning').durationMs, 12);
  ignored.resolve({ status: 200, ok: true, json: async () => ({ en: 'Late' }) }); await h.settle();
  assert.equal(h.stage('reasoning').status, 'cancel');
});

test('browser speech reports success at onstart only; playback end without that event is explicitly unmeasured/error', async () => {
  const h = harness(); h.open(true); h.at(200);
  const first = h.voice.speak('Synthetic browser speech.', 'en'); await h.settle();
  const utterance = h.synth.current; assert(utterance);
  assert.equal(h.stage('speech').status, 'running'); h.at(245); utterance.onstart();
  assert.equal(h.stage('speech').status, 'success'); assert.equal(h.stage('speech').durationMs, 45);
  h.at(900); h.synth.finish(); assert.equal(await first, true);
  assert.equal(h.stage('speech').durationMs, 45, 'playback duration must not replace first-audio latency');
  h.at(1000); const missing = h.voice.speak('No synthetic start event.', 'en'); await h.settle();
  h.at(1600); h.synth.finish(); assert.equal(await missing, true);
  assert.equal(h.stage('speech').status, 'error');
  assert.equal(h.nodes.get('debug-speech').textContent, translations.debug_failed[0]);
});

test('server speech records first audio onplaying, not fetch/blob resolution; native completion is never invented as first audio', async () => {
  const h = harness({ onlineVoice: true }), body = deferred(); h.open(true); h.at(200);
  h.context.transport = async () => ({ ok: true, blob: () => body.promise });
  const pending = h.voice.speak('Synthetic streamed speech.', 'en'); await h.settle();
  h.at(250); assert.equal(h.stage('speech').status, 'running');
  body.resolve(new Blob(['synthetic audio'])); await h.settle();
  assert.equal(h.audio.length, 1); assert.equal(h.stage('speech').status, 'running');
  h.at(280); h.audio[0].onplaying(); assert.equal(h.stage('speech').durationMs, 80);
  h.at(800); h.audio[0].onended(); assert.equal(await pending, true);
  assert.equal(h.stage('speech').status, 'success'); assert.equal(h.stage('speech').durationMs, 80);
  const native = harness({ native: true }); native.open(true);
  assert.equal(await native.voice.speak('Synthetic native speech.', 'en'), true);
  assert.equal(native.calls.native, 1); assert.equal(native.stage('speech').status, 'error');
});

test('Stop cancels speech timing; old playback events and completion cannot replace a newer measurement', async () => {
  const h = harness(); h.open(true); h.at(200);
  const old = h.voice.speak('Old synthetic sentence.', 'en'); await h.settle(); const previous = h.synth.current;
  h.at(215); h.context.stopAllSpeech(); assert.equal(await old, false);
  assert.equal(h.stage('speech').status, 'cancel'); assert.equal(h.stage('speech').durationMs, 15);
  h.at(240); const recent = h.voice.speak('New synthetic sentence.', 'en'); await h.settle(); const current = h.synth.current;
  previous.onstart(); previous.onend(); await h.settle();
  assert.equal(h.stage('speech').status, 'running');
  h.at(268); current.onstart(); assert.equal(h.stage('speech').status, 'success'); assert.equal(h.stage('speech').durationMs, 28);
  h.synth.finish(); assert.equal(await recent, true);
  previous.onstart(); previous.onerror(); assert.equal(h.stage('speech').durationMs, 28);
});

test('real source changes, reset, close and hidden lifecycle invalidate late measurements without starting work', async () => {
  for (const boundary of ['source', 'reset', 'close', 'hide', 'clear']) {
    const h = harness(), detected = deferred(); h.open(true); h.at(200);
    h.context.detect = () => detected.promise; const pending = h.detect();
    const before = { detection: h.calls.detection, requests: h.requests.length, capture: h.calls.capture };
    if (boundary === 'source') h.context.showSource('photo');
    if (boundary === 'reset') h.diagnostics.reset();
    if (boundary === 'close') h.open(false);
    if (boundary === 'hide') h.hide(true);
    if (boundary === 'clear') h.panel.clear();
    h.at(250); detected.resolve([]); await pending;
    assert.equal(h.stage('perception'), null, boundary);
    assert.deepEqual({ detection: h.calls.detection, requests: h.requests.length, capture: h.calls.capture }, before, boundary);
    assert.equal(h.calls.persistence, 0, boundary);
    if (boundary === 'close' || boundary === 'hide' || boundary === 'clear') assert.equal(h.diagnostics.snapshot().enabled, false, boundary);
  }
  const h = harness(); h.open(true); h.open(false); h.hide(true); h.hide(false); h.panel.clear();
  assert.equal(h.calls.detection, 0); assert.equal(h.requests.length, 0); assert.equal(h.calls.capture, 0); assert.equal(h.calls.persistence, 0);
  assert.equal(Object.values(h.diagnostics.snapshot().stages).every(value => value === null), true);
});
