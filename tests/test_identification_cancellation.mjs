// Exercise generated identification/clothing actions with deferred synthetic inference.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const read = path => fs.readFileSync(new URL('../' + path, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
function section(source, first, last) {
  const start = source.indexOf(first), end = source.indexOf(last, start + first.length);
  assert(start >= 0 && end > start, 'Missing actual action boundary: ' + first);
  return source.slice(start, end);
}
const built = read('web/index.html');
const actions = section(built, 'function inspectClothesAndColor(skipCloud)', '\n/* =====================================================================\n   11. Multimodal OCR-First')
  + section(built, 'function identifyObject(skipCloud)', '\n/* =====================================================================\n   12. Guided Home Layout Calibration Wizard')
  + section(built, 'async function analyzeStill(', '\nfunction describeScene(')
  + section(built, 'function safetyCheck(', '\n/* =====================================================================\n   12. Haptics')
  + section(read('tools/cloud.js'), 'async function cloudCompliment(', '\n// Read a page');
const busy = section(read('tools/base.html'), 'function captureLocalActionGuard()', '\nasync function analyzeStill(');
const cancellation = section(read('tools/module.js'), 'const AsthaCancellation =', '\nconst VoiceEchoFilter');
const stop = section(read('tools/offline.js'), 'function stopAllSpeech()', '\n// ---- "Works without internet"');
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const settle = () => new Promise(resolve => setImmediate(resolve));
const detection = () => [{ id: 'cup', score: .9, bbox: [200, 100, 200, 200] }];
const clothing = { colors: { top: { name: 'Blue', pct: 70 } } };

function harness() {
  const calls = { models: 0, ocrLoad: 0, ocr: 0, detect: 0, refine: 0, clip: 0, clothing: 0,
    captions: [], announcements: [], speech: [], saves: [], errors: [], overlays: 0, flashes: 0 };
  const state = { source: 'photo', sourceEpoch: 1, busy: false, relabel: {}, lastCocoPreds: [], world: new Map() };
  const context = vm.createContext({
    state, document: { hidden: false }, privacyMode: false, privacyTransition: false,
    LocalStore: { KEY: 'synthetic-owner-a' }, console: { warn() {}, error: (...a) => calls.errors.push(a) },
    withCamera: () => false, cloudReady: () => false,
    $: () => ({ setAttribute() {} }), t: key => key, tBn: key => key,
    setTimeout: () => 1, clearInterval() {}, stopLiveLoop() {}, startLiveLoop() {},
    setCaption: (...a) => calls.captions.push(a), announce: (...a) => calls.announcements.push(a), speak: (...a) => calls.speech.push(a),
    stopReader() {}, stopListening() {}, VoiceEngine: { stop() {} }, OfflineEar: { active: false },
    playEarcon() {}, haptic() {}, logEvent() {}, heartSet() {}, heartHide() {},
    heartFlash: () => calls.flashes++, drawOverlay: () => calls.overlays++,
    captureFrame: () => ({ width: 640, height: 480 }), centerRect: () => ({ x: 0, y: 0, s: 200 }),
    bodyRect: () => ({ x: 0, y: 0, s: 200 }), cropToCanvas: frame => frame,
    engine: { clip: { status: 'ready' } }, VOCAB_BY_ID: { cup: { en: 'cup', bn: 'কাপ' }, shirt: { garment: true } }, CLIP_SURE: .75,
    label: id => id, labelBn: id => id, labelWithArticle: id => 'a ' + id, withArticle: text => 'a ' + text,
    colorName: () => 'blue', colorNameBn: () => 'নীল', extractDominantColor: () => clothing.colors,
    scoreEmbedding: () => [{ id: 'cup', p: .9 }], clothingSentence: () => ({ en: 'A blue shirt.', bn: 'নীল জামা।', isGarment: false }),
    autoRecordMemory: value => calls.saves.push(value), mirrorCheck: async () => true,
    COMPLIMENTS: [['Synthetic compliment.', 'পরীক্ষা।']], CLOUD_PROMPTS: { clothes: 'synthetic' },
    ingest: () => calls.overlays++, worldSorted: () => [], showHazard: () => calls.flashes++, isHazard: () => false,
  });
  context.window = context; context.ASTHA_ACCOUNT_ID = 'synthetic-owner-a';
  const defaults = { models: true, ocrLoad: null, ocr: { data: { lines: [] } }, detect: detection(), refine: null, clip: [[.5]], clothing };
  const workers = {};
  for (const phase of Object.keys(defaults)) workers[phase] = async () => defaults[phase];
  context.ensureVisionModels = async () => { calls.models++; return workers.models(); };
  const worker = { recognize: async () => { calls.ocr++; return workers.ocr(); } };
  workers.ocrLoad = async () => worker;
  context.ensureOcr = async () => { calls.ocrLoad++; return workers.ocrLoad(); };
  context.runCoco = async () => { calls.detect++; return workers.detect(); };
  context.refineDetection = async () => { calls.refine++; return workers.refine(); };
  context.clipEmbedCrops = async () => { calls.clip++; return workers.clip(); };
  context.analyzeClothing = async () => { calls.clothing++; return workers.clothing(); };
  context.runClipZones = async () => ({ hits: [] });
  context.gemini = async () => workers.cloud();
  vm.runInContext(cancellation + busy + actions + stop, context);
  return { calls, context, workers, defaults, worker, run: text => vm.runInContext(text, context),
    effects: () => JSON.stringify({ calls, relabel: state.relabel, detections: state.lastCocoPreds }) };
}

test('Stop prevents late identification model/OCR/detector/refinement/CLIP results or failures from speaking or saving', async () => {
  for (const phase of ['models', 'ocrLoad', 'ocr', 'detect', 'refine', 'clip']) for (const reject of [false, true]) {
    const h = harness(), wait = deferred(); h.workers[phase] = () => wait.promise;
    const pending = h.run('identifyObject(true)'); await settle(); assert.equal(h.calls[phase], 1, phase);
    h.run('stopAllSpeech()'); const before = h.effects();
    if (reject) wait.reject(new Error('synthetic late inference failure'));
    else wait.resolve(phase === 'ocrLoad' ? h.worker : h.defaults[phase]);
    await pending; assert.equal(h.effects(), before, phase); assert.equal(h.calls.saves.length, 0);
  }
});

test('Stop rejects late garment identification and clothing-analysis output', async () => {
  for (const action of ['identifyObject(true)', 'inspectClothesAndColor(true)']) for (const reject of [false, true]) {
    const h = harness(), wait = deferred();
    h.context.scoreEmbedding = () => [{ id: 'shirt', p: .9 }]; h.workers.clothing = () => wait.promise;
    const pending = h.run(action); await settle(); assert.equal(h.calls.clothing, 1);
    h.run('stopAllSpeech()'); const before = h.effects();
    if (reject) wait.reject(new Error('synthetic clothing failure')); else wait.resolve(clothing);
    await pending; assert.equal(h.effects(), before); assert.equal(h.calls.saves.length, 0);
  }
});

test('source, account, local owner, hidden page and privacy changes invalidate delayed identification/clothing', async () => {
  const changes = [h => { h.context.state.sourceEpoch++; }, h => { h.context.state.source = 'pi'; },
    h => { h.context.ASTHA_ACCOUNT_ID = 'synthetic-owner-b'; }, h => { h.context.LocalStore.KEY = 'synthetic-owner-b'; },
    h => { h.context.document.hidden = true; }, h => { h.context.privacyMode = true; }, h => { h.context.privacyTransition = true; }];
  for (const action of ['identifyObject(true)', 'inspectClothesAndColor(true)']) for (const change of changes) {
    const h = harness(), wait = deferred(); h.workers.detect = () => wait.promise;
    const pending = h.run(action); await settle(); change(h); const before = h.effects();
    wait.resolve(detection()); await pending; assert.equal(h.effects(), before);
  }
});

test('ordinary object identification and clothing descriptions still complete', async () => {
  const identified = harness(); await identified.run('identifyObject(true)');
  assert.match(identified.calls.announcements[0][0], /cup/); assert.equal(identified.calls.saves.length, 1);
  assert.equal(identified.context.state.busy, false);
  const dressed = harness(); await dressed.run('inspectClothesAndColor(true)');
  assert.match(dressed.calls.announcements[0][0], /blue shirt/); assert.equal(dressed.calls.clothing, 1);
  assert.equal(dressed.context.state.busy, false);
});

test('Stop prevents deferred still-image hazard checking from announcing a late result', async () => {
  for (const phase of ['models', 'detect']) {
    const h = harness(), wait = deferred(); h.workers[phase] = () => wait.promise;
    const pending = h.run('safetyCheck(false)'); await settle(); h.run('stopAllSpeech()'); const before = h.effects();
    wait.resolve(h.defaults[phase]); await pending; assert.equal(h.effects(), before);
    assert.equal(h.context.state.world.size, 0);
  }
});

test('analyzeStill rejects delayed scene updates after an account switch', async () => {
  const h = harness(), wait = deferred(); h.workers.detect = () => wait.promise;
  const pending = h.run('analyzeStill()'); await settle(); h.context.ASTHA_ACCOUNT_ID = 'synthetic-owner-b'; const before = h.effects();
  wait.resolve(detection()); assert.equal(await pending, null); assert.equal(h.effects(), before);
});

test('deferred mirror cloud response does not speak or update compliment state after Stop or context changes', async () => {
  const changes = [h => h.run('stopAllSpeech()'), h => { h.context.state.sourceEpoch++; },
    h => { h.context.ASTHA_ACCOUNT_ID = 'synthetic-owner-b'; }, h => { h.context.document.hidden = true; }];
  for (const change of changes) for (const reject of [false, true]) {
    const h = harness(), wait = deferred(); h.workers.cloud = () => wait.promise;
    const pending = h.run('cloudCompliment({width:640,height:480}, {})'); await settle(); change(h); const before = h.effects();
    if (reject) wait.reject(new Error('synthetic provider failure')); else wait.resolve({ en: 'Synthetic shirt.', bn: 'জামা।' });
    await pending; assert.equal(h.effects(), before); assert.equal(h.context.state.complimentIdx, undefined);
    assert.equal(h.context.state.lastComplimentAt, undefined);
  }
  const h = harness(); h.workers.cloud = async () => ({ en: 'Synthetic shirt.', bn: 'জামা।' });
  await h.run('cloudCompliment({width:640,height:480}, {})'); assert.equal(h.calls.announcements.length, 1);
});

test('central Stop clears both deferred camera actions and pending camera reading', () => {
  const h = harness(); h.context.state.pendingRead = true; h.context.state.pendingAction = () => assert.fail('stale camera action');
  h.run('stopAllSpeech()'); assert.equal(h.context.state.pendingRead, false); assert.equal(h.context.state.pendingAction, null);
});
