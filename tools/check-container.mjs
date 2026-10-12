// Real image smoke test with disposable local fixtures; never load a private .env.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const id = randomBytes(12).toString('hex');
const prefix = `astha-check-${id}`;
const image = `${prefix}:test`;
const volume = `${prefix}-data`;
const containers = [];
let context;
let imageBuilt = false;
let volumeCreated = false;
const fixtureEnv = {
  ...process.env, NODE_ENV: 'production', JWT_SECRET: randomBytes(32).toString('hex'), PORT: '8787',
  CLOUD_AI_PROVIDER: 'auto', MAIRA_API_KEY: '', MAIRA_PROJECT_KEY: '', MAIRA_PROFILE_ID: '',
  MAIRA_API_URL: '', MAIRA_TOKEN: '', GEMINI_API_KEY: '', API_KEY: '', PROJECT_KEY: '',
  SUPABASE_DB_URL: '', SUPABASE_DB_CA_FILE: '', PUBLIC_ORIGIN: '', CORS_ORIGIN: '', TRUST_PROXY_HOPS: '0',
};
const runtimeEnvNames = ['NODE_ENV', 'JWT_SECRET', 'PORT', 'CLOUD_AI_PROVIDER', 'MAIRA_API_KEY',
  'MAIRA_PROJECT_KEY', 'MAIRA_PROFILE_ID', 'MAIRA_API_URL', 'MAIRA_TOKEN', 'GEMINI_API_KEY',
  'API_KEY', 'PROJECT_KEY', 'SUPABASE_DB_URL', 'SUPABASE_DB_CA_FILE', 'PUBLIC_ORIGIN', 'CORS_ORIGIN', 'TRUST_PROXY_HOPS'];
const runtimeEnvArgs = runtimeEnvNames.flatMap(name => ['--env', name]);

function command(binary, args, { label, timeout = 20000, allowFailure = false } = {}) {
  const result = spawnSync(binary, args, {
    cwd: root, env: fixtureEnv, encoding: 'utf8', timeout, maxBuffer: 8 * 1024 * 1024,
  });
  if (!allowFailure && (result.error || result.status !== 0)) {
    // Container output may contain application data. Keep failures bounded and quiet.
    throw new Error(`${label || 'Container command'} failed`);
  }
  return result;
}
function docker(args, options) { return command('docker', args, options).stdout.trim(); }
function createContainer(suffix, args) {
  const container = docker(['container', 'create', '--name', `${prefix}-${suffix}`, ...args], { label: `Create ${suffix} fixture` });
  assert.match(container, /^[a-f0-9]{64}$/);
  containers.push(container);
  return container;
}
function state(container) {
  return JSON.parse(docker(['container', 'inspect', '--format', '{{json .State}}', container], { label: 'Inspect fixture state' }));
}
function fixtureOrigin(container) {
  const mapping = docker(['container', 'port', container, '8787/tcp'], { label: 'Fixture loopback port' });
  assert.match(mapping, /^127\.0\.0\.1:\d+$/);
  return 'http://' + mapping;
}
async function request(origin, route, { method = 'GET', token, body } = {}) {
  const response = await fetch(origin + route, {
    method, redirect: 'error', signal: AbortSignal.timeout(5000),
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, headers: response.headers, data: await response.json() };
}
async function waitReady(container, origin) {
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    assert.equal(state(container).Running, true, 'Fixture stopped before readiness');
    try {
      const reply = await request(origin, '/api/health');
      if (reply.status === 200 && reply.data.ok === true && state(container).Health?.Status === 'healthy') return reply;
    } catch { /* Readiness can precede the first successful connection. */ }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error('Container readiness deadline exceeded');
}
function stopGracefully(container) {
  docker(['container', 'stop', '--timeout', '20', container], { label: 'Graceful fixture stop', timeout: 25000 });
  const stopped = state(container);
  assert.equal(stopped.Running, false);
  assert.equal(stopped.ExitCode, 0, 'Shutdown must drain storage without being killed');
}

try {
  docker(['version', '--format', '{{.Server.Version}}'], { label: 'Docker availability' });
  context = await fs.mkdtemp(path.join(os.tmpdir(), 'astha-container-check-'));
  // Tracked application files only: ignored operator credentials, data and local
  // dependencies are never copied or read. Add the new probe for pre-commit runs.
  const tracked = command('git', ['ls-files', '-z', '--', 'Dockerfile', '.dockerignore', 'server', 'web'], { label: 'Tracked source inventory' });
  const files = new Set([...tracked.stdout.split('\0').filter(Boolean), 'server/check-health.mjs']);
  for (const file of files) {
    if (path.basename(file).startsWith('.env')) continue;
    const source = path.resolve(root, file);
    const target = path.resolve(context, file);
    assert(source.startsWith(root + path.sep) && target.startsWith(context + path.sep));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(source, target);
  }
  const marker = `astha-synthetic-ignore-canary-${id}`;
  const canaries = ['server/.env', 'server/.env.ca', 'server/container-check.db', 'server/container-check.db-wal',
    'server/container-check.jks', 'server/supabase-root-ca.crt', 'server/node_modules/container-check-canary.txt',
    'web/.env', 'web/.env.local', 'web/container-check.db', 'web/container-check.keystore'];
  for (const file of canaries) {
    const target = path.join(context, file);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, `CONTAINER_CANARY=${marker}\n`);
  }
  docker(['image', 'build', '--pull', '--tag', image, context], { label: 'Production image build', timeout: 600000 });
  imageBuilt = true;
  const config = JSON.parse(docker(['image', 'inspect', '--format', '{{json .Config}}', image], { label: 'Image configuration' }));
  assert.equal(config.User, 'node');
  assert(config.Env.includes('DB_PROVIDER=supabase'));
  assert(config.Healthcheck?.Test?.includes('server/check-health.mjs'));
  const imageProbe = `
    const fs = require('node:fs');
    if (process.getuid() === 0) process.exit(1);
    const canaries = ${JSON.stringify(canaries)};
    for (const file of canaries) if (fs.existsSync('/app/' + file)) process.exit(1);
    if (fs.existsSync('/app/web/downloads/astha.apk')) process.exit(1);
    const marker = Buffer.from(${JSON.stringify(marker)});
    function scan(folder) {
      for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
        const file = folder + '/' + entry.name;
        if (entry.isDirectory()) scan(file);
        else if (entry.isFile() && fs.readFileSync(file).includes(marker)) process.exit(1);
      }
    }
    scan('/app/server'); scan('/app/web');
    fs.writeFileSync('/data/container-write-probe', 'nonroot fixture');
    if (fs.readFileSync('/data/container-write-probe', 'utf8') !== 'nonroot fixture') process.exit(1);
    fs.unlinkSync('/data/container-write-probe');
  `;
  const probe = createContainer('image', ['--network', 'none', '--entrypoint', 'node', image, '-e', imageProbe]);
  docker(['container', 'start', probe], { label: 'Image boundary probe' });
  assert.equal(docker(['container', 'wait', probe], { label: 'Image boundary result' }), '0');

  const missingConfig = createContainer('missing-config', ['--network', 'none', ...runtimeEnvArgs, image]);
  docker(['container', 'start', missingConfig], { label: 'Missing Supabase configuration probe' });
  const exit = Number(docker(['container', 'wait', missingConfig], { label: 'Fail-closed startup result' }));
  assert(exit > 0 && exit < 128, 'Missing selected storage must fail before serving');
  const failureLogs = command('docker', ['container', 'logs', missingConfig], { label: 'Fail-closed diagnostic' });
  const noFallback = failureLogs.stdout + failureLogs.stderr;
  assert(noFallback.includes('Supabase database URL is required'));
  assert(!noFallback.includes('Astha server listening'));

  const existingVolume = command('docker', ['volume', 'inspect', volume], { allowFailure: true });
  assert.notEqual(existingVolume.status, 0, 'Never reuse an existing volume');
  assert.equal(docker(['volume', 'create', '--label', `astha.check=${id}`, volume], { label: 'Create disposable volume' }), volume);
  const createdVolume = JSON.parse(docker(['volume', 'inspect', '--format', '{{json .}}', volume], { label: 'Verify disposable volume ownership' }));
  assert.equal(createdVolume.Labels['astha.check'], id);
  volumeCreated = true;
  const app = createContainer('sqlite', ['--publish', '127.0.0.1::8787', '--mount', `type=volume,source=${volume},target=/data`,
    ...runtimeEnvArgs, '--env', 'DB_PROVIDER=sqlite', image]);
  docker(['container', 'start', app], { label: 'Start explicit SQLite fixture' });
  let origin = fixtureOrigin(app);
  const ready = await waitReady(app, origin);
  assert.equal(ready.headers.get('cache-control'), 'no-store');
  assert.equal(ready.data.cloud, false);
  assert.equal(ready.data.cloudProvider, null);
  assert.equal((await request(origin, '/api/memories')).status, 401);
  docker(['container', 'exec', app, 'node', 'server/check-health.mjs'], { label: 'Docker readiness command' });
  const account = await request(origin, '/api/auth/signup', { method: 'POST',
    body: { name: 'Container fixture', phone: '01723456789', passcode: '916273' } });
  assert.equal(account.status, 200);
  assert.equal(typeof account.data.token, 'string');
  const saved = await request(origin, '/api/memories', { method: 'POST', token: account.data.token,
    body: { item: 'synthetic wallet', location: 'fixture desk' } });
  assert.equal(saved.status, 200);
  assert.equal(typeof saved.data.id, 'string');
  stopGracefully(app);
  docker(['container', 'start', app], { label: 'Restart persisted fixture' });
  origin = fixtureOrigin(app);
  await waitReady(app, origin);
  const memories = await request(origin, '/api/memories', { token: account.data.token });
  assert.equal(memories.status, 200);
  assert(memories.data.memories.some(memory => memory.id === saved.data.id && memory.item === 'synthetic wallet'));
  stopGracefully(app);
  console.log('Container build, nonroot/ignore boundaries, fail-closed storage, readiness, persisted SQLite fixture and graceful restart passed.');
} finally {
  // Remove only exact IDs/names created by this run. Never prune shared Docker state.
  for (const container of containers.reverse()) command('docker', ['container', 'rm', '--force', '--volumes', container], { allowFailure: true });
  if (volumeCreated) command('docker', ['volume', 'rm', volume], { allowFailure: true });
  if (imageBuilt) command('docker', ['image', 'rm', image], { allowFailure: true });
  if (context) {
    assert.equal(path.dirname(path.resolve(context)), path.resolve(os.tmpdir()));
    assert(path.basename(context).startsWith('astha-container-check-'));
    await fs.rm(context, { recursive: true, force: true });
  }
}
