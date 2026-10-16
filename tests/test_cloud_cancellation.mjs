import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const read = file => fs.readFileSync(new URL('../' + file, import.meta.url), 'utf8');
const cloud = read('tools/cloud.js'), module = read('tools/module.js');
const base = read('tools/base.html');
const localGuard = base.slice(base.indexOf('function captureLocalActionGuard()'), base.indexOf('async function withBusy('));
const policy = module.slice(module.indexOf('function apiUrl(path)'), module.indexOf('const VoiceEchoFilter'));
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const settle = () => new Promise(resolve => setImmediate(resolve));
const cancelled = error => error?.cancelled === true && error?.noCloud === true;
const reply = (value, status = 200) => ({ status, ok: status >= 200 && status < 300, json: async () => value });
const result = { en: 'Synthetic answer', bn: 'পরীক্ষামূলক উত্তর', text: 'Synthetic text', name: 'wallet', garment: 'shirt', colour: 'blue',
  objects: ['wallet'], item: 'wallet', surface: 'table', furniture: ['table'], found: true };

function harness() {
  const calls = { fetch: [], json: 0, announces: [], speaks: [], fallback: [], saves: [], warnings: [], captions: [] };
  const elements = new Map(), timers = new Map(), stored = new Map([['astha.ai_mode', 'gemini']]); let timer = 0;
  const context = vm.createContext({
    AbortController, AbortSignal, Date, navigator: { onLine: true },
    privacyMode: false, privacyTransition: false, uiLang: 'en', voiceLang: 'en',
    state: { source: 'camera', sourceEpoch: 1 }, document: { hidden: false },
    console: { warn: (...args) => calls.warnings.push(args) },
    localStorage: { getItem: key => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, value) },
    $: id => { if (!elements.has(id)) elements.set(id, { value: '', textContent: '', style: {}, classList: { toggle() {} }, setAttribute() {} }); return elements.get(id); },
    withBusy: (_title, action) => action(), captureFrame: () => ({ width: 640, height: 480 }),
    t: key => key, tBn: key => key, announce: (...args) => calls.announces.push(args), speak: (...args) => calls.speaks.push(args),
    setCaption: (...args) => calls.captions.push(args), heartSet() {}, heartFlash() {}, heartPointAt() {}, showHazard() {},
    playEarcon() {}, haptic() {}, logEvent() {}, objLabel: object => object.id,
    autoRecordMemory: value => calls.saves.push(value), COMPLIMENTS: [['Synthetic compliment', 'পরীক্ষামূলক প্রশংসা']],
    describeScene: () => calls.fallback.push('describe'), identifyObject: () => calls.fallback.push('identify'),
    inspectClothesAndColor: () => calls.fallback.push('clothes'), startReading: () => calls.fallback.push('read'),
    safetyCheck: () => calls.fallback.push('safety'), AsthaExperience: { admit: () => true },
    setTimeout: (callback, delay) => { const id = ++timer; timers.set(id, { callback, delay }); return id; }, clearTimeout: id => timers.delete(id),
  });
  context.window = context;
  context.ASTHA_ACCOUNT_ID = 'synthetic-cloud-owner';
  vm.runInContext(policy + localGuard + cloud.slice(0, cloud.indexOf('// ---- Modes:')) + '\nremoteProcessingConsent=true;serverCloud.available=true;globalThis.cancellation=AsthaCancellation;', context);
  context.frameToJpeg = () => 'synthetic-image';
  context.fetch = async (url, options) => { calls.fetch.push({ url, options }); return context.transport(url, options); };
  context.transport = async () => reply(result);
  return { context, calls, elements, timers, run: code => vm.runInContext(code, context), cancel: () => context.cancellation.cancel(),
    timersRun() { for (const [id, value] of [...timers]) { timers.delete(id); value.callback(); } } };
}

test('Stop aborts the actual request, promptly rejects an abort-ignoring transport and unregisters its controller', async () => {
  const h = harness(), wait = deferred(); h.context.transport = () => wait.promise;
  const pending = h.run("gemini('Synthetic request', null)");
  assert.equal(h.context.cancellation.controllers.size, 1);
  h.cancel();
  await assert.rejects(pending, cancelled);
  assert.equal(h.calls.fetch[0].options.signal.aborted, true);
  assert.equal(h.context.cancellation.controllers.size, 0);
  wait.resolve(reply(result)); await settle();
  assert.equal(h.calls.saves.length, 0); assert.equal(h.calls.announces.length, 0);
});

test('Stop rejects a pending body decode; its late result cannot become a successful response', async () => {
  const h = harness(), body = deferred();
  h.context.transport = async () => ({ status: 200, ok: true, json() { h.calls.json++; return body.promise; } });
  const pending = h.run("gemini('Synthetic request', null)"); await settle();
  assert.equal(h.calls.json, 1); h.cancel();
  await assert.rejects(pending, cancelled);
  body.resolve(result); await settle();
  assert.equal(h.context.cancellation.controllers.size, 0);
});

test('caller cancellation is combined with Stop and a fresh request still succeeds after either', async () => {
  const h = harness(), caller = new AbortController(), wait = deferred();
  h.context.caller = caller; h.context.transport = () => wait.promise;
  const pending = h.run("gemini('Synthetic request', null, {signal:caller.signal})"); caller.abort();
  await assert.rejects(pending, cancelled); assert.equal(h.calls.fetch[0].options.signal.aborted, true);
  h.cancel(); h.context.transport = async () => reply(result);
  assert.equal((await h.run("gemini('New synthetic request', null)")).en, result.en);
  assert.equal(h.context.cancellation.controllers.size, 0);
  wait.resolve(reply(result)); await settle();
});

test('account, source, source epoch, background and consent changes invalidate delayed fetches and bodies', async () => {
  const changes = [h => { h.context.ASTHA_ACCOUNT_ID = 'other-owner'; }, h => { h.context.state.source = 'photo'; },
    h => { h.context.state.sourceEpoch++; }, h => { h.context.document.hidden = true; }, h => h.run('remoteProcessingConsent=false')];
  for (const boundary of changes) for (const phase of ['fetch', 'body']) {
    const h = harness(), wait = deferred();
    h.context.transport = phase === 'fetch' ? () => wait.promise : async () => ({ status: 200, ok: true, json: () => wait.promise });
    const pending = h.run("gemini('Synthetic request', null)"); await settle(); boundary(h);
    wait.resolve(phase === 'fetch' ? reply(result) : result);
    await assert.rejects(pending, cancelled); assert.equal(h.context.cancellation.controllers.size, 0);
  }
});

test('canceled public describe, identify, clothes, reading and safety actions never announce, save or fall back', async () => {
  for (const action of ['cloudDescribe()', 'cloudIdentify()', 'cloudClothes()', 'cloudReadLive()', 'cloudSafetyCheck(false)']) {
    for (const phase of ['fetch', 'body']) {
      const h = harness(), wait = deferred();
      h.context.transport = phase === 'fetch' ? () => wait.promise : async () => ({ status: 200, ok: true, json: () => wait.promise });
      const pending = h.run(action); await settle(); h.cancel(); await pending;
      wait.resolve(phase === 'fetch' ? reply(result) : result); await settle(); h.timersRun();
      assert.equal(h.calls.announces.length, 0, action); assert.equal(h.calls.speaks.length, 0, action);
      assert.equal(h.calls.saves.length, 0, action); assert.equal(h.calls.fallback.length, 0, action);
      assert.equal(h.elements.get('reader-text')?.value || '', '', action);
    }
  }
});

test('canceled mirror compliments and verified narration cannot resurrect speech or fallback text', async () => {
  for (const action of ["cloudCompliment({}, {})", "cloudVerifyAndSpeak([{id:'wallet'}], 'fallback', 'পরীক্ষা')"]) {
    const h = harness(), wait = deferred(); h.context.transport = () => wait.promise;
    const pending = h.run(action); h.cancel(); await pending;
    wait.resolve(reply(result)); await settle();
    assert.equal(h.calls.announces.length, 0); assert.equal(h.calls.speaks.length, 0); assert.equal(h.calls.saves.length, 0);
    assert.equal(h.context.state.lastComplimentAt, undefined);
  }
});

test('canceled explicit placement never announces or saves; cancellation propagates to its caller', async () => {
  const h = harness(), wait = deferred(); h.context.transport = () => wait.promise;
  const pending = h.run("cloudRecordPlacement('remember synthetic wallet', {}, '')"); h.cancel();
  await assert.rejects(pending, cancelled); wait.resolve(reply(result)); await settle();
  assert.equal(h.calls.announces.length, 0); assert.equal(h.calls.saves.length, 0);
});

test('canceled calibration propagates instead of returning a normal empty result for local fallback', async () => {
  const h = harness(), wait = deferred(); h.context.transport = () => wait.promise;
  const pending = h.run("cloudCalibrateVideoFrame({}, 'Synthetic room')"); h.cancel();
  await assert.rejects(pending, cancelled); wait.resolve(reply(result)); await settle();
});

test('real failures retain on-device fallback and a Stop after scheduling suppresses that fallback', async () => {
  for (const [action, expected] of [['cloudDescribe()', 'describe'], ['cloudIdentify()', 'identify'], ['cloudClothes()', 'clothes'],
    ['cloudReadLive()', 'read'], ['cloudSafetyCheck(false)', 'safety']]) {
    for (const stop of [false, true]) {
      const h = harness(); h.context.transport = async () => { throw new Error('Synthetic transport failure'); };
      await h.run(action); if (stop) h.cancel(); h.timersRun();
      assert.deepEqual(h.calls.fallback, stop ? [] : [expected], action);
    }
  }
});

test('HTTP errors and ordinary deadline failures stay failures rather than being mislabeled as Stop', async () => {
  for (const response of [async () => reply({}, 429), async () => reply({}, 503), async () => { throw new DOMException('Synthetic deadline', 'TimeoutError'); }]) {
    const h = harness(); h.context.transport = response;
    await assert.rejects(h.run("gemini('Synthetic request', null)"), error => error.cancelled !== true);
    assert.equal(h.context.cancellation.controllers.size, 0);
  }
});

test('automatic observations reuse one existing request and only its guarded structured result', async () => {
  const h = harness(), observations = [], metadata = [{ item: 'wallet', visible: true, clarity: 'clear', position: 'right' }];
  h.context.AsthaObservationMemory = { prompt: () => '\nStructured memory test schema', observeCloud: (frame, values) => observations.push(values), stop() {} };
  h.context.transport = async () => reply({ ...result, memory_observations: metadata });
  await h.run('cloudDescribe()');
  assert.equal(h.calls.fetch.length, 1); assert.deepEqual(observations, [metadata]);
  assert.match(JSON.parse(h.calls.fetch[0].options.body).prompt, /Structured memory test schema/);
  const wait = deferred(); let taskCurrent = true;
  h.context.transport = () => wait.promise; h.context.taskCurrent = () => taskCurrent;
  const pending = h.run("cloudVisualQA('synthetic question', {}, '', taskCurrent)");
  taskCurrent = false; wait.resolve(reply({ ...result, memory_observations: metadata })); await pending;
  assert.equal(observations.length, 1, 'a superseded task cannot save observations before its caller checks currentness');
  await h.run('gemini("Synthetic OCR request", {})');
  assert.equal(observations.length, 1, 'reading does not opt into automatic object metadata');
  assert.doesNotMatch(JSON.parse(h.calls.fetch.at(-1).options.body).prompt, /Structured memory test schema/);
});
