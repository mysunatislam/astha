// Execute the shipped perception functions with deferred model boundaries.
// These checks establish cancellation behavior, not inference accuracy or speed.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const read = path => fs.readFileSync(new URL('../' + path, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const base = read('tools/base.html'), moduleSource = read('tools/module.js');
const perceive = read('tools/perceive.js'), offline = read('tools/offline.js');
function section(source, first, last) {
  const start = source.indexOf(first), end = source.indexOf(last, start + first.length);
  assert(start >= 0 && end > start, 'Actual source boundary missing: ' + first);
  return source.slice(start, end);
}
function fn(source, name) {
  const match = new RegExp('(?:async )?function ' + name + '\\(').exec(source);
  assert(match, 'Actual function missing: ' + name);
  const end = source.indexOf('\n}', match.index) + 2;
  assert(end > match.index);
  return source.slice(match.index, end);
}
const actual = [
  section(moduleSource, 'const AsthaCancellation =', '\nconst VoiceEchoFilter'),
  section(base, 'function captureLocalActionGuard()', '\nasync function analyzeStill('),
  section(perceive, 'const DepthEngine =', '\n// ---- Per-object geometry:'),
  section(moduleSource, 'const REFINE =', '\n// Track whether'),
  fn(moduleSource, 'refineWorld'),
  section(moduleSource, 'const liveRefineCache =', '\n// ---- Voice choice'),
  section(moduleSource, 'const MIRROR_SET =', '\n// ---- Astha\'s heart'),
  fn(moduleSource, 'howDoILook'), fn(perceive, 'describeScene'), fn(perceive, 'answerHowFar'), fn(perceive, 'currentMeasuredDistance'), fn(offline, 'stopAllSpeech'),
].join('\n');
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const settle = () => new Promise(resolve => setImmediate(resolve));
const frame = { width: 640, height: 480 };
const detection = () => [{ id: 'person', score: .9, bbox: [20, 20, 100, 100] }];
const tensor = { predicted_depth: { dims: [1, 2, 2], data: new Float32Array([0, 1, 2, 3]) } };
const clothing = { colors: { top: 'blue' } };

function harness() {
  const nodes = new Map(), calls = { stages: [], captions: [], speech: [], announcements: [], effects: [], errors: [], perceptionOptions: [] };
  const element = id => {
    if (!nodes.has(id)) nodes.set(id, { textContent: '', value: 'short', attributes: {}, setAttribute(k, v) { this.attributes[k] = v; } });
    return nodes.get(id);
  };
  const context = vm.createContext({
    console: { warn: (...args) => calls.errors.push(args.map(String)), error: (...args) => calls.errors.push(args.map(String)) },
    document: { hidden: false, createElement: () => ({ width: 0, height: 0, getContext: () => ({ drawImage() {}, getImageData: () => ({ data: new Uint8ClampedArray(16) }) }) }) },
    state: { source: 'photo', sourceEpoch: 1, world: new Map(), relabel: {}, announced: new Map(), lastCocoPreds: [], lastClipHits: [], liveLoop: {} },
    privacyMode: false, privacyTransition: false, LocalStore: { KEY: 'synthetic-owner-a' },
    engine: { depth: { status: 'ready' }, clip: { status: 'ready' } },
    reading: { active: false }, OfflineEar: { active: false }, VoiceEngine: { stop() {} },
    stopReader() {}, stopListening() {}, stopReading() {}, clearInterval() {}, setTimeout: () => 1,
    stopLiveLoop() {}, startLiveLoop() {}, $: element, t: key => key, tBn: key => key,
    withCamera: () => false, cloudReady: () => false, cloudDescribe: () => calls.effects.push('cloud-describe'),
    setCaption: (...args) => calls.captions.push(args), speak: (...args) => calls.speech.push(args),
    announce: (...args) => calls.announcements.push(args), cloudFail: error => calls.errors.push(String(error)),
    captureFrame: () => { calls.effects.push('capture'); return frame; },
    trackMotion: () => calls.effects.push('motion'), perceptionHook: (_objects, _frame, options) => { calls.effects.push('perception'); calls.perceptionOptions.push(options); },
    ingest: objects => { for (const object of objects) context.state.world.set(object.id, object); calls.effects.push('ingest'); },
    drawOverlay: () => calls.effects.push('overlay'), worldSorted: () => [...context.state.world.values()],
    sceneSummary: () => ({ en: 'Synthetic person ahead.', bn: 'সামনে পরীক্ষার মানুষ।' }),
    playEarcon: () => calls.effects.push('earcon'), haptic: () => calls.effects.push('haptic'),
    heartPointAt: () => calls.effects.push('point'), heartFlash: () => calls.effects.push('heart'),
    logEvent: () => calls.effects.push('log'), renderSeen: () => calls.effects.push('render'),
    setEngineState: (key, status) => { context.engine[key].status = status; calls.effects.push('engine'); },
    centerRect: () => ({}), bodyRect: () => ({}),
    clothingSentence: () => ({ isGarment: true, garment: { en: 'shirt', bn: 'শার্ট' } }),
    colorName: value => value, colorNameBn: () => 'নীল', CLOUD_PROMPTS: { mirror: 'mirror' },
    AsthaSensors: { measured: () => null }, measuredPhrase: metres => 'measured at ' + metres + ' metres',
    objLabel: object => object.id, objLabelBn: object => object.id,
  });
  context.window = context; context.ASTHA_ACCOUNT_ID = 'synthetic-owner-a';
  const defaults = { models: true, detect: detection, clip: () => ({ hits: [] }), depth: tensor,
    refinePrompt: {}, refineEmbed: [.5], mirrorEmbed: [[.5]], mirrorPrompt: {}, clothing,
    gemini: { mirror: true }, compliment: undefined };
  const results = { ...defaults };
  const step = async key => {
    calls.stages.push(key);
    const value = results[key]; return typeof value === 'function' ? value() : value;
  };
  context.ensureVisionModels = () => step('models'); context.runCoco = () => step('detect');
  context.runClipZones = () => step('clip');
  context.getPromptSet = key => step(key === 'mirror' ? 'mirrorPrompt' : 'refinePrompt');
  context.clipEmbedBox = () => step('refineEmbed'); context.clipEmbedCrops = () => step('mirrorEmbed');
  context.rankAgainst = () => results.ranked || [{ id: 'real', p: .9 }];
  context.analyzeClothing = () => step('clothing'); context.gemini = () => step('gemini');
  context.cloudCompliment = async (_frame, _r, current) => { await step('compliment'); if (current()) calls.announcements.push(['Synthetic online compliment']); };
  vm.runInContext(actual, context);
  const h = { context, calls, results, run: code => vm.runInContext(code, context) };
  context.depthResult = () => step('depth');
  h.run('DepthEngine.RawImage = class {}; DepthEngine.pipe = () => depthResult();');
  h.effects = () => JSON.stringify({ calls, world: [...context.state.world], relabel: context.state.relabel,
    coco: context.state.lastCocoPreds, clip: context.state.lastClipHits, announced: [...context.state.announced],
    compliment: context.state.complimentIdx, complimentAt: context.state.lastComplimentAt,
    mirrorAt: context.state.mirrorSeenAt, depth: h.run('DepthEngine.last'), failures: h.run('DepthEngine.failures'),
    votes: h.run('[...refineVotes]') });
  return h;
}
const boundaries = [
  h => h.run('stopAllSpeech()'), h => { h.context.state.source = 'camera'; },
  h => { h.context.state.sourceEpoch++; }, h => { h.context.ASTHA_ACCOUNT_ID = 'synthetic-owner-b'; },
  h => { h.context.LocalStore.KEY = 'synthetic-owner-b'; }, h => { h.context.document.hidden = true; },
  h => { h.context.privacyMode = true; }, h => { h.context.privacyTransition = true; },
];

test('generated final perception functions are the guarded source winners', () => {
  const built = read('web/index.html');
  for (const [source, name] of [[perceive, 'describeScene'], [moduleSource, 'howDoILook'], [moduleSource, 'mirrorCheck'], [moduleSource, 'refineWorld']]) {
    const expected = fn(source, name), start = built.lastIndexOf('function ' + name + '(');
    const body = built.slice(start - (expected.startsWith('async ') ? 6 : 0));
    assert(body.startsWith(expected), name + ' generated winner must match its reviewed source');
  }
  assert(built.includes(section(perceive, 'const DepthEngine =', '\n// ---- Per-object geometry:')),
    'Generated depth cache must match the guarded source');
});

test('offline describe discards delayed model, detector, CLIP and depth success or failure after Stop', async () => {
  for (const phase of ['models', 'detect', 'clip', 'depth']) for (const reject of [false, true]) {
    const h = harness(), wait = deferred(); h.results[phase] = () => wait.promise;
    const pending = h.run('describeScene(true)'); await settle(); assert(h.calls.stages.includes(phase));
    boundaries[0](h); const before = h.effects();
    if (reject) wait.reject(new Error('synthetic inference failure'));
    else wait.resolve(phase === 'models' ? true : phase === 'detect' ? detection() : phase === 'clip' ? { hits: [] } : tensor);
    await pending; assert.equal(h.effects(), before, phase); assert.equal(h.run('DepthEngine.busy'), false);
  }
});

test('offline describe source, ownership, background and privacy changes discard deferred inference', async () => {
  for (const boundary of boundaries.slice(1)) {
    const h = harness(), wait = deferred(); h.results.detect = () => wait.promise;
    const pending = h.run('describeScene(true)'); await settle(); boundary(h); const before = h.effects();
    wait.resolve(detection()); await pending; assert.equal(h.effects(), before);
  }
});

test('normal offline description and appearance retain scene, refinement and bilingual output', async () => {
  const scene = harness(); await scene.run('describeScene(true)');
  assert.equal(scene.calls.speech[0][0], 'Synthetic person ahead.');
  assert.equal(scene.context.state.world.get('person').id, 'person'); assert(scene.run('DepthEngine.last'));
  const look = harness(); look.results.ranked = [{ id: 'idcard', p: .8 }, { id: 'real', p: .1 }];
  await look.run('howDoILook()'); assert(look.context.state.world.has('id card'));
  assert.equal(look.calls.announcements.length, 1); assert.match(look.calls.announcements[0][0], /shirt/);
  assert.match(look.calls.announcements[0][1], /শার্ট/); assert.equal(look.context.state.busy, false);
});

test('offline descriptions associate sensor distance only with the unchanged sample from their captured picture', async () => {
  for (const changed of [false, true]) {
    const h = harness(), wait = deferred(); h.context.state.source = 'pi';
    const original = { measured: true, metres: 1.2, at: 1000 };
    let reading = original; h.context.AsthaSensors.measured = () => reading;
    h.results.detect = () => wait.promise;
    const pending = h.run('describeScene(true)'); await settle();
    if (changed) reading = { measured: true, metres: .4, at: 1100 };
    wait.resolve(detection()); await pending;
    assert.equal(h.calls.perceptionOptions.length, 1);
    assert.equal(h.calls.perceptionOptions[0].sensorReading, changed ? null : original,
      'a newer echo must not label an object in an older picture');
  }
});

test('a new forward echo cannot name the object associated with a previous sensor sample', () => {
  const h = harness(); h.context.state.source = 'pi';
  const object = { id: 'chair', distMeasured: true, distM: 1.2, distMeasuredAt: 1000, distMeasuredEpoch: 1 };
  h.context.state.scene = { at: Date.now(), ahead: { object } };
  let reading = { measured: true, metres: 1.2, at: 1000 };
  h.context.AsthaSensors.measured = () => reading;
  h.run("answerHowFar('how far is it')");
  assert.match(h.calls.announcements.at(-1)[0], /^The chair straight ahead is measured at 1\.2 metres/);
  reading = { measured: true, metres: .4, at: 1100 };
  h.run("answerHowFar('how far is it')");
  assert.match(h.calls.announcements.at(-1)[0], /^Something straight ahead is measured at 0\.4 metres/);
  assert.doesNotMatch(h.calls.announcements.at(-1)[0], /chair/);
  assert.doesNotMatch(h.calls.announcements.at(-1)[1], /chair/);
});

test('appearance Stop at model, detector, refinement and clothing boundaries suppresses late effects', async () => {
  for (const phase of ['models', 'detect', 'refinePrompt', 'refineEmbed', 'clothing']) for (const reject of [false, true]) {
    const h = harness(), wait = deferred(); h.results[phase] = () => wait.promise;
    const pending = h.run('howDoILook()'); await settle(); assert(h.calls.stages.includes(phase), phase);
    boundaries[0](h); const before = h.effects();
    if (reject) wait.reject(new Error('synthetic appearance failure'));
    else wait.resolve(phase === 'models' ? true : phase === 'detect' ? detection() : phase === 'clothing' ? clothing : {});
    await pending; assert.equal(h.effects(), before, phase); assert.equal(h.calls.announcements.length, 0);
  }
});

test('appearance account/source changes cannot relabel the replacement world or speak a late compliment', async () => {
  for (const phase of ['refineEmbed', 'clothing']) for (const boundary of boundaries.slice(1)) {
    const h = harness(), wait = deferred(); h.results[phase] = () => wait.promise;
    h.results.ranked = [{ id: 'idcard', p: .8 }];
    const pending = h.run('howDoILook()'); await settle(); boundary(h);
    h.context.state.world = new Map([['cup', { id: 'cup', owner: 'replacement' }]]); const before = h.effects();
    wait.resolve(phase === 'clothing' ? clothing : [.5]); await pending;
    assert.equal(h.effects(), before, phase); assert.equal(h.context.state.world.size, 1);
  }
});

test('mirror helper carries its original guard across local embedding, prompt loading and cloud handoff', async () => {
  for (const phase of ['mirrorEmbed', 'mirrorPrompt', 'gemini', 'compliment']) {
    const h = harness(), wait = deferred(); h.results[phase] = () => wait.promise;
    h.context.state.lastCocoPreds = [{ id: 'cell phone' }];
    h.context.cloudReady = () => phase === 'gemini' || phase === 'compliment';
    h.results.ranked = [{ id: 'mirror', p: .9 }];
    const pending = h.run('mirrorCheck({width:640,height:480}, false)'); await settle();
    assert(h.calls.stages.includes(phase)); boundaries[0](h); const before = h.effects();
    wait.resolve(phase === 'gemini' ? { mirror: true } : phase === 'mirrorEmbed' ? [[.5]] : {});
    assert.equal(await pending, false); assert.equal(h.effects(), before, phase);
  }
});

test('background depth inference cannot publish an old source/account map or failure', async () => {
  for (const boundary of boundaries) for (const reject of [false, true]) {
    const h = harness(), wait = deferred(); h.results.depth = () => wait.promise;
    const pending = h.run('DepthEngine.run({width:640,height:480})'); await settle(); boundary(h); const before = h.effects();
    if (reject) wait.reject(new Error('synthetic depth failure')); else wait.resolve(tensor);
    assert.equal(await pending, null); assert.equal(h.effects(), before); assert.equal(h.run('DepthEngine.busy'), false);
  }
});

test('a previously valid depth cache is unavailable after Stop, source, account or privacy changes', async () => {
  for (const boundary of boundaries) {
    const h = harness(); await h.run('DepthEngine.run({width:640,height:480})');
    assert(h.run('DepthEngine.fresh()')); boundary(h);
    assert.equal(h.run('DepthEngine.fresh()'), null);
    h.run('DepthEngine.busy = true');
    assert.equal(await h.run('DepthEngine.run({width:640,height:480})'), null);
  }
});

test('asking for a new picture while depth is busy never returns the previous picture', async () => {
  const h = harness(); await h.run('DepthEngine.run({width:640,height:480})');
  assert(h.run('DepthEngine.fresh()'), 'live perception can explicitly consult a recent cache');
  h.run('DepthEngine.busy = true; DepthEngine.last.at = Date.now() - 600000;');
  assert.equal(await h.run('DepthEngine.run({width:640,height:480})'), null);
  h.run('DepthEngine.last.at = Date.now();');
  assert.equal(await h.run('DepthEngine.run({width:640,height:480})'), null, 'even a recent different picture is not the requested one');
});

test('live refinement cannot publish stale votes/mirror effects or unlock a newer busy operation', async () => {
  const h = harness(), wait = deferred(); h.context.state.source = 'camera'; h.context.state.lastCocoPreds = detection();
  h.results.refineEmbed = () => wait.promise; h.results.ranked = [{ id: 'mirror', p: .9 }];
  const pending = h.run('liveRefineAndMirror({width:640,height:480})'); await settle();
  boundaries[0](h); const before = h.effects(); wait.resolve([.5]); await pending; assert.equal(h.effects(), before);
  const mirror = harness(), clothingWait = deferred(); mirror.context.state.mirrorSeenAt = Date.now();
  mirror.context.state.lastCocoPreds = [{ id: 'cell phone', score: .9 }];
  mirror.results.clothing = () => clothingWait.promise;
  const old = mirror.run('liveRefineAndMirror({width:640,height:480})'); await settle(); assert.equal(mirror.context.state.busy, true);
  boundaries[0](mirror); const nextToken = Symbol('new operation'); mirror.context.state.busyToken = nextToken; mirror.context.state.busy = true;
  clothingWait.resolve(clothing); await old; assert.equal(mirror.context.state.busy, true); assert.equal(mirror.context.state.busyToken, nextToken);
  assert.equal(mirror.calls.announcements.length, 0);
});
