// Actual spatial action and cancellation guards; model/depth results are synthetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const read = file => fs.readFileSync(new URL('../' + file, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
function section(source, first, last) {
  const start = source.indexOf(first), end = source.indexOf(last, start + first.length);
  assert(start >= 0 && end > start, 'Actual source boundary missing: ' + first);
  return source.slice(start, end);
}
const busy = section(read('tools/base.html'), 'function captureLocalActionGuard()', '\nasync function analyzeStill(');
const cancellation = section(read('tools/module.js'), 'const AsthaCancellation =', '\nconst VoiceEchoFilter');
const stop = section(read('tools/offline.js'), 'function stopAllSpeech()', '\n// ---- "Works without internet"');
const spatial = read('tools/spatial.js');
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const settle = () => new Promise(resolve => setImmediate(resolve));
const map = { w: 3, h: 1, near: [0.8, 0.5, 0.3] };

function harness() {
  const calls = { models: 0, detect: 0, depth: 0, perception: 0, captions: [], speech: [], announcements: [], errors: [], memory: [] }, nodes = new Map();
  const context = vm.createContext({
    state: { source: 'pi', sourceEpoch: 1, spatial: { previous: true }, memory: [], scene: { previous: true }, busy: false },
    privacyMode: false, privacyTransition: false, document: { hidden: false }, LocalStore: { KEY: 'synthetic-spatial-owner' },
    console: { error: (...args) => calls.errors.push(args) }, withCamera: () => false,
    t: key => key, tBn: key => key,
    $: id => { if (!nodes.has(id)) nodes.set(id, { setAttribute() {} }); return nodes.get(id); },
    setTimeout: () => 1, clearInterval() {}, stopLiveLoop() {}, startLiveLoop() {},
    setCaption: (...args) => calls.captions.push(args), speak: (...args) => calls.speech.push(args), announce: (...args) => calls.announcements.push(args),
    stopReader() {}, stopListening() {}, VoiceEngine: { stop() {} }, OfflineEar: { active: false },
    captureFrame: () => ({ width: 640, height: 480 }),
    perceptionHook: () => { calls.perception++; context.state.scene = { current: true }; },
    addLocalMemory: value => calls.memory.push(value),
    AsthaSensors: { measured: () => null }, measuredPhrase: metres => 'measured at ' + metres + ' metres',
    objLabelWithArticle: object => 'a ' + object.id, objLabelBn: object => object.id,
  });
  context.window = context; context.ASTHA_ACCOUNT_ID = 'synthetic-spatial-owner';
  context.modelResult = async () => true; context.detectResult = async () => []; context.depthResult = async () => map;
  context.ensureVisionModels = async () => { calls.models++; return context.modelResult(); };
  context.runCoco = async () => { calls.detect++; return context.detectResult(); };
  context.DepthEngine = { status: 'ready', wanted: () => true, load: async () => {},
    run: async () => { calls.depth++; return context.depthResult(); }, nearnessInBox: () => .5, nearnessInRegion: () => .5 };
  vm.runInContext(cancellation + busy + spatial + stop, context);
  const h = { context, calls, run: code => vm.runInContext(code, context) };
  h.effects = () => JSON.stringify({ calls, spatial: context.state.spatial, scene: context.state.scene, memory: context.state.memory });
  return h;
}

test('Stop discards spatial model, detector and depth success or failure before further work or effects', async () => {
  for (const phase of ['modelResult', 'detectResult', 'depthResult']) for (const reject of [false, true]) {
    const h = harness(), wait = deferred(); h.context[phase] = () => wait.promise;
    const pending = h.run('answerSpatial()'); await settle(); h.run('stopAllSpeech()'); const before = h.effects();
    if (reject) wait.reject(new Error('synthetic stale inference failure'));
    else wait.resolve(phase === 'modelResult' ? true : phase === 'detectResult' ? [] : map);
    await pending; assert.equal(h.effects(), before, phase); assert.equal(h.calls.speech.length, 0); assert.equal(h.calls.perception, 0);
    assert.deepEqual(h.context.state.spatial, { previous: true });
    assert.equal(h.context.state.busy, false);
  }
});

test('source, epoch, account, owner, background and privacy changes reject deferred spatial results', async () => {
  const boundaries = [h => { h.context.state.source = 'camera'; }, h => { h.context.state.sourceEpoch++; },
    h => { h.context.ASTHA_ACCOUNT_ID = 'other-synthetic-owner'; }, h => { h.context.LocalStore.KEY = 'other-synthetic-owner'; },
    h => { h.context.document.hidden = true; }, h => { h.context.privacyMode = true; }, h => { h.context.privacyTransition = true; }];
  for (const phase of ['modelResult', 'detectResult', 'depthResult']) for (const boundary of boundaries) {
    const h = harness(), wait = deferred(); h.context[phase] = () => wait.promise;
    const pending = h.run('answerSpatial()'); await settle(); boundary(h); const before = h.effects();
    wait.resolve(phase === 'modelResult' ? true : phase === 'detectResult' ? [] : map);
    await pending; assert.equal(h.effects(), before, phase); assert.equal(h.calls.memory.length, 0);
  }
});

test('ordinary spatial success uses the actual layout and conservative narration', async () => {
  const h = harness(); await h.run('answerSpatial()');
  assert.equal(h.calls.models, 1); assert.equal(h.calls.detect, 1); assert.equal(h.calls.depth, 1); assert.equal(h.calls.perception, 1);
  assert.equal(h.context.state.spatial.sectors.length, 3); assert.equal(h.context.state.spatial.scaled, false);
  assert.match(h.calls.speech[0][0], /nearest things are to your left/);
  assert.match(h.calls.speech[0][0], /cannot judge the other distances in metres/);
  assert.match(h.calls.speech[0][0], /Use your cane to confirm/);
  assert.doesNotMatch(h.calls.speech[0][0], /\b(clear|safe|free|open)\b/); assert.equal(h.calls.memory.length, 0);
});

test('ordinary depth failure and not-yet-loaded depth keep their existing feedback', async () => {
  const failed = harness(); failed.context.depthResult = async () => { throw new Error('synthetic depth unavailable'); };
  await failed.run('answerSpatial()'); assert.match(failed.calls.announcements[0][0], /could not judge depth/);
  assert.deepEqual(failed.context.state.spatial, { previous: true }); assert.equal(failed.calls.errors.length, 0);
  const loading = harness(); loading.context.DepthEngine.status = 'idle';
  await loading.run('answerSpatial()'); assert.match(loading.calls.announcements[0][0], /depth model.*loading/);
  assert.equal(loading.calls.detect, 0); assert.equal(loading.calls.depth, 0);
});
