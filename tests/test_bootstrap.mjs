import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../web/backend.js', import.meta.url), 'utf8');
function bootContext(fetch, initial = new Map()) {
  const listeners = new Map(), elements = new Map(), boots = [], requests = [], reloads = [];
  const context = {
    localStorage: { getItem: key => initial.get(key) ?? null, setItem: (key, value) => initial.set(key, value), removeItem: key => initial.delete(key) },
    document: { readyState: 'loading', addEventListener: (name, fn) => listeners.set(name, fn), getElementById: id => { if (!elements.has(id)) elements.set(id, { setAttribute() {}, value: '', hidden: false }); return elements.get(id); } },
    navigator: {}, location: { reload: () => reloads.push(true) }, clearTimeout() {},
    state: { memory: [], spatialHome: [], log: [] }, renderMemory() {}, renderSpatialLayout() {}, renderLog() {},
    deadlineSignal: () => undefined, apiUrl: path => path, uiLang: 'bn',
    fetch: async (path, options) => { requests.push(path); return fetch(path, options); },
    addEventListener: (name, fn) => listeners.set('window:' + name, fn),
  };
  context.window = context;
  context.__asthaBoot = () => boots.push([context.ASTHA_ACCOUNT_ID, context.ASTHA_LOCAL_ACCOUNT_ID]);
  vm.createContext(context); vm.runInContext(source, context);
  return { context, listeners, elements, boots, requests, reloads, initial, boot: listeners.get('DOMContentLoaded') };
}
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

test('verified account identity is established before the app can load personal memory', async () => {
  const s = bootContext(async () => json({ id: 'accountA', name: 'আস্থা' }));
  await s.boot();
  assert.deepEqual(s.boots, [['accountA', 'accountA']]);
  assert.equal(s.initial.get('astha.last_account.v2'), 'accountA');
  await s.context.ASTHA_REFRESH_SESSION();
  assert.equal(s.boots.length, 1);
});
test('offline boot can open local account notes but never treats cached identity as authenticated', async () => {
  const s = bootContext(async () => { throw new Error('offline'); }, new Map([['astha.last_account.v2', 'accountA']]));
  await s.boot();
  assert.deepEqual(s.boots, [[null, 'accountA']]);
});
test('a 401 clears old local identity before an isolated guest is established', async () => {
  let meRequests = 0;
  const s = bootContext(async path => {
    if (path === '/api/auth/me') return ++meRequests === 1 ? json({}, 401) : json({ id: 'guestB', name: 'User' });
    return json({ userId: 'guestB' });
  }, new Map([['astha.last_account.v2', 'accountA']]));
  await s.boot();
  assert.deepEqual(s.boots, [['guestB', 'guestB']]);
});
test('pending offline logout prevents restoration of the old server session', async () => {
  const s = bootContext(async () => { throw new Error('offline'); }, new Map([['astha.logout_pending.v2', '1']]));
  await s.boot();
  assert.deepEqual(s.requests, ['/api/auth/logout']);
  assert.deepEqual(s.boots, [[null, null]]);
  assert.equal(s.initial.get('astha.logout_pending.v2'), '1');
});

test('a late session refresh cannot restore identity or local notes after sign-out', async () => {
  let initial = true, completeMe;
  const s = bootContext(async () => {
    if (initial) { initial = false; return json({ id: 'accountA', name: 'A' }); }
    return new Promise(resolve => { completeMe = resolve; });
  });
  await s.boot();
  const refresh = s.context.ASTHA_REFRESH_SESSION();
  s.context.ASTHA_CLEAR_ACCOUNT({ logout: true });
  completeMe(json({ id: 'accountA', name: 'A' }));
  await refresh;
  assert.equal(s.initial.has('astha.last_account.v2'), false);
  assert.equal(s.context.ASTHA_ACCOUNT_ID, null);
  const reopened = bootContext(async () => { throw new Error('offline'); }, s.initial);
  await reopened.boot();
  assert.deepEqual(reopened.boots, [[null, null]]);
});

test('pending logout never opens a stale stored account namespace while offline', async () => {
  const s = bootContext(async () => { throw new Error('offline'); }, new Map([
    ['astha.logout_pending.v2', '1'], ['astha.last_account.v2', 'accountA'],
  ]));
  await s.boot();
  assert.deepEqual(s.boots, [[null, null]]);
});
