import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';

test('real Express API preserves account and storage contracts on local PostgreSQL via PGlite', { timeout: 60000 }, async t => {
  const reservation = createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const base = 'http://127.0.0.1:' + port;
  const env = { ...process.env, PORT: String(port), NODE_ENV: 'production', JWT_SECRET: randomBytes(32).toString('hex'),
    ASTHA_TEST_PGLITE: '1', DB_PROVIDER: 'supabase', SUPABASE_DB_URL: '', SUPABASE_DB_CA_FILE: '',
    PUBLIC_ORIGIN: '', CORS_ORIGIN: '', TRUST_PROXY_HOPS: '0', CLOUD_AI_PROVIDER: 'auto',
    MAIRA_API_KEY: '', MAIRA_PROJECT_KEY: '', MAIRA_PROFILE_ID: '', MAIRA_API_URL: '', API_KEY: '', PROJECT_KEY: '', GEMINI_API_KEY: '' };
  const loader = new URL('./fixtures/pglite-storage-loader.mjs', import.meta.url).href;
  const setup = 'data:text/javascript,' + encodeURIComponent(`import { register } from 'node:module'; register(${JSON.stringify(loader)}, ${JSON.stringify(import.meta.url)}); globalThis.fetch = async () => { throw new Error('Provider network disabled in local PostgreSQL regression'); };`);
  const child = spawn(process.execPath, ['--import', setup, 'server/index.js'], { cwd: new URL('..', import.meta.url), env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', startupError;
  child.on('error', error => { startupError = error; });
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  t.after(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise(resolve => child.once('exit', resolve));
    child.kill();
    const kill = setTimeout(() => child.kill('SIGKILL'), 3000);
    let timer;
    try { await Promise.race([exited, new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error('PostgreSQL fixture shutdown timed out')), 5000); })]); }
    finally { clearTimeout(kill); clearTimeout(timer); }
  });
  let ready = false;
  for (let attempt = 0; attempt < 200; attempt++) {
    if (startupError || child.exitCode !== null) break;
    try { const response = await fetch(base + '/api/health', { signal: AbortSignal.timeout(500) }); if (response.ok) { ready = true; break; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert(ready, 'Local PostgreSQL API startup failed: ' + output);
  async function api(route, { method = 'GET', token, body } = {}) {
    const response = await fetch(base + '/api' + route, { method, signal: AbortSignal.timeout(8000),
      headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const data = await response.json();
    assert.equal(response.status, 200, route + ': ' + JSON.stringify(data));
    assert.equal(response.headers.get('cache-control'), 'no-store');
    return data;
  }
  let account, guest, note;
  await t.test('Bangla signup, normalized login and guest identities remain distinct', async () => {
    account = await api('/auth/signup', { method: 'POST', body: { name: 'স্থানীয় পরীক্ষা', phone: '০১৭০০০০০০৮১', passcode: '১২৩৪' } });
    const login = await api('/auth/login', { method: 'POST', body: { phone: '01700000081', passcode: '1234' } });
    assert.equal(login.userId, account.userId); assert.equal(typeof login.userId, 'string');
    guest = await api('/auth/guest', { method: 'POST', body: {} });
    assert.notEqual(guest.userId, account.userId);
    assert.equal((await api('/auth/guest', { method: 'POST', token: guest.token, body: {} })).userId, guest.userId);
  });
  await t.test('memory/RAG persist Bangla, scores and numeric milliseconds without cross-account reads', async () => {
    note = await api('/memories', { method: 'POST', token: account.token, body: { item: 'চশমা', location: 'টেবিল', score: 0.75 } });
    const memory = (await api('/memories', { token: account.token })).memories[0];
    assert.equal(memory.id, note.id); assert.equal(memory.score, 0.75); assert(Number.isSafeInteger(memory.created_at));
    assert.equal((await api('/memories', { token: guest.token })).memories.length, 0);
    await api('/rag/docs', { method: 'POST', token: account.token, body: { title: 'চশমা', content: 'টেবিলের কাছে', tags: ['bn'] } });
    const rag = await api('/rag/query', { method: 'POST', token: account.token, body: { query: 'চশমা' } });
    assert.equal(rag.memories.length, 1); assert.equal(rag.docs.length, 1);
    assert.equal((await api('/rag/query', { method: 'POST', token: guest.token, body: { query: 'চশমা' } })).results.length, 0);
  });
  await t.test('concurrent same-name rooms share a stable ID while another account remains separate', async () => {
    const rooms = await Promise.all(['Desk', 'desk', 'DESK'].map(name => api('/rooms', { method: 'POST', token: account.token, body: { name, notes: 'fixture ' + name } })));
    assert(rooms.every(room => room.id === rooms[0].id));
    assert.equal((await api('/rooms', { token: account.token })).rooms.length, 1);
    const other = await api('/rooms', { method: 'POST', token: guest.token, body: { name: 'desk', notes: 'other fixture' } });
    assert.notEqual(other.id, rooms[0].id);
  });
  await t.test('one settings write and explicit biometric clear preserve response fields', async () => {
    const descriptor = Array(128).fill(0.125);
    await api('/settings', { method: 'PUT', token: account.token, body: { voice_lang: 'en', mode: 'quiet', face_descriptor: descriptor } });
    let user = await api('/auth/me', { token: account.token });
    assert.equal(user.voice_lang, 'en'); assert.equal(user.mode, 'quiet'); assert.deepEqual(user.face_descriptor, descriptor);
    await api('/settings', { method: 'PUT', token: account.token, body: { face_descriptor: null } });
    user = await api('/auth/me', { token: account.token });
    assert.equal(user.face_descriptor, null); assert.equal(user.voice_lang, 'en'); assert.equal(user.mode, 'quiet');
  });
  await t.test('agent persistence acknowledges a task while retaining unexecuted-tool verification status', async () => {
    const task = await api('/agent/run', { method: 'POST', token: account.token, body: { goal: 'find my glasses' } });
    assert.equal(typeof task.taskId, 'string'); assert.equal(task.status, 'needs_verification'); assert.equal(task.response.success, false);
  });
  await t.test('scoped delete cannot remove another account memory', async () => {
    await api('/memories/' + note.id, { method: 'DELETE', token: guest.token });
    assert.equal((await api('/memories', { token: account.token })).memories.length, 1);
    await api('/memories/' + note.id, { method: 'DELETE', token: account.token });
    assert.equal((await api('/memories', { token: account.token })).memories.length, 0);
  });
});
