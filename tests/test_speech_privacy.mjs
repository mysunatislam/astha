import assert from 'node:assert/strict';
import test, { before, beforeEach, after } from 'node:test';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import vm from 'node:vm';

// Real auth/origin/body middleware, isolated DB, injected audio; never contact a provider.
Object.assign(process.env, { DB_PROVIDER: 'sqlite', DB_PATH: ':memory:',
  SUPABASE_DB_URL: '', SUPABASE_DB_CA_FILE: '', RENDER_EXTERNAL_URL: '' });
process.env.NODE_ENV = 'production';
process.env.JWT_SECRET = randomBytes(32).toString('hex');
const { createSpeechRouter } = await import('../server/speech.js');
const { authMiddleware, createUser, signToken } = await import('../server/auth.js');
const { originGuard } = await import('../server/security.js');
const { db } = await import('../server/db.js');
const requireServer = createRequire(new URL('../server/package.json', import.meta.url));
const express = requireServer('express');
const cookieParser = requireServer('cookie-parser');
const token = signToken(await createUser({ name: 'Speech fixture', phone: null, passcode: 'test-only-passcode' }));
const audio = Buffer.from('fixture-mp3');
const calls = [];
let synthesize, listener, base;

before(async () => {
  const app = express();
  app.use('/api', (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  app.use('/api', originGuard(['https://app.example', 'capacitor://localhost']));
  app.use(cookieParser());
  app.use('/api/speak', express.json({ limit: '8kb' }));
  app.use('/api', authMiddleware, createSpeechRouter((text, voice, options) => {
    calls.push({ text, voice, signal: options.signal });
    return synthesize(text, voice, options);
  }));
  app.use((error, req, res, next) => res.status(error.type === 'entity.too.large' ? 413 : 400)
    .json({ error: error.type === 'entity.too.large' ? 'payload_too_large' : 'invalid_json' }));
  listener = app.listen(0, '127.0.0.1');
  await new Promise(resolve => listener.once('listening', resolve));
  base = 'http://127.0.0.1:' + listener.address().port;
});
beforeEach(() => { calls.length = 0; synthesize = async () => audio; });
after(async () => {
  if (listener) await new Promise(resolve => { listener.close(resolve); listener.closeAllConnections(); });
  db.close();
});

function request(body, options = {}) {
  return fetch(base + (options.path || '/api/speak'), {
    method: options.method || 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', ...options.headers },
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
    ...(options.signal ? { signal: options.signal } : {}),
  });
}

test('POST speech keeps Bangla text in JSON and returns private audio for authenticated clients', async () => {
  const text = 'আমার ব্যক্তিগত নোট: ওষুধ পাশে আছে।';
  for (const voice of ['bn-female', 'bn-male', 'en-female', 'en-male']) {
    const response = await request({ text, voice });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'audio/mpeg');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(await response.text(), audio.toString());
    assert.equal(calls.at(-1).text, text);
    assert.equal(calls.at(-1).voice, voice);
    assert.equal(calls.at(-1).signal.aborted, false);
  }
  const defaultVoice = await request({ text });
  assert.equal(defaultVoice.status, 200);
  await defaultVoice.arrayBuffer();
  assert.equal(calls.at(-1).voice, 'bn-female');
});

test('legacy GET never sends query speech to the provider and advertises the POST boundary', async () => {
  const response = await request(undefined, { method: 'GET', path: '/api/speak?text=private&voice=bn-female' });
  assert.equal(response.status, 405);
  assert.equal(response.headers.get('allow'), 'POST');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), { error: 'speech_post_required' });
  assert.equal(calls.length, 0);
});

test('speech retains session authentication and rejects cookie requests from untrusted origins', async () => {
  for (const headers of [{ Authorization: '' }, { Authorization: 'Bearer forged' },
    { Authorization: '', Cookie: 'astha_session=' + token, Origin: 'https://evil.example' },
    { 'Sec-Fetch-Site': 'cross-site', Origin: '' }]) {
    const response = await request({ text: 'private speech' }, { headers });
    assert.equal(response.status, headers.Origin === 'https://evil.example' || headers['Sec-Fetch-Site'] ? 403 : 401);
    assert.equal(response.headers.get('cache-control'), 'no-store');
  }
  assert.equal(calls.length, 0);
  for (const origin of ['https://app.example', 'capacitor://localhost', base]) {
    const response = await request({ text: 'বাংলা' }, { headers: {
      Authorization: '', Cookie: 'astha_session=' + token, Origin: origin,
    } });
    assert.equal(response.status, 200);
    await response.arrayBuffer();
  }
  assert.equal(calls.length, 3);
});

test('invalid speech types, voice values and oversized text fail before synthesis', async () => {
  for (const body of [{}, [], { text: {} }, { text: ['private'] }, { text: 123 },
    { text: null }, { text: '' }, { text: '   ' }, { text: 'x'.repeat(901) },
    { text: 'test', voice: {} }, { text: 'test', voice: ['bn-female'] },
    { text: 'test', voice: 'arbitrary-provider-voice' }]) {
    const response = await request(body);
    assert.equal(response.status, 400);
    assert.equal(response.headers.get('cache-control'), 'no-store');
  }
  assert.equal(calls.length, 0);
  const maximum = await request({ text: 'আ'.repeat(900) });
  assert.equal(maximum.status, 200);
  await maximum.arrayBuffer();
  assert.equal(calls.at(-1).text.length, 900);
});

test('speech JSON parsing is bounded and malformed/non-JSON bodies never reach synthesis', async () => {
  for (const [body, options, status] of [
    ['{"text":', {}, 400],
    [{ text: 'x'.repeat(9000) }, {}, 413],
    ['private text', { headers: { 'Content-Type': 'text/plain' } }, 415],
  ]) {
    const response = await request(body, options);
    assert.equal(response.status, status);
    assert.equal(response.headers.get('cache-control'), 'no-store');
  }
  assert.equal(calls.length, 0);
});

test('provider failure returns only a bounded private error with sanitized logging', async t => {
  const logs = [];
  t.mock.method(console, 'error', (...args) => logs.push(args));
  synthesize = async () => { throw new Error('provider URL with private text and internal details'); };
  const response = await request({ text: 'private text' });
  assert.equal(response.status, 502);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), { error: 'tts_unavailable' });
  assert.deepEqual(logs, [['tts unavailable']]);
});

test('disconnect while synthesis is pending aborts the provider signal without logging private errors', async t => {
  let started, aborted;
  const startedPromise = new Promise(resolve => { started = resolve; });
  const abortedPromise = new Promise(resolve => { aborted = resolve; });
  const logs = [];
  t.mock.method(console, 'error', (...args) => logs.push(args));
  synthesize = async (_text, _voice, { signal }) => {
    started(signal);
    return new Promise((resolve, reject) => signal.addEventListener('abort', () => {
      aborted(signal.aborted);
      reject(new Error('private provider cancellation details'));
    }, { once: true }));
  };
  const controller = new AbortController();
  const pending = request({ text: 'private pending speech' }, { signal: controller.signal });
  const signal = await startedPromise;
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(await Promise.race([abortedPromise, new Promise((resolve, reject) =>
    setTimeout(() => reject(new Error('Speech disconnect did not abort synthesis')), 1000))]), true);
  assert.equal(signal.aborted, true);
  assert.deepEqual(logs, []);
});

test('speech removes request and response cancellation listeners after every synthesis outcome', async t => {
  t.mock.method(console, 'error', () => {});
  for (const outcome of ['success', 'failure', 'disconnect']) {
    const req = Object.assign(new EventEmitter(), {
      body: { text: 'fixture text' }, is: type => type === 'application/json', aborted: false,
    });
    const res = Object.assign(new EventEmitter(), {
      writableEnded: false, destroyed: false, type() { return this; }, status() { return this; },
      send() { this.writableEnded = true; return this; }, json() { this.writableEnded = true; return this; },
    });
    let signal;
    const router = createSpeechRouter(async (_text, _voice, options) => {
      signal = options.signal;
      if (outcome === 'disconnect') res.emit('close');
      if (outcome !== 'success') throw new Error('fixture error');
      return audio;
    });
    const handler = router.stack[0].route.stack.find(layer => layer.method === 'post').handle;
    await handler(req, res);
    assert.equal(signal.aborted, outcome === 'disconnect');
    assert.equal(req.listenerCount('aborted'), 0);
    assert.equal(res.listenerCount('close'), 0);
  }
});

const moduleSource = readFileSync(new URL('../tools/module.js', import.meta.url), 'utf8');
function section(start, end) {
  const a = moduleSource.indexOf(start), b = moduleSource.indexOf(end, a + start.length);
  assert.ok(a >= 0 && b > a);
  return moduleSource.slice(a, b);
}
function voiceHarness() {
  const calls = { fetch: [], local: [], audio: [] };
  const context = vm.createContext({
    console, AbortController, AbortSignal, Date, setTimeout, navigator: { onLine: true },
    privacyMode: false, privacyTransition: false, state: { audio: true }, voiceLang: 'bn',
    URL: { createObjectURL: () => 'blob:fixture', revokeObjectURL() {} },
    $: () => ({ value: '1' }), sanitizeForSpeech: text => text,
    makeUtterance: text => ({ text }), backendReachable: () => true,
    voices: [{ name: 'Local Bangla', lang: 'bn-BD', localService: true }], refreshVoices() {},
    offlineError: () => new Error('remote processing disabled'),
    fetch: async (url, options) => { calls.fetch.push({ url, options }); return { ok: false, status: 405 }; },
    Audio: class {
      constructor(url) { calls.audio.push(url); }
      play() { queueMicrotask(() => this.onended?.()); return Promise.resolve(); }
      pause() {}
    },
    window: { ASTHA_API_BASE: 'https://api.example', speechSynthesis: {
      cancel() {}, speak(u) { calls.local.push(u.text); queueMicrotask(() => u.onend?.()); },
    } },
  });
  const run = script => vm.runInContext(script, context);
  run(section('function apiUrl(path)', 'const VoiceEchoFilter') +
    section('const VoiceEchoFilter', 'function asthaSpeaking()') + '\nremoteProcessingConsent = true;');
  return { context, calls, run };
}

test('VoiceEngine POST places generated speech only in JSON and keeps the local fallback', async () => {
  const h = voiceHarness();
  const text = 'Private notes & বাংলা?';
  h.context.text = text;
  assert.equal(await h.run("VoiceEngine.speak(text, 'bn')"), true);
  assert.equal(h.calls.fetch.length, 1);
  const { url, options } = h.calls.fetch[0];
  assert.equal(url, 'https://api.example/api/speak');
  assert.equal(options.method, 'POST');
  assert.equal(options.headers['Content-Type'], 'application/json');
  assert.equal(options.credentials, 'include');
  assert.equal(options.cache, 'no-store');
  assert.deepEqual(JSON.parse(options.body), { text, voice: 'bn-female' });
  assert.deepEqual(h.calls.local, [text]);
});

test('VoiceEngine consumes POST audio and Stop still cancels while its body is pending', async () => {
  const h = voiceHarness();
  h.context.fetch = async (url, options) => { h.calls.fetch.push({ url, options });
    return { ok: true, blob: async () => ({ fixture: true }) }; };
  assert.equal(await h.run("VoiceEngine.speak('English speech', 'en')"), true);
  assert.equal(JSON.parse(h.calls.fetch[0].options.body).voice, 'en-female');
  assert.equal(h.calls.audio.length, 1);
  assert.deepEqual(h.calls.local, []);

  let bodyStarted;
  const bodyStartedPromise = new Promise(resolve => { bodyStarted = resolve; });
  h.context.fetch = async (_url, { signal }) => ({ ok: true, blob: async () => {
    bodyStarted(signal);
    return new Promise((resolve, reject) => signal.addEventListener('abort', () =>
      reject(new Error('cancelled body')), { once: true }));
  } });
  const pending = h.run("VoiceEngine.speak('Cancelled speech', 'en')");
  const signal = await bodyStartedPromise;
  h.run('VoiceEngine.stop()');
  assert.equal(signal.aborted, true);
  assert.equal(await pending, false);
  assert.equal(h.calls.audio.length, 1);
  assert.deepEqual(h.calls.local, []);
});

test('VoiceEngine private/offline speech sends no POST or GET request', async () => {
  for (const state of ['privacy', 'offline', 'no-consent']) {
    const h = voiceHarness();
    if (state === 'privacy') h.context.privacyMode = true;
    if (state === 'offline') h.context.navigator.onLine = false;
    if (state === 'no-consent') h.run('remoteProcessingConsent = false');
    assert.equal(await h.run("VoiceEngine.speak('বাংলা', 'bn')"), true);
    assert.equal(h.calls.fetch.length, 0);
    assert.deepEqual(h.calls.local, ['বাংলা']);
  }
});
