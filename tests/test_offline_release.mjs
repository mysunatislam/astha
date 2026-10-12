import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../tools/offline.js', import.meta.url), 'utf8');
function storageContext(backing = new Map()) {
  const elements = new Map();
  const context = {
    window: { ASTHA_ACCOUNT_ID: 'accountA', ASTHA_LOCAL_ACCOUNT_ID: 'accountA' },
    localStorage: { getItem: key => backing.get(key) ?? null, setItem: (key, value) => backing.set(key, value), removeItem: key => backing.delete(key) },
    state: { memory: [], spatialHome: [], log: [] }, privacyMode: false, privacyTransition: false,
    navigator: { onLine: true }, engine: { coco: {}, clip: {}, ocr: {} },
    setTimeout: () => 1, clearTimeout() {}, console: { warn() {} }, crypto: { randomUUID: () => 'local-memory' },
    $: id => { if (!elements.has(id)) elements.set(id, { value: '', focus() {} }); return elements.get(id); },
    esc: value => String(value), t: key => key, memoryDate: () => 'today',
    announce() {}, logEvent() {}, renderLog() {}, confirm: () => true, DepthEngine: { status: 'idle' },
    apiSend: async () => { throw Object.assign(new Error('offline'), { quiet: true }); },
    apiGet: async () => ({ memories: [], rooms: [] }),
    remoteProcessingAllowed: () => true,
  };
  vm.createContext(context);
  vm.runInContext(source + '\nglobalThis.release = { LocalStore, refreshMemory, refreshRooms, addLocalMemory, deleteMemory, clearMemory, deleteCalibratedRoom, autoRecordMemory, OfflineEar, OfflinePack };', context);
  return { context, ...context.release, backing, elements };
}

test('local namespaces isolate accounts and never auto-import unattributed legacy records', () => {
  const s = storageContext(new Map([['astha.local.v1', JSON.stringify({ memory: [{ uid: 'legacy', item: 'private', location: 'home' }] })]]));
  assert.equal(s.LocalStore.load().memory.length, 0);
  s.context.state.memory = [{ uid: 'a', item: 'wallet', location: 'desk' }]; s.LocalStore.save();
  s.context.window.ASTHA_ACCOUNT_ID = 'accountB'; s.context.window.ASTHA_LOCAL_ACCOUNT_ID = 'accountB';
  assert.equal(s.LocalStore.load().memory.length, 0);
  s.context.window.ASTHA_LOCAL_ACCOUNT_ID = 'accountA';
  assert.equal(s.LocalStore.load().memory[0].uid, 'a');
  assert.equal(s.backing.has('astha.local.v1'), true);
});

test('failed deletion survives restart, hides the server record and retries successfully', async () => {
  const s = storageContext();
  s.context.state.memory = [{ uid: 'server1', item: 'wallet', location: 'desk' }];
  await s.deleteMemory('server1');
  const reopened = storageContext(s.backing);
  reopened.context.apiGet = async () => ({ memories: [{ id: 'server1', item: 'wallet', location: 'desk', created_at: Date.now() }] });
  await reopened.refreshMemory();
  assert.equal(reopened.context.state.memory.length, 0);
  assert.equal(reopened.LocalStore.deletions.length, 1);
  const requests = [];
  reopened.context.apiSend = async (method, path) => { requests.push([method, path]); return { ok: true }; };
  assert.equal(await reopened.LocalStore.flushDeletions(), true);
  assert.deepEqual(requests, [['DELETE', '/api/memories/server1']]);
  assert.equal(JSON.parse(reopened.backing.get(reopened.LocalStore.KEY)).deletions.length, 0);
});

test('delete-all never reports remote success on a failed connection', async () => {
  const s = storageContext(); const messages = [];
  s.context.announce = en => messages.push(en);
  await s.clearMemory();
  assert.equal(s.LocalStore.deletions.length, 3);
  assert.match(messages.at(-1), /pending/);
  assert.equal(s.context.state.memory.length, 0);
});

test('a stale response from account A cannot populate account B', async () => {
  const s = storageContext();
  s.context.apiGet = async () => {
    s.context.window.ASTHA_LOCAL_ACCOUNT_ID = 'accountB'; s.context.window.ASTHA_ACCOUNT_ID = 'accountB';
    return { memories: [{ id: 'a', item: 'private', location: 'home', created_at: Date.now() }] };
  };
  await s.refreshMemory();
  assert.equal(s.context.state.memory.length, 0);
  assert.equal(s.backing.has('astha.local.v2.accountB'), false);
});

test('late create response for a deleted note is queued for remote deletion', async () => {
  const s = storageContext(); let complete;
  s.context.apiSend = () => new Promise(resolve => { complete = resolve; });
  const entry = s.addLocalMemory({ item: 'wallet', location: 'desk' });
  s.context.state.memory = [];
  complete({ id: 'created-late' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(entry.pending, false);
  assert.equal(s.LocalStore.deletions.includes('/api/memories/created-late'), true);
});

test('direct save and an overlapping refresh share one pending memory create', async () => {
  const s = storageContext(); let complete, posts = 0;
  s.context.apiSend = async method => {
    assert.equal(method, 'POST'); posts++;
    return new Promise(resolve => { complete = resolve; });
  };
  const entry = s.addLocalMemory({ item: 'wallet', location: 'desk' });
  const refresh = s.refreshMemory();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(posts, 1);
  complete({ id: 'created-once' });
  await refresh;
  assert.equal(entry.uid, 'created-once');
  assert.equal(s.context.state.memory.length, 1);
  assert.equal(posts, 1);
});

test('successful deletion during another pending upload cannot be undone by a stale merge', async () => {
  const s = storageContext(); let completePost;
  s.context.state.memory = [{ uid: 'delete-A', item: 'wallet', location: 'desk' },
    { uid: 'pending-B', item: 'glasses', location: 'drawer', pending: true }];
  s.context.apiGet = async () => ({ memories: [{ id: 'delete-A', item: 'wallet', location: 'desk', created_at: Date.now() }] });
  s.context.apiSend = async method => method === 'POST' ? new Promise(resolve => { completePost = resolve; }) : { ok: true };
  const refresh = s.refreshMemory();
  await new Promise(resolve => setImmediate(resolve));
  await s.deleteMemory('delete-A');
  completePost({ id: 'created-B' });
  await refresh;
  assert.equal(s.context.state.memory.some(memory => memory.uid === 'delete-A'), false);
  assert.equal(s.LocalStore.deletions.length, 0);
  assert.equal(s.context.state.memory[0].uid, 'created-B');
});

test('passive observations never save memory; explicit approved requests still do', async () => {
  const s = storageContext();
  await s.autoRecordMemory({ item: 'wallet', location: 'desk' });
  assert.equal(s.context.state.memory.length, 0);
  await s.autoRecordMemory({ item: 'wallet', location: 'desk', approved: true });
  assert.equal(s.context.state.memory.length, 1);
});

test('privacy mode does not reload personal data and selects the on-device recognizer', async () => {
  const s = storageContext(); let requests = 0;
  s.context.privacyMode = true;
  s.context.remoteProcessingAllowed = () => false;
  s.context.apiGet = async () => { requests++; return {}; };
  await s.refreshMemory(); await s.refreshRooms();
  assert.equal(requests, 0);
  assert.equal(s.OfflineEar.wanted(), true);
});

test('historical download markers do not claim offline readiness after cache eviction', () => {
  const s = storageContext(new Map([['astha.offline.parts', JSON.stringify(['coco', 'clip', 'ocr', 'depth', 'ear'])]]));
  s.OfflinePack.renderStatus();
  assert.equal(s.elements.get('offline-pill').textContent, 'Models not verified');
});

const swSource = fs.readFileSync(new URL('../web/sw.js', import.meta.url), 'utf8');
function serviceWorker() {
  const events = new Map(), entries = new Map(), removed = [], added = [];
  const key = request => new URL(typeof request === 'string' ? request : request.url, 'https://app.example/astha/sw.js').href;
  const cache = {
    addAll: async paths => { added.push(...paths); for (const p of paths) entries.set(key(p), new Response('cached shell')); },
    add: async () => {}, match: async request => entries.get(key(request))?.clone(),
    put: async (request, response) => entries.set(key(request), response),
  };
  const context = {
    self: { location: new URL('https://app.example/astha/sw.js'), addEventListener: (name, fn) => events.set(name, fn), skipWaiting: async () => {}, clients: { claim: async () => {} } },
    caches: { open: async () => cache, keys: async () => ['astha-shell-old', 'transformers-cache'], delete: async name => removed.push(name) },
    fetch: async () => { throw new Error('offline'); }, URL, Request, Response, AbortSignal, Set, Promise,
  };
  vm.createContext(context); vm.runInContext(swSource, context);
  return { context, events, entries, removed, added };
}
test('service-worker install caches bootstrap dependencies and preserves unrelated caches', async () => {
  const s = serviceWorker(); let pending;
  s.events.get('install')({ waitUntil: promise => { pending = promise; } }); await pending;
  assert(s.added.includes('./config.js')); assert(s.added.includes('./backend.js'));
  s.events.get('activate')({ waitUntil: promise => { pending = promise; } }); await pending;
  assert.deepEqual(s.removed, ['astha-shell-old']);
});
test('service worker bypasses API calls on subpaths and arbitrary third-party resources', () => {
  const s = serviceWorker();
  for (const url of ['https://app.example/api/speak?text=private', 'https://app.example/astha/api/memories', 'https://third.example/image.jpg']) {
    let intercepted = false;
    s.events.get('fetch')({ request: { url, method: 'GET', mode: 'cors' }, respondWith() { intercepted = true; } });
    assert.equal(intercepted, false, url);
  }
});
test('offline navigation falls back to the shell; server errors are never cached', async () => {
  const s = serviceWorker();
  s.entries.set('https://app.example/astha/', new Response('offline home'));
  let pending;
  const event = { request: { url: 'https://app.example/astha/', method: 'GET', mode: 'navigate' }, respondWith: promise => { pending = promise; } };
  s.events.get('fetch')(event); assert.equal(await (await pending).text(), 'offline home');
  s.context.fetch = async () => new Response('unavailable', { status: 503 });
  s.events.get('fetch')(event); assert.equal(await (await pending).text(), 'offline home');
  assert.equal(s.entries.size, 1);
});

test('an installed shell and its bootstrap scripts stay on one version during an upgrade', async () => {
  const s = serviceWorker(); let requests = 0;
  s.entries.set('https://app.example/astha/', new Response('HTML-v1'));
  s.entries.set('https://app.example/astha/backend.js', new Response('backend-v1'));
  s.context.fetch = async request => { requests++; return new Response(request.url.endsWith('backend.js') ? 'backend-v2' : 'HTML-v2'); };
  async function resource(url, mode) {
    let pending;
    s.events.get('fetch')({ request: { url, method: 'GET', mode }, respondWith: promise => { pending = promise; } });
    return (await pending).text();
  }
  assert.equal(await resource('https://app.example/astha/', 'navigate'), 'HTML-v1');
  assert.equal(await resource('https://app.example/astha/backend.js', 'cors'), 'backend-v1');
  assert.equal(requests, 0);
});
