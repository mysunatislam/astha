import assert from 'node:assert/strict';
import test, { beforeEach, after } from 'node:test';
import { randomBytes } from 'node:crypto';
import { registerHooks } from 'node:module';

// Import the unchanged callers with a promise-only storage boundary. This test process
// cannot open SQLite, connect to Supabase, or call an AI provider.
Object.assign(process.env, { NODE_ENV: 'production', JWT_SECRET: randomBytes(32).toString('hex'),
  CLOUD_AI_PROVIDER: 'auto', MAIRA_API_KEY: '', MAIRA_PROJECT_KEY: '', MAIRA_PROFILE_ID: '',
  MAIRA_API_URL: '', GEMINI_API_KEY: '', API_KEY: '', PROJECT_KEY: '', GEMINI_MODELS: '' });
const storageUrl = new URL('../server/db.js', import.meta.url).href;
const storage = globalThis.__ASTHA_TEST_ASYNC_AGENT_STORAGE__ = {};
const hooks = registerHooks({
  load(url, context, nextLoad) {
    if (url !== storageUrl) return nextLoad(url, context);
    return { format: 'module', shortCircuit: true, source: `
      export async function run(...args) { return globalThis.__ASTHA_TEST_ASYNC_AGENT_STORAGE__.run(...args); }
      export async function get(...args) { return globalThis.__ASTHA_TEST_ASYNC_AGENT_STORAGE__.get(...args); }
      export async function all(...args) { return globalThis.__ASTHA_TEST_ASYNC_AGENT_STORAGE__.all(...args); }
    ` };
  },
});
const { agentRouter } = await import('../server/agent.js');
const { authMiddleware, getAuthenticatedUser, createUser, findByPhoneEquivalent, signToken } = await import('../server/auth.js');
const { asyncRoute } = await import('../server/async-route.js');
hooks.deregister();
after(() => { delete globalThis.__ASTHA_TEST_ASYNC_AGENT_STORAGE__; });

let queries;
beforeEach(() => {
  queries = [];
  storage.run = async (sql, params) => { queries.push({ sql, params }); return { changes: 1 }; };
  storage.get = async (sql, params) => { queries.push({ sql, params }); return undefined; };
  storage.all = async (sql, params) => { queries.push({ sql, params }); return []; };
});
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function response() {
  return { statusCode: 200, body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; } };
}
function agentHandler(path) {
  return agentRouter.stack.find(layer => layer.route?.path === path).route.stack[0].handle;
}
const user = { id: 'async-account-a', name: 'Fixture', phone: null };

test('agent planning/run responses wait for task persistence before claiming an acknowledged result', async () => {
  for (const path of ['/agent/plan', '/agent/run']) {
    const entered = deferred(), commit = deferred();
    let complete = false;
    storage.run = async (sql, params) => {
      entered.resolve({ sql, params });
      return commit.promise;
    };
    const res = response();
    const pending = agentHandler(path)({ user, body: { goal: 'find wallet' } }, res,
      error => { throw error; }).then(() => { complete = true; });
    const write = await entered.promise;
    assert.match(write.sql, /^INSERT INTO agent_tasks/);
    assert.equal(write.params[1], user.id);
    assert.equal(write.params[2], 'find wallet');
    assert.equal(res.body, undefined);
    assert.equal(complete, false);
    commit.resolve({ changes: 1 });
    await pending;
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.ok, true);
    assert.equal(typeof res.body.taskId, 'string');
    if (path === '/agent/run') {
      assert.equal(res.body.status, 'needs_verification');
      assert.equal(res.body.response.success, false);
    }
  }
});

test('rejected async agent writes return sanitized failures without false task IDs or success', async t => {
  const logs = [];
  t.mock.method(console, 'error', (...args) => logs.push(args));
  const marker = 'synthetic_private_query_or_credential_marker';
  storage.run = async () => { throw new Error(marker); };
  for (const [path, code] of [['/agent/plan', 'agent_plan_failed'], ['/agent/run', 'agent_run_failed']]) {
    const res = response();
    await agentHandler(path)({ user, body: { goal: 'find wallet' } }, res, error => { throw error; });
    assert.equal(res.statusCode, 500);
    assert.deepEqual(res.body, { error: code, message: code });
    assert.equal(res.body.taskId, undefined);
    assert.equal(res.body.ok, undefined);
  }
  assert.equal(JSON.stringify(logs).includes(marker), false);
});

test('a rejected async RAG read prevents agent persistence and does not invent an empty successful search', async t => {
  t.mock.method(console, 'error', () => {});
  const marker = 'synthetic_private_storage_outage_marker';
  storage.all = async () => { throw new Error(marker); };
  let writes = 0;
  storage.run = async () => { writes++; return { changes: 1 }; };
  for (const [path, code] of [['/agent/plan', 'agent_plan_failed'], ['/agent/run', 'agent_run_failed']]) {
    const res = response();
    await agentHandler(path)({ user, body: { goal: 'find wallet' } }, res, error => { throw error; });
    assert.equal(res.statusCode, 500);
    assert.deepEqual(res.body, { error: code, message: code });
  }
  assert.equal(writes, 0);
});

test('authentication awaits its lookup, ignores forged req.user and reuses only this request verified identity', async () => {
  const entered = deferred(), lookup = deferred();
  let reads = 0, nextCalls = 0;
  storage.get = async (_sql, params) => { reads++; entered.resolve(params); return lookup.promise; };
  const req = { headers: { authorization: 'Bearer ' + signToken(user.id) }, user: { id: 'forged-account' } };
  const res = response();
  const pending = authMiddleware(req, res, error => { assert.equal(error, undefined); nextCalls++; });
  assert.deepEqual(await entered.promise, [user.id]);
  assert.equal(nextCalls, 0);
  lookup.resolve(user);
  await pending;
  assert.equal(req.user.id, user.id);
  assert.equal(nextCalls, 1);
  for (let index = 0; index < 3; index++) {
    await authMiddleware(req, res, error => { assert.equal(error, undefined); nextCalls++; });
  }
  assert.equal(reads, 1);
  assert.equal(nextCalls, 4);
});

test('session memo never crosses requests or tokens and is not a trust shortcut for req.user', async () => {
  let reads = 0;
  storage.get = async (_sql, [id]) => { reads++; return { ...user, id }; };
  const tokenA = signToken(user.id), tokenB = signToken('async-account-b');
  const a = { headers: { authorization: 'Bearer ' + tokenA } };
  const b = { headers: { authorization: 'Bearer ' + tokenB }, user: user };
  assert.equal((await getAuthenticatedUser(a)).id, user.id);
  assert.equal((await getAuthenticatedUser(a)).id, user.id);
  assert.equal((await getAuthenticatedUser(b)).id, 'async-account-b');
  assert.equal(reads, 2);
  a.headers.authorization = 'Bearer ' + tokenB;
  assert.equal((await getAuthenticatedUser(a)).id, 'async-account-b');
  assert.equal(reads, 3);
  a.headers.authorization = 'Bearer forged';
  assert.equal(await getAuthenticatedUser(a), null);
  assert.equal(reads, 3);
  assert.equal(await getAuthenticatedUser({ headers: {}, user }), null);
});

test('DB rejection reaches next rather than 401 while invalid JWT avoids the database entirely', async () => {
  const outage = new Error('synthetic_private_db_outage_marker');
  let reads = 0;
  storage.get = async () => { reads++; throw outage; };
  const req = { headers: { authorization: 'Bearer ' + signToken(user.id) } };
  const res = response();
  const errors = [];
  await authMiddleware(req, res, error => errors.push(error));
  assert.deepEqual(errors, [outage]);
  assert.equal(res.body, undefined);
  assert.equal(res.statusCode, 200);
  await assert.rejects(getAuthenticatedUser(req), error => error === outage);
  assert.equal(reads, 2, 'Failed lookups must not be memoized');
  const rejected = response();
  await authMiddleware({ headers: { authorization: 'Bearer forged' }, user }, rejected,
    () => assert.fail('Invalid token must not continue to a protected route'));
  assert.equal(rejected.statusCode, 401);
  assert.deepEqual(rejected.body, { error: 'not_signed_in' });
  assert.equal(reads, 2);
});

test('auth creation and legacy-equivalent lookup await each storage result without changing account identity', async () => {
  const entered = deferred(), saved = deferred();
  let complete = false;
  storage.run = async (sql, params) => { entered.resolve({ sql, params }); return saved.promise; };
  const pending = createUser({ name: 'Fixture', phone: null, passcode: 'test-only' }).then(id => { complete = true; return id; });
  const insert = await entered.promise;
  assert.equal(complete, false);
  assert.match(insert.sql, /^INSERT INTO users/);
  saved.resolve({ changes: 1 });
  assert.equal(await pending, insert.params[0]);
  const legacy = { ...user, phone: '+৮৮০ (১৭১২) ৩৪৫-৬৭৮' };
  storage.get = async (sql, [value]) => sql.includes('WHERE id') && value === user.id ? legacy : undefined;
  storage.all = async () => [{ id: user.id, phone: legacy.phone }];
  assert.equal((await findByPhoneEquivalent('+8801712345678')).id, user.id);
});

test('Express wrapper forwards both synchronous exceptions and rejected promises', async () => {
  const failure = new Error('synthetic failure');
  for (const handler of [() => { throw failure; }, async () => { throw failure; }]) {
    const errors = [];
    await asyncRoute(handler)({}, response(), error => errors.push(error));
    assert.deepEqual(errors, [failure]);
  }
});
