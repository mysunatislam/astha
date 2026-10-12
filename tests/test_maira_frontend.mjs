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

test('personal Maira retains the supported ask JSON image contract, scoped identity and optional profile', async () => {
  const h = harness({ key: 'gAAAAA-personal-test-key' });
  h.context.ASTHA_MAIRA_PROJECT_KEY = 'personal-test-project';
  h.mockFetch(() => mairaReply({ en: 'A fixture is visible.', bn: 'পরীক্ষার ছবি।' }));
  assert.equal(h.run('cloudReady()'), true);
  await h.run("gemini('inspect fixture', {})");
  let body = JSON.parse(h.calls[0].options.body);
  assert.equal(h.calls[0].url, 'https://api.recommender.gigalogy.com/v1/maira/ask');
  assert.equal(body.user_id, 'verified-account');
  assert.equal(body.conversation_type, 'question');
  assert.deepEqual(body.images, [{ file_content: 'data:image/jpeg;base64,fixture-image-base64', filename: 'frame.jpg' }]);
  assert.equal('gpt_profile_id' in body, false);
  h.context.ASTHA_MAIRA_PROFILE_ID = ' explicit-owner-profile ';
  await h.run("gemini('text fixture', null)");
  body = JSON.parse(h.calls[1].options.body);
  assert.equal(body.gpt_profile_id, 'explicit-owner-profile');
  assert.deepEqual(body.images, []);
});

test('unknown or cached-only identity cannot use personal Maira; explicit device-owner identity can', async () => {
  const h = harness({ key: 'gAAAAA-personal-test-key', account: null });
  h.context.ASTHA_LOCAL_ACCOUNT_ID = 'cached-someone-else';
  h.context.ASTHA_MAIRA_PROJECT_KEY = 'personal-test-project';
  assert.equal(h.run('cloudReady()'), false);
  await assert.rejects(h.run("gemini('text fixture', null)"), error => error.noCloud === true);
  assert.equal(h.calls.length, 0);
  h.context.ASTHA_MAIRA_USER_ID = 'explicit-device-owner';
  h.mockFetch(() => mairaReply({ en: 'Fixture' }));
  assert.equal(h.run('cloudReady()'), true);
  await h.run("gemini('text fixture', null)");
  assert.equal(JSON.parse(h.calls[0].options.body).user_id, 'explicit-device-owner');
  assert(!cloudSource.includes("user_id: 'astha-browser-user'"));
  assert(!cloudSource.includes('7edb5168-fafd-432c-80e9-de59acc9d0a2'));
});

test('personal Maira rejects incomplete/empty/malformed responses and preserves plain text compatibility', async () => {
  const h = harness({ key: 'gAAAAA-personal-test-key' });
  h.context.ASTHA_MAIRA_PROJECT_KEY = 'personal-test-project';
  for (const reply of [
    response({ detail: { response: '{"en":"not final"}' } }, 202),
    response({}), response({ detail: { response: { en: 'not a string' } } }),
    ...['', '   ', '{}', '[]', 'null', '42', '"scalar"', '{"en":"truncated', '```json\n{invalid}\n```', '```json\n{"en":"missing closing fence"}',
      '{"en":[]}', '{"bn":false}', 'x'.repeat(131073)].map(text => mairaReply(text)),
  ]) {
    h.mockFetch(() => reply);
    await assert.rejects(h.run("gemini('text fixture', null)"), /Maira unavailable/);
  }
  h.mockFetch(() => mairaReply('A plain text response.'));
  assert.equal((await h.run("gemini('text fixture', null)")).en, 'A plain text response.');
  h.mockFetch(() => mairaReply('```json\n{"en":"A valid object","bn":"পরীক্ষা"}\n```'));
  assert.equal((await h.run("gemini('text fixture', null)")).bn, 'পরীক্ষা');
  h.mockFetch(() => mairaReply({ found: false }));
  assert.equal((await h.run("gemini('text fixture', null)")).found, false);
});

test('personal Maira late responses cannot cross owner/consent/caller-cancellation boundaries', async () => {
  for (const change of [
    h => { h.context.ASTHA_ACCOUNT_ID = 'another-owner'; },
    h => { h.context.privacyMode = true; },
    h => { h.stored.set('astha.ai_mode', 'offline'); },
    h => { h.context.caller.abort(); },
  ]) {
    const h = harness({ key: 'gAAAAA-personal-test-key' });
    h.context.ASTHA_MAIRA_PROJECT_KEY = 'personal-test-project';
    h.context.caller = new AbortController();
    let complete;
    h.mockFetch(() => new Promise(resolve => { complete = resolve; }));
    const result = h.run("gemini('text fixture', null, {signal:caller.signal})");
    change(h); complete(mairaReply({ en: 'Late answer' }));
    await assert.rejects(result, error => error.noCloud === true);
    assert.equal(h.calls.length, 1);
    if (h.context.caller.signal.aborted) assert.equal(h.calls[0].options.signal.aborted, true);
  }
});

test('personal Maira has no provider requests without consent, online access or project credentials', async () => {
  for (const change of [
    h => { h.run('remoteProcessingConsent = false'); },
    h => { h.context.navigator.onLine = false; },
    h => { h.context.privacyMode = true; },
    h => { h.context.ASTHA_MAIRA_PROJECT_KEY = ''; },
  ]) {
    const h = harness({ key: 'gAAAAA-personal-test-key' });
    h.context.ASTHA_MAIRA_PROJECT_KEY = 'personal-test-project';
    change(h);
    await assert.rejects(h.run("gemini('text fixture', null)"), error => error.noCloud === true);
    assert.equal(h.calls.length, 0);
  }
});

test('personal Maira retries a rate limit once and never retries after the owner or consent changes', async () => {
  const h = harness({ key: 'gAAAAA-personal-test-key' });
  h.context.ASTHA_MAIRA_PROJECT_KEY = 'personal-test-project';
  h.mockFetch(() => response({}, 429));
  await assert.rejects(h.run("gemini('text fixture', null)"), /rate limit/);
  assert.equal(h.calls.length, 2);
  for (const change of [
    h => { h.context.ASTHA_ACCOUNT_ID = 'another-owner'; },
    h => { h.context.privacyMode = true; },
    h => { h.context.caller.abort(); },
  ]) {
    const s = harness({ key: 'gAAAAA-personal-test-key' });
    s.context.ASTHA_MAIRA_PROJECT_KEY = 'personal-test-project';
    s.context.caller = new AbortController();
    s.mockFetch(() => response({}, 429));
    s.context.setTimeout = callback => { change(s); queueMicrotask(callback); return 1; };
    await assert.rejects(s.run("gemini('text fixture', null, {signal:caller.signal})"), error => error.noCloud === true);
    assert.equal(s.calls.length, 1);
  }
});
