import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../web/native-api.js', import.meta.url), 'utf8');
const BASE = 'https://astha-preview.onrender.com';
function harness({ platform = 'android', native = true, request, base = BASE, timers } = {}) {
  const web = [], calls = [];
  const storage = new Map();
  const original = async (...args) => { web.push(args); return new Response('web'); };
  const window = {
    location: { href: 'https://localhost/' }, ASTHA_API_BASE: base, fetch: original,
    localStorage: { setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key), getItem: key => storage.get(key) ?? null },
    Capacitor: {
      isNativePlatform: () => native, getPlatform: () => platform,
      Plugins: { CapacitorHttp: { request: options => { calls.push(options); return request ? request(options) : Promise.resolve({ status: 200, headers: { 'Content-Type': 'application/json' }, data: { ok: true }, url: options.url }); } } },
    },
  };
  vm.runInNewContext(source, { window, URL, Request, Response, Headers, DOMException, Uint8Array, atob, setTimeout: timers?.setTimeout || setTimeout, clearTimeout: timers?.clearTimeout || clearTimeout });
  return { window, original, web, calls, storage };
}
const include = { credentials: 'include' };
test('web and iOS retain the original fetch implementation', async () => {
  for (const options of [{ native: false }, { platform: 'ios' }]) {
    const h = harness(options);
    assert.equal(h.window.fetch, h.original);
    await h.window.fetch(BASE + '/api/health', include);
    assert.equal(h.calls.length, 0);
  }
});
test('only exact backend API requests use the native client', async () => {
  const h = harness();
  const options = { signal: new AbortController().signal };
  for (const url of ['https://cdn.example/model.onnx', BASE + '/index.html', 'https://astha-preview.onrender.com.evil.test/api/auth/me', '/api/auth/me']) {
    const response = await h.window.fetch(url, options);
    assert.equal(await response.text(), 'web');
    assert.equal(h.web.at(-1)[1], options);
  }
  assert.equal(h.calls.length, 0);
  const response = await h.window.fetch(BASE + '/api/health?check=1', include);
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(response.url, BASE + '/api/health?check=1');
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].connectTimeout, 5000);
  assert.equal(h.calls[0].readTimeout, 30000);
  assert.equal(h.calls[0].disableRedirects, true);
  assert.equal(h.calls[0].responseType, 'text');
});
test('JSON mutation payloads and HTTP errors preserve the Response contract without cookie headers', async () => {
  const h = harness({ request: o => ({ status: 401, url: o.url, headers: { 'Content-Type': 'application/json', 'Set-Cookie': 'private-session', 'set-cookie2': 'private-extra', 'X-Request-ID': 'id' }, data: { error: 'unauthorized' } }) });
  const body = JSON.stringify({ item: 'বই' });
  const response = await h.window.fetch(BASE + '/api/memories', { ...include, method: 'POST', headers: { 'Content-Type': 'application/json' }, body, cache: 'no-store' });
  assert.equal(h.calls[0].data, body);
  assert.equal(response.ok, false);
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: 'unauthorized' });
  assert.equal(response.headers.has('set-cookie'), false);
  assert.equal(response.headers.has('set-cookie2'), false);
  assert.equal(response.headers.get('x-request-id'), 'id');
});
test('TTS base64 bytes survive blob conversion and JSON errors remain JSON', async () => {
  const bytes = Buffer.from([0x49, 0x44, 0x33, 0xff, 0, 0x80]);
  const h = harness({ request: o => ({ status: 200, url: o.url, headers: { 'Content-Type': 'audio/mpeg' }, data: bytes.toString('base64').slice(0, 4) + '\r\n' + bytes.toString('base64').slice(4) + '\n' }) });
  const response = await h.window.fetch(BASE + '/api/speak', { ...include, method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"text":"hello"}' });
  assert.equal(h.calls[0].responseType, 'arraybuffer');
  const blob = await response.blob();
  assert.equal(blob.type, 'audio/mpeg');
  assert.deepEqual(Buffer.from(await blob.arrayBuffer()), bytes);
  const error = harness({ request: () => ({ status: 503, headers: { 'Content-Type': 'application/json' }, data: { error: 'tts_unavailable' } }) });
  assert.deepEqual(await (await error.window.fetch(BASE + '/api/speak', include)).json(), { error: 'tts_unavailable' });
});
test('caller abort rejects immediately, suppresses late native responses and removes listeners', async () => {
  let finish;
  const h = harness({ request: () => new Promise(resolve => { finish = resolve; }) });
  const controller = new AbortController();
  const reason = new DOMException('Caller deadline', 'TimeoutError');
  const result = h.window.fetch(BASE + '/api/auth/me', { ...include, signal: controller.signal });
  await new Promise(resolve => setImmediate(resolve));
  controller.abort(reason);
  await assert.rejects(result, error => error === reason);
  const late = { get status() { throw new Error('Late response must not be read'); } };
  finish(late);
  await new Promise(resolve => setImmediate(resolve));
  const previous = harness();
  await assert.rejects(previous.window.fetch(BASE + '/api/auth/me', { ...include, signal: controller.signal }), error => error === reason);
  assert.equal(previous.calls.length, 0);
});
test('native wall timeout rejects hung requests and consumes late rejections', async () => {
  let expire, rejectNative, cleared = 0;
  const h = harness({ request: () => new Promise((_, reject) => { rejectNative = reject; }), timers: { setTimeout(fn, ms) { assert.equal(ms, 35000); expire = fn; return 123; }, clearTimeout(id) { assert.equal(id, 123); cleared++; } } });
  const pending = h.window.fetch(BASE + '/api/auth/me', include);
  await new Promise(resolve => setImmediate(resolve));
  expire();
  await assert.rejects(pending, { name: 'TimeoutError' });
  assert.equal(cleared, 1);
  rejectNative(new Error('Late socket error'));
  await new Promise(resolve => setImmediate(resolve));
});
test('redirects, changed response URLs and malformed native replies fail closed', async () => {
  for (const reply of [{ status: 302, headers: {} }, { status: 200, url: 'https://evil.test/api/health', headers: {} }, { status: 0 }, { status: 200, headers: { 'Content-Type': 5 }, data: '{}' }, { status: 200, headers: { 'Content-Type': 'audio/mpeg' }, data: 'not base64!' }]) {
    const h = harness({ request: () => reply });
    await assert.rejects(h.window.fetch(BASE + (reply.data === 'not base64!' ? '/api/speak' : '/api/health'), include), { name: 'TypeError' });
    assert.equal(h.web.length, 0);
  }
});
test('unsupported API options and unsafe origins never fall back to browser cookies', async () => {
  const h = harness();
  for (const options of [{}, { credentials: 'omit' }, { ...include, mode: 'no-cors' }, { ...include, redirect: 'follow' }, { ...include, keepalive: true }, { ...include, method: 'TRACE' }, { ...include, headers: { Cookie: 'manual-session' } }, { ...include, method: 'POST', body: 'plain' }, { ...include, method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' , integrity: 'hash' }]) {
    await assert.rejects(h.window.fetch(BASE + '/api/auth/me', options), { name: 'TypeError' });
  }
  await assert.rejects(h.window.fetch(new Request(BASE + '/api/auth/me', include), include), { name: 'TypeError' });
  assert.equal(h.calls.length, 0);
  assert.equal(h.web.length, 0);
  const insecure = harness({ base: 'http://backend.example' });
  await assert.rejects(insecure.window.fetch('http://backend.example/api/health', include), { name: 'TypeError' });
  assert.equal(insecure.calls.length, 0);
  const unavailable = harness();
  unavailable.window.Capacitor.Plugins.CapacitorHttp = undefined;
  await assert.rejects(unavailable.window.fetch(BASE + '/api/health', include), { name: 'TypeError' });
  assert.equal(unavailable.web.length, 0);
});
test('empty and HEAD responses work without inventing a body', async () => {
  for (const [status, method] of [[204, 'DELETE'], [200, 'HEAD']]) {
    const h = harness({ request: () => ({ status, headers: {}, data: '' }) });
    const response = await h.window.fetch(BASE + '/api/memories/own-id', { ...include, method });
    assert.equal(await response.text(), '');
    assert.equal(response.body, null);
  }
});
test('native parsed JSON primitives serialize as valid JSON', async () => {
  for (const data of ['a quoted "string"', 42, null, true, false]) {
    const h = harness({ request: () => ({ status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8' }, data }) });
    const response = await h.window.fetch(BASE + '/api/health', include);
    assert.deepEqual(await response.json(), data);
  }
});
test('an aborted sign-in clears its late cookie before queued logout or a newer sign-in', async () => {
  let releaseLogin;
  let cookie = 'original';
  const h = harness({ request: async options => {
    if (options.url.endsWith('/login') && options.data === '{"attempt":1}') {
      await new Promise(resolve => { releaseLogin = resolve; });
      cookie = 'abandoned';
    } else if (options.url.endsWith('/logout')) cookie = null;
    else if (options.url.endsWith('/login')) cookie = 'new-account';
    return { status: 200, url: options.url, headers: { 'Content-Type': 'application/json' }, data: { ok: true } };
  } });
  const controller = new AbortController();
  const bodyOptions = { ...include, method: 'POST', headers: { 'Content-Type': 'application/json' } };
  const first = h.window.fetch(BASE + '/api/auth/login', { ...bodyOptions, body: '{"attempt":1}', signal: controller.signal });
  await new Promise(resolve => setImmediate(resolve));
  controller.abort();
  await assert.rejects(first, { name: 'AbortError' });
  const logout = h.window.fetch(BASE + '/api/auth/logout', { ...include, method: 'POST' });
  const next = h.window.fetch(BASE + '/api/auth/login', { ...bodyOptions, body: '{"attempt":2}' });
  assert.equal(h.calls.length, 1);
  releaseLogin();
  await logout; await next;
  assert.deepEqual(h.calls.map(o => new URL(o.url).pathname), ['/api/auth/login', '/api/auth/logout', '/api/auth/logout', '/api/auth/login']);
  assert.equal(cookie, 'new-account');
  assert.equal(h.storage.has('astha.logout_pending.v2'), false);
});
test('failed abandoned-auth cleanup preserves pending logout and serializes session reads', async () => {
  let releaseGuest;
  let failLogout = true;
  let cleared = 0;
  const h = harness({ request: async options => {
    if (options.url.endsWith('/guest')) await new Promise(resolve => { releaseGuest = resolve; });
    if (options.url.endsWith('/logout') && failLogout) throw new Error('Offline during cleanup');
    return { status: 200, url: options.url, headers: { 'Content-Type': 'application/json' }, data: { ok: true } };
  } });
  h.window.ASTHA_ACCOUNT_ID = 'old-account';
  h.window.ASTHA_CLEAR_ACCOUNT = options => { assert.equal(options.logout, true); assert.deepEqual(Object.keys(options), ['logout']); cleared++; h.window.ASTHA_ACCOUNT_ID = null; };
  const controller = new AbortController();
  const guest = h.window.fetch(BASE + '/api/auth/guest', { ...include, method: 'POST', signal: controller.signal });
  await new Promise(resolve => setImmediate(resolve));
  controller.abort();
  await assert.rejects(guest, { name: 'AbortError' });
  assert.equal(h.window.ASTHA_ACCOUNT_ID, null);
  assert.equal(cleared, 1);
  const read = h.window.fetch(BASE + '/api/auth/me', include);
  assert.equal(h.calls.length, 1);
  releaseGuest();
  await assert.rejects(read, { name: 'TypeError' });
  assert.deepEqual(h.calls.map(o => new URL(o.url).pathname), ['/api/auth/guest', '/api/auth/logout']);
  assert.equal(h.storage.get('astha.logout_pending.v2'), '1');
  assert.equal(h.storage.size, 1); // Only the existing nonsecret pending marker.
  await assert.rejects(h.window.fetch(BASE + '/api/memories', include), { name: 'TypeError' });
  await assert.rejects(h.window.fetch(BASE + '/api/auth/login', { ...include, method: 'POST' }), { name: 'TypeError' });
  assert.equal(h.calls.length, 2);
  failLogout = false;
  assert.equal((await h.window.fetch(BASE + '/api/auth/logout', { ...include, method: 'POST' })).ok, true);
  assert.equal(h.storage.has('astha.logout_pending.v2'), false);
  assert.equal((await h.window.fetch(BASE + '/api/auth/me', include)).ok, true);
  assert.equal(cleared, 1);
});
test('pending logout stays fail closed when localStorage is unavailable', async () => {
  let complete;
  const h = harness({ request: options => options.url.endsWith('/login') ? new Promise(resolve => { complete = resolve; }) : Promise.reject(new Error('offline')) });
  h.window.localStorage = { setItem() { throw new Error('storage disabled'); }, getItem() { throw new Error('storage disabled'); }, removeItem() { throw new Error('storage disabled'); } };
  const controller = new AbortController();
  const request = h.window.fetch(BASE + '/api/auth/login', { ...include, method: 'POST', signal: controller.signal });
  await new Promise(resolve => setImmediate(resolve));
  controller.abort();
  await assert.rejects(request, { name: 'AbortError' });
  complete({ status: 200, headers: { 'Content-Type': 'application/json' }, data: { ok: true } });
  await assert.rejects(h.window.fetch(BASE + '/api/memories', include), { name: 'TypeError' });
  assert.equal(h.calls.length, 2); // Login and internal cleanup; no memory request.
});
