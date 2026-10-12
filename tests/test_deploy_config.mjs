import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const read = file => fs.readFileSync(new URL('../' + file, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const blueprint = read('render.yaml');

// Each "- key: NAME" entry with the single setting that follows it.
const entries = new Map([...blueprint.matchAll(/^\s+- key: ([A-Z_]+)\n\s+(value|sync|generateValue): (.+)$/gm)]
  .map(match => [match[1], { kind: match[2], value: match[3].trim().replace(/^"|"$/g, '') }]));

test('the host blueprint asks for provider keys at deploy time and never carries a secret', () => {
  for (const key of ['MAIRA_API_KEY', 'MAIRA_PROJECT_KEY']) {
    assert.deepEqual(entries.get(key), { kind: 'sync', value: 'false' }, key + ' must be entered on the host, not stored in the repository');
  }
  assert.deepEqual(entries.get('JWT_SECRET'), { kind: 'generateValue', value: 'true' });
  // Fixed settings only: no entry may hold something shaped like a credential.
  for (const [key, entry] of entries) {
    if (entry.kind !== 'value') continue;
    assert(entry.value.length <= 40, key + ' holds an unexpectedly long literal');
    assert.doesNotMatch(entry.value, /^gAAAAA|^AIza|^sk-|^eyJ|postgres(ql)?:\/\//, key + ' looks like a credential');
  }
  assert.doesNotMatch(blueprint, /gAAAAA|AIza[0-9A-Za-z_-]{20}|postgres(ql)?:\/\/[^\s]+@/);
});

test('the blueprint is a free single-origin service the server accepts as configured', () => {
  assert.match(blueprint, /^\s+plan: free$/m);
  assert.doesNotMatch(blueprint, /^\s+disk:/m, 'the free plan has no disk');
  assert.match(blueprint, /^\s+runtime: docker$/m); assert.match(blueprint, /^\s+dockerfilePath: \.\/Dockerfile$/m);
  assert.match(blueprint, /^\s+healthCheckPath: \/api\/health$/m);
  assert.equal(entries.get('NODE_ENV').value, 'production');
  assert.equal(entries.get('CLOUD_AI_PROVIDER').value, 'maira');
  // The image defaults to Supabase and refuses to start without it; SQLite must be explicit.
  assert.equal(entries.get('DB_PROVIDER').value, 'sqlite'); assert.equal(entries.get('DB_PATH').value, '/data/astha.db');
  assert.match(read('Dockerfile'), /chown node:node \/data/);
  assert.match(entries.get('TRUST_PROXY_HOPS').value, /^[0-3]$/);
  assert(!entries.has('PUBLIC_ORIGIN'), 'the origin comes from the host unless a custom domain is configured');
});

test('the public pages never ship a provider key and send cloud work to the server', () => {
  for (const file of ['web/index.html', 'web/config.js', 'web/backend.js']) {
    const source = read(file);
    assert.doesNotMatch(source, /['"`]gAAAAA[A-Za-z0-9_\-=]{20,}/, file + ' contains a Maira key literal');
    assert.doesNotMatch(source, /AIza[0-9A-Za-z_-]{30,}/, file + ' contains a Google key literal');
    assert.doesNotMatch(source, /DEFAULT_PASS_TOKEN|ASTHA_MAIRA_PROJECT_KEY\s*=\s*['"`][^'"`]/, file + ' embeds a shared credential');
  }
  assert.match(read('web/config.js'), /window\.ASTHA_API_BASE = '';/);
  assert.match(read('web/index.html'), /apiUrl\('\/api\/vision'\)/);
});
