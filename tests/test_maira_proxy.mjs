import assert from 'node:assert/strict';
import test, { beforeEach } from 'node:test';

const CONFIG = ['CLOUD_AI_PROVIDER', 'MAIRA_API_KEY', 'MAIRA_PROJECT_KEY', 'MAIRA_PROFILE_ID',
  'MAIRA_API_URL', 'API_KEY', 'PROJECT_KEY', 'GEMINI_API_KEY', 'GEMINI_MODELS', 'CLOUD_TIMEOUT_MS'];
function resetConfig() { for (const name of CONFIG) delete process.env[name]; }
resetConfig();
const { getCloudProvider, getCloudStatus, hasCloudAI, callMaira, callGemini, callCloudAI } =
  await import('../server/gemini.js');
beforeEach(resetConfig);
const credentials = { MAIRA_API_KEY: 'mock-maira-canonical-key', MAIRA_PROJECT_KEY: 'mock-maira-project' };
function useMaira(extra = {}) { Object.assign(process.env, credentials, { CLOUD_AI_PROVIDER: 'maira' }, extra); }
const reply = (text, init) => new Response(JSON.stringify({ detail: { response: text } }), init);
const answer = { en: 'A chair is ahead.', bn: 'সামনে একটি চেয়ার আছে।', hazard: false };
const fixtureImage = Buffer.from('mock-image-bytes').toString('base64');

test('explicit provider selection and config-only status preserve Gemini and legacy Maira installations', () => {
  assert.equal(getCloudProvider({}), 'none');
  assert.deepEqual(getCloudStatus({}), { provider: 'none', configured: false });
  assert.equal(getCloudProvider({ GEMINI_API_KEY: 'mock-gemini-key' }), 'gemini');
  assert.deepEqual(getCloudStatus(credentials), { provider: 'maira', configured: true });
  assert.deepEqual(getCloudStatus({ API_KEY: 'legacy-maira-key', PROJECT_KEY: 'legacy-project' }),
    { provider: 'maira', configured: true });
  assert.deepEqual(getCloudStatus({ GEMINI_API_KEY: 'gAAAAA-mock-old-maira-key', PROJECT_KEY: 'legacy-project' }),
    { provider: 'maira', configured: true });
  assert.deepEqual(getCloudStatus({ API_KEY: 'legacy-gemini-key' }), { provider: 'gemini', configured: true });
  assert.deepEqual(getCloudStatus({ CLOUD_AI_PROVIDER: 'maira', GEMINI_API_KEY: 'mock-gemini-key' }),
    { provider: 'maira', configured: false });
  assert.deepEqual(getCloudStatus({ MAIRA_PROJECT_KEY: 'incomplete', GEMINI_API_KEY: 'mock-gemini-key' }),
    { provider: 'maira', configured: false });
  assert.deepEqual(getCloudStatus({ CLOUD_AI_PROVIDER: 'gemini', ...credentials }), { provider: 'gemini', configured: false });
  assert.throws(() => getCloudProvider({ CLOUD_AI_PROVIDER: 'invented-provider' }), error => error.code === 'bad_request');
  assert.equal(callCloudAI, callGemini);
});

test('canonical Maira keys win without relying on their format and configured profile remains optional', async t => {
  useMaira({ API_KEY: 'mock-obsolete-key', PROJECT_KEY: 'mock-obsolete-project', GEMINI_API_KEY: 'mock-gemini-key' });
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push({ url, options, body: JSON.parse(options.body) });
    return reply(JSON.stringify(answer));
  });
  assert.deepEqual(await callGemini({ task: 'describe', userId: 'account-a', imageBase64: fixtureImage }), answer);
  const first = requests[0];
  assert.equal(first.url, 'https://api.recommender.gigalogy.com/v1/maira/ask');
  assert.equal(first.options.headers['api-key'], credentials.MAIRA_API_KEY);
  assert.equal(first.options.headers['project-key'], credentials.MAIRA_PROJECT_KEY);
  assert.equal(first.options.headers['Content-Type'], 'application/json');
  assert.equal(first.options.redirect, 'error');
  assert.equal(first.options.cache, 'no-store');
  assert.equal(first.url.includes('mock-'), false);
  assert.equal(first.body.user_id, 'account-a');
  assert.equal(first.body.conversation_type, 'question');
  assert.equal('gpt_profile_id' in first.body, false);
  assert.deepEqual(first.body.images, [{ file_content: 'data:image/jpeg;base64,' + fixtureImage, filename: 'frame.jpg' }]);
  assert.match(first.body.query, /Return JSON/);
  process.env.MAIRA_PROFILE_ID = 'operator-profile';
  await callGemini({ customPrompt: 'Return a bilingual plan.', userId: 'account-b' });
  assert.equal(requests[1].body.gpt_profile_id, 'operator-profile');
  assert.equal(requests[1].body.user_id, 'account-b');
  assert.deepEqual(requests[1].body.images, []);
  assert.equal('user_name' in requests[1].body, false);
  await callMaira({ task: 'read', userId: 'account-a', gptProfileId: 'explicit-internal-profile' });
  assert.equal(requests[2].body.gpt_profile_id, 'explicit-internal-profile');
  assert.equal(hasCloudAI(), true); // configuration, not proof of real inference
});

test('legacy key aliases remain supported without sending an ordinary Gemini key to Maira', async t => {
  Object.assign(process.env, { API_KEY: 'mock-legacy-maira-key', PROJECT_KEY: 'mock-legacy-project' });
  let request;
  t.mock.method(globalThis, 'fetch', async (url, options) => { request = { url, options }; return reply('Legacy answer'); });
  assert.deepEqual(await callGemini({ task: 'describe', userId: 'account-a' }), { en: 'Legacy answer', bn: '' });
  assert.equal(request.options.headers['api-key'], 'mock-legacy-maira-key');
  delete process.env.API_KEY;
  process.env.GEMINI_API_KEY = 'gAAAAA-mock-legacy-maira-key';
  await callGemini({ task: 'read', userId: 'account-a' });
  assert.equal(request.options.headers['api-key'], 'gAAAAA-mock-legacy-maira-key');
  process.env.GEMINI_API_KEY = 'ordinary-mock-gemini-key';
  process.env.CLOUD_AI_PROVIDER = 'maira';
  await assert.rejects(callGemini({ task: 'read', userId: 'account-a' }), error => error.code === 'no_key');
});

test('Maira honors HTTPS endpoint configuration and rejects unsafe endpoints/config before fetch', async t => {
  useMaira({ MAIRA_API_URL: 'https://operator.example/custom/ask' });
  const requests = [];
  t.mock.method(globalThis, 'fetch', async url => { requests.push(url); return reply('Configured endpoint answer'); });
  await callMaira({ task: 'describe', userId: 'account-a' });
  assert.deepEqual(requests, ['https://operator.example/custom/ask']);
  for (const url of ['http://operator.example/ask', 'https://user:password@operator.example/ask',
    'https://operator.example/ask?key=private', 'https://operator.example/ask#secret', 'invalid']) {
    process.env.MAIRA_API_URL = url;
    assert.equal(hasCloudAI(), false);
    await assert.rejects(callMaira({ task: 'describe', userId: 'account-a' }), error => error.code === 'bad_request');
  }
  process.env.MAIRA_API_URL = 'https://operator.example/ask';
  process.env.MAIRA_PROFILE_ID = 'x'.repeat(129);
  assert.equal(hasCloudAI(), false);
  await assert.rejects(callMaira({ task: 'describe', userId: 'account-a' }), error => error.code === 'bad_request');
  delete process.env.MAIRA_PROFILE_ID;
  process.env.MAIRA_API_KEY = 'invalid\nheader';
  await assert.rejects(callMaira({ task: 'describe', userId: 'account-a' }), error => error.code === 'bad_request');
  assert.equal(requests.length, 1);
});

test('missing/shared identity, nonscalar prompts and malformed or oversized images never reach Maira', async t => {
  useMaira();
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; throw new Error('Invalid request reached provider'); });
  for (const userId of [undefined, null, '', ' ', {}, 'x'.repeat(129), 'astha-user', ' astha-user ', 'astha-browser-user', 'account\nother']) {
    await assert.rejects(callMaira({ task: 'describe', userId }), error => error.code === 'bad_request');
  }
  for (const customPrompt of ['', ' ', {}, [], 123, 'x'.repeat(32001)]) {
    await assert.rejects(callMaira({ customPrompt, userId: 'account-a' }), error => error.code === 'bad_request');
  }
  for (const task of ['unknown', '__proto__', 'toString', ['describe'], {}]) {
    await assert.rejects(callMaira({ task, userId: 'account-a' }), error => error.code === 'bad_request');
  }
  for (const imageBase64 of [{}, 123, 'https://external.example/private.jpg', 'data:text/html;base64,AAAA',
    'data:image/jpeg;base64,', 'not valid base64!', 'x', 'A'.repeat(8 * 1024 * 1024 + 65)]) {
    await assert.rejects(callMaira({ task: 'describe', userId: 'account-a', imageBase64 }), error => error.code === 'bad_request');
  }
  assert.equal(calls, 0);
});

test('supported data-URL images preserve their format and account boundaries without unrelated metadata', async t => {
  useMaira();
  const bodies = [];
  t.mock.method(globalThis, 'fetch', async (_url, options) => { bodies.push(JSON.parse(options.body)); return reply(JSON.stringify(answer)); });
  for (const [type, filename] of [['jpeg', 'frame.jpg'], ['png', 'frame.png'], ['webp', 'frame.webp']]) {
    await callMaira({ task: 'identify', userId: 'account-' + type, imageBase64: `data:image/${type};base64,${fixtureImage}` });
    assert.deepEqual(bodies.at(-1).images, [{ file_content: `data:image/${type};base64,${fixtureImage}`, filename }]);
    assert.equal(bodies.at(-1).user_id, 'account-' + type);
    assert.equal('member_id' in bodies.at(-1), false);
    assert.equal('session_id' in bodies.at(-1), false);
  }
});

test('Maira returns complete JSON plans, bilingual/fenced objects and compatible plain text', async t => {
  useMaira();
  const cases = [
    [JSON.stringify(answer), answer],
    ['```json\n' + JSON.stringify(answer) + '\n```', answer],
    ['Plain English answer', { en: 'Plain English answer', bn: '' }],
    ['পরিষ্কার বাংলা উত্তর', { en: 'পরিষ্কার বাংলা উত্তর', bn: '' }],
    ['{"goal":"find wallet","steps":[]}', { goal: 'find wallet', steps: [] }],
  ];
  for (const [text, expected] of cases) {
    t.mock.method(globalThis, 'fetch', async () => reply(text));
    assert.deepEqual(await callMaira({ customPrompt: 'Test task', userId: 'account-a' }), expected);
    t.mock.restoreAll();
  }
});

test('invalid, missing, empty, truncated and nonfinal provider responses are rejected as failures', async t => {
  useMaira();
  const invalid = [undefined, null, {}, [], '', ' ', '{}', '[]', 'null', '42', '"quoted scalar"',
    '{"en":"partial",', '```json\n{"en":"partial"', '```json\n{"en":"complete"}',
    '```json\nplain text\n```', '{"en":{}}', '{"bn":[]}', 'x'.repeat(128 * 1024 + 1)];
  for (const text of invalid) {
    t.mock.method(globalThis, 'fetch', async () => reply(text));
    await assert.rejects(callMaira({ task: 'describe', userId: 'account-a' }), error => error.code === 'bad_response' && error.message === 'bad_response');
    t.mock.restoreAll();
  }
  t.mock.method(globalThis, 'fetch', async () => new Response('{malformed provider JSON'));
  await assert.rejects(callMaira({ task: 'describe', userId: 'account-a' }), error => error.code === 'bad_response');
  t.mock.restoreAll();
  t.mock.method(globalThis, 'fetch', async () => reply(JSON.stringify(answer), { status: 202 }));
  await assert.rejects(callMaira({ task: 'describe', userId: 'account-a' }), error => error.code === 'bad_response');
});

test('oversized declared or streamed JSON is cancelled instead of accumulating provider data', async t => {
  useMaira();
  for (const declared of [true, false]) {
    let cancelled = false;
    const stream = new ReadableStream({
      start(controller) { if (!declared) controller.enqueue(Buffer.alloc(256 * 1024 + 1)); },
      cancel() { cancelled = true; },
    });
    t.mock.method(globalThis, 'fetch', async () => new Response(stream,
      declared ? { headers: { 'Content-Length': String(256 * 1024 + 1) } } : {}));
    await assert.rejects(callMaira({ task: 'describe', userId: 'account-a' }), error => error.code === 'bad_response');
    assert.equal(cancelled, true);
    t.mock.restoreAll();
  }
});

test('Maira auth/rate/upstream failures make one request and never switch to configured Gemini', async t => {
  useMaira({ GEMINI_API_KEY: 'mock-gemini-key' });
  for (const [status, code] of [[401, 'bad_key'], [403, 'bad_key'], [429, 'rate_limit'], [404, 'upstream'], [500, 'upstream']]) {
    const calls = [];
    t.mock.method(globalThis, 'fetch', async url => { calls.push(url); return reply('private provider error', { status }); });
    await assert.rejects(callCloudAI({ task: 'describe', userId: 'account-a' }), error => error.code === code && error.message === code);
    assert.deepEqual(calls, ['https://api.recommender.gigalogy.com/v1/maira/ask']);
    t.mock.restoreAll();
  }
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; throw new Error('private key/URL/provider details'); });
  await assert.rejects(callGemini({ task: 'describe', userId: 'account-a' }), error => error.code === 'network' && error.message === 'network');
  assert.equal(calls, 1);
});

test('explicit Gemini still works when Maira credentials coexist', async t => {
  useMaira({ CLOUD_AI_PROVIDER: 'gemini', GEMINI_API_KEY: 'mock-gemini-key' });
  const calls = [];
  t.mock.method(globalThis, 'fetch', async url => {
    calls.push(url);
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(answer) }] } }] }));
  });
  assert.deepEqual(getCloudStatus(), { provider: 'gemini', configured: true });
  assert.deepEqual(await callGemini({ task: 'describe' }), answer);
  assert.equal(new URL(calls[0]).hostname, 'generativelanguage.googleapis.com');
  assert.equal(calls.length, 1);
});

test('Maira deadline covers stalled response bodies and returns only a sanitized network failure', async t => {
  useMaira({ CLOUD_TIMEOUT_MS: '1000' });
  let signal;
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    signal = options.signal;
    return new Response(new ReadableStream({ start(controller) {
      signal.addEventListener('abort', () => controller.error(signal.reason), { once: true });
    } }));
  });
  const keepAlive = setTimeout(() => {}, 1500);
  try {
    await assert.rejects(callMaira({ task: 'describe', userId: 'account-a' }), error => error.code === 'network' && error.message === 'network');
    assert.equal(signal.aborted, true);
  } finally { clearTimeout(keepAlive); }
});
