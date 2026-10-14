import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const cloudSource = fs.readFileSync(new URL('../tools/cloud.js', import.meta.url), 'utf8');
const moduleSource = fs.readFileSync(new URL('../tools/module.js', import.meta.url), 'utf8');
function section(source, start, end) {
  const a = source.indexOf(start), b = source.indexOf(end, a + start.length);
  assert(a >= 0 && b > a, `Missing source boundary: ${start}`);
  return source.slice(a, b);
}
const policy = section(moduleSource, 'function apiUrl(path)', 'const VoiceEchoFilter');
const cloudPolicy = section(cloudSource, 'const cloud =', 'const ASTHA_SYSTEM');
const request = section(cloudSource, 'async function gemini(', 'function cloudFail(');

function harness({ key = '', consent = true, account = 'verified-account', device, language = 'en' } = {}) {
  const stored = new Map([['astha.ai_mode', 'gemini'], ['astha.gemini', key]]);
  const elements = new Map(), calls = [];
  const context = vm.createContext({
    AbortController, AbortSignal, Date, console: { warn() {} }, navigator: { onLine: true },
    privacyMode: false, privacyTransition: false, voiceLang: 'bn', uiLang: language,
    ASTHA_SYSTEM: 'test-system', ASTHA_ACCOUNT_ID: account, ASTHA_MAIRA_USER_ID: device,
    localStorage: { getItem: key => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, String(value)) },
    $: id => {
      if (!elements.has(id)) elements.set(id, { textContent: '', style: {}, className: '', setAttribute() {}, classList: { toggle() {} } });
      return elements.get(id);
    },
    announce() {}, frameToJpeg: () => 'fixture-image-base64',
    setTimeout: callback => { queueMicrotask(callback); return 1; }, clearTimeout() {},
  });
  context.window = context;
  context.fetch = async (url, options) => {
    calls.push({ url, options });
    throw new Error('Unexpected network request: ' + url);
  };
  const run = source => vm.runInContext(source, context);
  run(policy + cloudPolicy + request);
  context.frameToJpeg = () => 'fixture-image-base64';
  run('remoteProcessingConsent = ' + Boolean(consent));
  return { context, run, calls, elements, stored,
    mockFetch(fn) { context.fetch = async (url, options) => { calls.push({ url, options }); return fn(url, options); }; },
  };
}
const response = (result, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => result });
const mairaReply = result => response({ detail: { response: typeof result === 'string' ? result : JSON.stringify(result) } });

test('server health reports an allowlisted configured Maira/Gemini provider in both UI languages', async () => {
  for (const [provider, label, language] of [['maira', 'Maira AI', 'en'], ['gemini', 'Gemini', 'en'], ['maira', 'মায়রা এআই', 'bn']]) {
    const h = harness({ language });
    h.mockFetch(() => response({ cloud: true, cloudProvider: provider }));
    await h.run('refreshCloudStatus()');
    assert.equal(h.run('serverCloud.provider'), provider);
    assert.equal(h.run('cloudReady()'), true);
    assert.match(h.elements.get('cloud-pill').textContent, new RegExp(label));
    assert.doesNotMatch(h.elements.get('cloud-pill').textContent, /connected|high-accuracy|free pass/i);
    assert.equal(h.calls[0].url, '/api/health');
  }
});

test('HTTP/network/invalid JSON health failures clear stale configured-provider state', async () => {
  for (const reply of [
    () => response({}, 503),
    () => { throw new Error('offline'); },
    () => ({ ok: true, json: async () => { throw new Error('invalid JSON'); } }),
  ]) {
    const h = harness();
    h.run("serverCloud.available = true; serverCloud.provider = 'maira'");
    h.mockFetch(reply);
    await h.run('refreshCloudStatus()');
    assert.equal(h.run('serverCloud.available'), false);
    assert.equal(h.run('serverCloud.provider'), null);
    assert.equal(h.run('serverCloud.reachable'), false);
    assert.equal(h.run('cloudReady()'), false);
    assert.match(h.elements.get('cloud-pill').textContent, /unavailable/);
  }
});

test('health rejects truthy nonboolean readiness and untrusted provider labels without breaking old servers', async () => {
  const h = harness();
  for (const [body, ready, provider] of [
    [{ cloud: 'false', cloudProvider: 'maira' }, false, null],
    [{ cloud: true, cloudProvider: '<script>secret</script>' }, true, null],
    [{ cloud: true }, true, null],
    [{ cloud: false, cloudProvider: 'maira' }, false, null],
  ]) {
    h.mockFetch(() => response(body)); await h.run('refreshCloudStatus()');
    assert.equal(h.run('serverCloud.available'), ready);
    assert.equal(h.run('serverCloud.provider'), provider);
    assert(!h.elements.get('cloud-pill').textContent.includes('<script>'));
  }
});

test('configured ASTHA server stays preferred and personal deployment credentials never enter its request', async () => {
  const h = harness({ key: 'gAAAAA-personal-test-key' });
  h.context.ASTHA_MAIRA_PROJECT_KEY = 'personal-test-project';
  h.run("serverCloud.available = true; serverCloud.provider = 'maira'");
  h.mockFetch(url => { assert.equal(url, '/api/vision'); return response({ en: 'Fixture', bn: 'পরীক্ষা' }); });
  const result = await h.run("gemini('describe fixture', {})");
  assert.equal(result.bn, 'পরীক্ষা');
  const { options } = h.calls[0];
  assert.equal(options.credentials, 'include');
  assert.equal(options.headers['project-key'], undefined);
  assert.equal(options.headers['api-key'], undefined);
  assert(!options.body.includes('personal-test-key'));
  assert(!options.body.includes('personal-test-project'));
  assert.equal(h.calls.length, 1);
});

test('retired browser credentials cannot bypass the configured server', async () => {
  for (const key of ['old-gemini-key', 'gAAAAA-old-maira-key']) {
    const h = harness({key}); h.context.ASTHA_MAIRA_PROJECT_KEY = 'old-project';
    assert.equal(h.run('cloudReady()'), false);
    await assert.rejects(h.run("gemini('inspect', null)"), error => error.noCloud === true);
    assert.equal(h.calls.length, 0);
  }
});

test('server errors never fail over to a personal provider and unauthenticated state is cleared', async () => {
  for (const status of [401, 403, 429, 500, 503]) {
    const h = harness({key:'old-personal-key'}); h.run('serverCloud.available = true');
    h.mockFetch(url => { assert.equal(url, '/api/vision'); return response({}, status); });
    await assert.rejects(h.run("gemini('inspect', null)"));
    assert.equal(h.calls.length, 1);
    if ([401,503].includes(status)) assert.equal(h.run('serverCloud.available'), false);
  }
});

test('late server results cannot cross account, consent or cancellation boundaries', async () => {
  for (const change of [
    h => { h.context.ASTHA_ACCOUNT_ID = 'another'; },
    h => { h.context.privacyMode = true; },
    h => { h.stored.set('astha.ai_mode', 'offline'); },
    h => { h.context.caller.abort(); },
  ]) {
    const h = harness(); h.run('serverCloud.available = true');
    h.context.caller = new AbortController(); let complete;
    h.mockFetch(() => new Promise(resolve => { complete = resolve; }));
    const result = h.run("gemini('inspect', null, {signal:caller.signal})");
    change(h); complete(response({en:'late'}));
    await assert.rejects(result, error => error.noCloud === true);
    assert.equal(h.calls.length, 1);
  }
});

test('privacy, consent and offline guards run before any image is captured or request sent', async () => {
  for (const change of [h=>h.run('remoteProcessingConsent=false'), h=>h.context.navigator.onLine=false, h=>h.context.privacyMode=true]) {
    const h=harness(); h.run('serverCloud.available=true'); change(h);
    h.context.frameToJpeg=()=>{throw new Error('must not capture');};
    await assert.rejects(h.run("gemini('inspect', {})"),error=>error.noCloud===true);
    assert.equal(h.calls.length,0);
  }
});
