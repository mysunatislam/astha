import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { postgresConfig, postgresQuery, createPostgresStorage, verifyPostgresStorage } from '../server/postgres.js';

const fixtureUrl = 'postgresql://astha_backend:fixture-password@db.fixture.supabase.co:5432/postgres';
test('Supabase configuration bounds pooling/deadlines and verifies TLS without URL overrides', () => {
  const config = postgresConfig({ SUPABASE_DB_URL: fixtureUrl });
  assert.deepEqual(config.ssl, { rejectUnauthorized: true });
  assert.equal(config.max, 5); assert.equal(config.connectionTimeoutMillis, 5000);
  assert.equal(config.statement_timeout, 10000); assert.equal(config.query_timeout, 12000);
  assert.equal(postgresConfig({ SUPABASE_DB_URL: 'postgres://astha_backend.fixture:fixture@aws-0-region.pooler.supabase.com:5432/postgres' }).ssl.rejectUnauthorized, true);
  for (const url of ['', fixtureUrl + '?sslmode=disable', fixtureUrl + '?sslmode=require', fixtureUrl + '#unsafe',
    fixtureUrl.replace('astha_backend:', 'postgres:'), fixtureUrl.replace('db.fixture.supabase.co', 'supabase.co.attacker.example'),
    fixtureUrl.replace('5432', '4444'), fixtureUrl.replace('5432', '6543'),
    'postgres://astha_backend.fixture:fixture@aws-0-region.pooler.supabase.com:6543/postgres',
    fixtureUrl.replace('/postgres', '/other')]) {
    assert.throws(() => postgresConfig({ SUPABASE_DB_URL: url }));
  }
});

test('static SQL keeps injected values bound, qualifies private tables and rejects unsupported syntax', () => {
  const value = "owner' OR 1=1 --";
  assert.deepEqual(postgresQuery('SELECT * FROM memories WHERE user_id = ? LIMIT 200', [value]),
    { text: 'SELECT * FROM astha.memories WHERE user_id = $1 LIMIT 200', values: [value] });
  for (const query of ['SELECT * FROM public.users', 'SELECT * FROM secrets', 'SELECT * FROM users; DELETE FROM users',
    'SELECT * FROM users -- bypass', "SELECT * FROM users WHERE id = 'literal'", 'DROP TABLE users']) {
    assert.throws(() => postgresQuery(query));
  }
  assert.throws(() => postgresQuery('SELECT * FROM users WHERE id = ?', []));
  // Every current application SQL call must fit the intentionally small compiler.
  for (const file of ['auth.js', 'memory.js', 'rag.js', 'agent.js']) {
    const source = readFileSync(new URL('../server/' + file, import.meta.url), 'utf8');
    for (const match of source.matchAll(/\b(?:run|get|all)\(\s*'((?:SELECT|INSERT|UPDATE|DELETE)[^']+)'/g)) {
      postgresQuery(match[1], Array((match[1].match(/\?/g) || []).length).fill('fixture'));
    }
  }
});

test('Postgres adapter normalizes millisecond strings and rejects unsafe timestamps', async () => {
  const store = createPostgresStorage({ query: async () => ({ rows: [{ id: 'fixture', created_at: '1791540000000', updated_at: '1791540000001' }], rowCount: 1 }), end: async () => {} });
  const row = await store.get('SELECT * FROM users WHERE id = ?', ['fixture']);
  assert.equal(row.created_at, 1791540000000); assert.equal(typeof row.updated_at, 'number');
  const invalid = createPostgresStorage({ query: async () => ({ rows: [{ created_at: '9007199254740993' }] }) });
  await assert.rejects(invalid.all('SELECT * FROM users'), /Invalid stored timestamp/);
  const unavailable = createPostgresStorage({ query: async () => { throw new Error('fixture unavailable'); } });
  await assert.rejects(unavailable.run('DELETE FROM memories WHERE user_id = ?', ['fixture']), /unavailable/);
});

test('explicit Supabase selection fails closed before creating a SQLite database', () => {
  const file = path.join(tmpdir(), 'astha-never-created-' + randomUUID() + '.db');
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', "await import('./server/db.js')"], {
    cwd: new URL('..', import.meta.url), encoding: 'utf8', timeout: 10000,
    env: { ...process.env, DB_PROVIDER: 'supabase', SUPABASE_DB_URL: '', SUPABASE_DB_CA_FILE: '', DB_PATH: file },
  });
  assert.notEqual(result.status, 0); assert.match(result.stderr, /database URL is required/);
  assert.equal(existsSync(file), false);
});

// Actual local PostgreSQL semantics via PGlite; no network, Supabase project or credentials.
let engine, pool, store;
const migration = readFileSync(new URL('../server/migrations/001_supabase.sql', import.meta.url), 'utf8');
before(async () => {
  engine = await PGlite.create();
  await engine.exec('CREATE ROLE astha_backend LOGIN; CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;');
  await engine.exec(migration);
  pool = { query: async (text, params = []) => { const result = await engine.query(text, params); return { rows: result.rows, rowCount: result.affectedRows }; }, end: () => engine.close() };
  await engine.exec('SET ROLE astha_backend');
  store = createPostgresStorage(pool);
});
after(async () => { if (engine) await engine.close(); });

test('reviewed migration passes actual Postgres role/schema/RLS/index startup checks', async () => {
  await verifyPostgresStorage(pool);
});

test('Postgres preserves owned IDs, JSON, Bangla, numeric scores and all six table APIs', async () => {
  const now = Date.now();
  for (const id of ['owner-a', 'owner-b']) await store.run('INSERT INTO users (id,name,phone,passcode_hash,passcode_salt,created_at) VALUES (?,?,?,?,?,?)', [id, 'আস্থা', null, 'fixture-hash', 'fixture-salt', now]);
  await store.run('INSERT INTO memories (id,user_id,item,location,source,score,created_at) VALUES (?,?,?,?,?,?,?)', ['memory-a', 'owner-a', 'চশমা', 'টেবিল', 'Your note', 0.85, now]);
  await store.run('INSERT INTO events (id,user_id,kind,text,created_at) VALUES (?,?,?,?,?)', ['event-a', 'owner-a', 'note', 'fixture', now]);
  await store.run('INSERT INTO knowledge_docs (id,user_id,category,title,content,tags_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)', ['doc-a', 'owner-a', 'general', 'fixture', 'fixture note', '["bn"]', now, now]);
  await store.run('INSERT INTO agent_tasks (id,user_id,goal,plan_json,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?)', ['task-a', 'owner-a', 'fixture', '{"steps":[]}', 'planned', now, now]);
  const memory = await store.get('SELECT * FROM memories WHERE user_id = ?', ['owner-a']);
  assert.equal(memory.item, 'চশমা'); assert.equal(memory.score, 0.85); assert.equal(memory.created_at, now);
  assert.equal((await store.all('SELECT * FROM memories WHERE user_id = ?', ['owner-b'])).length, 0);
  assert.equal((await store.get('SELECT * FROM agent_tasks WHERE user_id = ?', ['owner-a'])).plan_json, '{"steps":[]}');
  assert.equal((await store.get('SELECT * FROM knowledge_docs WHERE user_id = ?', ['owner-a'])).tags_json, '["bn"]');
  assert.equal((await store.run('DELETE FROM memories WHERE id = ? AND user_id = ?', ['memory-a', 'owner-b'])).changes, 0);
});

test('atomic Postgres room saves share one owned ID under concurrent requests', async () => {
  const ids = await Promise.all(['Desk', 'desk'].map(name => store.saveRoom({ userId: 'owner-a', name, notes: 'fixture ' + name })));
  assert.equal(ids[0], ids[1]);
  assert.equal((await store.all('SELECT * FROM rooms WHERE user_id = ?', ['owner-a'])).length, 1);
  const other = await store.saveRoom({ userId: 'owner-b', name: 'desk', notes: 'other fixture' });
  assert.notEqual(other, ids[0]);
});

test('Data API roles and backend schema creation are denied by actual PostgreSQL grants', async () => {
  for (const role of ['anon', 'authenticated', 'service_role']) {
    await engine.exec('RESET ROLE; SET ROLE ' + role);
    await assert.rejects(engine.query('SELECT * FROM astha.users'), /permission denied/);
  }
  await engine.exec('RESET ROLE; SET ROLE astha_backend');
  await assert.rejects(engine.query('CREATE TABLE astha.forbidden (id text)'), /permission denied/);
});

test('migration replay refuses existing schema and preserves records; foreign keys cascade', async () => {
  await engine.exec('RESET ROLE');
  await assert.rejects(engine.exec(migration), /Refusing to reuse an existing astha schema/);
  await engine.exec('ROLLBACK; SET ROLE astha_backend');
  assert.equal((await store.get('SELECT * FROM users WHERE id = ?', ['owner-a'])).name, 'আস্থা');
  await store.run('DELETE FROM users WHERE id = ?', ['owner-a']);
  for (const table of ['memories', 'rooms', 'events', 'agent_tasks', 'knowledge_docs']) {
    assert.equal((await store.all('SELECT * FROM ' + table + ' WHERE user_id = ?', ['owner-a'])).length, 0);
  }
  assert.equal((await store.all('SELECT * FROM users WHERE id = ?', ['owner-b'])).length, 1);
});

test('one settings statement preserves unspecified values and rolls back all fields on rejection', async () => {
  const sql = 'UPDATE users SET voice_lang = COALESCE(?, voice_lang), mode = COALESCE(?, mode), face_descriptor = CASE WHEN ? = 1 THEN ? ELSE face_descriptor END WHERE id = ?';
  await store.run(sql, ['en', 'quiet', 1, '[0.1]', 'owner-b']);
  await store.run(sql, [null, null, 1, null, 'owner-b']);
  let row = await store.get('SELECT * FROM users WHERE id = ?', ['owner-b']);
  assert.equal(row.voice_lang, 'en'); assert.equal(row.mode, 'quiet'); assert.equal(row.face_descriptor, null);
  await engine.exec("RESET ROLE; ALTER TABLE astha.users ADD CONSTRAINT fixture_settings CHECK (mode <> 'auto'); SET ROLE astha_backend");
  await assert.rejects(store.run(sql, ['bn', 'auto', 1, '[0.2]', 'owner-b']), /fixture_settings/);
  row = await store.get('SELECT * FROM users WHERE id = ?', ['owner-b']);
  assert.equal(row.voice_lang, 'en'); assert.equal(row.mode, 'quiet'); assert.equal(row.face_descriptor, null);
  await engine.exec('RESET ROLE; ALTER TABLE astha.users DROP CONSTRAINT fixture_settings; SET ROLE astha_backend');
});

test('startup refuses the migration owner and a changed schema instead of auto-repair', async () => {
  await engine.exec('RESET ROLE');
  await assert.rejects(verifyPostgresStorage(pool), /limited astha_backend role/);
  await engine.exec('ALTER TABLE astha.users RENAME COLUMN name TO incompatible_name; SET ROLE astha_backend');
  await assert.rejects(verifyPostgresStorage(pool), /columns are incompatible/);
});
