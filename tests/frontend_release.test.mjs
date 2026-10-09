import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n');
const base = read('tools/base.html');
const moduleSource = read('tools/module.js');
const cloudSource = read('tools/cloud.js');
function section(source, start, end) {
  const a = source.indexOf(start);
  const b = source.indexOf(end, a + start.length);
  assert(a >= 0 && b > a, `Missing source boundary: ${start}`);
  return source.slice(a, b);
}
const policy = section(moduleSource, 'function apiUrl(path)', 'const VoiceEchoFilter');
const cloudPolicy = section(cloudSource, 'const cloud =', 'const ASTHA_SYSTEM');
const voice = section(moduleSource, 'const VoiceEchoFilter', 'function asthaSpeaking()');
const utterance = section(base, 'function makeUtterance(', 'function speak(enText');
const siri = section(moduleSource, 'const SiriVoice =', 'function toggleHandsFree()');
const boot = section(moduleSource, 'function companionBoot()', 'function backendReachable()');
const api = section(moduleSource, 'function backendReachable()', 'async function refreshMemory()');
const gemini = section(cloudSource, 'async function gemini(', 'function parseJsonLoose(');
const translations = section(base, 'const I18N =', '/* =====================================================================\n   2. Clinical Audio');
const languageSetters = section(base, 'function setUiLanguage(', 'function applyLanguage()');

function harness(saved = {}, consent = true) {
  const storage = new Map(Object.entries({ 'astha.ai_mode': 'gemini', ...saved }));
  const calls = { fetch: [], speech: [], recognition: 0, listeners: [], timers: [] };
  const elements = new Map();
  const $ = id => {
    if (!elements.has(id)) elements.set(id, { value: '1', textContent: '', dataset: {}, style: {}, classList: { add() {}, remove() {}, toggle() {} }, setAttribute() {} });
    return elements.get(id);
  };
  const context = vm.createContext({
    console, Date, AbortController, AbortSignal, URL: { createObjectURL: () => 'blob:test', revokeObjectURL() {} },
    navigator: { onLine: true }, privacyMode: false, privacyTransition: false,
    state: { audio: true, listening: false }, voiceLang: 'bn', $, calls,
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)) },
    voices: [{ name: 'Local Bangla', lang: 'bn-BD', localService: true }],
    SpeechSynthesisUtterance: function (text) { this.text = text; },
    fetch: async (...args) => { calls.fetch.push(args); return { ok: false, status: 503 }; },
    setTimeout: callback => { calls.timers.push(callback); return calls.timers.length; }, clearTimeout() {},
    sanitizeForSpeech: text => text, populateVoices() {}, playEarcon() {}, logEvent() {},
    announce() {}, sttLang: () => 'bn-BD', stopAllSpeech() {}, t: key => key,
  });
  context.window = {
    confirm: text => { calls.confirmations ??= []; calls.confirmations.push(text); return false; },
    addEventListener: (name, callback) => calls.listeners.push({ name, callback }),
    speechSynthesis: { cancel() {}, addEventListener() {}, speak(u) { calls.speech.push(u); queueMicrotask(() => u.onend?.()); } },
    SpeechRecognition: class { start() { calls.recognition++; } abort() {} },
  };
  const run = script => vm.runInContext(script, context);
  run(policy + cloudPolicy);
  if (consent) run('remoteProcessingConsent = true');
  return { context, calls, storage, run };
}

test('no implicit demo credential or embedded Maira project credential remains', () => {
  assert(!cloudSource.includes('DEFAULT_PASS_TOKEN'));
  assert(!/const pKey\s*=\s*['"]/.test(cloudSource));
  const h = harness();
  assert.equal(h.run('getEffectiveKey()'), '');
  assert.equal(h.run('cloudReady()'), false);
  h.run('serverCloud.available = true');
  assert.equal(h.run('cloudReady()'), true);
  h.context.privacyMode = true;
  assert.equal(h.run('cloudReady()'), false);
});

test('explicit stored personal key remains available without fabricating a key', () => {
  const h = harness({ 'astha.gemini': 'user-supplied-test-key' });
  assert.equal(h.run('getEffectiveKey()'), 'user-supplied-test-key');
  assert.equal(h.run('cloudReady()'), true);
  h.storage.set('astha.ai_mode', 'offline');
  assert.equal(h.run('cloudReady()'), false);
});

test('remote processing requires explicit session consent and never prompts on boot', () => {
  const h = harness({}, false);
  h.run('serverCloud.available = true');
  assert.equal(h.run('cloudReady()'), false);
  assert.equal(h.run('remoteProcessingAllowed()'), false);
  assert.equal(h.calls.confirmations, undefined);
  h.run("Subscription.setMode('gemini', true)");
  assert.equal(h.run('remoteProcessingAllowed()'), false);
  assert.equal(h.calls.confirmations.length, 1);
  h.context.window.confirm = text => { h.calls.confirmations.push(text); return true; };
  h.run("Subscription.setMode('gemini', true)");
  assert.equal(h.run('remoteProcessingAllowed()'), true);
  h.run("Subscription.setMode('offline', true)");
  assert.equal(h.run('remoteProcessingConsent'), false);
  assert.equal(h.run('remoteProcessingAllowed()'), false);
});

test('fresh profiles select on-device mode without a client-side entitlement', () => {
  const h = harness({}, false);
  h.storage.delete('astha.ai_mode');
  h.run('Subscription.init()');
  assert.equal(h.run('Subscription.getMode()'), 'offline');
  assert.equal(h.calls.confirmations, undefined);
  assert(!cloudSource.includes('TRIAL_DAYS'));
});

test('documented stable Gemini default and bounded explicit runtime model list', () => {
  const h = harness();
  assert.equal(h.run('cloud.model'), 'gemini-3.6-flash');
  assert.deepEqual(Array.from(h.run('configuredClientModels()')), ['gemini-3.6-flash']);
  h.context.window.ASTHA_GEMINI_MODELS = ['explicit-first', 'explicit-second'];
  assert.deepEqual(Array.from(h.run('configuredClientModels()')), ['explicit-first', 'explicit-second']);
  for (const invalid of [['one', 'two', 'three', 'four'], ['bad/path'], [23], []]) {
    h.context.window.ASTHA_GEMINI_MODELS = invalid;
    assert.deepEqual(Array.from(h.run('configuredClientModels()')), ['gemini-3.6-flash']);
  }
});

test('personal Gemini falls back only for a mocked 404 on explicitly configured models', async () => {
  const h = harness({ 'astha.gemini': 'user-supplied-test-key' });
  h.context.window.ASTHA_GEMINI_MODELS = ['explicit-first', 'explicit-second'];
  h.context.ASTHA_SYSTEM = 'test-system';
  h.context.fetch = async (url, options) => {
    h.calls.fetch.push([url, options]);
    return h.calls.fetch.length === 1 ? { status:404, ok:false } : { status:200, ok:true, json:async () => ({candidates:[{content:{parts:[{text:'{"en":"fixture response","bn":"পরীক্ষা"}'}]}}]}) };
  };
  h.run(gemini + section(cloudSource, 'function parseJsonLoose(', 'function cloudFail('));
  const result = await h.run("gemini('describe', null)");
  assert.equal(result.en, 'fixture response');
  assert.equal(h.calls.fetch.length, 2);
  assert(h.calls.fetch[0][0].includes('explicit-first:'));
  assert(h.calls.fetch[1][0].includes('explicit-second:'));
  assert.equal(h.run('cloud.model'), 'explicit-second');
  h.calls.fetch = [];
  h.context.fetch = async (url, options) => { h.calls.fetch.push([url,options]); return {status:500,ok:false}; };
  await assert.rejects(h.run("gemini('describe', null)"), /Gemini 500/);
  assert.equal(h.calls.fetch.length, 1);
});

test('cloud entry point refuses privacy/offline processing before capture or fetch', async () => {
  for (const mode of ['privacy', 'transition', 'offline', 'network']) {
    const h = harness();
    h.run(gemini);
    if (mode === 'privacy') h.context.privacyMode = true;
    if (mode === 'transition') h.context.privacyTransition = true;
    if (mode === 'offline') h.storage.set('astha.ai_mode', 'offline');
    if (mode === 'network') h.context.navigator.onLine = false;
    await assert.rejects(h.run("gemini('describe', null)"), /remote processing disabled/);
    assert.equal(h.calls.fetch.length, 0);
  }
});

test('offline/private TTS uses only a local device voice and sends no request', async () => {
  for (const mode of ['privacy', 'transition', 'offline', 'network']) {
    const h = harness();
    h.run(api + utterance + voice);
    if (mode === 'privacy') h.context.privacyMode = true;
    if (mode === 'transition') h.context.privacyTransition = true;
    if (mode === 'offline') h.storage.set('astha.ai_mode', 'offline');
    if (mode === 'network') h.context.navigator.onLine = false;
    assert.equal(await h.run("VoiceEngine.speak('বাংলা উত্তর', 'bn')"), true);
    assert.equal(h.calls.fetch.length, 0);
    assert.equal(h.calls.speech.length, 1);
    assert.equal(h.calls.speech[0].voice.localService, true);
  }
});

test('missing local Bangla voice cannot silently use a remote synthesis voice offline', async () => {
  const h = harness({ 'astha.ai_mode': 'offline' });
  h.context.voices = [{ name: 'Remote Bangla', lang: 'bn-BD', localService: false }];
  h.run(api + utterance + voice);
  assert.equal(await h.run("VoiceEngine.speak('বাংলা উত্তর', 'bn')"), false);
  assert.equal(h.calls.fetch.length, 0);
  assert.equal(h.calls.speech.length, 0);
});

test('online server TTS failure retains the existing device voice fallback', async () => {
  const h = harness();
  h.run(api + utterance + voice);
  assert.equal(await h.run("VoiceEngine.speak('বাংলা উত্তর', 'bn')"), true);
  assert.equal(h.calls.fetch.length, 1);
  assert.equal(h.calls.speech.length, 1);
});

test('Stop aborts pending server TTS and a late response cannot speak', async () => {
  const h = harness();
  let respond;
  let requestSignal;
  h.context.fetch = async (_url, options) => { requestSignal = options.signal; return new Promise(resolve => { respond = resolve; }); };
  h.run(api + utterance + voice);
  const pending = h.run("VoiceEngine.speak('বাংলা উত্তর', 'bn')");
  h.run('VoiceEngine.stop()');
  assert.equal(requestSignal.aborted, true);
  respond({ ok: false });
  assert.equal(await pending, false);
  assert.equal(h.calls.speech.length, 0);
});

test('account switch while waiting for health cannot upload an earlier account note', async () => {
  const h = harness();
  h.run(api);
  h.context.window.ASTHA_ACCOUNT_ID = 'account-a';
  h.run('serverCloud.ready = new Promise(resolve => { window.finishHealth = resolve; });');
  const pending = h.run("apiSend('POST', '/api/memories', {item:'wallet'})");
  h.context.window.ASTHA_ACCOUNT_ID = 'account-b';
  h.context.window.finishHealth();
  await assert.rejects(pending, /backend_unreachable/);
  assert.equal(h.calls.fetch.length, 0);
});

test('a personal Maira key without an explicit project cannot advertise cloud readiness', () => {
  const h = harness({ 'astha.gemini': 'gAAAAA-test-key' });
  assert.equal(h.run('cloudReady()'), false);
  h.context.window.ASTHA_MAIRA_PROJECT_KEY = 'explicit-test-project';
  assert.equal(h.run('cloudReady()'), true);
});

test('request deadline preserves caller cancellation, including older mobile fallback', () => {
  for (const native of [true, false]) {
    const h = harness();
    if (!native) h.context.AbortSignal = undefined;
    const controller = new AbortController();
    h.context.callerSignal = controller.signal;
    const combined = h.run('deadlineSignal(10000, callerSignal)');
    assert.equal(combined.aborted, false);
    controller.abort();
    assert.equal(combined.aborted, true);
  }
});

test('API requests apply 10-second deadlines and forward caller abort', async () => {
  const h = harness();
  const deadlines = [];
  h.context.AbortSignal = { timeout: ms => { deadlines.push(ms); return new AbortController().signal; }, any: AbortSignal.any };
  h.run(api);
  const caller = new AbortController(); h.context.callerSignal = caller.signal;
  await assert.rejects(h.run("apiGet('/api/health', {signal:callerSignal})"), /http_503/);
  assert.deepEqual(deadlines, [10000]);
  caller.abort();
  assert.equal(h.calls.fetch[0][1].signal.aborted, true);
});

test('boot and unrelated interactions never request microphone consent', () => {
  const h = harness();
  h.run(siri + boot);
  h.run('companionBoot(); SiriVoice.start()');
  assert.equal(h.calls.recognition, 0);
  assert.equal(h.calls.timers.length, 0);
  assert(!h.calls.listeners.some(l => l.name === 'pointerdown' || l.name === 'keydown'));
  h.run('SiriVoice.toggle()');
  assert.equal(h.calls.recognition, 1);
});

test('explicit hands-free opt-in is still blocked in privacy/offline mode', () => {
  for (const mode of ['privacy', 'offline', 'network']) {
    const h = harness();
    h.run(siri);
    if (mode === 'privacy') h.context.privacyMode = true;
    if (mode === 'offline') h.storage.set('astha.ai_mode', 'offline');
    if (mode === 'network') h.context.navigator.onLine = false;
    h.run('SiriVoice.toggle()');
    assert.equal(h.calls.recognition, 0);
  }
});

test('switching to offline cancels hands-free consent and active recognizer', () => {
  const h = harness();
  h.run(siri);
  h.run("SiriVoice.toggle(); Subscription.setMode('offline', true)");
  assert.equal(h.run('SiriVoice.enabled'), false);
  assert.equal(h.run('SiriVoice.active'), false);
});

test('personal data never syncs from an unknown local profile or privacy mode', async () => {
  const h = harness();
  h.run(api);
  await assert.rejects(h.run("apiSend('POST', '/api/memories', {item:'wallet'})"), /backend_unreachable/);
  assert.equal(h.calls.fetch.length, 0);
  h.context.window.ASTHA_ACCOUNT_ID = 'verified-account-test-id';
  h.context.privacyMode = true;
  await assert.rejects(h.run("apiGet('/api/rooms')"), /backend_unreachable/);
  assert.equal(h.calls.fetch.length, 0);
});

test('Bangla is the default UI while UI and voice preferences stay independent', () => {
  const h = harness({ 'astha.voice_lang': 'en' });
  delete h.context.voiceLang;
  h.run(translations + languageSetters + 'function applyLanguage(){ window.currentUi = uiLang; }');
  assert.equal(h.run('uiLang'), 'bn');
  assert.equal(h.run('voiceLang'), 'en');
  assert.equal(h.run("t('brand')"), 'আস্থা');
  h.run("setUiLanguage('en')");
  assert.equal(h.run("t('brand')"), 'Astha');
  assert.equal(h.run('voiceLang'), 'en');
  assert.equal(h.storage.get('astha.ui_lang'), 'en');
  h.run("setUiLanguage('bn')");
  assert.equal(h.run('voiceLang'), 'en');
  assert.equal(h.run("t('missing_key')"), 'missing_key');
  h.run("I18N.en.fallback_test = 'Hello {name}';");
  assert.equal(h.run("t('fallback_test', {name:'ASTHA'})"), 'Hello ASTHA');
});

test('invalid persisted locale values fall back without breaking dictionaries', () => {
  const h = harness({ 'astha.ui_lang': '../../invalid', 'astha.voice_lang': 'unknown' });
  delete h.context.voiceLang;
  h.run(translations);
  assert.equal(h.run('uiLang'), 'bn');
  assert.equal(h.run('voiceLang'), 'bn');
  assert.equal(h.run("t('brand')"), 'আস্থা');
});

test('unrequested observations do not save memory in the module implementation', async () => {
  const h = harness();
  h.context.state.memory = [];
  h.run(section(moduleSource, 'async function autoRecordMemory(', 'async function saveManualMemory()'));
  await h.run("autoRecordMemory({item:'wallet', location:'table'})");
  assert.equal(h.context.state.memory.length, 0);
  assert.equal(h.calls.fetch.length, 0);
});

test('live observations never invoke passive memory tracking or announce a saved note', () => {
  const h = harness();
  let passiveTracking = 0;
  const announcements = [];
  Object.assign(h.context, {
    worldSorted: () => [], isHazard: () => false,
    trackItemPlacementOnFurniture: () => { passiveTracking++; announcements.push('Remembered'); },
    announce: text => announcements.push(text), captureFrame: () => ({}),
  });
  h.context.state.shield = false; h.context.state.narrate = false;
  h.run(section(base, 'function afterLiveUpdate()', 'function showHazard('));
  h.run('afterLiveUpdate()');
  assert.equal(passiveTracking, 0);
  assert.deepEqual(announcements, []);
});

test('explicit cloud placement approves a note without inventing confidence or location', async () => {
  const h = harness();
  const notes = [];
  Object.assign(h.context, {
    withBusy: (_label, fn) => fn(), heartSet() {}, heartFlash() {}, haptic() {},
    captureFrame: () => ({}), CLOUD_PROMPTS: { placement: 'placement-test' },
    gemini: async () => ({ en: 'Your requested note', item: 'wallet' }),
    autoRecordMemory: note => notes.push(note),
  });
  h.run(section(cloudSource, 'async function cloudRecordPlacement(', 'async function cloudRecordPassivePlacement('));
  await h.run("cloudRecordPlacement('remember my wallet here', null, '')");
  assert.equal(notes.length, 1);
  assert.equal(notes[0].approved, true);
  assert.equal(notes[0].score, null);
  assert.equal(notes[0].location, 'Physical location unconfirmed');
});

test('stabilized source and any built inline scripts remain valid JavaScript', () => {
  new vm.Script(moduleSource, { filename: 'tools/module.js' });
  new vm.Script(cloudSource, { filename: 'tools/cloud.js' });
  const generated = path.join(root, 'web/index.html');
  if (!fs.existsSync(generated)) return;
  const html = fs.readFileSync(generated, 'utf8');
  for (const match of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) {
    if (match[1].trim()) new vm.Script(match[1], { filename: 'web/index.html inline script' });
  }
  assert(!html.includes('DEFAULT_PASS_TOKEN'));
  assert(html.includes('id="ui-language"'));
});
