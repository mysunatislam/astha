// Actual generated still reader, guided reader, local placement and busy/Stop paths.
// Models are deferred stand-ins; these tests do not establish device inference speed.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const read = file => fs.readFileSync(new URL('../' + file, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const base = read('tools/base.html'), moduleSource = read('tools/module.js'), offline = read('tools/offline.js'), built = read('web/index.html');
function section(source, first, last) {
  const start = source.indexOf(first), end = source.indexOf(last, start + first.length);
  assert(start >= 0 && end > start, 'Actual source boundary missing: ' + first);
  return source.slice(start, end);
}
const guardAndBusy = section(base, 'function captureLocalActionGuard()', '\nasync function analyzeStill(');
const cancellation = section(moduleSource, 'const AsthaCancellation =', '\nconst VoiceEchoFilter');
const stillReader = section(built, 'function readStillOnce()', '\nfunction renderShieldState()');
const guidedReader = section(moduleSource, 'async function ocrPage()', '\n// ---- Foreground hands-free');
const placement = section(offline, 'async function handleOnDevicePlacement(', '\n// ---- Search & guidance:');
const stop = section(offline, 'function stopAllSpeech()', '\n// ---- "Works without internet"');
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const settle = () => new Promise(resolve => setImmediate(resolve));
const localResult = { data: { lines: [{ confidence: 95, text: 'Synthetic page বাংলা' }] } };
const cloudResult = { lines: ['Synthetic online page বাংলা'], explainEn: 'Synthetic explanation', explainBn: 'পরীক্ষা' };

function harness() {
  const nodes = new Map();
  const calls = { ocr: 0, cloud: 0, detect: 0, clip: 0, model: 0, captions: [], speaks: [], announcements: [], readers: [], saves: [], errors: [], perceptions: 0, loops: 0 };
  const element = id => {
    if (!nodes.has(id)) nodes.set(id, { textContent: '', value: '', hidden: true, attributes: {}, setAttribute(key, value) { this.attributes[key] = value; } });
    return nodes.get(id);
  };
  const context = vm.createContext({
    console: { warn: (...args) => calls.errors.push(args), error: (...args) => calls.errors.push(args) },
    state: { source: 'photo', sourceEpoch: 1, busy: false, lastCocoPreds: [] },
    document: { hidden: false }, privacyMode: false, privacyTransition: false,
    LocalStore: { KEY: 'synthetic-owner-a' },
    reader: { onFinish: null }, reading: { active: true, ocrBusy: false, phase: 'ocr', readLines: new Set() },
    engine: { clip: { status: 'idle' } }, VOCAB_BY_ID: { wallet: { personal: true } },
    OfflineEar: { active: false }, VoiceEngine: { stop() {} },
    stopReader() {}, stopListening() {}, stopReading() { context.reading.active = false; },
    clearInterval() {}, setTimeout: () => 1,
    stopLiveLoop() {}, startLiveLoop: () => calls.loops++,
    $: element, t: key => key, tBn: key => key,
    setCaption: (...args) => calls.captions.push(args), speak: (...args) => calls.speaks.push(args),
    announce: (...args) => calls.announcements.push(args), startReader: text => calls.readers.push(text),
    playEarcon() {}, haptic() {}, logEvent() {}, heartSet() {}, heartHide() {}, heartFlash() {},
    captureFrame: () => ({ width: 640, height: 480 }), cleanOcrLine: text => text.trim(), normLine: text => text.toLowerCase(),
    cloudReady: () => false, cloudFail: error => calls.errors.push(error), sayGuide() {},
    perceptionHook: () => calls.perceptions++,
    findVocabMatch: item => ({ id: item, en: item, bn: 'মানিব্যাগ' }),
    centerRect: () => ({}), scoreEmbedding: () => [{ id: 'wallet', p: .8 }],
    parseSpokenPlace: () => ({ en: 'on the table', bn: 'টেবিলের ওপর' }),
    label: id => id, labelBn: id => id, objLabel: value => value.id, objLabelBn: value => value.id,
    addLocalMemory: value => calls.saves.push(value),
  });
  context.window = context; context.ASTHA_ACCOUNT_ID = 'synthetic-owner-a';
  context.worker = { recognize: async () => { calls.ocr++; return context.ocrResult(); } };
  context.ocrResult = async () => localResult;
  context.ensureOcr = async () => context.worker;
  context.cloudReadLines = async () => { calls.cloud++; return context.cloudResult(); };
  context.cloudResult = async () => cloudResult;
  context.ensureVisionModels = async () => { calls.model++; return context.modelResult(); };
  context.modelResult = async () => true;
  context.runCoco = async () => { calls.detect++; return context.detectResult(); };
  context.detectResult = async () => [];
  context.clipEmbedCrops = async () => { calls.clip++; return context.clipResult(); };
  context.clipResult = async () => [[.5]];
  vm.runInContext(cancellation + guardAndBusy + stillReader + guidedReader + placement + stop, context);
  const h = { context, calls, nodes, run: code => vm.runInContext(code, context) };
  h.effects = () => JSON.stringify({ captions: calls.captions, speaks: calls.speaks, announcements: calls.announcements,
    readers: calls.readers, saves: calls.saves, errors: calls.errors, transcript: element('ocr-text').textContent,
    readerText: element('reader-text').value, cloud: calls.cloud, ocr: calls.ocr, detect: calls.detect, clip: calls.clip, perceptions: calls.perceptions });
  return h;
}

test('still-image Stop during OCR loading prevents a new online request, local inference and failure speech', async () => {
  for (const reject of [false, true]) {
    const h = harness(), wait = deferred(); h.context.cloudReady = () => true; h.context.ensureOcr = () => wait.promise;
    const pending = h.run('readStillOnce()'); h.run('stopAllSpeech()'); const before = h.effects();
    if (reject) wait.reject(new Error('synthetic model failure')); else wait.resolve(h.context.worker);
    await pending; assert.equal(h.effects(), before); assert.equal(h.calls.cloud, 0); assert.equal(h.calls.ocr, 0);
  }
});

test('still-image Stop discards delayed local OCR success and failure without transcript or reader speech', async () => {
  for (const reject of [false, true]) {
    const h = harness(), wait = deferred(); h.context.ocrResult = () => wait.promise;
    const pending = h.run('readStillOnce()'); await settle(); assert.equal(h.calls.ocr, 1);
    h.run('stopAllSpeech()'); const before = h.effects();
    if (reject) wait.reject(new Error('synthetic inference failure')); else wait.resolve(localResult);
    await pending; assert.equal(h.effects(), before); assert.equal(h.calls.readers.length, 0);
  }
});

test('still-image Stop discards delayed cloud output and ordinary cloud failure cannot start fallback after Stop', async () => {
  for (const reject of [false, true]) {
    const h = harness(), wait = deferred(); h.context.cloudReady = () => true; h.context.cloudResult = () => wait.promise;
    const pending = h.run('readStillOnce()'); await settle(); assert.equal(h.calls.cloud, 1);
    h.run('stopAllSpeech()'); const before = h.effects();
    if (reject) wait.reject(new Error('synthetic provider failure')); else wait.resolve(cloudResult);
    await pending; assert.equal(h.effects(), before); assert.equal(h.calls.ocr, 0);
  }
});

test('still-image ordinary local, online and provider-fallback reading keep working', async () => {
  for (const mode of ['local', 'online', 'fallback']) {
    const h = harness(); h.context.cloudReady = () => mode !== 'local';
    if (mode === 'fallback') h.context.cloudResult = async () => { throw new Error('synthetic provider failure'); };
    await h.run('readStillOnce()');
    const expected = mode === 'online' ? cloudResult.lines[0] : localResult.data.lines[0].text;
    assert.equal(h.calls.readers[0], expected); assert.equal(h.nodes.get('ocr-text').textContent, expected);
    assert.equal(h.nodes.get('ocr-result').hidden, false); assert.equal(h.context.state.busy, false);
  }
});

test('source, epoch, account, local namespace, background and privacy changes invalidate delayed OCR', async () => {
  const boundaries = [h => { h.context.state.source = 'camera'; }, h => { h.context.state.sourceEpoch++; },
    h => { h.context.ASTHA_ACCOUNT_ID = 'synthetic-owner-b'; }, h => { h.context.LocalStore.KEY = 'synthetic-owner-b'; },
    h => { h.context.document.hidden = true; }, h => { h.context.privacyMode = true; }, h => { h.context.privacyTransition = true; }];
  for (const boundary of boundaries) {
    const h = harness(), wait = deferred(); h.context.ocrResult = () => wait.promise;
    const pending = h.run('readStillOnce()'); await settle(); boundary(h); const before = h.effects();
    wait.resolve(localResult); await pending; assert.equal(h.effects(), before);
  }
});

test('local placement Stop during model loading or detector inference prevents later perception, CLIP, saves and speech', async () => {
  for (const phase of ['modelResult', 'detectResult']) for (const reject of [false, true]) {
    const h = harness(), wait = deferred(); h.context[phase] = () => wait.promise; h.context.engine.clip.status = 'ready';
    const pending = h.run("handleOnDevicePlacement('my wallet is on the table', 'wallet')"); await settle();
    h.run('stopAllSpeech()'); const before = h.effects();
    if (reject) wait.reject(new Error('synthetic local failure')); else wait.resolve(phase === 'modelResult' ? true : []);
    await pending; assert.equal(h.effects(), before); assert.equal(h.calls.saves.length, 0); assert.equal(h.calls.clip, 0);
  }
});

test('local placement Stop during CLIP discards both a late embedding and late failure', async () => {
  for (const reject of [false, true]) {
    const h = harness(), wait = deferred(); h.context.engine.clip.status = 'ready'; h.context.clipResult = () => wait.promise;
    const pending = h.run("handleOnDevicePlacement('my wallet is on the table', 'wallet')"); await settle(); assert.equal(h.calls.clip, 1);
    h.run('stopAllSpeech()'); const before = h.effects();
    if (reject) wait.reject(new Error('synthetic CLIP failure')); else wait.resolve([[.5]]);
    await pending; assert.equal(h.effects(), before); assert.equal(h.calls.saves.length, 0);
  }
});

test('local placement keeps an explicit successful save and rejects changed source/account/privacy ownership', async () => {
  const ok = harness(); ok.context.engine.clip.status = 'ready';
  await ok.run("handleOnDevicePlacement('my wallet is on the table', 'wallet')");
  assert.equal(ok.calls.saves[0].item, 'wallet'); assert.equal(ok.calls.saves[0].location, 'on the table');
  assert.equal(ok.calls.saves[0].score, null); assert.match(ok.calls.announcements[0][0], /Remembered:/);
  for (const boundary of [h => { h.context.state.sourceEpoch++; }, h => { h.context.ASTHA_ACCOUNT_ID = 'synthetic-owner-b'; },
    h => { h.context.LocalStore.KEY = 'synthetic-owner-b'; }, h => { h.context.privacyMode = true; }]) {
    const h = harness(), wait = deferred(); h.context.detectResult = () => wait.promise;
    const pending = h.run("handleOnDevicePlacement('my wallet is on the table', 'wallet')"); await settle(); boundary(h);
    const before = h.effects(); wait.resolve([]); await pending; assert.equal(h.effects(), before); assert.equal(h.calls.saves.length, 0);
  }
});

test('guided OCR cannot start cloud work after Stop during initialization, or revive transcript after local/cloud inference', async () => {
  for (const phase of ['load', 'local', 'cloud']) {
    const h = harness(), wait = deferred(); h.context.state.source = 'camera';
    if (phase === 'load') { h.context.ensureOcr = () => wait.promise; h.context.cloudReady = () => true; }
    if (phase === 'local') h.context.ocrResult = () => wait.promise;
    if (phase === 'cloud') { h.context.cloudReady = () => true; h.context.cloudResult = () => wait.promise; }
    const pending = h.run('ocrPage()'); await settle(); h.run('stopAllSpeech()'); const before = h.effects();
    wait.resolve(phase === 'load' ? h.context.worker : phase === 'local' ? localResult : cloudResult);
    await pending; assert.equal(h.effects(), before); assert.equal(h.context.reading.ocrBusy, false);
    if (phase === 'load') assert.equal(h.calls.cloud, 0);
  }
});

test('guided OCR ordinary local and online reading still populates the reader', async () => {
  for (const online of [false, true]) {
    const h = harness(); h.context.state.source = 'camera'; h.context.cloudReady = () => online;
    await h.run('ocrPage()'); assert.equal(h.calls.readers[0], online ? cloudResult.lines[0] : localResult.data.lines[0].text);
    assert.equal(h.context.reading.ocrBusy, false);
  }
});

test('Stop immediately releases busy and an old completion cannot unlock or restart a newer operation', async () => {
  for (const reject of [false, true]) {
    const h = harness(), old = deferred(), next = deferred(); h.context.state.source = 'camera'; h.context.old = old.promise; h.context.next = next.promise;
    const first = h.run("withBusy('first', () => old)"); assert.equal(h.context.state.busy, true);
    h.run('stopAllSpeech()'); assert.equal(h.context.state.busy, false);
    assert.equal(h.nodes.get('companion-main').attributes['aria-busy'], 'false');
    const second = h.run("withBusy('second', () => next)"); const currentToken = h.context.state.busyToken;
    if (reject) old.reject(new Error('synthetic stale failure')); else old.resolve();
    await first; assert.equal(h.context.state.busy, true); assert.equal(h.context.state.busyToken, currentToken);
    assert.equal(h.nodes.get('companion-main').attributes['aria-busy'], 'true'); assert.equal(h.calls.loops, 0);
    assert.equal(h.calls.errors.length, 0); assert.equal(h.calls.announcements.length, 0);
    next.resolve(); await second; assert.equal(h.context.state.busy, false); assert.equal(h.calls.loops, 1);
  }
});
