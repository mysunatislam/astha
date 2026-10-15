// Real recognizer dispatch, echo filter, voice engine, visual-task predicate and final
// Stop implementation run together. Speech/network/model/timers are recording stand-ins.
// These checks establish event handling, not separation of human speech from acoustic echo.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const read = file => fs.readFileSync(new URL('../' + file, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const moduleSource = read('tools/module.js'), offlineSource = read('tools/offline.js'), cloudSource = read('tools/cloud.js');
function section(source, first, last) {
  const start = source.indexOf(first), end = source.indexOf(last, start + first.length);
  assert(start >= 0 && end > start, 'real source boundary missing: ' + first);
  return source.slice(start, end);
}
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const settle = async () => { for (let index = 0; index < 16; index++) await Promise.resolve(); };

function harness({ onlineVoice = false, fetchImpl, finalRuntime = false } = {}) {
  let now = 100_000, timerId = 0;
  const timers = new Map(), nodes = new Map(), captions = [], earcons = [], queries = [], announcements = [], saves = [], fallbacks = [];
  const documentListeners = new Map(), windowListeners = new Map();
  const register = (listeners, name, callback) => {
    if (!listeners.has(name)) listeners.set(name, []);
    listeners.get(name).push(callback);
  };
  const counts = { agent: 0, offlineEar: 0, seeker: 0, oneTapAbort: 0, audioCreated: 0, audioPlayed: 0 };
  const synth = {
    current: null, spoken: [], cancelled: [],
    get speaking() { return Boolean(this.current); },
    speak(utterance) { this.current = utterance; this.spoken.push(utterance); },
    cancel() {
      const previous = this.current; this.current = null;
      if (previous) { this.cancelled.push(previous.text); previous.onerror?.(); }
    },
    finish() { const previous = this.current; this.current = null; previous?.onend?.(); },
    pause() {}, resume() {}, addEventListener() {},
  };
  const recognizers = [];
  class Recognizer {
    constructor() { this.starts = 0; this.aborts = 0; recognizers.push(this); }
    start() { this.starts++; }
    abort() { this.aborts++; }
    emit(transcript, final = false) {
      const result = [{ transcript }]; result.isFinal = final;
      this.onresult({ resultIndex: 0, results: [result] });
    }
  }
  const element = id => {
    if (!nodes.has(id)) nodes.set(id, { value: '1', textContent: '', hidden: true, setAttribute() {},
      addEventListener() {}, focus() {}, classList: { add() {}, remove() {}, toggle() {} } });
    return nodes.get(id);
  };
  const context = vm.createContext({
    console, Promise, Map, Set, Math, JSON, Object, Array, String, Number, Boolean, RegExp, Error,
    AbortController, AbortSignal, Blob,
    Date: class extends Date { static now() { return now; } },
    setTimeout(fn, ms) { const id = ++timerId; timers.set(id, { fn, at: now + ms, ms }); return id; },
    clearTimeout: id => timers.delete(id),
    state: { audio: true, source: 'camera', sourceEpoch: 1, shield: false, busy: false, listening: false, pendingAction: { synthetic: true } },
    reader: { active: false, paused: false, generation: 0, parts: [], index: 0 },
    reading: { active: false, phase: 'idle', timer: null }, recognizer: null, listenTimer: null,
    uiLang: 'en', voiceLang: 'en', voices: [{ lang: 'en-US' }, { lang: 'bn-BD' }], refreshVoices() {},
    privacyMode: false, privacyTransition: false, remoteAllowed: true, navigator: { onLine: true },
    remoteProcessingAllowed: () => context.remoteAllowed && !context.privacyMode && !context.privacyTransition,
    backendReachable: () => onlineVoice, offlineError: () => new Error('synthetic-offline'),
    apiUrl: path => path, deadlineSignal: (_ms, signal) => signal,
    fetch: fetchImpl || (() => { throw new Error('unexpected mocked fetch'); }),
    Audio: class {
      constructor(src) { this.src = src; this.paused = true; this.ended = false; counts.audioCreated++; }
      play() { counts.audioPlayed++; this.paused = false; return Promise.resolve(); }
      pause() { this.paused = true; }
    },
    URL: { createObjectURL: () => 'blob:synthetic', revokeObjectURL() {} },
    makeUtterance: (text, lang) => ({ text, lang, rate: 1 }), sanitizeForSpeech: text => text,
    t: key => key, sttLang: () => 'en-US', classifyIntent: () => false, populateVoices() {},
    playEarcon: name => earcons.push(name), haptic() {}, showHazard() {},
    setCaption: (...values) => captions.push(values), logEvent() {},
    handleQuery: query => queries.push(query),
    announce: (en, bn, kind) => announcements.push({ en, bn, kind }),
    AsthaAgent: { cancel: () => { counts.agent++; } },
    OfflineEar: { active: false, wanted: () => false,
      listenAndHandle(reason) { fallbacks.push(reason); this.active = true; },
      cancel() { counts.offlineEar++; this.active = false; } },
    Seeker: { active: false, stop() { counts.seeker++; this.active = false; } },
    setMode: value => { context.state.shield = value === 'auto'; },
    heartHide() {}, setReadButton() {}, startLiveLoop() {}, heartSet() {}, heartFlash() {},
    captureFrame: () => ({ syntheticFrame: true }), CLOUD_PROMPTS: { vqa: () => 'Synthetic visual question' },
    gemini: () => { throw new Error('unexpected mocked model'); }, autoRecordMemory: value => saves.push(value),
    cloudReady: () => false, $: element,
    document: { hidden: false, body: element('body'), querySelectorAll: () => [], querySelector: selector => element(selector),
      addEventListener: (name, callback) => register(documentListeners, name, callback) },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} }, I18N: { en: {}, bn: {} },
  });
  context.window = { speechSynthesis: synth, SpeechRecognition: Recognizer, ASTHA_ACCOUNT_ID: 'synthetic-a', ASTHA_LOCAL_ACCOUNT_ID: 'synthetic-a',
    addEventListener: (name, callback) => register(windowListeners, name, callback) };
  const realCode = [
    read('tools/experience.js'),
    section(moduleSource, 'const VoiceEchoFilter = {', 'function startReader('),
    section(moduleSource, 'function stopReader()', 'function stopAllSpeech()'),
    section(moduleSource, 'function stopReading(', 'function setReadButton('),
    section(moduleSource, 'let listenTimer = null;', 'function companionBoot('),
    section(moduleSource, 'function companionBoot()', '/* =====================================================================\n   17. Server-backed memory'),
    section(moduleSource, 'const STOP_TALKING_REGEX =', 'function toggleHandsFree('),
    ...(finalRuntime ? [section(offlineSource, 'function toggleListening()', 'function stopAllSpeech()')] : []),
    section(offlineSource, 'function stopAllSpeech()', '// ---- "Works without internet"'),
    section(cloudSource, 'async function cloudVisualQA(', '// Live Video Walkthrough Room Calibration'),
    'globalThis.engine = VoiceEngine; globalThis.ear = SiriVoice; globalThis.experience = AsthaExperience; globalThis.echo = VoiceEchoFilter;',
  ].join('\n');
  vm.runInContext(realCode, context);
  context.ear.enabled = true; context.ear.start();
  const emit = (text, final = false) => context.ear.rec.emit(text, final);
  async function advance(ms) {
    now += ms;
    for (let index = 0; index < 100; index++) {
      const next = [...timers].find(([, timer]) => timer.at <= now); if (!next) break;
      timers.delete(next[0]); next[1].fn(); await settle();
    }
  }
  return { context, engine: context.engine, experience: context.experience, ear: context.ear, echo: context.echo,
    synth, timers, nodes, captions, earcons, queries, announcements, saves, fallbacks, counts, recognizers, emit, advance, settle,
    bootCompanion: () => context.companionBoot(),
    fireDocument: name => { for (const callback of documentListeners.get(name) || []) callback(); },
    fireWindow: name => { for (const callback of windowListeners.get(name) || []) callback(); } };
}

function speechEvent(transcript, final = true) {
  const result = [{ transcript }]; result.isFinal = final;
  return { resultIndex: 0, results: [result] };
}

test('a current final hands-free request dispatches once after the user finishes speaking', async () => {
  const h = harness();
  h.emit('Astha, where is my synthetic charger?', true);
  assert.deepEqual(h.queries, []);
  await h.advance(1100);
  assert.deepEqual(h.queries, ['where is my synthetic charger?']);
  await h.advance(5000);
  assert.deepEqual(h.queries, ['where is my synthetic charger?']);
  assert.equal(h.ear.active, true);
});

test('a legitimate hands-free final survives the recognizer natural end and restart', async () => {
  const h = harness(), previous = h.ear.rec;
  h.emit('Astha, where is my synthetic charger?', true);
  previous.onend();
  await h.advance(300);
  assert.notEqual(h.ear.rec, previous);
  assert.deepEqual(h.queries, []);
  await h.advance(800);
  assert.deepEqual(h.queries, ['where is my synthetic charger?']);
  await h.advance(5000);
  assert.deepEqual(h.queries, ['where is my synthetic charger?']);
});

test('a queued recognition result cannot dispatch or Stop after listening was stopped or opted out', async () => {
  for (const boundary of ['stopped', 'opted-out', 'privacy', 'offline']) {
    const h = harness(), previous = h.ear.rec, result = previous.onresult;
    if (boundary === 'opted-out') h.ear.enabled = false;
    if (boundary === 'privacy') h.context.privacyMode = true;
    if (boundary === 'offline') h.context.remoteAllowed = false;
    h.ear.stop(true);
    const before = { captions: h.captions.length, earcons: h.earcons.length, cancellations: h.counts.agent };
    result(speechEvent('Astha, where is my synthetic charger?'));
    result(speechEvent('Stop', false));
    await h.advance(20000);
    assert.deepEqual(h.queries, [], boundary);
    assert.equal(h.counts.agent, before.cancellations, boundary);
    assert.equal(h.captions.length, before.captions, boundary);
    assert.equal(h.earcons.length, before.earcons, boundary);
    assert.equal(h.recognizers.length, 1, boundary);
    assert.equal(previous.aborts, 1, boundary);
    assert.equal(h.ear.active, false, boundary);
  }
});

test('revoking consent or hiding the page suppresses results even before an old event reaches the stop listener', async () => {
  for (const boundary of ['privacy', 'offline', 'hidden']) {
    const h = harness(), result = h.ear.rec.onresult;
    if (boundary === 'privacy') h.context.privacyMode = true;
    if (boundary === 'offline') h.context.remoteAllowed = false;
    if (boundary === 'hidden') h.context.document.hidden = true;
    result(speechEvent('Astha, where is my synthetic charger?'));
    result(speechEvent('Stop', false));
    await h.advance(20000);
    assert.deepEqual(h.queries, [], boundary);
    assert.equal(h.counts.agent, 0, boundary);
    assert.equal(h.recognizers.length, 1, boundary);
  }
});

test('old recognition results and endings cannot interrupt or detach a replacement listening session', async () => {
  const h = harness(), old = h.ear.rec;
  const oldResult = old.onresult, oldEnd = old.onend, oldError = old.onerror;
  h.ear.stop(true); h.ear.start();
  const current = h.ear.rec;
  assert.notEqual(current, old);
  const pendingSpeech = h.engine.speak('A new synthetic answer.', 'en');
  oldResult(speechEvent('Stop', false));
  oldResult(speechEvent('Where is my old synthetic charger?'));
  oldEnd(); oldError({ error: 'not-allowed' });
  await h.advance(20000);
  assert.equal(h.ear.rec, current);
  assert.equal(h.ear.active, true);
  assert.equal(current.aborts, 0);
  assert.equal(h.recognizers.length, 2);
  assert.equal(h.counts.agent, 0);
  assert.deepEqual(h.queries, []);
  assert.equal(h.synth.current?.text, 'A new synthetic answer.');
  h.engine.stop(true); assert.equal(await pendingSpeech, false);
});

test('an already queued debounce cannot consume a new session request after Stop and restart', async () => {
  const h = harness();
  h.emit('Where is my previous synthetic charger?', true);
  const queued = [...h.timers.values()].map(timer => timer.fn);
  assert(queued.length > 0);
  h.ear.stop(true); h.ear.start();
  h.emit('Where is my current synthetic charger?', true);
  for (const callback of queued) callback();
  await h.settle();
  assert.deepEqual(h.queries, []);
  await h.advance(1100);
  assert.deepEqual(h.queries, ['Where is my current synthetic charger?']);
});

test('an already queued recognizer restart cannot replace a newer active microphone', async () => {
  const h = harness(), old = h.ear.rec;
  old.onend();
  const queued = [...h.timers.values()].map(timer => timer.fn);
  assert(queued.length > 0);
  h.ear.stop(true); h.ear.start();
  const current = h.ear.rec;
  for (const callback of queued) callback();
  await h.advance(5000);
  assert.equal(h.ear.rec, current);
  assert.equal(current.aborts, 0);
  assert.equal(h.recognizers.length, 2);
});

test('consent renewed after an opt-out cannot revive an already queued result or restart', async () => {
  const h = harness(), old = h.ear.rec, result = old.onresult;
  old.onend();
  const queued = [...h.timers.values()].map(timer => timer.fn);
  h.context.remoteAllowed = false; h.ear.enabled = false; h.ear.stop(true);
  h.context.remoteAllowed = true; h.ear.enabled = true; h.ear.start();
  const current = h.ear.rec;
  result(speechEvent('Where is my expired synthetic charger?'));
  for (const callback of queued) callback();
  await h.advance(20000);
  assert.deepEqual(h.queries, []);
  assert.equal(h.ear.rec, current);
  assert.equal(current.aborts, 0);
  assert.equal(h.recognizers.length, 2);
});

test('microphone permission denial stops listening accessibly without a restart loop', async () => {
  for (const error of ['not-allowed', 'service-not-allowed']) {
    const h = harness(), current = h.ear.rec, previousCaptions = h.captions.length, previousAnnouncements = h.announcements.length;
    current.onerror({ error });
    assert.equal(h.ear.active, false, error);
    assert.equal(h.ear.rec, null, error);
    assert.equal(current.aborts, 1, error);
    const caption = h.captions.length > previousCaptions && h.captions.at(-1).some(value => typeof value === 'string' && value.trim());
    const spoken = h.announcements.length > previousAnnouncements &&
      Boolean(h.announcements.at(-1).en?.trim()) && Boolean(h.announcements.at(-1).bn?.trim());
    assert(caption || spoken, error);
    await h.advance(20000);
    assert.equal(h.recognizers.length, 1, error);
    assert.deepEqual(h.queries, [], error);
  }
});

test('a current one-tap final request dispatches once and releases its microphone', async () => {
  const h = harness(); h.context.toggleListening();
  const current = h.context.recognizer;
  assert.equal(h.context.state.listening, true);
  assert.equal(h.ear.active, false);
  current.emit('Where is my current synthetic charger?', true);
  await h.advance(2200);
  assert.deepEqual(h.queries, ['Where is my current synthetic charger?']);
  assert.equal(h.context.state.listening, false);
  assert.equal(current.aborts, 1);
  await h.advance(5000);
  assert.deepEqual(h.queries, ['Where is my current synthetic charger?']);
});

test('one-tap callbacks from before Stop cannot dispatch or clear a newer listening session', async () => {
  const h = harness(); h.context.toggleListening();
  const previous = h.context.recognizer, oldResult = previous.onresult, oldEnd = previous.onend, oldError = previous.onerror;
  previous.emit('Where is my old synthetic charger?', true);
  const queued = [...h.timers.values()].map(timer => timer.fn);
  h.context.stopListening(); h.context.toggleListening();
  const current = h.context.recognizer;
  const before = { captions: h.captions.length, announcements: h.announcements.length };
  oldResult(speechEvent('Where is my expired synthetic charger?')); oldEnd(); oldError({ error: 'not-allowed' });
  for (const callback of queued) callback();
  await h.settle();
  assert.equal(h.context.recognizer, current);
  assert.equal(h.context.state.listening, true);
  assert.equal(current.aborts, 0);
  assert.equal(h.captions.length, before.captions);
  assert.equal(h.announcements.length, before.announcements);
  assert.deepEqual(h.queries, []);
  current.emit('Where is my current synthetic charger?', true);
  await h.advance(2200);
  assert.deepEqual(h.queries, ['Where is my current synthetic charger?']);
  assert.equal(current.aborts, 1);
});

test('a queued one-tap finish cannot consume a new request or reopen continuous listening', async () => {
  const h = harness(); h.context.toggleListening();
  h.context.recognizer.emit('Where is my previous synthetic charger?', true);
  const queued = [...h.timers.values()].map(timer => timer.fn);
  h.context.stopListening(); h.context.toggleListening();
  const current = h.context.recognizer;
  current.emit('Where is my current synthetic charger?', true);
  for (const callback of queued) callback();
  await h.advance(200);
  assert.equal(h.context.recognizer, current);
  assert.equal(h.context.state.listening, true);
  assert.equal(h.ear.active, false);
  assert.equal(current.aborts, 0);
  assert.deepEqual(h.queries, []);
  await h.advance(2000);
  assert.deepEqual(h.queries, ['Where is my current synthetic charger?']);
});

test('one-tap results and natural endings cannot dispatch after consent is revoked or the page hides', async () => {
  for (const boundary of ['privacy', 'offline', 'hidden']) {
    const h = harness(); h.context.toggleListening();
    const current = h.context.recognizer, result = current.onresult, ended = current.onend;
    if (boundary === 'privacy') h.context.privacyMode = true;
    if (boundary === 'offline') h.context.remoteAllowed = false;
    if (boundary === 'hidden') h.context.document.hidden = true;
    result(speechEvent('Where is my expired synthetic charger?')); ended();
    await h.advance(20000);
    assert.deepEqual(h.queries, [], boundary);
    assert.equal(h.ear.active, false, boundary);
  }
});

test('the final shipped browser one-tap override dispatches a current final request once', async () => {
  const h = harness({ finalRuntime: true }); h.context.toggleListening();
  const current = h.context.recognizer;
  assert(current, 'exercise the browser branch of the final offline override');
  current.emit('Where is my current synthetic charger?', true);
  await h.advance(2200);
  assert.deepEqual(h.queries, ['Where is my current synthetic charger?']);
  assert.equal(current.aborts, 1);
  assert.equal(h.context.state.listening, false);
  assert.deepEqual(h.fallbacks, []);
});

test('final shipped one-tap stale callbacks and network errors cannot replace a newer request or start Whisper', async () => {
  const h = harness({ finalRuntime: true }); h.context.toggleListening();
  const previous = h.context.recognizer, result = previous.onresult, ended = previous.onend, error = previous.onerror;
  previous.emit('Where is my previous synthetic charger?', true);
  const queued = [...h.timers.values()].map(timer => timer.fn);
  h.context.stopListening(); h.context.toggleListening();
  const current = h.context.recognizer;
  const before = { captions: h.captions.length, announcements: h.announcements.length };
  result(speechEvent('Where is my expired synthetic charger?')); ended();
  error({ error: 'network' }); error({ error: 'service-not-allowed' });
  for (const callback of queued) callback();
  await h.advance(200);
  assert.equal(h.context.recognizer, current);
  assert.equal(h.context.state.listening, true);
  assert.equal(current.aborts, 0);
  assert.equal(h.ear.active, false);
  assert.equal(h.captions.length, before.captions);
  assert.equal(h.announcements.length, before.announcements);
  assert.deepEqual(h.queries, []); assert.deepEqual(h.fallbacks, []);
  current.emit('Where is my current synthetic charger?', true);
  await h.advance(2200);
  assert.deepEqual(h.queries, ['Where is my current synthetic charger?']);
  assert.deepEqual(h.fallbacks, []);
});

test('the final shipped one-tap override retains the intentional current network to Whisper handoff', async () => {
  const h = harness({ finalRuntime: true }); h.context.toggleListening();
  const current = h.context.recognizer, error = current.onerror;
  error({ error: 'network' });
  assert.equal(h.context.state.listening, false);
  assert.equal(h.context.recognizer, null);
  assert.equal(current.aborts, 1);
  assert.deepEqual(h.fallbacks, ['network']);
  error({ error: 'network' });
  await h.advance(5000);
  assert.deepEqual(h.fallbacks, ['network']);
  assert.deepEqual(h.queries, []);
});

test('final shipped one-tap late results and network errors stay inert after privacy, offline or hidden boundaries', async () => {
  for (const boundary of ['privacy', 'offline', 'hidden']) {
    const h = harness({ finalRuntime: true }); h.context.toggleListening();
    const current = h.context.recognizer, result = current.onresult, ended = current.onend, error = current.onerror;
    if (boundary === 'privacy') h.context.privacyMode = true;
    if (boundary === 'offline') h.context.remoteAllowed = false;
    if (boundary === 'hidden') h.context.document.hidden = true;
    result(speechEvent('Where is my expired synthetic charger?')); error({ error: 'network' }); ended();
    await h.advance(20000);
    assert.deepEqual(h.queries, [], boundary);
    assert.deepEqual(h.fallbacks, [], boundary);
    assert.equal(h.ear.active, false, boundary);
  }
});

test('background lifecycle stops the final shipped one-tap recognizer and rejects delayed fallback work', async () => {
  const h = harness({ finalRuntime: true }); h.bootCompanion(); h.context.toggleListening();
  const current = h.context.recognizer, result = current.onresult, error = current.onerror;
  h.context.document.hidden = true; h.fireDocument('visibilitychange');
  assert.equal(current.aborts, 1);
  assert.equal(h.context.state.listening, false);
  assert.equal(h.ear.active, false);
  result(speechEvent('Where is my hidden synthetic charger?')); error({ error: 'network' });
  h.context.document.hidden = false; h.fireDocument('visibilitychange');
  await h.advance(20000);
  assert.deepEqual(h.queries, []); assert.deepEqual(h.fallbacks, []);
  assert.equal(h.recognizers.length, 2);
});

test('background lifecycle events stop the foreground microphone and returning alone does not reopen it', async () => {
  for (const event of ['visibilitychange', 'pagehide']) {
    const h = harness(), current = h.ear.rec, oldResult = current.onresult;
    h.bootCompanion();
    if (event === 'visibilitychange') { h.context.document.hidden = true; h.fireDocument(event); }
    else h.fireWindow(event);
    assert.equal(h.ear.active, false, event);
    assert.equal(current.aborts, 1, event);
    oldResult(speechEvent('Where is my hidden synthetic charger?'));
    h.context.document.hidden = false; h.fireDocument('visibilitychange');
    await h.advance(20000);
    assert.equal(h.recognizers.length, 1, event);
    assert.deepEqual(h.queries, [], event);
  }
});

test('interim Stop aborts a pending server voice request and ignores its late response without fallback audio', async () => {
  const response = deferred(), requests = [];
  const h = harness({ onlineVoice: true, fetchImpl: (_path, options) => { requests.push(options); return response.promise; } });
  const pending = h.engine.speak('The synthetic answer has not reached the speaker.', 'en');
  assert.equal(requests.length, 1); assert.equal(requests[0].signal.aborted, false);
  assert.equal(h.engine.speaking, false, 'Stop must work before playback has started');
  h.emit('Stop', false);
  assert.equal(requests[0].signal.aborted, true); assert.equal(h.counts.agent, 1);
  response.resolve({ ok: true, blob: async () => new Blob(['synthetic audio']) });
  assert.equal(await pending, false); await h.settle();
  assert.equal(h.counts.audioCreated, 0); assert.equal(h.synth.spoken.length, 0);
  assert.equal(h.ear.active, true); assert.equal(h.ear.rec.aborts, 0);
});

test('Stop while a server voice body is pending cannot start late playback or a device fallback', async () => {
  const body = deferred(); let signal;
  const h = harness({ onlineVoice: true, fetchImpl: async (_path, options) => { signal = options.signal; return { ok: true, blob: () => body.promise }; } });
  const pending = h.engine.speak('Synthetic server voice body.', 'en'); await h.settle();
  assert(signal && !signal.aborted);
  h.emit('Astha, stop talking!', false); assert.equal(signal.aborted, true);
  body.resolve(new Blob(['late synthetic audio']));
  assert.equal(await pending, false); assert.equal(h.counts.audioPlayed, 0); assert.equal(h.synth.spoken.length, 0);
});

test('an explicit interim Stop outranks echo matching, ends a critical alert and drops its waiting answer', async () => {
  const h = harness(); h.experience.setContext('road', true);
  h.engine.emergencyAlert('Stop! Drop-off ahead!', '', 'drop_off');
  assert.equal(h.echo.isMachineEcho('Stop'), true, 'exercise the real heuristic conflict');
  const waiting = h.engine.speak('An ordinary synthetic answer queued behind the alert.', 'en'); await h.settle();
  assert.equal(h.synth.current.text, 'Stop! Drop-off ahead!');
  h.emit('Stop', false); assert.equal(await waiting, false); await h.settle();
  assert.equal(h.synth.current, null); assert.equal(h.engine.criticalUntil, 0);
  assert.deepEqual(h.synth.spoken.map(value => value.text), ['Stop! Drop-off ahead!']);
  assert.equal(h.counts.agent, 1); assert.equal(h.experience.allows('medium'), false);
  await h.advance(6000); assert.equal(h.synth.current, null, 'late alert-end timer must not revive speech');
});

test('Stop invalidates the actual visual-task predicate before a late model answer can announce or save', async () => {
  const h = harness(), model = deferred(); h.context.state.audio = false;
  h.context.gemini = () => model.promise;
  let current;
  const pending = h.experience.visualTask('Can you see my synthetic pen?', predicate => {
    current = predicate; return h.context.cloudVisualQA('Can you see my synthetic pen?', { currentFrame: true }, '', predicate);
  });
  assert.equal(current(), true); assert.equal(h.experience.busy, true);
  h.emit('আস্থা, থামো।', false); assert.equal(current(), false);
  model.resolve({ en: 'Late synthetic pen on a desk.', bn: 'পুরনো পরীক্ষামূলক উত্তর', found: true,
    item: 'synthetic pen', surface: 'synthetic desk', room_hint: 'synthetic room' });
  assert.equal(await pending, null); assert.equal(h.experience.busy, false);
  assert.equal(h.announcements.length, 0); assert.equal(h.saves.length, 0); assert.equal(h.counts.agent, 1);
});

test('the repeated final Stop and delayed fragments are discarded while the continuous listener remains usable', async () => {
  const h = harness(); const recognizer = h.ear.rec;
  h.emit('Where is the synthetic charger?', true);
  assert.equal(h.ear.pendingSpeech, 'Where is the synthetic charger?');
  h.emit('Stop', false); h.emit('Stop', true); h.emit('talking', true);
  assert.equal(h.counts.agent, 1); assert.equal(h.ear.pendingSpeech, '');
  assert.equal(h.captions.filter(value => value[1] === 'Stopped speech.').length, 1);
  await h.advance(1100); assert.deepEqual(h.queries, []);
  assert.equal(h.ear.active, true); assert.equal(h.ear.enabled, true); assert.equal(h.ear.rec, recognizer); assert.equal(recognizer.aborts, 0);
  await h.advance(101); h.emit('Where is my synthetic charger now?', true); await h.advance(1100);
  assert.deepEqual(h.queries, ['Where is my synthetic charger now?']);
});

test('sentences mentioning stops or quoted instructions never cancel the active alert', async () => {
  for (const words of ['Stop! Drop-off ahead!', 'The bus stop is on your left.', 'Read the stop button label.',
    'The instructions say stop talking before recording.', 'Please do not stop talking yet.', 'বাস স্টপ কোথায়?']) {
    const h = harness(); h.experience.setContext('road', true);
    h.engine.emergencyAlert('Stop! Drop-off ahead!', '', 'drop_off');
    const active = h.synth.current;
    h.emit(words, false); h.emit(words, true); await h.settle();
    assert.equal(h.synth.current, active, words); assert.equal(h.counts.agent, 0, words);
    assert.equal(h.engine.criticalUntil > 0, true, words);
  }
});

test('whole English and Bangla Stop commands with wake words or curly apostrophes cancel immediately', () => {
  for (const words of ['Stop.', 'Astha, stop!', 'Hey Astha, stop speaking please.', "don't talk", 'don’t speak',
    "Astha, don't talk.", 'আস্থা, থামো।', 'হেই আস্থা, চুপ করো!', 'আস্থা, কথা বন্ধ।']) {
    const h = harness(); h.emit(words, false);
    assert.equal(h.counts.agent, 1, words); assert.equal(h.context.state.pendingAction, null, words);
    assert.equal(h.captions.at(-1)[1], 'Stopped speech.', words); assert.equal(h.ear.active, true, words);
  }
});

test('spoken Stop reading clears reader/page and seeker without ending the active hands-free listener', async () => {
  const h = harness(); h.experience.setContext('reading', true);
  h.context.reader.active = true; h.context.reader.parts = ['Synthetic reader text'];
  h.context.reading.active = true; h.context.reading.phase = 'reading';
  // A real offline microphone pauses hands-free first; do not simulate both active.
  h.context.Seeker.active = true;
  h.emit('Astha, stop reading.', false); await h.settle();
  assert.equal(h.experience.mode, 'ask'); assert.equal(h.context.reader.active, false);
  assert.equal(h.context.reader.parts.length, 0); assert.equal(h.context.reading.active, false);
  assert.equal(h.context.reading.phase, 'idle'); assert.equal(h.context.state.listening, false);
  assert.equal(h.counts.offlineEar, 0); assert.equal(h.counts.seeker, 1);
  await h.advance(12000); assert.equal(h.announcements.length, 0); assert.equal(h.ear.active, true);
  assert.equal(h.ear.rec.aborts, 0); assert.equal(h.queries.length, 0);
});

test('the Stop control cancels the offline microphone while hands-free is paused', () => {
  const h = harness(); h.ear.stop(true);
  h.context.OfflineEar.active = true;
  h.context.stopAllSpeech();
  assert.equal(h.counts.offlineEar, 1);
  assert.equal(h.context.OfflineEar.active, false);
});

test('the Stop control aborts an actual one-tap recognizer and drops its queued answer', async () => {
  const h = harness(); h.context.toggleListening();
  const current = h.context.recognizer, oldResult = current.onresult;
  current.emit('Where is my previous synthetic charger?', true);
  h.context.stopAllSpeech();
  assert.equal(h.context.state.listening, false);
  assert.equal(current.aborts, 1);
  oldResult(speechEvent('Where is my canceled synthetic charger?'));
  await h.advance(20000);
  assert.deepEqual(h.queries, []);
  assert.equal(h.context.recognizer, null);
});
