import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkHealth } from '../server/check-health.mjs';

async function fixture(handler, run) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try { await run(server.address().port); }
  finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}

test('readiness probe checks the configured local API port and real JSON readiness', async () => {
  await fixture((req, res) => {
    assert.equal(req.url, '/api/health');
    res.end('{"ok":true,"cloud":false}');
  }, async port => assert.equal(await checkHealth({ port }), true));
  for (const [status, body] of [[503, '{"ok":true}'], [200, '{"ok":false}'],
    [200, '{"ok":"true"}'], [200, 'unavailable'], [200, '{"ok":true,"padding":"' + 'x'.repeat(4096) + '"}']]) {
    await fixture((req, res) => { res.statusCode = status; res.end(body); },
      async port => assert.equal(await checkHealth({ port }), false));
  }
});

test('readiness probe bounds stalled requests and refuses redirects', async () => {
  await fixture(() => {}, async port => {
    const started = Date.now();
    assert.equal(await checkHealth({ port, timeoutMillis: 80 }), false);
    assert(Date.now() - started < 1500);
  });
  await fixture((req, res) => {
    res.writeHead(302, { Location: 'https://example.invalid/private' }); res.end();
  }, async port => assert.equal(await checkHealth({ port }), false));
});

test('invalid ports fail quietly without loading server configuration', async () => {
  for (const port of ['0', '65536', '-1', '8787/path', 'http://remote.invalid', ' 8787']) {
    assert.equal(await checkHealth({ port }), false);
  }
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../server/check-health.mjs', import.meta.url))], {
    env: { ...process.env, PORT: 'invalid', SUPABASE_DB_URL: 'must-not-be-read-or-printed' }, encoding: 'utf8',
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
});
