// Personal setup preferences over the real API against a disposable SQLite file.
// The Supabase adapter is covered by checking that every statement it would receive
// compiles under the same restrictions; no hosted database is contacted.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { postgresQuery } from '../server/postgres.js';
import { createPostgresStorage } from '../server/postgres.js';
import { registerHooks } from 'node:module';
import { PGlite } from '@electric-sql/pglite';

const root = fileURLToPath(new URL('..', import.meta.url));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const VALID = { vision: 'none', language: 'bn', feedback: 'brief', textSize: 'large', theme: 'lavender', speechRate: '1.2',
  devices: ['clip_camera', 'braille_controller'], modes: ['ask', 'classroom'], haptics: false };

test('every preferences statement is accepted by the restricted Supabase query adapter', () => {
  const sources = ['server/preferences.js', 'server/rag.js'].map(file => readFileSync(path.join(root, file), 'utf8')).join('\n');
  const statements = [...sources.matchAll(/'((?:SELECT|INSERT|UPDATE|DELETE)[^']*knowledge_docs[^']*)'/g)].map(match => match[1]);
  assert(statements.length >= 8, 'expected the knowledge_docs statements to be found');
  for (const sql of statements) {
    const compiled = postgresQuery(sql, Array.from({ length: (sql.match(/\?/g) || []).length }, () => 'x'));
    assert.match(compiled.text, /astha\.knowledge_docs/);
    assert.doesNotMatch(compiled.text, /\?/);
  }
  // The reserved row is selected by a bound value, never by text spliced into SQL.
  assert.doesNotMatch(sources, /astha_preferences'[^;]*(?:SELECT|DELETE|UPDATE)|category\s*(?:=|<>)\s*'/);
});

test('concurrent preference upserts preserve one owner-scoped row under actual local PostgreSQL and forced RLS', async () => {
  const engine = await PGlite.create();
  const storageUrl = new URL('../server/db.js', import.meta.url).href;
  const globalKey = '__ASTHA_PREFERENCES_POSTGRES_FIXTURE__';
  let hooks;
  try {
    await engine.exec('CREATE ROLE astha_backend LOGIN');
    await engine.exec(readFileSync(new URL('../server/migrations/001_supabase.sql', import.meta.url), 'utf8'));
    await engine.exec('SET ROLE astha_backend');
    const storage = createPostgresStorage({ query: async (sql, params = []) => {
      const result = await engine.query(sql, params);
      return { rows: result.rows, rowCount: result.affectedRows };
    } });
    globalThis[globalKey] = storage;
    hooks = registerHooks({ load(url, context, nextLoad) {
      if (url !== storageUrl) return nextLoad(url, context);
      return { format: 'module', shortCircuit: true,
        source: `export const run = globalThis.${globalKey}.run, all = globalThis.${globalKey}.all;` };
    } });
    const { preferencesRouter } = await import('../server/preferences.js?atomic-preferences-postgres-fixture');
    hooks.deregister(); hooks = null;
    const put = preferencesRouter.stack.find(layer => layer.route?.methods.put).route.stack[0].handle;
    const save = async (owner, preferences) => {
      const response = { statusCode: 200, status(value) { this.statusCode = value; return this; }, json(value) { this.body = value; return this; } };
      await put({ user: { id: owner }, body: { preferences } }, response, error => { response.error = error; });
      return response;
    };
    const insert = 'INSERT INTO users (id,name,phone,passcode_hash,passcode_salt,created_at) VALUES (?,?,?,?,?,?)';
    for (const owner of ['pg-pref-a', 'pg-pref-b', 'pg-pref-c']) await storage.run(insert, [owner, 'Synthetic preferences', null, 'fixture-hash', 'fixture-salt', 1]);
    const choices = [{ vision: 'none', language: 'bn' }, { vision: 'low', language: 'en' }, { feedback: 'brief', haptics: true }];
    const replies = await Promise.all(choices.map(preferences => save('pg-pref-a', preferences)));
    assert(replies.every(reply => !reply.error && reply.body?.ok === true));
    assert.deepEqual(replies.map(reply => reply.body.preferences), choices);
    let rows = (await engine.query('SELECT id,user_id,category,content FROM astha.knowledge_docs WHERE user_id=$1', ['pg-pref-a'])).rows;
    assert.equal(rows.length, 1); assert.equal(rows[0].id, 'astha.preferences.pg-pref-a');
    assert(choices.some(value => JSON.stringify(value) === rows[0].content));

    const noteInsert = 'INSERT INTO knowledge_docs (id,user_id,category,title,content,tags_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)';
    for (let index = 0; index < 8; index++) await storage.run(noteInsert, ['pg-legacy-' + index, 'pg-pref-a', 'astha_preferences', 'Legacy', '{}', '[]', 1, 1]);
    await storage.run(noteInsert, ['pg-normal', 'pg-pref-a', 'general', 'Normal note', 'Keep me', '[]', 1, 1]);
    await storage.run(noteInsert, ['pg-other', 'pg-pref-b', 'astha_preferences', 'Other setup', '{"vision":"low"}', '[]', 1, 1]);
    assert.equal((await save('pg-pref-a', { language: 'bn' })).body.ok, true);
    rows = (await engine.query('SELECT id FROM astha.knowledge_docs WHERE user_id=$1 AND category=$2', ['pg-pref-a', 'astha_preferences'])).rows;
    assert.equal(rows.length, 1); assert.equal(rows[0].id, 'astha.preferences.pg-pref-a');
    assert.equal((await engine.query('SELECT content FROM astha.knowledge_docs WHERE id=$1', ['pg-normal'])).rows[0].content, 'Keep me');
    assert.equal((await engine.query('SELECT content FROM astha.knowledge_docs WHERE id=$1', ['pg-other'])).rows[0].content, '{"vision":"low"}');
    await storage.run(noteInsert, ['astha.preferences.pg-pref-c', 'pg-pref-b', 'general', 'Collision', 'Unchanged', '[]', 1, 1]);
    const refused = await save('pg-pref-c', { vision: 'none' });
    assert(refused.error); assert.equal(refused.body, undefined);
    assert.equal((await engine.query('SELECT content FROM astha.knowledge_docs WHERE id=$1', ['astha.preferences.pg-pref-c'])).rows[0].content, 'Unchanged');
    assert.equal((await engine.query("SELECT count(*)::int AS count FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='astha' AND c.relkind='r'")).rows[0].count, 6);
  } finally {
    hooks?.deregister(); delete globalThis[globalKey]; await engine.close();
  }
});

test('setup preferences are validated, isolated per account, exported, kept out of notes and deleted with the account', { timeout: 90000 }, async t => {
  const parent = path.resolve(tmpdir());
  const temp = mkdtempSync(path.join(parent, 'astha-preferences-'));
  const dbPath = path.join(temp, 'preferences.db');
  const reserved = createServer();
  await new Promise(resolve => reserved.listen(0, '127.0.0.1', resolve));
  const port = reserved.address().port;
  await new Promise(resolve => reserved.close(resolve));
  const base = 'http://127.0.0.1:' + port;
  const env = {
    ...process.env, NODE_ENV: 'production', JWT_SECRET: randomBytes(32).toString('hex'),
    DB_PROVIDER: 'sqlite', DB_PATH: dbPath, SUPABASE_DB_URL: '', SUPABASE_DB_CA_FILE: '', DATABASE_URL: '', PORT: String(port),
    CORS_ORIGIN: '', PUBLIC_ORIGIN: '', TRUST_PROXY_HOPS: '0',
    CLOUD_AI_PROVIDER: 'auto', MAIRA_API_KEY: '', MAIRA_PROJECT_KEY: '', MAIRA_PROFILE_ID: '',
    MAIRA_API_URL: '', API_KEY: '', PROJECT_KEY: '', GEMINI_API_KEY: '', GEMINI_MODELS: '',
  };
  const setup = 'data:text/javascript,' + encodeURIComponent(
    "globalThis.fetch = async () => { throw new Error('Provider network disabled in preferences regression'); };");
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
    assert(path.basename(temp).startsWith('astha-preferences-'));
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
  assert(ready, 'Disposable preferences server did not start: ' + output);
  inspection = new DatabaseSync(dbPath);

  async function api(route, { method = 'GET', body, token } = {}) {
    const headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (token) headers.Authorization = 'Bearer ' + token;
    const reply = await fetch(base + route, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(8000) });
    return { status: reply.status, headers: reply.headers, data: JSON.parse(await reply.text()) };
  }
  const rows = userId => inspection.prepare("SELECT id, category, content FROM knowledge_docs WHERE user_id = ? AND category = 'astha_preferences'").all(userId);

  const owner = (await api('/api/auth/guest', { method: 'POST', body: {} })).data;
  const other = (await api('/api/auth/guest', { method: 'POST', body: {} })).data;

  assert.equal((await api('/api/preferences')).status, 401, 'preferences require a session');
  assert.deepEqual((await api('/api/preferences', { token: owner.token })).data, { preferences: null, updated_at: null });

  // Anything outside the contract is rejected and nothing is stored.
  for (const preferences of [null, [], 'none', { vision: 'legally-blind' }, { diagnosis: 'private note' }, { devices: ['toaster'] },
    { devices: ['clip_camera', 'clip_camera'] }, { modes: 'road' }, { haptics: 'yes' }, { textSize: 'huge' }, { language: 'fr' },
    { speechRate: 1.2 }, { vision: 'none', note: 'x'.repeat(3000) }]) {
    const rejected = await api('/api/preferences', { method: 'PUT', token: owner.token, body: { preferences } });
    assert.equal(rejected.status, 400, JSON.stringify(preferences)?.slice(0, 60)); assert.equal(rejected.data.error, 'invalid_preferences');
  }
  assert.equal(rows(owner.userId).length, 0);

  const saved = await api('/api/preferences', { method: 'PUT', token: owner.token, body: { preferences: VALID } });
  assert.equal(saved.status, 200); assert.equal(saved.headers.get('cache-control'), 'no-store');
  assert.deepEqual(saved.data.preferences, VALID);
  const fetched = (await api('/api/preferences', { token: owner.token })).data;
  assert.deepEqual(fetched.preferences, VALID); assert.equal(fetched.updated_at, saved.data.updated_at);

  // The renamed default can sync, while old installs can still send their saved colour choice.
  for (const theme of ['lavender', 'mulberry-apricot', 'calm-teal', 'clinical-yellow', 'monochrome', 'navy-cyan']) {
    const result = await api('/api/preferences', { method: 'PUT', token: owner.token, body: { preferences: { theme } } });
    assert.equal(result.status, 200, theme);
    assert.deepEqual((await api('/api/preferences', { token: owner.token })).data.preferences, { theme });
  }

  // A second save replaces the first: one row per account, and array order is normalised.
  const changed = { ...VALID, vision: 'low', devices: ['braille_controller', 'phone_camera'] };
  await api('/api/preferences', { method: 'PUT', token: owner.token, body: { preferences: changed } });
  assert.equal(rows(owner.userId).length, 1);
  assert.deepEqual((await api('/api/preferences', { token: owner.token })).data.preferences, { ...changed, devices: ['phone_camera', 'braille_controller'] });

  // Concurrent first saves share the existing primary key rather than racing a SELECT.
  const fresh = (await api('/api/auth/guest', { method: 'POST', body: {} })).data;
  const simultaneous = [{ vision: 'none', language: 'bn' }, { vision: 'low', language: 'en' }, { feedback: 'brief', haptics: true }];
  const acknowledged = await Promise.all(simultaneous.map(preferences => api('/api/preferences', { method: 'PUT', token: fresh.token, body: { preferences } })));
  assert(acknowledged.every(result => result.status === 200));
  assert.deepEqual(acknowledged.map(result => result.data.preferences), simultaneous);
  const freshRows = rows(fresh.userId);
  assert.equal(freshRows.length, 1, 'concurrent initial saves must leave exactly one reserved row');
  assert(simultaneous.some(value => JSON.stringify(value) === freshRows[0].content), 'stored settings must be one whole acknowledged save');
  assert.deepEqual((await api('/api/preferences', { token: fresh.token })).data.preferences, JSON.parse(freshRows[0].content));

  // Clean every legacy duplicate, even when more than the old five-row read limit exist.
  const insert = inspection.prepare('INSERT INTO knowledge_docs (id,user_id,category,title,content,tags_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)');
  for (let index = 0; index < 8; index++) insert.run('legacy-pref-' + index, owner.userId, 'astha_preferences', 'Legacy setup', '{"vision":"none"}', '[]', index, index);
  insert.run('ordinary-owner-note', owner.userId, 'general', 'Ordinary note', 'This must stay', '[]', 1, 1);
  await api('/api/preferences', { method: 'PUT', token: owner.token, body: { preferences: changed } });
  assert.equal(rows(owner.userId).length, 1);
  assert.equal(inspection.prepare('SELECT COUNT(*) AS n FROM knowledge_docs WHERE id = ? AND user_id = ?').get('ordinary-owner-note', owner.userId).n, 1);

  // An unexpected primary-key collision cannot change an unrelated owner's row.
  const collision = (await api('/api/auth/guest', { method: 'POST', body: {} })).data;
  const collisionId = 'astha.preferences.' + collision.userId;
  insert.run(collisionId, other.userId, 'general', 'Collision fixture', 'Untouched', '[]', 2, 2);
  const refused = await api('/api/preferences', { method: 'PUT', token: collision.token, body: { preferences: { vision: 'none' } } });
  assert.equal(refused.status, 500);
  assert.equal(inspection.prepare('SELECT content FROM knowledge_docs WHERE id = ? AND user_id = ?').get(collisionId, other.userId).content, 'Untouched');
  assert.equal(rows(collision.userId).length, 0);
  // Remove only the directly seeded ordinary fixture before the existing notes-list assertions.
  inspection.prepare('DELETE FROM knowledge_docs WHERE id = ? AND user_id = ?').run('ordinary-owner-note', owner.userId);

  // Another account neither sees nor changes them.
  assert.deepEqual((await api('/api/preferences', { token: other.token })).data, { preferences: null, updated_at: null });
  await api('/api/preferences', { method: 'PUT', token: other.token, body: { preferences: { vision: 'unspecified' } } });
  assert.equal((await api('/api/preferences', { token: owner.token })).data.preferences.vision, 'low');

  // The row is configuration: it is not a note, not search context, and cannot be forged or removed through the notes API.
  const note = await api('/api/rag/docs', { method: 'POST', token: owner.token, body: { title: 'Clinic', content: 'braille_controller appointment on Sunday' } });
  assert.equal(note.status, 200);
  const forged = await api('/api/rag/docs', { method: 'POST', token: owner.token, body: { title: 'x', content: '{"vision":"none"}', category: 'astha_preferences' } });
  assert.equal(forged.status, 400);
  const listed = (await api('/api/rag/docs', { token: owner.token })).data.docs;
  assert.deepEqual(listed.map(doc => doc.title), ['Clinic']);
  const search = (await api('/api/rag/query', { method: 'POST', token: owner.token, body: { query: 'braille_controller low vision' } })).data;
  assert.deepEqual(search.docs.map(doc => doc.title), ['Clinic'], 'a real note is still found');
  assert(!JSON.stringify(search).includes('textSize') && !JSON.stringify(search).includes('astha_preferences'), 'saved preferences must never be returned as retrieval context');
  await api('/api/rag/docs/' + rows(owner.userId)[0].id, { method: 'DELETE', token: owner.token });
  await api('/api/rag/docs', { method: 'DELETE', token: owner.token });
  assert.equal(rows(owner.userId).length, 1, 'clearing notes keeps the setup');
  assert.equal((await api('/api/rag/docs', { token: owner.token })).data.docs.length, 0);

  // Export names them explicitly; deleting them or the account removes the row.
  const exported = (await api('/api/account/export', { token: owner.token })).data;
  assert.equal(exported.preferences.values.vision, 'low'); assert.equal(exported.knowledge_docs.length, 0);
  assert.equal((await api('/api/preferences', { method: 'DELETE', token: other.token })).status, 200);
  assert.equal(rows(other.userId).length, 0); assert.equal(rows(owner.userId).length, 1);
  const removed = await api('/api/account/delete', { method: 'POST', token: owner.token, body: { confirm: 'delete_my_account' } });
  assert.equal(removed.status, 200); assert.equal(rows(owner.userId).length, 0);
});
