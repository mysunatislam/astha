import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getJwtSecret, normalizePasscode, normalizePhone, validateAuthBody,
  getAllowedOrigins, getTrustProxyHops, getPublicOrigin, isAllowedOrigin, originGuard, createAuthRateLimiter, fetchCloud,
} from '../server/security.js';

test('production refuses missing, placeholder, short and formerly public signing secrets', () => {
  for (const JWT_SECRET of [undefined, 'short', 'replace-with-a-long-random-string', 'astha-default-secure-companion-secret-key-2026']) {
    assert.throws(() => getJwtSecret({ NODE_ENV: 'production', JWT_SECRET }), /JWT_SECRET/);
  }
  const secret = '1b68e9ab7f77a3e80dc61135e42c3592';
  assert.equal(getJwtSecret({ NODE_ENV: 'production', JWT_SECRET: secret }), secret);
  assert.notEqual(getJwtSecret({ NODE_ENV: 'development' }), getJwtSecret({ NODE_ENV: 'development' }));
});

test('spoken Bangla and English digits normalize; oversized and non-scalar PIN input is rejected', () => {
  assert.equal(normalizePasscode('১২ ৩৪'), '1234');
  assert.equal(normalizePhone('+৮৮০ (১৭১২) ৩৪৫-৬৭৮'), '+8801712345678');
  for (const input of [1234, {}, '123', '123456789', 'a1234', '1'.repeat(5000)]) {
    assert.equal(normalizePasscode(input), null);
  }
  assert.deepEqual(validateAuthBody({ name: '  আস্থা  ', phone: '০১৭১২৩৪৫৬৭৮', passcode: '১২৩৪' }, true),
    { name: 'আস্থা', phone: '01712345678', passcode: '1234' });
  assert.equal(validateAuthBody({ name: {}, phone: '01712345678', passcode: '1234' }, true), null);
  assert.equal(validateAuthBody({ name: 'x', phone: '01000000000', passcode: '1234' }, true), null);
  assert.deepEqual(validateAuthBody({ phone: '01712345678', passcode: 'legacy-spoken-password' }),
    { phone: '01712345678', passcode: 'legacy-spoken-password' });
  assert.equal(validateAuthBody({ phone: '01712345678', passcode: 'x'.repeat(129) }), null);
  assert.equal(validateAuthBody({ phone: '০১০০০০০০০০০', passcode: '1234' }), null);
});

function request(origin, method = 'POST', ip = '127.0.0.1') {
  return { method, ip, protocol: 'https', get: header => ({ host: 'api.example', origin })[header] };
}
function response() {
  return { statusCode: 200, headers: {}, status(code) { this.statusCode = code; return this; },
    set(key, value) { this.headers[key] = value; return this; }, json(body) { this.body = body; return this; } };
}

test('configured origins are exact and preserve the configured Capacitor origin', () => {
  const origins = getAllowedOrigins({ CORS_ORIGIN: 'https://app.example, capacitor://localhost' });
  for (const origin of ['https://app.example', 'https://api.example', 'capacitor://localhost', undefined]) {
    assert.equal(isAllowedOrigin(origin, request(origin), origins), true);
  }
  for (const origin of ['https://app.example.evil', 'null', '*', 'https://app.example/private', 'https://app.example@evil.example']) {
    assert.equal(isAllowedOrigin(origin, request(origin), origins), false);
  }
  assert.throws(() => getAllowedOrigins({ CORS_ORIGIN: '*' }), /exact trusted origins/);
  const res = response();
  let nextCalled = false;
  originGuard(origins)(request('https://evil.example'), res, () => { nextCalled = true; });
  assert.equal(res.statusCode, 403);
  assert.equal(nextCalled, false);
});

test('auth throttle blocks abusive callers, expires and bounds memory without dropping active limits', () => {
  let clock = 1000;
  const limiter = createAuthRateLimiter({ limit: 2, windowMs: 1000, maxEntries: 1, now: () => clock });
  let nextCount = 0;
  const call = ip => {
    const res = response();
    limiter(request(undefined, 'POST', ip), res, () => { nextCount += 1; });
    return res;
  };
  assert.equal(call('client-a').statusCode, 200);
  assert.equal(call('client-a').statusCode, 200);
  const blocked = call('client-a');
  assert.equal(blocked.statusCode, 429);
  assert.equal(blocked.headers['Retry-After'], '1');
  assert.equal(call('client-b').statusCode, 429);
  clock += 1001;
  assert.equal(call('client-b').statusCode, 200);
  assert.equal(nextCount, 3);
});

test('cloud deadline aborts a stalled provider request without making a live network call', async t => {
  t.mock.method(globalThis, 'fetch', async (_url, options) => new Promise((resolve, reject) => {
    if (options.signal.aborted) return reject(options.signal.reason);
    options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
  }));
  // AbortSignal.timeout does not keep the event loop alive; the timer models other active server work.
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    await assert.rejects(fetchCloud('https://provider.invalid', { method: 'POST' }, 20), { name: 'TimeoutError' });
  } finally {
    clearTimeout(keepAlive);
  }
});

import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, scryptSync } from 'node:crypto';

const requireServer = createRequire(new URL('../server/package.json', import.meta.url));
const jwt = requireServer('jsonwebtoken');
const express = requireServer('express');
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

test('proxy trust is explicit and public origins work behind TLS termination', async t => {
  assert.equal(getTrustProxyHops({}), 0);
  for (const value of ['0', '1', '2', '3']) assert.equal(getTrustProxyHops({ TRUST_PROXY_HOPS: value }), Number(value));
  for (const value of ['true', '4', '-1', '1.5', '']) assert.throws(() => getTrustProxyHops({ TRUST_PROXY_HOPS: value }), /TRUST_PROXY_HOPS/);
  assert.equal(getPublicOrigin({ NODE_ENV: 'production', PUBLIC_ORIGIN: 'https://astha.example/' }), 'https://astha.example');
  assert.throws(() => getPublicOrigin({ NODE_ENV: 'production', PUBLIC_ORIGIN: 'http://astha.example' }), /PUBLIC_ORIGIN/);
  // The host's own address is used only when no origin is configured, and is held to the same rules.
  assert.equal(getPublicOrigin({}), null);
  assert.equal(getPublicOrigin({ NODE_ENV: 'production', RENDER_EXTERNAL_URL: 'https://astha-demo.onrender.com' }), 'https://astha-demo.onrender.com');
  assert.equal(getPublicOrigin({ NODE_ENV: 'production', PUBLIC_ORIGIN: 'https://astha.example', RENDER_EXTERNAL_URL: 'https://astha-demo.onrender.com' }), 'https://astha.example');
  for (const invalid of ['http://astha-demo.onrender.com', 'https://astha-demo.onrender.com/path', 'https://user:pass@astha-demo.onrender.com', '*']) {
    assert.throws(() => getPublicOrigin({ NODE_ENV: 'production', RENDER_EXTERNAL_URL: invalid }), /PUBLIC_ORIGIN/);
  }
  for (const hops of [0, 1]) {
    const app = express();
    app.set('trust proxy', getTrustProxyHops({ TRUST_PROXY_HOPS: String(hops) }));
    app.post('/probe', (req, res) => res.json({ protocol: req.protocol, ip: req.ip,
      sameOrigin: isAllowedOrigin(req.get('origin'), req, []),
      publicOrigin: isAllowedOrigin('https://astha.example', req, [], getPublicOrigin({ PUBLIC_ORIGIN: 'https://astha.example' })) }));
    const listener = app.listen(0, '127.0.0.1');
    await new Promise(resolve => listener.once('listening', resolve));
    const url = 'http://127.0.0.1:' + listener.address().port;
    try {
      const res = await fetch(url + '/probe', { method: 'POST', headers: {
        Origin: url.replace('http:', 'https:'), 'X-Forwarded-Proto': 'https',
        'X-Forwarded-For': '198.51.100.7, 203.0.113.8' } });
      const probe = await res.json();
      assert.equal(probe.protocol, hops === 0 ? 'http' : 'https');
      assert.equal(probe.ip, hops === 0 ? '127.0.0.1' : '203.0.113.8');
      assert.equal(probe.sameOrigin, hops === 1);
      assert.equal(probe.publicOrigin, true);
    } finally {
      await new Promise((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
    }
  }
});

test('security regression requests run against an isolated server without cloud calls', async t => {
  const temp = mkdtempSync(path.join(tmpdir(), 'astha-security-'));
  const reserved = createServer();
  await new Promise(resolve => reserved.listen(0, '127.0.0.1', resolve));
  const port = reserved.address().port;
  await new Promise(resolve => reserved.close(resolve));
  const childEnv = { ...process.env, NODE_ENV: 'production',
    // Standalone execution must also isolate storage from an operator's server/.env.
    DB_PROVIDER: 'sqlite', SUPABASE_DB_URL: '', SUPABASE_DB_CA_FILE: '', RENDER_EXTERNAL_URL: '',
    JWT_SECRET: randomBytes(32).toString('hex'), DB_PATH: path.join(temp, 'test.db'), PORT: String(port),
    CORS_ORIGIN: 'https://trusted.example,capacitor://localhost', PUBLIC_ORIGIN: '', TRUST_PROXY_HOPS: '0',
    CLOUD_AI_PROVIDER: 'auto', MAIRA_API_KEY: '', MAIRA_PROJECT_KEY: '', MAIRA_PROFILE_ID: '',
    MAIRA_API_URL: '', API_KEY: '', PROJECT_KEY: '', GEMINI_API_KEY: '' };
  const root = fileURLToPath(new URL('..', import.meta.url));
  const child = spawn(process.execPath, ['server/index.js'], { cwd: root, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', db;
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  let childError;
  child.on('error', error => { childError = error; });
  const base = 'http://127.0.0.1:' + port;
  let requestCount = 0;
  t.after(async () => {
    db?.close();
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise(resolve => child.once('exit', resolve));
      child.kill();
      await exited;
    }
    rmSync(temp, { recursive: true, force: true });
  });
  let ready = false, probeFailure = '';
  for (let i = 0; i < 100; i += 1) {
    if (childError || child.exitCode !== null) break;
    try {
      const res = await fetch(base + '/api/health', { signal: AbortSignal.timeout(500) });
      if (res.ok) { ready = true; break; }
      probeFailure = 'HTTP ' + res.status;
    } catch (error) { probeFailure = error.message + ' ' + (error.cause?.code || ''); }
    await pause(50);
  }
  assert.ok(ready, 'Isolated server must become ready. ' + probeFailure + ' ' + (childError?.message || output));
  db = new DatabaseSync(childEnv.DB_PATH);

async function api(route, { method = 'GET', body, token, cookie, origin } = {}) {
  requestCount += 1;
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = 'Bearer ' + token;
  if (cookie) headers.Cookie = cookie;
  if (origin) headers.Origin = origin;
  const res = await fetch(base + route, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { res, data };
}
async function guest() {
  const reply = await api('/api/auth/guest', { method: 'POST', body: {} });
  assert.equal(reply.res.status, 200);
  assert.equal(reply.res.headers.get('cache-control'), 'no-store');
  return reply.data;
}

await t.test('separate guests cannot read or delete each other\'s private records or face settings', async () => {
  const a = await guest(), b = await guest();
  assert.notEqual(a.userId, b.userId);
  const memory = await api('/api/memories', { method: 'POST', token: a.token, body: { item: 'wallet', location: 'private drawer' } });
  assert.equal(memory.res.status, 200);
  await api('/api/rooms', { method: 'POST', token: a.token, body: { name: 'private room', notes: 'secret layout' } });
  await api('/api/log', { method: 'POST', token: a.token, body: { text: 'private note' } });
  const savedFace = await api('/api/settings', { method: 'PUT', token: a.token, body: { face_descriptor: Array(128).fill(0.1) } });
  assert.equal(savedFace.res.status, 200);
  const memories = await api('/api/memories', { token: b.token });
  const rooms = await api('/api/rooms', { token: b.token });
  const log = await api('/api/log', { token: b.token });
  const me = await api('/api/auth/me', { token: b.token });
  assert.deepEqual(memories.data.memories, []);
  assert.deepEqual(rooms.data.rooms, []);
  assert.deepEqual(log.data.events, []);
  assert.equal(me.data.face_descriptor, null);
  assert.equal(me.data.phone, null);
  await api('/api/memories/' + memory.data.id, { method: 'DELETE', token: b.token });
  const retained = await api('/api/memories', { token: a.token });
  assert.equal(retained.data.memories.length, 1);
  assert.equal(retained.res.headers.get('cache-control'), 'no-store');
  const resumed = await api('/api/auth/guest', { method: 'POST', token: a.token, body: {} });
  assert.equal(resumed.data.userId, a.userId);
});

await t.test('formerly public signing secret and legacy shared guest session cannot authenticate', async () => {
  const a = await guest();
  const forged = jwt.sign({ sub: a.userId }, 'astha-default-secure-companion-secret-key-2026');
  assert.equal((await api('/api/auth/me', { token: forged })).res.status, 401);
  const legacyId = 'legacy-shared-guest';
  const salt = randomBytes(16).toString('hex');
  db.prepare('INSERT INTO users (id,name,phone,passcode_hash,passcode_salt,created_at) VALUES (?,?,?,?,?,?)')
    .run(legacyId, 'Legacy shared guest', '01000000000', scryptSync('1234', salt, 64).toString('hex'), salt, Date.now());
  const legacyToken = jwt.sign({ sub: legacyId }, childEnv.JWT_SECRET, { algorithm: 'HS256' });
  assert.equal((await api('/api/auth/me', { token: legacyToken })).res.status, 401);
  assert.equal((await api('/api/auth/login', { method: 'POST', body: { phone: '01000000000', passcode: '1234' } })).res.status, 400);
});

await t.test('trusted/native origins work; hostile sites cannot read CORS responses or mutate using a cookie', async () => {
  const a = await guest();
  const trusted = await api('/api/auth/me', { token: a.token, origin: 'https://trusted.example' });
  assert.equal(trusted.res.status, 200);
  assert.equal(trusted.res.headers.get('access-control-allow-origin'), 'https://trusted.example');
  const native = await api('/api/auth/me', { token: a.token, origin: 'capacitor://localhost' });
  assert.equal(native.res.status, 200);
  const hostile = await api('/api/auth/me', { token: a.token, origin: 'https://evil.example' });
  assert.equal(hostile.res.headers.get('access-control-allow-origin'), null);
  const blocked = await api('/api/memories', { method: 'POST', cookie: 'astha_session=' + a.token,
    origin: 'https://evil.example', body: { item: 'wallet', location: 'stolen' } });
  assert.equal(blocked.res.status, 403);
  assert.deepEqual((await api('/api/memories', { token: a.token })).data.memories, []);
});

await t.test('Bangla signup and English login preserve normal authentication; malformed input is rejected', async () => {
  const signup = await api('/api/auth/signup', { method: 'POST', body: { name: 'আস্থা', phone: '০১৭১২৩৪৫৬৭৮', passcode: '১২৩৪' } });
  assert.equal(signup.res.status, 200);
  const login = await api('/api/auth/login', { method: 'POST', body: { phone: '01712345678', passcode: '1234' } });
  assert.equal(login.res.status, 200);
  assert.equal(login.data.userId, signup.data.userId);
  const salt = randomBytes(16).toString('hex');
  db.prepare('INSERT INTO users (id,name,phone,passcode_hash,passcode_salt,created_at) VALUES (?,?,?,?,?,?)')
    .run('legacy-bangla-account', 'পুরনো ব্যবহারকারী', '০১৮১২৩৪৫৬৭৮',
      scryptSync('৫৬৭৮', salt, 64).toString('hex'), salt, Date.now());
  const legacy = await api('/api/auth/login', { method: 'POST', body: { phone: '০১৮১২৩৪৫৬৭৮', passcode: '৫৬৭৮' } });
  assert.equal(legacy.res.status, 200);
  assert.equal(legacy.data.userId, 'legacy-bangla-account');
  const duplicate = await api('/api/auth/signup', { method: 'POST', body: { name: 'Duplicate', phone: '01812345678', passcode: '1234' } });
  assert.equal(duplicate.res.status, 409);
  const legacySalt = randomBytes(16).toString('hex');
  db.prepare('INSERT INTO users (id,name,phone,passcode_hash,passcode_salt,created_at) VALUES (?,?,?,?,?,?)')
    .run('legacy-word-account', 'Legacy user', '01912345678',
      scryptSync('spoken-secret', legacySalt, 64).toString('hex'), legacySalt, Date.now());
  const legacyWords = await api('/api/auth/login', { method: 'POST', body: { phone: '01912345678', passcode: 'spoken-secret' } });
  assert.equal(legacyWords.res.status, 200);
  assert.equal(legacyWords.data.userId, 'legacy-word-account');
  assert.equal((await api('/api/auth/signup', { method: 'POST', body: { name: 'New user', phone: '01612345678', passcode: 'spoken-secret' } })).res.status, 400);
  const malformed = await api('/api/auth/signup', { method: 'POST', body: { name: {}, phone: ['01712345678'], passcode: '1'.repeat(500) } });
  assert.equal(malformed.res.status, 400);
  const oversized = await api('/api/auth/signup', { method: 'POST', body: { name: 'x'.repeat(9000) } });
  assert.equal(oversized.res.status, 413);
});

await t.test('speech rejection is private and cloud-unavailable behavior remains explicit', async () => {
  const a = await guest();
  const speak = await api('/api/speak', { token: a.token });
  assert.equal(speak.res.status, 405);
  assert.equal(speak.res.headers.get('allow'), 'POST');
  assert.equal(speak.res.headers.get('cache-control'), 'no-store');
  const missing = await api('/api/speak', { method: 'POST', token: a.token, body: {} });
  assert.equal(missing.res.status, 400);
  assert.equal(missing.res.headers.get('cache-control'), 'no-store');
  const vision = await api('/api/vision', { method: 'POST', token: a.token, body: { task: 'describe' } });
  assert.equal(vision.res.status, 503);
  assert.equal(vision.data.error, 'no_key');
});

await t.test('invalid memory types and settings are rejected without partial writes or process failure', async () => {
  const a = await guest();
  for (const body of [
    { item: {}, location: 'drawer' }, { item: 'wallet', location: ['drawer'] },
    { item: 'wallet', location: 'drawer', source: {} }, { item: 'wallet', location: 'drawer', score: '0.9' },
    { item: 'x'.repeat(121), location: 'drawer' },
  ]) assert.equal((await api('/api/memories', { method: 'POST', token: a.token, body })).res.status, 400);
  const infiniteScore = await fetch(base + '/api/memories', { method: 'POST',
    headers: { Authorization: 'Bearer ' + a.token, 'Content-Type': 'application/json' },
    body: '{"item":"wallet","location":"drawer","score":1e400}' });
  assert.equal(infiniteScore.status, 400);
  assert.equal((await api('/api/memories?q[]=wallet', { token: a.token })).res.status, 400);
  assert.equal((await api('/api/rooms', { method: 'POST', token: a.token, body: { name: {}, notes: 'text' } })).res.status, 400);
  assert.equal((await api('/api/rooms', { method: 'POST', token: a.token, body: { name: 'room', notes: 'x'.repeat(2001) } })).res.status, 400);
  assert.equal((await api('/api/log', { method: 'POST', token: a.token, body: { text: 'note', kind: {} } })).res.status, 400);
  for (const body of [{ voice_lang: 'fr' }, { mode: {} }, { voice_lang: 'en', face_descriptor: [0.1] },
    { face_descriptor: Array(128).fill('0.1') }]) {
    assert.equal((await api('/api/settings', { method: 'PUT', token: a.token, body })).res.status, 400);
  }
  const me = await api('/api/auth/me', { token: a.token });
  assert.equal(me.data.voice_lang, 'bn');
  assert.equal(me.data.mode, 'auto');
  assert.equal(me.data.face_descriptor, null);
  assert.deepEqual((await api('/api/memories', { token: a.token })).data.memories, []);
  assert.equal((await api('/api/settings', { method: 'PUT', token: a.token, body: { voice_lang: 'en', mode: 'quiet', face_descriptor: Array(128).fill(0.1) } })).res.status, 200);
  assert.equal((await api('/api/settings', { method: 'PUT', token: a.token, body: { face_descriptor: null } })).res.status, 200);
  const validMemory = await api('/api/memories', { method: 'POST', token: a.token, body: { item: 'wallet', location: 'drawer', score: 0.9 } });
  assert.equal(validMemory.res.status, 200);
});

await t.test('auth brute-force requests eventually receive a bounded 429 response', async () => {
  const session = await guest();
  let blocked = false;
  for (let i = 0; i < 35; i += 1) {
    const reply = await api('/api/auth/login', { method: 'POST', body: { phone: '01999999999', passcode: '1234' } });
    if (reply.res.status === 429) {
      assert.ok(Number(reply.res.headers.get('retry-after')) > 0);
      blocked = true;
      break;
    }
    assert.equal(reply.res.status, 401);
  }
  assert.equal(blocked, true);
  assert.equal((await api('/api/auth/me', { token: session.token })).res.status, 200);
  const logout = await api('/api/auth/logout', { method: 'POST' });
  assert.equal(logout.res.status, 200);
  const cleared = logout.res.headers.get('set-cookie');
  assert.match(cleared, /astha_session=;/);
  assert.doesNotMatch(cleared, /Max-Age=/i);
  assert.ok(Date.parse(cleared.match(/Expires=([^;]+)/i)?.[1]) < Date.now());
});

});

