import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const root = fileURLToPath(new URL('..', import.meta.url));
const loader = new URL('./fixtures/async-sqlite-loader.mjs', import.meta.url).href;

test('real API awaits asynchronous disposable SQLite storage and preserves account-owned data', { timeout: 60000 }, async t => {
  const parent = path.resolve(tmpdir());
  const temp = mkdtempSync(path.join(parent, 'astha-storage-api-'));
  const dbPath = path.join(temp, 'routes.db');
  const reserved = createServer();
  await new Promise(resolve => reserved.listen(0, '127.0.0.1', resolve));
  const port = reserved.address().port;
  await new Promise(resolve => reserved.close(resolve));
  const base = 'http://127.0.0.1:' + port;
  const env = {
    ...process.env, NODE_ENV: 'production', JWT_SECRET: randomBytes(32).toString('hex'),
    DB_PROVIDER: 'sqlite', DB_PATH: dbPath, SUPABASE_DB_URL: '', DATABASE_URL: '',
    SUPABASE_URL: '', SUPABASE_SERVICE_ROLE_KEY: '', SUPABASE_ANON_KEY: '',
    ASTHA_TEST_ASYNC_SQLITE: '1', PORT: String(port),
    CORS_ORIGIN: '', PUBLIC_ORIGIN: '', TRUST_PROXY_HOPS: '0',
    CLOUD_AI_PROVIDER: 'auto', MAIRA_API_KEY: '', MAIRA_PROJECT_KEY: '', MAIRA_PROFILE_ID: '',
    MAIRA_API_URL: '', API_KEY: '', PROJECT_KEY: '', GEMINI_API_KEY: '', GEMINI_MODELS: '',
  };
  // The child serves real HTTP requests but cannot use fetch for any AI/provider call.
  const setup = 'data:text/javascript,' + encodeURIComponent(`
    import { register } from 'node:module';
    register(${JSON.stringify(loader)}, ${JSON.stringify(import.meta.url)});
    globalThis.fetch = async () => { throw new Error('Provider network disabled in storage regression'); };
  `);
  let child, output = '', inspection;
  async function stopServer() {
    const stopping = child;
    if (!stopping || stopping.exitCode !== null || stopping.signalCode !== null) return;
    const exited = new Promise(resolve => stopping.once('exit', resolve));
    stopping.kill();
    const timeout = setTimeout(() => stopping.kill('SIGKILL'), 2000);
    let deadline;
    const overdue = new Promise((resolve, reject) => { deadline = setTimeout(() => reject(new Error('Storage test server did not stop')), 4000); });
    try { await Promise.race([exited, overdue]); }
    finally { clearTimeout(timeout); clearTimeout(deadline); }
  }
  t.after(async () => {
    inspection?.close();
    await stopServer();
    // Delete only the directory freshly created by this test, never a supplied DB path.
    assert.equal(path.dirname(path.resolve(temp)), parent);
    assert(path.basename(temp).startsWith('astha-storage-api-'));
    rmSync(temp, { recursive: true, force: true });
  });
  async function startServer() {
    child = spawn(process.execPath, ['--import', setup, 'server/index.js'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let startupError, probeFailure = '';
    child.on('error', error => { startupError = error; });
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    for (let attempt = 0; attempt < 100; attempt++) {
      if (startupError || child.exitCode !== null) break;
      try {
        const reply = await fetch(base + '/api/health', { signal: AbortSignal.timeout(500) });
        if (reply.ok) {
          const status = await reply.json();
          assert.equal(status.cloud, false, 'No cloud credentials may be active in the storage test');
          return;
        }
        probeFailure = 'HTTP ' + reply.status;
      } catch (error) {
        if (error instanceof assert.AssertionError) throw error;
        probeFailure = error.message + ' ' + (error.cause?.code || '');
      }
      await pause(50);
    }
    assert.fail('Disposable async storage server did not start: ' + probeFailure + ' ' + (startupError?.message || output));
  }
  async function api(route, { method = 'GET', body, token } = {}) {
    const headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (token) headers.Authorization = 'Bearer ' + token;
    const reply = await fetch(base + route, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    const text = await reply.text();
    let data;
    try { data = JSON.parse(text); } catch { assert.fail('API must return JSON for ' + route + ': ' + text.slice(0, 120)); }
    return { status: reply.status, headers: reply.headers, data };
  }
  async function ok(route, options) {
    const result = await api(route, options);
    assert.equal(result.status, 200, route + ': ' + JSON.stringify(result.data));
    assert.equal(result.headers.get('cache-control'), 'no-store');
    return result.data;
  }
  await startServer();
  inspection = new DatabaseSync(dbPath);
  let account, login, guestA, guestB, memoryId, roomId, docId;

  await t.test('signup/login and guest resumption await account reads/writes before returning valid identity', async () => {
    account = await ok('/api/auth/signup', { method: 'POST', body: { name: 'আস্থা পরীক্ষা', phone: '০১৭২৩৪৫৬৭৮৯', passcode: '১২৩৪' } });
    assert.equal(typeof account.userId, 'string'); assert.equal(typeof account.token, 'string');
    const me = await ok('/api/auth/me', { token: account.token });
    assert.equal(me.id, account.userId); assert.equal(me.phone, '01723456789');
    assert.equal(me.voice_lang, 'bn'); assert.equal(me.mode, 'auto');
    login = await ok('/api/auth/login', { method: 'POST', body: { phone: '01723456789', passcode: '1234' } });
    assert.equal(login.userId, account.userId);
    assert.equal((await api('/api/auth/login', { method: 'POST', body: { phone: '01723456789', passcode: '9999' } })).status, 401);
    assert.equal((await api('/api/auth/signup', { method: 'POST', body: { name: 'Duplicate', phone: '01723456789', passcode: '1234' } })).status, 409);
    guestA = await ok('/api/auth/guest', { method: 'POST', body: {} });
    guestB = await ok('/api/auth/guest', { method: 'POST', body: {} });
    assert.notEqual(guestA.userId, guestB.userId);
    assert.equal((await ok('/api/auth/guest', { method: 'POST', body: {}, token: guestA.token })).userId, guestA.userId);
    assert.equal((await api('/api/memories')).status, 401);
  });

  await t.test('memory response waits for committed persistence and remains account-owned', async () => {
    const saved = await ok('/api/memories', { method: 'POST', token: account.token,
      body: { item: 'wallet', location: 'drawer in Living Room', source: 'Your note', score: null } });
    memoryId = saved.id; assert.equal(typeof memoryId, 'string');
    const persisted = inspection.prepare('SELECT * FROM memories WHERE id = ?').get(memoryId);
    assert.equal(persisted.user_id, account.userId); assert.equal(persisted.score, null);
    const records = (await ok('/api/memories?q=wallet', { token: login.token })).memories;
    assert.equal(records.length, 1); assert.equal(records[0].id, memoryId); assert.equal(typeof records[0].created_at, 'number');
    assert.deepEqual((await ok('/api/memories', { token: guestA.token })).memories, []);
    await ok('/api/memories/' + memoryId, { method: 'DELETE', token: guestA.token });
    assert.equal((await ok('/api/memories', { token: account.token })).memories.length, 1);
  });

  await t.test('case-insensitive room upsert awaits its lookup and updates only the owning row', async () => {
    roomId = (await ok('/api/rooms', { method: 'POST', token: account.token,
      body: { name: 'Living Room', notes: 'Original room note' } })).id;
    const update = await ok('/api/rooms', { method: 'POST', token: account.token,
      body: { name: 'living room', notes: 'Wallet drawer beside the window' } });
    assert.equal(update.id, roomId);
    const rooms = (await ok('/api/rooms', { token: account.token })).rooms;
    assert.equal(rooms.length, 1); assert.equal(rooms[0].notes, 'Wallet drawer beside the window');
    assert.equal(inspection.prepare('SELECT COUNT(*) AS n FROM rooms WHERE user_id = ?').get(account.userId).n, 1);
    await ok('/api/rooms/' + roomId, { method: 'DELETE', token: guestB.token });
    assert.equal((await ok('/api/rooms', { token: account.token })).rooms.length, 1);
  });

  await t.test('camera capture timestamps survive persistence and cannot bypass validation or account ownership', async () => {
    const observedAt = Date.now() - 86400000;
    const saved = await ok('/api/memories', { method: 'POST', token: account.token,
      body: { item: 'observed phone', location: 'Possible sighting in image; physical location unconfirmed', source: 'Camera observation (online, possible)', observed_at: observedAt } });
    const record = inspection.prepare('SELECT * FROM memories WHERE id = ?').get(saved.id);
    assert.equal(record.created_at, observedAt); assert.equal(record.user_id, account.userId);
    assert.equal((await ok('/api/memories?q=observed phone', { token: account.token })).memories[0].created_at, observedAt);
    assert.deepEqual((await ok('/api/memories?q=observed phone', { token: guestB.token })).memories, []);
    for (const invalid of [null, '2026-10-17', false, {}, [], -1, 0, 1.5, Date.now() + 60000, Number.MAX_SAFE_INTEGER]) {
      assert.equal((await api('/api/memories', { method: 'POST', token: account.token,
        body: { item: 'invalid timestamp', location: 'unknown', observed_at: invalid } })).status, 400, JSON.stringify(invalid));
    }
    assert.equal(inspection.prepare('SELECT COUNT(*) AS n FROM memories WHERE item = ?').get('invalid timestamp').n, 0);
    await ok('/api/memories/' + saved.id, { method: 'DELETE', token: guestB.token });
    assert(inspection.prepare('SELECT * FROM memories WHERE id = ?').get(saved.id));
    await ok('/api/memories/' + saved.id, { method: 'DELETE', token: account.token });
  });

  await t.test('concurrent same-name room saves share one stable owned ID without merging accounts', async () => {
    const notes = Array.from({ length: 6 }, (_, index) => 'Concurrent room note ' + index);
    const saves = await Promise.all(notes.map((note, index) => ok('/api/rooms', {
      method: 'POST', token: account.token,
      body: { name: index % 2 ? 'concurrent room' : 'Concurrent Room', notes: note },
    })));
    assert.equal(new Set(saves.map(save => save.id)).size, 1);
    const ownedId = saves[0].id;
    const owned = (await ok('/api/rooms', { token: account.token })).rooms.filter(room => room.name.toLowerCase() === 'concurrent room');
    assert.equal(owned.length, 1); assert.equal(owned[0].id, ownedId); assert(notes.includes(owned[0].notes));
    assert.equal(inspection.prepare('SELECT COUNT(*) AS n FROM rooms WHERE user_id = ? AND lower(name) = ?').get(account.userId, 'concurrent room').n, 1);
    const other = await ok('/api/rooms', { method: 'POST', token: guestA.token,
      body: { name: 'CONCURRENT ROOM', notes: 'A separate guest room' } });
    assert.notEqual(other.id, ownedId);
    assert.equal((await ok('/api/rooms', { token: guestA.token })).rooms[0].notes, 'A separate guest room');
    await ok('/api/rooms/' + ownedId, { method: 'DELETE', token: account.token });
    await ok('/api/rooms/' + other.id, { method: 'DELETE', token: guestA.token });
  });

  await t.test('activity and settings acknowledgements reflect persisted values and biometric clearing', async () => {
    await ok('/api/log', { method: 'POST', token: account.token, body: { kind: 'test', text: 'Test activity marker' } });
    const events = (await ok('/api/log', { token: account.token })).events;
    assert.equal(events.length, 1); assert.equal(events[0].text, 'Test activity marker');
    const descriptor = Array.from({ length: 128 }, (_, index) => index / 128);
    await ok('/api/settings', { method: 'PUT', token: account.token, body: { voice_lang: 'en', mode: 'quiet', face_descriptor: descriptor } });
    let me = await ok('/api/auth/me', { token: account.token });
    assert.equal(me.voice_lang, 'en'); assert.equal(me.mode, 'quiet'); assert.deepEqual(me.face_descriptor, descriptor);
    await ok('/api/settings', { method: 'PUT', token: account.token, body: { face_descriptor: null } });
    me = await ok('/api/auth/me', { token: account.token }); assert.equal(me.face_descriptor, null);
    for (const body of [{ mode: {} }, { voice_lang: 'fr' }, { face_descriptor: [1, 2] }, { face_descriptor: Array(128).fill('0') }]) {
      assert.equal((await api('/api/settings', { method: 'PUT', token: account.token, body })).status, 400);
    }
    me = await ok('/api/auth/me', { token: account.token }); assert.equal(me.voice_lang, 'en'); assert.equal(me.mode, 'quiet');
    assert.deepEqual((await ok('/api/log', { token: guestB.token })).events, []);
  });

  await t.test('RAG docs/query await all storage reads and return persisted relevant data only for that account', async () => {
    docId = (await ok('/api/rag/docs', { method: 'POST', token: account.token,
      body: { title: 'Wallet reminder', content: 'The wallet is kept in the drawer.', category: 'personal', tags: ['wallet', 'home'] } })).id;
    const persisted = inspection.prepare('SELECT * FROM knowledge_docs WHERE id = ?').get(docId);
    assert.equal(persisted.user_id, account.userId); assert.deepEqual(JSON.parse(persisted.tags_json), ['wallet', 'home']);
    const query = await ok('/api/rag/query', { method: 'POST', token: account.token, body: { query: 'wallet', limit: 10 } });
    assert.equal(query.ok, true); assert(query.docs.some(doc => doc.id === docId));
    assert(query.memories.some(memory => memory.id === memoryId)); assert(query.rooms.some(room => room.id === roomId));
    assert.match(query.contextBlock, /Wallet reminder/);
    const other = await ok('/api/rag/query', { method: 'POST', token: guestA.token, body: { query: 'wallet' } });
    assert.deepEqual(other.results, []); assert.equal(other.contextBlock, '');
    for (const body of [{ title: {}, content: 'x' }, { title: 'x', content: [] }, { title: 'x', content: 'y', tags: [{}] }]) {
      assert.equal((await api('/api/rag/docs', { method: 'POST', token: account.token, body })).status, 400);
    }
    for (const body of [{ query: {} }, { query: 'wallet', limit: 'six' }, { query: 'wallet', limit: -1 }]) {
      assert.equal((await api('/api/rag/query', { method: 'POST', token: account.token, body })).status, 400);
    }
  });

  await t.test('a process restart preserves sessions and committed memories/rooms/log/settings/docs', async () => {
    await stopServer(); await startServer();
    const me = await ok('/api/auth/me', { token: login.token });
    assert.equal(me.id, account.userId); assert.equal(me.voice_lang, 'en'); assert.equal(me.mode, 'quiet');
    assert.equal((await ok('/api/memories', { token: login.token })).memories[0].id, memoryId);
    assert.equal((await ok('/api/rooms', { token: login.token })).rooms[0].id, roomId);
    assert.equal((await ok('/api/log', { token: login.token })).events.length, 1);
    const rag = await ok('/api/rag/query', { method: 'POST', token: login.token, body: { query: 'wallet' } });
    assert(rag.docs.some(doc => doc.id === docId));
  });

  await t.test('rejected asynchronous writes cannot return successful saves or reveal internal storage errors', async () => {
    const marker = 'synthetic_private_storage_failure_marker';
    const cases = [
      { table: 'memories', operation: 'INSERT', route: '/api/memories', method: 'POST', body: { item: 'keys', location: 'desk' } },
      { table: 'rooms', operation: 'UPDATE', route: '/api/rooms', method: 'POST', body: { name: 'Living Room', notes: 'Should not persist' } },
      { table: 'events', operation: 'INSERT', route: '/api/log', method: 'POST', body: { kind: 'test', text: 'Should not persist' } },
      { table: 'users', operation: 'UPDATE', route: '/api/settings', method: 'PUT', body: { voice_lang: 'bn', mode: 'auto', face_descriptor: Array(128).fill(0.5) } },
      { table: 'knowledge_docs', operation: 'INSERT', route: '/api/rag/docs', method: 'POST', body: { title: 'Should fail', content: 'Should not persist' } },
      { table: 'memories', operation: 'DELETE', route: '/api/memories', method: 'DELETE' },
      { table: 'rooms', operation: 'DELETE', route: '/api/rooms', method: 'DELETE' },
      { table: 'events', operation: 'DELETE', route: '/api/log', method: 'DELETE' },
      { table: 'users', operation: 'INSERT', route: '/api/auth/signup', method: 'POST', body: { name: 'Failed signup', phone: '01823456789', passcode: '1234' } },
      { table: 'users', operation: 'INSERT', route: '/api/auth/guest', method: 'POST', body: {} },
    ];
    for (const [index, probe] of cases.entries()) {
      const trigger = 'reject_test_write_' + index;
      inspection.exec(`CREATE TRIGGER ${trigger} BEFORE ${probe.operation} ON ${probe.table} BEGIN SELECT RAISE(ABORT, '${marker}'); END;`);
      try {
        const reply = await api(probe.route, { method: probe.method, body: probe.body, token: account.token });
        assert.equal(reply.status, 500, probe.route + ' must wait for a failed write');
        assert.equal(reply.data.ok, undefined); assert.equal(reply.data.id, undefined);
        assert.equal(reply.data.token, undefined); assert.equal(reply.data.userId, undefined);
        assert.equal(typeof reply.data.error, 'string');
        assert(!JSON.stringify(reply.data).includes(marker));
      } finally { inspection.exec('DROP TRIGGER ' + trigger); }
    }
    assert.equal((await ok('/api/memories', { token: account.token })).memories.length, 1);
    assert.equal((await ok('/api/rooms', { token: account.token })).rooms[0].notes, 'Wallet drawer beside the window');
    assert.equal((await ok('/api/log', { token: account.token })).events.length, 1);
    const unchanged = await ok('/api/auth/me', { token: account.token });
    assert.equal(unchanged.voice_lang, 'en'); assert.equal(unchanged.mode, 'quiet'); assert.equal(unchanged.face_descriptor, null);
    await pause(20); assert(!output.includes(marker), 'Application logs must not expose storage exception details');
  });

  await t.test('storage read outages are handled failures rather than empty success or invalid-login responses', async () => {
    inspection.exec('ALTER TABLE memories RENAME TO unavailable_memories');
    try {
      for (const [route, options] of [['/api/memories', {}], ['/api/rag/query', { method: 'POST', body: { query: 'wallet' } }]]) {
        const reply = await api(route, { ...options, token: account.token });
        assert.equal(reply.status, 500); assert.equal(reply.data.ok, undefined);
        assert.equal(typeof reply.data.error, 'string');
        assert(!JSON.stringify(reply.data).includes('unavailable_memories')); assert(!JSON.stringify(reply.data).includes('no such table'));
      }
    } finally { inspection.exec('ALTER TABLE unavailable_memories RENAME TO memories'); }
    // Account lookup failure must remain a storage failure, not quietly turn into an anonymous session.
    inspection.exec('ALTER TABLE users RENAME TO unavailable_users');
    try {
      const reply = await api('/api/auth/me', { token: account.token });
      assert.equal(reply.status, 500); assert.notEqual(reply.data.error, 'not_signed_in');
      assert(!JSON.stringify(reply.data).includes('unavailable_users'));
    } finally { inspection.exec('ALTER TABLE unavailable_users RENAME TO users'); }
    assert.equal((await ok('/api/auth/me', { token: account.token })).id, account.userId);
  });

  await t.test('successful async deletions persist and cannot remove another account records', async () => {
    const guestNote = await ok('/api/memories', { method: 'POST', token: guestB.token, body: { item: 'glasses', location: 'guest desk' } });
    await ok('/api/memories', { method: 'DELETE', token: account.token });
    await ok('/api/rooms', { method: 'DELETE', token: account.token });
    await ok('/api/log', { method: 'DELETE', token: account.token });
    assert.deepEqual((await ok('/api/memories', { token: account.token })).memories, []);
    assert.deepEqual((await ok('/api/rooms', { token: account.token })).rooms, []);
    assert.deepEqual((await ok('/api/log', { token: account.token })).events, []);
    assert.equal((await ok('/api/memories', { token: guestB.token })).memories[0].id, guestNote.id);
  });
});
