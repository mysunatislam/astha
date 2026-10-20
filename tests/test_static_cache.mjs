import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { staticCacheOptions } from '../server/static-cache.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(new URL('../server/index.js', import.meta.url));
const express = require('express');
const bootstrap = ['config.js', 'native-api.js', 'native-device.js', 'pi-camera.js', 'paired-camera-store.js', 'backend.js'];
const scripts = html => new Map([...html.matchAll(/<script src="([^"<>]+\.js)(\?v=[0-9a-f]{16})"><\/script>/g)].map(match => [match[1], match[1] + match[2]]));

async function serve(directory, run) {
  const app = express();
  app.get('/api/private', (_req, res) => res.set('Cache-Control', 'no-store').json({ private: true }));
  app.use(express.static(directory, staticCacheOptions(true)));
  const server = await new Promise(resolve => { const value = app.listen(0, '127.0.0.1', () => resolve(value)); });
  try { await run('http://127.0.0.1:' + server.address().port + '/'); }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}

test('real static responses revalidate mutable HTML/bootstrap/SW while API remains private and images keep their existing cache', async () => {
  await serve(path.join(root, 'web'), async origin => {
    for (const name of ['index.html', 'sw.js', 'manifest.webmanifest', ...bootstrap]) {
      const response = await fetch(new URL(name, origin));
      assert.equal(response.status, 200, name);
      assert.equal(response.headers.get('cache-control'), 'no-cache', name);
      await response.arrayBuffer();
      // Fetch deliberately adds a request no-cache directive when given conditional
      // headers. Use an ordinary HTTP validation request to exercise Express's 304 path.
      const unchanged = await new Promise((resolve, reject) => {
        http.get(new URL(name, origin), { headers: { 'If-None-Match': response.headers.get('etag') } }, reply => {
          reply.resume(); reply.on('end', () => resolve(reply));
        }).on('error', reject);
      });
      assert.equal(unchanged.statusCode, 304, 'unchanged content may reuse validated bytes: ' + name);
      assert.equal(unchanged.headers['cache-control'], 'no-cache');
    }
    const privateResponse = await fetch(new URL('api/private?request=private', origin));
    assert.equal(privateResponse.headers.get('cache-control'), 'no-store');
    const logo = await fetch(new URL('brand/astha-mulberry-apricot-v1.png', origin));
    assert.match(logo.headers.get('cache-control'), /max-age=86400/);
  });
  const serverSource = fs.readFileSync(path.join(root, 'server/index.js'), 'utf8');
  assert.match(serverSource, /express\.static\(WEB_DIR, staticCacheOptions\(IS_PROD\)\)/);
  assert.match(serverSource, /res\.set\('Cache-Control', 'no-cache'\);\s+res\.sendFile\(path\.join\(WEB_DIR, 'index\.html'\)\)/, 'SPA fallback HTML must revalidate too');
});

test('a changed bootstrap gets a new HTTP cache key on first load and matching offline keys in a reproducible build', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'astha-cache-release-'));
  try {
    fs.cpSync(path.join(root, 'tools'), path.join(directory, 'tools'), { recursive: true });
    for (const name of [...bootstrap, 'sw.js', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png', 'brand/luneyra-purple-winged-v1.png', 'brand/astha-mulberry-apricot-v1.png', 'brand/astha-mulberry-apricot-dark-v1.png']) {
      const target = path.join(directory, 'web', name); fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(root, 'web', name), target);
    }
    const build = () => {
      const result = spawnSync(process.env.ASTHA_PYTHON || 'python', ['tools/build.py'], { cwd: directory, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr || result.error?.message);
      return { html: fs.readFileSync(path.join(directory, 'web/index.html'), 'utf8'), sw: fs.readFileSync(path.join(directory, 'web/sw.js'), 'utf8') };
    };
    const before = build(), previous = scripts(before.html);
    assert.equal(previous.size, bootstrap.length);
    for (const name of bootstrap) {
      const hash = crypto.createHash('sha256').update(fs.readFileSync(path.join(directory, 'web', name))).digest('hex').slice(0, 16);
      assert.equal(previous.get(name), name + '?v=' + hash);
    }
    const freshHttpCache = new Map([[previous.get('pi-camera.js'), 'previous camera release'], ['pi-camera.js', 'previous unversioned camera release']]);
    fs.appendFileSync(path.join(directory, 'web/pi-camera.js'), '\n// Synthetic next release camera fixture.\n');
    const after = build(), current = scripts(after.html);
    assert.notEqual(current.get('pi-camera.js'), previous.get('pi-camera.js'));
    assert.equal(freshHttpCache.has(current.get('pi-camera.js')), false, 'a fresh previous release entry cannot satisfy the new HTML URL');
    for (const name of bootstrap.filter(name => name !== 'pi-camera.js')) assert.equal(current.get(name), previous.get(name));
    const shell = JSON.parse(/^const SHELL = (.*);$/m.exec(after.sw)[1]);
    for (const url of current.values()) assert(shell.includes('./' + url));
    assert(!shell.includes('./' + previous.get('pi-camera.js')), 'a new shell never requests the prior bootstrap key');
    assert.notEqual(/const CACHE = '([^']+)'/.exec(after.sw)[1], /const CACHE = '([^']+)'/.exec(before.sw)[1]);
    assert.deepEqual(build(), after, 'normalizing the generated cache stamp prevents circular or time-dependent hashes');
    await serve(path.join(directory, 'web'), async origin => {
      const response = await fetch(new URL(current.get('pi-camera.js'), origin));
      assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-cache');
      assert.match(await response.text(), /Synthetic next release camera fixture/);
    });
  } finally {
    // This exact directory was freshly created by this test and contains only fixture copies.
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
