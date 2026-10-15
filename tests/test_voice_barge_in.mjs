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

function harness({ onlineVoice = false, fetchImpl } = {}) {
  let now = 100_000, timerId = 0;
  const timers = new Map(), nodes = new Map(), captions = [], earcons = [], queries = [], announcements = [], saves = [];
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
    pause() {}, resume() {},
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
    privacyMode: false, privacyTransition: false, remoteProcessingAllowed: () => true,
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
    t: key => key, sttLang: () => 'en-US', classifyIntent: () => false,
    playEarcon: name => earcons.push(name), haptic() {}, showHazard() {},
    setCaption: (...values) => captions.push(values), logEvent() {},
    handleQuery: query => queries.push(query),
    announce: (en, bn, kind) => announcements.push({ en, bn, kind }),
    AsthaAgent: { cancel: () => { counts.agent++; } },
    OfflineEar: { active: false, cancel() { counts.offlineEar++; this.active = false; } },
    Seeker: { active: false, stop() { counts.seeker++; this.active = false; } },
    setMode: value => { context.state.shield = value === 'auto'; },
    heartHide() {}, setReadButton() {}, startLiveLoop() {}, heartSet() {}, heartFlash() {},
    captureFrame: () => ({ syntheticFrame: true }), CLOUD_PROMPTS: { vqa: () => 'Synthetic visual question' },
    gemini: () => { throw new Error('unexpected mocked model'); }, autoRecordMemory: value => saves.push(value),
    cloudReady: () => false, $: element,
    document: { hidden: false, body: element('body'), querySelectorAll: () => [], querySelector: selector => element(selector), addEventListener() {} },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} }, I18N: { en: {}, bn: {} },
  });
  context.window = { speechSynthesis: synth, SpeechRecognition: Recognizer, ASTHA_ACCOUNT_ID: 'synthetic-a', ASTHA_LOCAL_ACCOUNT_ID: 'synthetic-a' };
  const realCode = [
    read('tools/experience.js'),
    section(moduleSource, 'const VoiceEchoFilter = {', 'function startReader('),
    section(moduleSource, 'function stopReader()', 'function stopAllSpeech()'),
    section(moduleSource, 'function stopReading(', 'function setReadButton('),
    section(moduleSource, 'function stopListening()', 'function companionBoot('),
    section(moduleSource, 'const STOP_TALKING_REGEX =', 'function toggleHandsFree('),
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
    synth, timers, nodes, captions, earcons, queries, announcements, saves, counts, recognizers, emit, advance, settle };
}

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

test('Stop reading clears actual reader/page work and cancels one-tap, seeker and offline listening without ending hands-free', async () => {
  const h = harness(); h.experience.setContext('reading', true);
  h.context.reader.active = true; h.context.reader.parts = ['Synthetic reader text'];
  h.context.reading.active = true; h.context.reading.phase = 'reading';
  h.context.state.listening = true;
  h.context.recognizer = { abort: () => { h.counts.oneTapAbort++; } };
  h.context.OfflineEar.active = true; h.context.Seeker.active = true;
  h.emit('Astha, stop reading.', false); await h.settle();
  assert.equal(h.experience.mode, 'ask'); assert.equal(h.context.reader.active, false);
  assert.equal(h.context.reader.parts.length, 0); assert.equal(h.context.reading.active, false);
  assert.equal(h.context.reading.phase, 'idle'); assert.equal(h.context.state.listening, false);
  assert.equal(h.counts.oneTapAbort, 1); assert.equal(h.counts.offlineEar, 1); assert.equal(h.counts.seeker, 1);
  await h.advance(12000); assert.equal(h.announcements.length, 0); assert.equal(h.ear.active, true);
  assert.equal(h.ear.rec.aborts, 0); assert.equal(h.queries.length, 0);
});
