import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setTimeout as pause } from 'node:timers/promises';

test('actual ASTHA routes use server-only Maira credentials and authenticated account identity', async t => {
  const reserved = createServer();
  await new Promise(resolve => reserved.listen(0, '127.0.0.1', resolve));
  const port = reserved.address().port;
  await new Promise(resolve => reserved.close(resolve));
  const root = fileURLToPath(new URL('..', import.meta.url));
  const env = { ...process.env, NODE_ENV: 'production', DB_PATH: ':memory:', PORT: String(port),
    JWT_SECRET: randomBytes(32).toString('hex'), PUBLIC_ORIGIN: '', CORS_ORIGIN: '', TRUST_PROXY_HOPS: '0',
    CLOUD_AI_PROVIDER: 'maira', MAIRA_API_KEY: 'server-only-maira-test-key',
    MAIRA_PROJECT_KEY: 'server-only-maira-test-project', MAIRA_PROFILE_ID: '',
    MAIRA_API_URL: 'https://api.recommender.gigalogy.com/v1/maira/ask',
    GEMINI_API_KEY: 'unused-gemini-test-key', API_KEY: '', PROJECT_KEY: '' };
  const child = spawn(process.execPath, ['--import', './tests/fixtures/maira-provider.mjs', 'server/index.js'],
    { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', childError;
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  child.on('error', error => { childError = error; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise(resolve => child.once('exit', resolve)); child.kill(); await exited;
    }
  });
  const base = 'http://127.0.0.1:' + port;
  let health;
  for (let i = 0; i < 100 && !health; i++) {
    if (childError || child.exitCode !== null) break;
    try { const res = await fetch(base + '/api/health', { signal: AbortSignal.timeout(500) }); if (res.ok) health = await res.json(); }
    catch { /* startup race */ }
    if (!health) await pause(50);
  }
  assert.ok(health, 'Server startup: ' + (childError?.message || output));
  assert.equal(health.cloud, true);
  assert.equal(health.cloudProvider, 'maira');
  assert.doesNotMatch(JSON.stringify(health), /server-only|project-key|api-key/);
  async function post(path, body, token) {
    const res = await fetch(base + path, { method: 'POST', headers: {
      'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}),
    }, body: JSON.stringify(body) });
    return { status: res.status, cache: res.headers.get('cache-control'), data: await res.json() };
  }
  const unauthenticated = await post('/api/vision', { task: 'describe' });
  assert.equal(unauthenticated.status, 401);
  const a = (await post('/api/auth/guest', {})).data;
  const b = (await post('/api/auth/guest', {})).data;
  assert.notEqual(a.userId, b.userId);
  for (const account of [a, b]) {
    const result = await post('/api/vision', { task: 'describe', userId: 'forged-other-account' }, account.token);
    assert.equal(result.status, 200);
    assert.equal(result.cache, 'no-store');
    assert.equal(result.data.bn, 'একটি চেয়ার দেখা যাচ্ছে।');
    assert.equal(result.data.providerUserId, account.userId);
    assert.equal(result.data.configuredProfile, null);
    assert.doesNotMatch(JSON.stringify(result.data), /server-only/);
  }
  const image = await post('/api/vision', { task: 'describe', image: '/9j/2Q==' }, a.token);
  assert.equal(image.status, 200);
  assert.equal(image.data.imageCount, 1); // mocked contract only; no physical image accuracy claim
  for (const [prompt, code] of [['provider-reject-fixture', 'bad_key'], ['provider-empty-fixture', 'bad_response']]) {
    const result = await post('/api/vision', { prompt }, a.token);
    assert.equal(result.status, 502);
    assert.equal(result.data.error, code);
    assert.doesNotMatch(JSON.stringify(result.data), /server-only|unused-gemini/);
  }
});
