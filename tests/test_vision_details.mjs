// Actual capture/detector/overlay/view functions with synthetic model and DOM stand-ins.
// These tests prove lifecycle and labels, not camera hardware or detection accuracy.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const read = file => fs.readFileSync(new URL('../' + file, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const base = read('tools/base.html'), moduleSource = read('tools/module.js'), source = read('tools/vision-details.js');
const strings = JSON.parse(read('tools/i18n.json')).strings;
const section = (text, first, last) => {
  const start = text.indexOf(first), end = text.indexOf(last, start + first.length);
  assert(start >= 0 && end > start, 'actual source boundary missing: ' + first); return text.slice(start, end);
};
const guardBusy = section(base, 'function captureLocalActionGuard()', '\nasync function analyzeStill(');
const cancellation = section(moduleSource, 'const AsthaCancellation =', '\nconst VoiceEchoFilter');
const captureAndDetect = section(base, 'function captureFrame(', '\nfunction posFromX(');
const overlay = section(base, 'function drawOverlay(', '\nfunction isHazard(');
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const settle = () => new Promise(resolve => setImmediate(resolve));
const prediction = [{ class: 'chair', score: .82, bbox: [32, 24, 100, 160] }];

function harness() {
  let now = 10000, timerId = 0;
  const elements = new Map(), listeners = new Map(), timers = new Map();
  const calls = { models: 0, detection: 0, camera: 0, network: 0, timing: 0, speech: [], errors: [], clear: 0, boxes: [], labels: [] };
  function node(tag = 'div') {
    const value = { tagName: tag.toUpperCase(), children: [], dataset: {}, attributes: {}, textContent: '', hidden: false, value: '',
      style: { values: {}, setProperty(key, entry) { this.values[key] = entry; } },
      setAttribute(key, entry) { this.attributes[key] = String(entry); }, focus() {},
      append(...children) { this.children.push(...children); }, replaceChildren(...children) { this.children = children; },
      addEventListener(key, action) { this.events ||= {}; this.events[key] = action; },
      classList: { add() {}, remove() {}, toggle() {} },
      getContext() { return { clearRect() { calls.clear++; }, drawImage() {},
        strokeRect: (...args) => calls.boxes.push(args), fillRect() {}, fillText: text => calls.labels.push(text), setLineDash() {}, measureText: text => ({ width: text.length * 8 }) }; },
    };
    return value;
  }
  const $ = id => { if (!elements.has(id)) elements.set(id, node(id === 'overlay' ? 'canvas' : 'div')); return elements.get(id); };
  const pages = ['home', 'tools', 'memory', 'devices', 'assessment', 'settings'].map(page => Object.assign(node('button'), { dataset: { asthaPage: page } }));
  $('cam').videoWidth = 1280; $('cam').videoHeight = 720;
  $('still').naturalWidth = 800; $('still').naturalHeight = 1000;
  const context = vm.createContext({
    console: { warn() {}, error: (...args) => calls.errors.push(args) }, $, uiLang: 'en', voiceLang: 'en',
    state: { source: null, sourceEpoch: 1, busy: false, audio: false, listening: false, shield: false },
    privacyMode: false, privacyTransition: false, LocalStore: { KEY: 'synthetic-detail-owner' },
    document: { hidden: false, body: node('body'), createElement: node,
      addEventListener: (key, action) => listeners.set(key, action), querySelector: () => $('main'),
      querySelectorAll: selector => selector === '[data-astha-page]' ? pages : [] },
    performance: { now: () => now }, Date: class extends Date { static now() { return now; } },
    setTimeout: (action, delay) => { const id = ++timerId; timers.set(id, { action, delay }); return id; }, clearTimeout: id => timers.delete(id),
    engine: { coco: { status: 'ready', type: 'coco-ssd', model: { detect: async () => { calls.detection++; return context.predictions(); } } } },
    COCO_TO_ID: { chair: 'chair', person: 'person' },
    posFromX: () => 'left', proxFromArea: () => null, isHazard: () => false,
    label: id => context.uiLang === 'bn' ? ({ chair: 'চেয়ার', person: 'মানুষ', cable: 'তার', card: 'কার্ড' })[id] || id : id,
    activeSourceEl: () => context.state.source === 'camera' ? $('cam') : context.state.source === 'pi' ? context.AsthaPiCamera.frame() : context.state.source ? $('still') : null,
    AsthaPiCamera: { frame: () => context.piFrame }, piFrame: null,
    AsthaDiagnostics: { setEnabled: () => calls.timing++, start: () => null, finish() {} },
    stopLiveLoop() {}, startLiveLoop() {}, setCaption() {}, announce: (...args) => calls.speech.push(args),
    toggleCamera: () => calls.camera++, fetch: () => { calls.network++; throw new Error('no network in this fixture'); },
    t: (key, params = {}) => { let text = strings[key]?.[context.uiLang === 'bn' ? 1 : 0] || ({ pos_left: ['left', 'বাঁয়ে'], pos_ahead: ['ahead', 'সামনে'], pos_right: ['right', 'ডানে'] })[key]?.[context.uiLang === 'bn' ? 1 : 0] || key;
      for (const [name, entry] of Object.entries(params)) text = text.split('{' + name + '}').join(entry); return text; },
  });
  context.window = context; context.ASTHA_ACCOUNT_ID = 'synthetic-detail-owner';
  context.predictions = async () => prediction;
  context.ensureVisionModels = async () => { calls.models++; return context.modelsReady(); }; context.modelsReady = async () => true;
  context.reading = { active: false }; context.reader = { active: false };
  vm.runInContext(cancellation + guardBusy + captureAndDetect + overlay + source + '\nglobalThis.details = AsthaVisionDetails;', context);
  const h = { context, calls, elements, timers, listeners, details: context.details, run: code => vm.runInContext(code, context),
    advance: ms => { now += ms; }, rows: () => $('vision-result-rows').children.map(row => row.children.map(cell => cell.textContent)),
    select(kind) { context.state.source = kind; context.state.sourceEpoch++; context.details.sourceChanged(); },
    async detect() { const frame = context.captureFrame(); const objects = await context.runCoco(frame); context.drawOverlay(frame, objects, []); return { frame, objects }; } };
  return h;
}

test('opening Detailed view and boot use the existing viewport without starting camera, model, network or timings', () => {
  const h = harness(); h.details.boot(); h.details.setVisible(true);
  assert.equal(h.calls.models, 0); assert.equal(h.calls.camera, 0); assert.equal(h.calls.detection, 0); assert.equal(h.calls.network, 0); assert.equal(h.calls.timing, 0);
  assert.equal(h.elements.get('vision-state').dataset.state, 'vision_off'); assert.equal(h.elements.get('vision-check').disabled, true);
  assert.equal(h.rows().length, 0);
  assert.equal((base.match(/id="cam"/g) || []).length, 1); assert.equal((base.match(/id="overlay"/g) || []).length, 1);
  assert.match(read('tools/assessment.html').slice(read('tools/assessment.html').indexOf('id="devices-page"')), /data-astha-page="tools" data-i18n="page_tools"/);
  assert.match(base, /class="btn accent detailed-entry"[^>]*data-astha-page="tools"/);
  assert.doesNotMatch(base.slice(base.indexOf('<section class="essentials"'), base.indexOf('<details class="type-instead"')), /data-astha-page="tools"/);
  h.elements.get('vision-camera').events.click(); assert.equal(h.calls.camera, 1, 'camera starts only after its explicit control');
});

test('actual capture/detect/overlay publish matching boxes, model score, frame geometry and bilingual rows', async () => {
  const h = harness(); h.select('photo'); const { frame, objects } = await h.detect();
  assert.equal(h.calls.detection, 1); assert.equal(frame.width, 640); assert.equal(frame.height, 800);
  assert.equal(h.calls.boxes.length, 1); assert.deepEqual(h.calls.boxes[0], prediction[0].bbox);
  assert.deepEqual(h.rows()[0], ['chair', 'Detector box', '82% model score', 'left']);
  assert.equal(h.elements.get('vision-model').textContent, strings.vision_model_coco[0]);
  assert.equal(h.elements.get('vision-state').dataset.state, 'vision_image_results');
  assert.equal(h.elements.get('vision-results').dataset.source, 'photo');
  assert.equal(h.elements.get('viewport').style.values['--vision-aspect'], '640 / 800');
  assert.match(h.calls.labels[0], /chair.*82%/);
  objects[0].id = 'card'; objects[0].score = .99; h.context.drawOverlay(frame, objects, []);
  assert.match(h.calls.labels.at(-1), /chair.*82%/, 'contextual relabeling does not replace the detector class/score');
  h.context.uiLang = 'bn'; h.details.render();
  assert.deepEqual(h.rows()[0], ['চেয়ার', 'শনাক্তকারীর বক্স', 'মডেলের স্কোর 82%', 'বাঁয়ে']);
  h.context.engine.coco.type = 'yolo26n'; h.details.modelChanged(); assert.equal(h.elements.get('vision-model').textContent, strings.vision_model_yolo[1]);
  h.elements.get('vision-model').textContent = strings.vision_model_idle[1];
  h.elements.get('vision-state').textContent = strings.vision_off[1];
  h.details.render(true);
  assert.equal(h.elements.get('vision-model').textContent, strings.vision_model_yolo[1], 'same-language translation refresh restores live state');
  assert.equal(h.elements.get('vision-state').textContent, strings.vision_image_results[1]);
});

test('CLIP zones stay separate from detector boxes and never become percent confidence or segmentation', async () => {
  const h = harness(); h.select('photo'); const { frame, objects } = await h.detect();
  h.context.drawOverlay(frame, objects, [{ id: 'cable', score: .22, pos: 'right', src: 'clip', at: 10000, zone: { x: 50, y: 50, s: 100 } },
    { id: 'chair', score: .9, pos: 'left', zone: { x: 0, y: 0, s: 100 } },
    { id: 'person', score: .7, pos: 'ahead', at: 5000, zone: { x: 0, y: 0, s: 100 } }]);
  assert.deepEqual(h.rows(), [['chair', 'Detector box', '82% model score', 'left'], ['cable', 'CLIP zone', '0.22', 'right']]);
  assert.match(h.calls.labels.at(-1), /CLIP ranking 0\.22/); assert.doesNotMatch(h.calls.labels.at(-1), /22%/);
  assert.equal(h.elements.get('vision-result-rows').children[1].dataset.resultKind, 'zone');
});

test('actual empty detector output, loading and failures never fabricate object rows', async () => {
  const h = harness(); h.select('photo'); h.context.predictions = async () => []; await h.detect();
  assert.equal(h.elements.get('vision-state').dataset.state, 'vision_no_boxes'); assert.equal(h.rows().length, 0);
  assert.ok(h.elements.get('vision-results').dataset.frame);
  h.context.engine.coco.status = 'loading'; h.details.modelChanged(); assert.equal(h.elements.get('vision-state').dataset.state, 'vision_loading');
  h.context.engine.coco.status = 'error'; h.details.modelChanged(); assert.equal(h.elements.get('vision-state').dataset.state, 'vision_failed');
  h.context.engine.coco.status = 'ready'; h.context.predictions = async () => { throw new Error('synthetic inference failure'); };
  await assert.rejects(h.context.runCoco(h.context.captureFrame()), /synthetic/);
  assert.equal(h.elements.get('vision-state').dataset.state, 'vision_failed'); assert.equal(h.rows().length, 0);
});

test('a skipped idle or failed detector preserves actual CLIP-only zones without claiming completed detection', async () => {
  for (const status of ['idle', 'error']) {
    const h = harness(); h.select('photo'); h.context.engine.coco.status = status; h.details.modelChanged();
    const frame = h.context.captureFrame(), objects = await h.context.runCoco(frame);
    assert.equal(objects.length, 0); assert.equal(h.calls.detection, 0);
    h.context.drawOverlay(frame, objects, [{ id: 'cable', score: .22, pos: 'right', src: 'clip', zone: { x: 50, y: 50, s: 100 } }]);
    assert.deepEqual(h.rows(), [['cable', 'CLIP zone', '0.22', 'right']]);
    assert.equal(h.elements.get('vision-state').dataset.state, 'vision_clip_only');
    assert.equal(h.elements.get('vision-model').textContent, strings[status === 'idle' ? 'vision_model_idle' : 'vision_model_error'][0]);
    assert.match(h.elements.get('vision-result-count').textContent, /Object boxes: 0; CLIP zones: 1/);
    const count = h.calls.boxes.length;
    h.context.drawOverlay(frame, [{ id: 'chair', score: .8, bbox: [0, 0, 10, 10] }], []);
    assert.equal(h.calls.boxes.length, count, 'a skipped detector cannot publish cached/fabricated object boxes');
    h.run('AsthaCancellation.cancel()'); h.context.drawOverlay(frame, objects, [{ id: 'cable', score: .22, zone: { x: 0, y: 0, s: 100 } }]);
    assert.equal(h.calls.boxes.length, count, 'skipped frames retain the same Stop guard');
  }
});

test('a pending or rejected detector is not a skipped detector and cannot prematurely publish CLIP-only results', async () => {
  const h = harness(), wait = deferred(); h.select('photo'); h.context.predictions = () => wait.promise;
  const frame = h.context.captureFrame(), pending = h.context.runCoco(frame);
  const zone = [{ id: 'cable', score: .22, pos: 'right', zone: { x: 0, y: 0, s: 100 } }];
  h.context.drawOverlay(frame, [], zone); assert.equal(h.rows().length, 0);
  wait.reject(new Error('synthetic detector failed')); await assert.rejects(pending, /synthetic/);
  h.context.drawOverlay(frame, [], zone); assert.equal(h.rows().length, 0);
});

test('delayed inference cannot repaint after Stop, source/epoch/account changes, hidden/visible transitions or source removal', async () => {
  for (const boundary of [h => h.run('AsthaCancellation.cancel()'), h => h.select('camera'), h => { h.context.state.sourceEpoch++; },
    h => { h.context.ASTHA_ACCOUNT_ID = 'other-owner'; }, h => { h.context.LocalStore.KEY = 'other-owner'; },
    h => { h.context.document.hidden = true; h.listeners.get('visibilitychange')(); h.context.document.hidden = false; h.listeners.get('visibilitychange')(); },
    h => h.select(null)]) {
    const h = harness(), wait = deferred(); h.details.boot(); h.select('photo'); h.context.predictions = () => wait.promise;
    const frame = h.context.captureFrame(), pending = h.context.runCoco(frame); boundary(h); const painted = h.calls.boxes.length;
    wait.resolve(prediction); const objects = await pending; h.context.drawOverlay(frame, objects, []);
    assert.equal(h.calls.boxes.length, painted); assert.equal(h.rows().length, 0); assert.equal(h.elements.get('vision-results').dataset.frame, '');
  }
});

test('an older completion cannot replace a newer frame, live boxes expire and still images remain clearly static', async () => {
  const h = harness(); h.select('camera'); const oldWait = deferred(); h.context.predictions = () => oldWait.promise;
  const first = h.context.captureFrame(), old = h.context.runCoco(first);
  h.context.predictions = async () => [{ class: 'person', score: .9, bbox: [20, 20, 60, 100] }];
  const newer = await h.detect(); const count = h.calls.boxes.length;
  oldWait.resolve(prediction); const oldObjects = await old; h.context.drawOverlay(first, oldObjects, []);
  assert.equal(h.calls.boxes.length, count); assert.equal(h.rows()[0][0], 'person');
  h.advance(3501); h.details.render(); assert.equal(h.rows().length, 0); assert.equal(h.elements.get('vision-state').dataset.state, 'vision_stale');
  h.context.drawOverlay(newer.frame, newer.objects, []); assert.equal(h.rows().length, 0);
  h.select('photo'); await h.detect(); h.advance(60000); h.details.render();
  assert.equal(h.rows()[0][0], 'person'); assert.equal(h.elements.get('vision-state').dataset.state, 'vision_image_results');
});

test('Pi link freshness is required before accepting or retaining its frame results', async () => {
  const h = harness(); h.context.piFrame = { width: 640, height: 480 }; h.select('pi'); await h.detect();
  assert.equal(h.rows().length, 1); h.context.piFrame = null; h.details.render();
  assert.equal(h.rows().length, 0); assert.equal(h.elements.get('vision-state').dataset.state, 'vision_stale');
});

test('explicit one-check control reuses one existing detector call and Stop during model initialization prevents inference', async () => {
  const h = harness(); h.select('photo'); await h.details.check(); assert.equal(h.calls.models, 1); assert.equal(h.calls.detection, 1);
  assert.equal(h.calls.camera, 0); assert.equal(h.calls.network, 0); assert.equal(h.calls.timing, 0); assert.equal(h.rows().length, 1);
  const wait = deferred(); h.context.modelsReady = () => wait.promise;
  const pending = h.details.check(); await settle(); h.run('AsthaCancellation.cancel()'); wait.resolve(true); await pending;
  assert.equal(h.calls.detection, 1, 'cancelled model load cannot start another inference');
});

test('result rendering stays bounded and uses text cells rather than model supplied markup', async () => {
  const h = harness(); h.select('photo'); const { frame, objects } = await h.detect();
  h.context.drawOverlay(frame, objects, Array.from({ length: 40 }, (_, i) => ({ id: 'zone-' + i, score: .2, pos: 'right', zone: { x: 0, y: 0, s: 100 } })));
  assert.equal(h.rows().length, 20); assert.ok(h.elements.get('vision-result-rows').children.every(row => row.children.length === 4));
});

test('a real captured-picture description survives status text and is explicitly timestamped and bilingual', () => {
  const h = harness(); h.select('photo');
  const frame = h.context.captureFrame();
  assert.equal(h.details.describeResult(frame, { en: '<b>A chair beside a desk.</b>', bn: 'টেবিলের পাশে চেয়ার।' }, 'online'), true);
  h.advance(20000); h.context.setCaption('Connection', 'Reconnected', 'system'); h.details.render();
  assert.equal(h.elements.get('vision-description-text').textContent, '<b>A chair beside a desk.</b>', 'model text stays literal, separate from system captions');
  assert.match(h.elements.get('vision-description-meta').textContent, /Captured at.*Selected image.*Online AI/);
  h.context.uiLang = 'bn'; h.details.render(true);
  assert.equal(h.elements.get('vision-description-text').textContent, 'টেবিলের পাশে চেয়ার।');
  assert.match(h.elements.get('vision-description-meta').textContent, /তোলা/);
});

test('description ownership rejects late results and clears prior text after Stop, source, profile, privacy or background changes', () => {
  for (const change of [h => h.run('AsthaCancellation.cancel()'), h => h.select('photo'),
    h => { h.context.ASTHA_ACCOUNT_ID = 'replacement'; }, h => { h.context.LocalStore.KEY = 'other'; },
    h => { h.context.privacyMode = true; }, h => { h.context.document.hidden = true; }]) {
    const h = harness(); h.select('photo'); const frame = h.context.captureFrame();
    assert(h.details.describeResult(frame, { en: 'Prior picture', bn: 'আগের ছবি' }, 'local'));
    change(h); h.details.render();
    assert.notEqual(h.elements.get('vision-description-text').textContent, 'Prior picture');
    assert.equal(h.details.describeResult(frame, { en: 'Late picture', bn: 'দেরির ছবি' }, 'online'), false);
  }
});

test('a delayed older picture description cannot replace a newer completed picture answer', () => {
  const h = harness(); h.select('photo'); const earlier = h.context.captureFrame();
  h.advance(8000); const newer = h.context.captureFrame();
  assert(h.details.describeResult(newer, { en: 'Newer picture', bn: 'নতুন ছবি' }, 'online'));
  assert.equal(h.details.describeResult(earlier, { en: 'Older picture', bn: 'আগের ছবি' }, 'online'), false);
  assert.equal(h.elements.get('vision-description-text').textContent, 'Newer picture');
});

test('Detailed view describe button explicitly uses the established detailed action without a second camera or periodic request', async () => {
  const h = harness(), requested = [];
  h.context.describeScene = (...args) => requested.push(args); h.details.boot(); h.select('photo');
  h.elements.get('vision-describe').events.click();
  assert.deepEqual(requested, [[undefined, true]]);
  assert.equal(h.calls.camera, 0); assert.equal(h.calls.network, 0);
  assert.equal(strings.vision_none[0], 'I am blind and use speech or touch');
  assert.match(strings.vision_no_boxes[0], /no object boxes/, 'detector empty state does not reuse the blindness setup label');
});

function identityHarness({ messageOwns = false } = {}) {
  const spoken = [], context = vm.createContext({ window: {}, state: { audio: false }, uiLang: 'en', voiceLang: 'en',
    document: { body: { classList: { add() {} } }, hidden: false },
    I18N: { en: { identity_intro: strings.identity_intro[0] }, bn: { identity_intro: strings.identity_intro[1] } },
    announce: (...args) => spoken.push(args), AsthaMessages: { route: () => messageOwns },
  });
  vm.runInContext(read('tools/experience.js') + '\nglobalThis.experience = AsthaExperience;', context);
  return { context, spoken, experience: context.experience };
}

test('whole local greeting/identity requests return the exact LUNEYRA introduction without camera/provider work', () => {
  const h = identityHarness();
  for (const query of ['Hello', 'hi LUNEYRA', 'Who are you?', 'Introduce yourself.', 'LUNEYRA, are you there?',
    'Hey LUNEYRA, introduce yourself.', 'লুনেইরা তুমি কে?', 'হেই লুনেইরা, তুমি কে?', 'হে লুনেইরা, নিজের পরিচয় দাও।',
    'হ্যালো লুনেইরা', 'নিজের পরিচয় দিন।', 'hi Astha', 'Astha, are you there?', 'আস্থা তুমি কে?', 'হ্যালো আস্থা']) {
    assert.equal(h.experience.route(query), true, query);
    assert.equal(h.spoken.at(-1)[0], 'Hello, I am LUNEYRA, your AI vision companion.');
    assert.equal(h.spoken.at(-1)[1], 'হ্যালো, আমি লুনেইরা, আপনার এআই দৃষ্টি সহায়ক।');
  }
  const owned = identityHarness({ messageOwns: true }); assert.equal(owned.experience.route('hello'), true); assert.equal(owned.spoken.length, 0, 'message replies own their text');
  for (const query of ['read the word hello', 'what does "who are you" mean', 'say hello to Rina', 'hello, read this page', 'হ্যালো শব্দটি পড়ো']) {
    assert.equal(h.experience.route(query), false, query);
  }
});
