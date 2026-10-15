// Real OfflineEar control flow with synthetic microphone samples and deferred work.
// These checks cover request ownership, not actual microphone or Whisper accuracy.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../tools/offline.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const start = source.indexOf('const OfflineEar = {'), end = source.indexOf('// One-tap listening:', start);
assert(start >= 0 && end > start, 'real OfflineEar source boundary is required');
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const settle = async () => { for (let index = 0; index < 20; index++) await Promise.resolve(); };
const audio = () => ({ speech: true, data: new Float32Array([0.1, 0.2]), ms: 500 });

function harness() {
  let now = 100_000, timerId = 0;
  const queries = [], announcements = [], captions = [], events = [], timers = new Map(), nodes = new Map();
  const permissions = [], streams = [], contexts = [], processors = [];
  const element = id => {
    if (!nodes.has(id)) {
      const classes = new Set(), attributes = new Map();
      nodes.set(id, { textContent: '', attributes, classes,
        setAttribute: (name, value) => attributes.set(name, value),
        classList: { add: name => classes.add(name), remove: name => classes.delete(name) } });
    }
    return nodes.get(id);
  };
  class AudioContext {
    constructor() { this.sampleRate = 16000; this.state = 'running'; this.destination = {}; this.closed = 0; contexts.push(this); }
    createMediaStreamSource(stream) {
      return { connect() { events.push('source connected'); }, disconnect() { events.push('source disconnected'); }, stream };
    }
    createScriptProcessor() {
      const processor = { connect() { events.push('processor connected'); }, disconnect() { events.push('processor disconnected'); }, onaudioprocess: null };
      processors.push(processor); return processor;
    }
    close() { this.closed++; this.state = 'closed'; return Promise.resolve(); }
    resume() { return Promise.resolve(); }
  }
  const context = vm.createContext({
    console: { warn() {}, log() {}, error() {} }, Promise, Float32Array, Array, Math, Number, Object, String,
    Date: class extends Date { static now() { return now; } },
    setTimeout(fn, ms) { const id = ++timerId; timers.set(id, { fn, at: now + ms }); return id; },
    clearTimeout: id => timers.delete(id),
    navigator: { onLine: true, mediaDevices: { getUserMedia() { const pending = deferred(); permissions.push(pending); return pending.promise; } } },
    window: { AudioContext, ASTHA_ACCOUNT_ID: 'synthetic-account-a', ASTHA_LOCAL_ACCOUNT_ID: 'synthetic-account-a', addEventListener() {} },
    document: { hidden: false, addEventListener() {} },
    engine: { ear: { status: 'ready' }, clip: {} },
    state: { listening: false, source: 'camera', sourceEpoch: 1 },
    privacyMode: false, privacyTransition: false, remoteAllowed: true,
    remoteProcessingAllowed: () => context.remoteAllowed && !context.privacyMode && !context.privacyTransition,
    localStorage: { getItem: () => null }, sttLang: () => 'en-US',
    setEngineState: (key, status) => { context.engine[key].status = status; }, setProgress() {},
    t: key => key, $: element, logEvent: message => events.push(message),
    setCaption: (...values) => captions.push(values), announce: (...values) => announcements.push(values),
    handleQuery: value => queries.push(value), playEarcon: value => events.push(value),
    VoiceEngine: { stop() { events.push('speech stopped'); } },
    SiriVoice: { active: false, enabled: false, stop() {}, start() { events.push('hands-free started'); } },
  });
  vm.runInContext(source.slice(start, end) + '\nglobalThis.ear = OfflineEar;', context);
  const grant = index => {
    const track = { stops: 0, stop() { this.stops++; } }, stream = { track, getTracks: () => [track] };
    streams.push(stream); permissions[index].resolve(stream); return stream;
  };
  const sample = (value = 0.1, milliseconds = 300) => {
    now += milliseconds;
    const processor = processors.at(-1);
    assert.equal(typeof processor?.onaudioprocess, 'function', 'recording owns an audio processor');
    processor.onaudioprocess({ inputBuffer: { getChannelData: () => new Float32Array(4096).fill(value) } });
  };
  return { context, ear: context.ear, queries, announcements, captions, events, timers, nodes, permissions, streams, contexts, processors, grant, sample, settle };
}

test('the current offline request records, waits for its model and dispatches its own transcript once', async () => {
  const h = harness(), recording = deferred(), model = deferred(), transcript = deferred(), transcribed = [];
  h.ear.record = () => recording.promise; h.ear.load = () => model.promise;
  h.ear.transcribe = data => { transcribed.push(data); return transcript.promise; };
  const pending = h.ear.listenAndHandle('manual');
  assert.equal(h.ear.active, true);
  recording.resolve(audio()); await h.settle();
  assert.equal(transcribed.length, 0);
  model.resolve(true); await h.settle(); assert.equal(transcribed.length, 1);
  transcript.resolve('Where is my synthetic pen?'); await pending;
  assert.deepEqual(h.queries, ['Where is my synthetic pen?']);
  assert.equal(h.ear.active, false); assert.equal(h.nodes.get('mic').attributes.get('aria-pressed'), 'false');
  assert.deepEqual(h.announcements, []);
});

test('Stop during recording permits a replacement and stale recording cleanup cannot clear it', async () => {
  const h = harness(), first = deferred(), next = deferred(); let recordings = 0;
  h.ear.load = async () => true;
  h.ear.record = () => ++recordings === 1 ? first.promise : next.promise;
  h.ear.transcribe = async () => 'Current synthetic request';
  const previous = h.ear.listenAndHandle('manual'); h.ear.cancel();
  const replacement = h.ear.listenAndHandle('manual');
  assert.equal(recordings, 2, 'Stop releases ownership before an old recording finishes');
  const before = h.captions.length;
  first.resolve(audio()); await previous; await h.settle();
  assert.equal(h.ear.active, true); assert.equal(h.nodes.get('mic').attributes.get('aria-pressed'), 'true');
  assert.equal(h.captions.length, before); assert.deepEqual(h.queries, []); assert.deepEqual(h.announcements, []);
  next.resolve(audio()); await replacement;
  assert.deepEqual(h.queries, ['Current synthetic request']);
});

test('a stale model completion or failure cannot transcribe, announce or clear a newer recording', async () => {
  for (const modelResult of [true, false]) {
    const h = harness(), model = deferred(), next = deferred(); let recordings = 0, loads = 0, transcribes = 0;
    h.ear.load = () => ++loads === 1 ? model.promise : Promise.resolve(true);
    h.ear.record = () => ++recordings === 1 ? Promise.resolve(audio()) : next.promise;
    h.ear.transcribe = async () => { transcribes++; return 'Current synthetic request'; };
    const previous = h.ear.listenAndHandle('manual'); await h.settle(); h.ear.cancel();
    const replacement = h.ear.listenAndHandle('manual');
    assert.equal(recordings, 2);
    model.resolve(modelResult); await previous; await h.settle();
    assert.equal(transcribes, 0); assert.deepEqual(h.announcements, []); assert.deepEqual(h.queries, []);
    assert.equal(h.ear.active, true); assert.equal(h.nodes.get('mic').attributes.get('aria-pressed'), 'true');
    next.resolve(audio()); await replacement;
    assert.deepEqual(h.queries, ['Current synthetic request']);
  }
});

test('late transcription success and failure after Stop leave the replacement request untouched', async () => {
  for (const failure of [false, true]) {
    const h = harness(), transcript = deferred(), next = deferred(); let recordings = 0, transcribes = 0;
    h.ear.load = async () => true;
    h.ear.record = () => ++recordings === 1 ? Promise.resolve(audio()) : next.promise;
    h.ear.transcribe = () => ++transcribes === 1 ? transcript.promise : Promise.resolve('Current synthetic request');
    const previous = h.ear.listenAndHandle('manual'); await h.settle(); assert.equal(transcribes, 1);
    h.ear.cancel(); const replacement = h.ear.listenAndHandle('manual'); assert.equal(recordings, 2);
    const before = h.captions.length;
    if (failure) transcript.reject(new Error('Synthetic expired inference failure')); else transcript.resolve('Expired synthetic request');
    await previous; await h.settle();
    assert.deepEqual(h.queries, []); assert.deepEqual(h.announcements, []); assert.equal(h.captions.length, before);
    assert.equal(h.ear.active, true); assert.equal(h.nodes.get('mic').attributes.get('aria-pressed'), 'true');
    next.resolve(audio()); await replacement; assert.deepEqual(h.queries, ['Current synthetic request']);
  }
});

test('Stop immediately stops a granted microphone without waiting for another audio callback', async () => {
  const h = harness(); h.ear.load = async () => true;
  const pending = h.ear.listenAndHandle('manual'); assert.equal(h.permissions.length, 1);
  const stream = h.grant(0); await h.settle(); assert.equal(h.processors.length, 1);
  h.ear.cancel();
  assert(stream.track.stops > 0, 'Stop closes the owned microphone immediately');
  assert.equal(h.ear.active, false); await pending;
  assert.equal(h.contexts[0].state, 'closed'); assert.deepEqual(h.queries, []); assert.deepEqual(h.announcements, []);
});

test('a microphone permission granted after Stop is closed without starting a recorder', async () => {
  const h = harness(); h.ear.load = async () => true;
  const pending = h.ear.listenAndHandle('manual'); assert.equal(h.permissions.length, 1);
  h.ear.cancel(); const stream = h.grant(0); await h.settle();
  assert(stream.track.stops > 0, 'a late grant must not leave microphone tracks running');
  assert.equal(h.contexts.length, 0); assert.equal(h.processors.length, 0);
  await pending; assert.deepEqual(h.queries, []); assert.deepEqual(h.announcements, []);
});

test('late microphone permission denial after Stop is silent and cannot clear its replacement', async () => {
  const h = harness(), next = deferred(); h.ear.load = async () => true;
  const previous = h.ear.listenAndHandle('manual'); h.ear.cancel();
  h.ear.record = () => next.promise; h.ear.transcribe = async () => 'Current synthetic request';
  const replacement = h.ear.listenAndHandle('manual');
  h.permissions[0].reject(new Error('Synthetic expired permission denial')); await previous;
  assert.deepEqual(h.announcements, []); assert.equal(h.ear.active, true);
  assert.equal(h.nodes.get('mic').attributes.get('aria-pressed'), 'true');
  next.resolve(audio()); await replacement; assert.deepEqual(h.queries, ['Current synthetic request']);
});

test('privacy, visibility, account or input changes suppress an outstanding offline transcript', async () => {
  for (const boundary of ['privacy', 'transition', 'hidden', 'account', 'local-account', 'source', 'source-epoch', 'remote-consent']) {
    const h = harness(), transcript = deferred(); h.ear.load = async () => true; h.ear.record = async () => audio();
    h.ear.transcribe = () => transcript.promise;
    const pending = h.ear.listenAndHandle('manual'); await h.settle();
    if (boundary === 'privacy') h.context.privacyMode = true;
    if (boundary === 'transition') h.context.privacyTransition = true;
    if (boundary === 'hidden') h.context.document.hidden = true;
    if (boundary === 'account') h.context.window.ASTHA_ACCOUNT_ID = 'synthetic-account-b';
    if (boundary === 'local-account') h.context.window.ASTHA_LOCAL_ACCOUNT_ID = 'synthetic-account-b';
    if (boundary === 'source') h.context.state.source = 'pi';
    if (boundary === 'source-epoch') h.context.state.sourceEpoch++;
    if (boundary === 'remote-consent') h.context.remoteAllowed = false;
    const before = h.captions.length;
    transcript.resolve('Expired synthetic request'); await pending; await h.settle();
    assert.deepEqual(h.queries, [], boundary); assert.deepEqual(h.announcements, [], boundary);
    assert.equal(h.captions.length, before, boundary); assert.equal(h.ear.active, false, boundary);
  }
});

test('the real local recorder still detects speech, closes its stream and dispatches the current transcript', async () => {
  const h = harness(); h.ear.load = async () => true; let samples;
  h.ear.transcribe = async data => { samples = data; return 'Current recorded request'; };
  const pending = h.ear.listenAndHandle('manual'), stream = h.grant(0); await h.settle();
  h.sample(0.1, 300); h.sample(0.1, 300);
  for (let index = 0; index < 6 && h.processors.at(-1).onaudioprocess; index++) h.sample(0, 300);
  await pending;
  assert(samples instanceof Float32Array && samples.length > 0);
  assert.deepEqual(h.queries, ['Current recorded request']); assert(stream.track.stops > 0);
  assert.equal(h.contexts[0].state, 'closed'); assert.equal(h.ear.active, false);
  assert.equal(h.processors.at(-1).onaudioprocess, null, 'closed recording cannot accept more frames');
});
