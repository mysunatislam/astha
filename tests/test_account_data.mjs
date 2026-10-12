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
const TABLES = ['memories', 'rooms', 'events', 'agent_tasks', 'knowledge_docs'];

// Real HTTP against a disposable SQLite file. No provider credentials exist and fetch is
// disabled in the child, so every agent route exercises its heuristic path only.
test('account export, deletion, retention and input bounds over the real API', { timeout: 90000 }, async t => {
  const parent = path.resolve(tmpdir());
  const temp = mkdtempSync(path.join(parent, 'astha-account-data-'));
  const dbPath = path.join(temp, 'account.db');
  const reserved = createServer();
  await new Promise(resolve => reserved.listen(0, '127.0.0.1', resolve));
  const port = reserved.address().port;
  await new Promise(resolve => reserved.close(resolve));
  const base = 'http://127.0.0.1:' + port;
  const env = {
    ...process.env, NODE_ENV: 'production', JWT_SECRET: randomBytes(32).toString('hex'),
    DB_PROVIDER: 'sqlite', DB_PATH: dbPath, SUPABASE_DB_URL: '', DATABASE_URL: '',
    ASTHA_TEST_ASYNC_SQLITE: '1', PORT: String(port),
    CORS_ORIGIN: '', PUBLIC_ORIGIN: '', TRUST_PROXY_HOPS: '0',
    CLOUD_AI_PROVIDER: 'auto', MAIRA_API_KEY: '', MAIRA_PROJECT_KEY: '', MAIRA_PROFILE_ID: '',
    MAIRA_API_URL: '', API_KEY: '', PROJECT_KEY: '', GEMINI_API_KEY: '', GEMINI_MODELS: '',
  };
  const setup = 'data:text/javascript,' + encodeURIComponent(`
    import { register } from 'node:module';
    register(${JSON.stringify(loader)}, ${JSON.stringify(import.meta.url)});
    globalThis.fetch = async () => { throw new Error('Provider network disabled in account regression'); };
  `);
  let child, output = '', inspection;
  t.after(async () => {
    inspection?.close();
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise(resolve => child.once('exit', resolve));
      child.kill();
      const force = setTimeout(() => child.kill('SIGKILL'), 2000);
      await exited; clearTimeout(force);
    }
    // Delete only the directory freshly created by this test.
    assert.equal(path.dirname(path.resolve(temp)), parent);
    assert(path.basename(temp).startsWith('astha-account-data-'));
    rmSync(temp, { recursive: true, force: true });
  });
  child = spawn(process.execPath, ['--import', setup, 'server/index.js'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  let ready = false;
  for (let attempt = 0; attempt < 100 && child.exitCode === null; attempt++) {
    try {
      const reply = await fetch(base + '/api/health', { signal: AbortSignal.timeout(500) });
      if (reply.ok) { ready = true; break; }
    } catch { /* Server is still starting. */ }
    await pause(50);
  }
  assert(ready, 'Disposable account server did not start: ' + output);
  inspection = new DatabaseSync(dbPath);

  async function api(route, { method = 'GET', body, token } = {}) {
    const headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (token) headers.Authorization = 'Bearer ' + token;
    const reply = await fetch(base + route, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(8000),
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
  const count = (table, userId) => inspection.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE user_id = ?`).get(userId).n;
  const descriptor = Array.from({ length: 128 }, (_, index) => index / 128);

  const owner = await ok('/api/auth/signup', { method: 'POST', body: { name: 'আস্থা মালিক', phone: '01712345678', passcode: '4821' } });
  const other = await ok('/api/auth/guest', { method: 'POST', body: {} });
  const ownerMemory = (await ok('/api/memories', { method: 'POST', token: owner.token, body: { item: 'চশমা', location: 'পড়ার টেবিল' } })).id;
  await ok('/api/rooms', { method: 'POST', token: owner.token, body: { name: 'Bedroom', notes: 'Bed on the left' } });
  await ok('/api/log', { method: 'POST', token: owner.token, body: { kind: 'note', text: 'Owner activity' } });
  const ownerDoc = (await ok('/api/rag/docs', { method: 'POST', token: owner.token,
    body: { title: 'Medicine', content: 'Blue box on the shelf', category: 'health', tags: ['medicine'] } })).id;
  await ok('/api/agent/plan', { method: 'POST', token: owner.token, body: { goal: 'find my glasses' } });
  await ok('/api/settings', { method: 'PUT', token: owner.token, body: { voice_lang: 'en', face_descriptor: descriptor } });
  const otherMemory = (await ok('/api/memories', { method: 'POST', token: other.token, body: { item: 'other-account-keys', location: 'other-account-desk' } })).id;
  const otherDoc = (await ok('/api/rag/docs', { method: 'POST', token: other.token, body: { title: 'other-account-note', content: 'other-account-content' } })).id;

  await t.test('export contains every owned record, no credentials and no other account', async () => {
    assert.equal((await api('/api/account/export')).status, 401);
    const reply = await api('/api/account/export', { token: owner.token });
    assert.equal(reply.status, 200);
    assert.equal(reply.headers.get('cache-control'), 'no-store');
    assert.match(reply.headers.get('content-disposition'), /^attachment; filename="astha-export\.json"$/);
    const data = reply.data;
    assert.equal(data.format, 'astha-export-v1');
    assert.equal(typeof data.exported_at, 'number');
    assert.deepEqual(data.truncated, []);
    assert.deepEqual(Object.keys(data.account).sort(), ['created_at', 'face_descriptor', 'id', 'mode', 'name', 'phone', 'voice_lang']);
    assert.equal(data.account.id, owner.userId); assert.equal(data.account.name, 'আস্থা মালিক');
    assert.equal(data.account.phone, '01712345678'); assert.equal(data.account.voice_lang, 'en');
    assert.deepEqual(data.account.face_descriptor, descriptor);
    assert.deepEqual(data.memories.map(row => [row.id, row.item, row.location]), [[ownerMemory, 'চশমা', 'পড়ার টেবিল']]);
    assert.deepEqual(data.rooms.map(row => [row.name, row.notes]), [['Bedroom', 'Bed on the left']]);
    assert.deepEqual(data.events.map(row => row.text), ['Owner activity']);
    assert.equal(data.agent_tasks.length, 1);
    assert.equal(data.agent_tasks[0].goal, 'find my glasses');
    assert(Array.isArray(data.agent_tasks[0].plan.steps), 'stored plan JSON is exported as a value');
    assert.deepEqual(data.knowledge_docs.map(row => [row.id, row.title, row.tags]), [[ownerDoc, 'Medicine', ['medicine']]]);
    const serialized = JSON.stringify(data);
    assert.doesNotMatch(serialized, /passcode|other-account|user_id/);
    const stored = inspection.prepare('SELECT passcode_hash, passcode_salt FROM users WHERE id = ?').get(owner.userId);
    assert(!serialized.includes(stored.passcode_hash) && !serialized.includes(stored.passcode_salt));
    // A guest has no phone and still receives only its own records.
    const guest = await ok('/api/account/export', { token: other.token });
    assert.equal(guest.account.phone, null); assert.equal(guest.account.face_descriptor, null);
    assert.deepEqual(guest.memories.map(row => row.id), [otherMemory]);
    assert.equal(guest.rooms.length + guest.events.length + guest.agent_tasks.length, 0);
  });

  await t.test('personal notes can be listed and removed only by their owner', async () => {
    assert.deepEqual((await ok('/api/rag/docs', { token: owner.token })).docs.map(doc => doc.id), [ownerDoc]);
    await ok('/api/rag/docs/' + ownerDoc, { method: 'DELETE', token: other.token });
    assert.equal(count('knowledge_docs', owner.userId), 1);
    await ok('/api/rag/docs', { method: 'DELETE', token: other.token });
    assert.equal(count('knowledge_docs', owner.userId), 1); assert.equal(count('knowledge_docs', other.userId), 0);
    await ok('/api/rag/docs/' + ownerDoc, { method: 'DELETE', token: owner.token });
    assert.equal(count('knowledge_docs', owner.userId), 0);
    assert.equal(inspection.prepare('SELECT COUNT(*) AS n FROM knowledge_docs WHERE id = ?').get(otherDoc).n, 0);
  });

  await t.test('oversized or mistyped agent, note, search and vision input is rejected before any work', async () => {
    const before = TABLES.map(table => count(table, owner.userId));
    const big = 'x'.repeat(20000);
    const rejected = [
      ['/api/agent/plan', { goal: 'g'.repeat(501) }], ['/api/agent/plan', { goal: { text: 'find' } }],
      ['/api/agent/plan', { goal: 'find keys', image: 12345 }], ['/api/agent/plan', { goal: '   ' }],
      ['/api/agent/run', { goal: 'find keys', observations: Array(21).fill({}) }],
      ['/api/agent/run', { goal: 'find keys', observations: [{ note: big }] }],
      ['/api/agent/run', { goal: 'find keys', observations: 'seen' }],
      ['/api/agent/run', { goal: ['find keys'] }],
      ['/api/agent/evaluate', { step: 'tool_vision_detect', toolOutput: { found: true } }],
      ['/api/agent/evaluate', { step: { tool: 'tool_ocr_read' }, toolOutput: 'text' }],
      ['/api/agent/evaluate', { step: { tool: 'tool_ocr_read', args: { focus_area: big } }, toolOutput: { text: 'ok' } }],
      ['/api/agent/evaluate', { step: { tool: 'tool_ocr_read' }, toolOutput: { text: big } }],
      ['/api/agent/evaluate', { step: { tool: 'tool_ocr_read' }, toolOutput: { text: 'ok' }, goal: 'g'.repeat(501) }],
      ['/api/rag/docs', { title: 't'.repeat(101), content: 'c' }], ['/api/rag/docs', { title: 't', content: 'c'.repeat(4001) }],
      ['/api/rag/docs', { title: 't', content: 'c', category: 'k'.repeat(41) }],
      ['/api/rag/docs', { title: 't', content: 'c', tags: Array(21).fill('tag') }],
      ['/api/rag/docs', { title: 't', content: 'c', tags: ['t'.repeat(41)] }],
      ['/api/rag/query', { query: 'q'.repeat(241) }],
      ['/api/vision', { task: 'describe', maxTokens: 'many' }], ['/api/vision', { task: 'describe', maxTokens: 100000 }],
      ['/api/vision', { image: 'AAAA' }], ['/api/vision', { prompt: 'p'.repeat(32001) }],
      ['/api/vision', { task: 'describe', image: { data: 'AAAA' } }], ['/api/vision', { task: ['describe'] }],
    ];
    for (const [route, body] of rejected) {
      const reply = await api(route, { method: 'POST', token: owner.token, body });
      assert.equal(reply.status, 400, route + ' ' + JSON.stringify(body).slice(0, 60));
      assert.equal(typeof reply.data.error, 'string');
      assert(!JSON.stringify(reply.data).includes('xxxx'), 'rejected input is not echoed');
    }
    assert.deepEqual(TABLES.map(table => count(table, owner.userId)), before, 'rejected input stores nothing');
    // A mistyped OCR result is a failed step, not a server error.
    const evaluated = await ok('/api/agent/evaluate', { method: 'POST', token: owner.token,
      body: { step: { tool: 'tool_ocr_read' }, toolOutput: { text: 42 } } });
    assert.equal(evaluated.evaluation.verified, false);
    // Without configured credentials the provider category is fixed and carries no detail.
    const vision = await api('/api/vision', { method: 'POST', token: owner.token, body: { task: 'describe' } });
    assert.equal(vision.status, 503); assert.deepEqual(vision.data, { error: 'no_key', message: 'no_key' });
    const unknown = await api('/api/not-a-route', { token: owner.token });
    assert.equal(unknown.status, 404); assert.deepEqual(unknown.data, { error: 'not_found' });
    assert.equal((await api('/api/not-a-route', { method: 'POST', token: owner.token, body: {} })).status, 404);
  });

  await t.test('each account keeps only its newest rows and another account is never pruned', async () => {
    const insert = {
      memories: inspection.prepare('INSERT INTO memories (id,user_id,item,location,source,score,created_at) VALUES (?,?,?,?,?,?,?)'),
      events: inspection.prepare('INSERT INTO events (id,user_id,kind,text,created_at) VALUES (?,?,?,?,?)'),
      agent_tasks: inspection.prepare('INSERT INTO agent_tasks (id,user_id,goal,plan_json,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?)'),
      knowledge_docs: inspection.prepare('INSERT INTO knowledge_docs (id,user_id,category,title,content,tags_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)'),
      rooms: inspection.prepare('INSERT INTO rooms (id,user_id,name,notes,updated_at) VALUES (?,?,?,?,?)'),
    };
    // Older than every API-created row, so the seeded rows are the ones retention removes first.
    inspection.exec('BEGIN');
    for (let i = 0; i < 520; i++) insert.memories.run('seed-m-' + i, owner.userId, 'item ' + i, 'place', 'Your note', null, 1000 + i);
    for (let i = 0; i < 230; i++) insert.events.run('seed-e-' + i, owner.userId, 'note', 'event ' + i, 1000 + i);
    for (let i = 0; i < 70; i++) insert.agent_tasks.run('seed-t-' + i, owner.userId, 'goal ' + i, '{}', 'planned', 1000 + i, 1000 + i);
    for (let i = 0; i < 210; i++) insert.knowledge_docs.run('seed-d-' + i, owner.userId, 'general', 'title ' + i, 'content', '[]', 1000 + i, 1000 + i);
    for (let i = 0; i < 120; i++) insert.rooms.run('seed-r-' + i, owner.userId, 'Seed room ' + i, 'notes', 1000 + i);
    for (let i = 0; i < 600; i++) insert.memories.run('other-m-' + i, other.userId, 'item ' + i, 'place', 'Your note', null, 1000 + i);
    inspection.exec('COMMIT');

    const newest = (await ok('/api/memories', { method: 'POST', token: owner.token, body: { item: 'newest keys', location: 'door hook' } })).id;
    await ok('/api/log', { method: 'POST', token: owner.token, body: { text: 'newest event' } });
    await ok('/api/agent/run', { method: 'POST', token: owner.token, body: { goal: 'find newest keys' } });
    await ok('/api/rag/docs', { method: 'POST', token: owner.token, body: { title: 'newest note', content: 'kept' } });
    await ok('/api/rooms', { method: 'POST', token: owner.token, body: { name: 'Newest room', notes: 'kept' } });

    assert.equal(count('memories', owner.userId), 500);
    assert.equal(count('events', owner.userId), 200);
    assert.equal(count('agent_tasks', owner.userId), 50);
    assert.equal(count('knowledge_docs', owner.userId), 200);
    assert.equal(count('rooms', owner.userId), 100);
    const kept = id => inspection.prepare('SELECT COUNT(*) AS n FROM memories WHERE id = ?').get(id).n === 1;
    assert(kept(newest) && kept(ownerMemory) && kept('seed-m-519'), 'newest rows survive');
    assert(!kept('seed-m-0') && !kept('seed-m-21'), 'oldest rows are removed first');
    assert(kept('seed-m-22'), 'exactly the newest 500 remain');
    assert.equal(inspection.prepare("SELECT COUNT(*) AS n FROM events WHERE text = 'newest event'").get().n, 1);
    assert.equal(inspection.prepare("SELECT COUNT(*) AS n FROM rooms WHERE name = 'Newest room'").get().n, 1);
    assert.equal(count('memories', other.userId), 601, 'retention never crosses accounts');
    // The list route still returns its own bounded, newest-first window.
    const listed = (await ok('/api/memories', { token: owner.token })).memories;
    assert.equal(listed.length, 200); assert.equal(listed[0].id, newest);
  });

  await t.test('clearing the activity log also clears agent task history for that account only', async () => {
    await ok('/api/agent/plan', { method: 'POST', token: other.token, body: { goal: 'find other things' } });
    assert(count('agent_tasks', owner.userId) > 0 && count('events', owner.userId) > 0);
    await ok('/api/log', { method: 'DELETE', token: owner.token });
    assert.equal(count('events', owner.userId), 0); assert.equal(count('agent_tasks', owner.userId), 0);
    assert.equal(count('agent_tasks', other.userId), 1);
  });

  await t.test('a guest who registers keeps the same account, and signing in removes only an untouched guest', async () => {
    const users = id => inspection.prepare('SELECT COUNT(*) AS n FROM users WHERE id = ?').get(id).n;
    const guest = await ok('/api/auth/guest', { method: 'POST', body: {} });
    const saved = (await ok('/api/memories', { method: 'POST', token: guest.token, body: { item: 'guest wallet', location: 'guest drawer' } })).id;
    // A taken phone number is refused and leaves the guest a guest.
    const taken = await api('/api/auth/signup', { method: 'POST', token: guest.token, body: { name: 'Taken', phone: '01712345678', passcode: '1357' } });
    assert.equal(taken.status, 409);
    assert.equal((await ok('/api/auth/me', { token: guest.token })).phone, null);
    const registered = await ok('/api/auth/signup', { method: 'POST', token: guest.token, body: { name: 'নিবন্ধিত', phone: '01611111111', passcode: '1357' } });
    assert.equal(registered.userId, guest.userId, 'registration claims the guest account instead of creating another');
    const me = await ok('/api/auth/me', { token: registered.token });
    assert.equal(me.name, 'নিবন্ধিত'); assert.equal(me.phone, '01611111111');
    assert.deepEqual((await ok('/api/memories', { token: registered.token })).memories.map(memory => memory.id), [saved]);
    const login = await ok('/api/auth/login', { method: 'POST', body: { phone: '01611111111', passcode: '1357' } });
    assert.equal(login.userId, guest.userId);
    // The earlier guest token is the same account, so it keeps working after registration.
    assert.equal((await ok('/api/auth/me', { token: guest.token })).phone, '01611111111');

    const untouched = await ok('/api/auth/guest', { method: 'POST', body: {} });
    const used = await ok('/api/auth/guest', { method: 'POST', body: {} });
    await ok('/api/log', { method: 'POST', token: used.token, body: { text: 'guest activity' } });
    const wrong = await api('/api/auth/login', { method: 'POST', token: untouched.token, body: { phone: '01611111111', passcode: '0000' } });
    assert.equal(wrong.status, 401); assert.equal(users(untouched.userId), 1, 'a failed sign-in removes nothing');
    assert.equal((await ok('/api/auth/login', { method: 'POST', token: untouched.token, body: { phone: '01611111111', passcode: '1357' } })).userId, guest.userId);
    assert.equal(users(untouched.userId), 0, 'an untouched guest is removed once its device signs in');
    assert.equal((await api('/api/auth/me', { token: untouched.token })).status, 401);
    await ok('/api/auth/login', { method: 'POST', token: used.token, body: { phone: '01611111111', passcode: '1357' } });
    assert.equal(users(used.userId), 1, 'a guest with saved records is never removed implicitly');
    assert.equal(count('events', used.userId), 1);
    // Signing in again from the registered session never touches a registered account.
    await ok('/api/auth/login', { method: 'POST', token: registered.token, body: { phone: '01611111111', passcode: '1357' } });
    assert.equal(users(guest.userId), 1); assert.equal(count('memories', guest.userId), 1);
  });

  await t.test('deletion needs explicit confirmation and the PIN, then removes every row and session', async () => {
    const request = (body, token = owner.token) => api('/api/account/delete', { method: 'POST', token, body });
    assert.equal((await api('/api/account/delete', { method: 'POST', body: { confirm: 'delete_my_account' } })).status, 401);
    assert.equal((await api('/api/account', { method: 'DELETE', token: owner.token })).status, 404);
    for (const body of [{}, { confirm: 'yes' }, { confirm: true, passcode: '4821' }, { passcode: '4821' }]) {
      const reply = await request(body);
      assert.equal(reply.status, 400); assert.equal(reply.data.error, 'confirmation_required');
    }
    for (const passcode of [undefined, 4821, '', '123', 'x'.repeat(129)]) {
      const reply = await request({ confirm: 'delete_my_account', passcode });
      assert.equal(reply.status, 400); assert.equal(reply.data.error, 'passcode_required');
    }
    const wrong = await request({ confirm: 'delete_my_account', passcode: '0000' });
    assert.equal(wrong.status, 403); assert.equal(wrong.data.error, 'invalid_credentials');
    assert.equal(wrong.headers.get('set-cookie'), null);
    assert.equal((await ok('/api/auth/me', { token: owner.token })).id, owner.userId);
    assert.equal(count('memories', owner.userId), 500, 'a refused deletion changes nothing');

    // Spoken Bangla digits are accepted exactly as they are at sign-in.
    const deleted = await request({ confirm: 'delete_my_account', passcode: '৪৮২১' });
    assert.equal(deleted.status, 200); assert.deepEqual(deleted.data, { ok: true });
    const cookie = deleted.headers.get('set-cookie');
    assert.match(cookie, /^astha_session=;/); assert.match(cookie, /Expires=Thu, 01 Jan 1970/); assert.doesNotMatch(cookie, /Max-Age/i);
    assert.equal(inspection.prepare('SELECT COUNT(*) AS n FROM users WHERE id = ?').get(owner.userId).n, 0);
    for (const table of TABLES) assert.equal(count(table, owner.userId), 0, table + ' rows are removed with the account');
    // Every token issued for the removed account stops working, including its export.
    for (const route of ['/api/auth/me', '/api/memories', '/api/account/export']) {
      assert.equal((await api(route, { token: owner.token })).status, 401);
    }
    assert.equal((await request({ confirm: 'delete_my_account', passcode: '4821' })).status, 401);
    assert.equal(count('memories', other.userId), 601); assert.equal(count('agent_tasks', other.userId), 1);
    assert.equal((await ok('/api/auth/me', { token: other.token })).id, other.userId);
    // The phone number is free again and the new account starts empty.
    const again = await ok('/api/auth/signup', { method: 'POST', body: { name: 'New owner', phone: '01712345678', passcode: '9753' } });
    assert.notEqual(again.userId, owner.userId);
    assert.deepEqual((await ok('/api/memories', { token: again.token })).memories, []);

    // A guest has no PIN its owner knows; explicit confirmation is the gate.
    const guestDeleted = await request({ confirm: 'delete_my_account' }, other.token);
    assert.equal(guestDeleted.status, 200);
    assert.equal(inspection.prepare('SELECT COUNT(*) AS n FROM users WHERE id = ?').get(other.userId).n, 0);
    assert.equal(count('memories', other.userId), 0);
    assert.equal((await api('/api/auth/me', { token: other.token })).status, 401);
  });

  await t.test('repeated wrong PINs for deletion reach the shared attempt limit without deleting', async () => {
    const victim = await ok('/api/auth/signup', { method: 'POST', body: { name: 'Limited', phone: '01898765432', passcode: '2468' } });
    let limited = null;
    for (let attempt = 0; attempt < 40 && !limited; attempt++) {
      const reply = await api('/api/account/delete', { method: 'POST', token: victim.token, body: { confirm: 'delete_my_account', passcode: '1111' } });
      if (reply.status === 429) limited = reply;
      else assert.equal(reply.status, 403);
    }
    assert(limited, 'PIN guessing through deletion is rate limited');
    assert.equal(limited.data.error, 'auth_rate_limit'); assert(Number(limited.headers.get('retry-after')) >= 1);
    // Even the correct PIN is refused while limited, and the account is intact.
    assert.equal((await api('/api/account/delete', { method: 'POST', token: victim.token, body: { confirm: 'delete_my_account', passcode: '2468' } })).status, 429);
    assert.equal((await ok('/api/auth/me', { token: victim.token })).id, victim.userId);
    // Export is a read and is not consumed by the attempt limit.
    assert.equal((await ok('/api/account/export', { token: victim.token })).account.id, victim.userId);
  });

  await pause(20);
  assert.doesNotMatch(output, /passcode|SQLITE|\n\s+at /, 'server logs stay free of credentials and stacks');
});
