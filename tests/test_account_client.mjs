import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const accountSource = fs.readFileSync(new URL('../tools/account.js', import.meta.url), 'utf8');
const backendSource = fs.readFileSync(new URL('../web/backend.js', import.meta.url), 'utf8');
// Values created inside the VM belong to another realm; compare their plain data.
const plain = value => JSON.parse(JSON.stringify(value));
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

// The data controls with every collaborator replaced: no network, storage or speech is real.
function controls({ accountId = 'accountA', registered = true, reply = () => json({ ok: true }), failingKeys = [] } = {}) {
  const storage = new Map([
    ['astha.local.v2.accountA', JSON.stringify({ memory: [{ uid: 'm1', item: 'চশমা', location: 'টেবিল' }], rooms: [], deletions: [] })],
    ['astha.owner.v2.accountA.face', JSON.stringify([0.5])], ['astha.owner.v2.accountA.voice', JSON.stringify({ mean: [1] })],
    ['astha.owner.v2.accountA.lock', '1'], ['astha.gemini', 'personal-provider-key'], ['astha.spatial_home', '[]'], ['astha.memory.v1.encrypted', 'legacy'],
    ['astha.local.v2.accountB', 'other-profile-notes'], ['astha.owner.v2.accountB.face', 'other-profile-face'],
    ['astha.ui_lang', 'bn'], ['astha.clinical_theme', 'navy-cyan'], ['astha.preferences', '{"rate":1}'],
  ]);
  const elements = new Map();
  const $ = id => {
    if (!elements.has(id)) elements.set(id, { id, value: '', textContent: '', hidden: id === 'delete-account-panel', disabled: false, attrs: {},
      setAttribute(name, value) { this.attrs[name] = String(value); }, focus() { calls.focus.push(id); } });
    return elements.get(id);
  };
  const calls = { fetch: [], spoken: [], focus: [], timers: [], reloads: 0, cleared: [], settings: [], renders: 0, logouts: 0 };
  const context = vm.createContext({
    console, JSON, Date, Blob, Response, uiLang: 'bn', $, I18N: { en: { data_delete_warn: 'warn-en' }, bn: { data_delete_warn: 'warn-bn' } },
    t: key => key, announce: (en, bn) => calls.spoken.push([en, bn]), logEvent() {}, stopAllSpeech() {},
    localStorage: { getItem: key => storage.get(key) ?? null, removeItem: key => { if (failingKeys.includes(key)) throw new Error('storage blocked'); storage.delete(key); }, setItem: (key, value) => storage.set(key, value) },
    LocalStore: { get KEY() { return 'astha.local.v2.' + (context.window.ASTHA_ACCOUNT_ID || 'device'); }, timer: 7, deletions: ['/api/memories/m1'] },
    ownerNamespace: () => 'astha.owner.v2.' + (context.window.ASTHA_ACCOUNT_ID || 'device'), refreshOwnerContext: () => 'astha.owner.v2.' + (context.window.ASTHA_ACCOUNT_ID || 'device'),
    owner: { face: [0.5], voice: { mean: [1] }, lock: true, verifiedAt: 5 }, cloud: { key: 'personal-provider-key' },
    state: { memory: [{ uid: 'm1' }], spatialHome: [{ id: 'r1' }], log: [{ text: 'x' }] },
    renderMemory: () => calls.renders++, renderSpatialLayout() {}, renderLog() {}, renderOwner() {}, readerTextChanged() {},
    apiUrl: path => path, deadlineSignal: () => undefined, clearTimeout() {},
    setTimeout: (fn, ms) => { calls.timers.push({ fn, ms }); return calls.timers.length; },
    apiGet: async path => { calls.fetch.push(['GET', path]); if (path === '/api/auth/me') return { id: accountId, phone: registered ? '01700000001' : null }; return { format: 'astha-export-v1', memories: [] }; },
    apiSend: async (method, path, body) => { calls.settings.push([method, path, body]); if (path === '/api/auth/logout') calls.logouts++; return { ok: true }; },
    fetch: async (path, options) => { calls.fetch.push([options.method, path, JSON.parse(options.body)]); return reply(path, options); },
    location: { reload: () => calls.reloads++ }, navigator: {}, document: {}, URL: {},
  });
  context.window = { ASTHA_LOCAL_ACCOUNT_ID: accountId || 'local-guest', ASTHA_ACCOUNT_ID: accountId, ASTHA_ACCOUNT_REGISTERED: accountId ? registered : null,
    ASTHA_CLEAR_ACCOUNT: options => { calls.cleared.push(options); context.window.ASTHA_ACCOUNT_ID = null; } };
  vm.runInContext(accountSource, context);
  return { context, calls, storage, $, run: code => vm.runInContext(code, context) };
}
const PERSONAL = ['astha.local.v2.accountA', 'astha.owner.v2.accountA.face', 'astha.owner.v2.accountA.voice', 'astha.owner.v2.accountA.lock', 'astha.gemini', 'astha.spatial_home', 'astha.memory.v1.encrypted'];

test('deletion asks the server first and removes this profile from the phone only after it succeeds', async () => {
  const s = controls();
  await s.run('openDeleteAccount()');
  assert.equal(s.$('delete-account-panel').hidden, false); assert.equal(s.$('delete-account-btn').attrs['aria-expanded'], 'true');
  assert.equal(s.$('delete-account-pin-field').hidden, false); assert.deepEqual(s.calls.focus, ['delete-account-pin']);
  assert.deepEqual(s.calls.spoken.at(-1), ['warn-en', 'warn-bn'], 'the irreversible warning is spoken, not only shown');
  await s.run('confirmDeleteAccount()');
  assert.equal(s.calls.fetch.filter(call => call[1] === '/api/account/delete').length, 0, 'a missing passcode never reaches the server');
  s.$('delete-account-pin').value = ' ৪৮২৬ ';
  await s.run('confirmDeleteAccount()');
  assert.deepEqual(s.calls.fetch.at(-1), ['POST', '/api/account/delete', { confirm: 'delete_my_account', passcode: '৪৮২৬' }]);
  for (const key of PERSONAL) assert(!s.storage.has(key), key + ' must be removed');
  // Another profile on the same phone and the interface preferences are not this account's data.
  for (const key of ['astha.local.v2.accountB', 'astha.owner.v2.accountB.face', 'astha.ui_lang', 'astha.clinical_theme', 'astha.preferences']) assert(s.storage.has(key), key + ' must be kept');
  assert.deepEqual(plain(s.context.state), { memory: [], spatialHome: [], log: [] });
  assert.equal(s.context.owner.face, null); assert.equal(s.context.owner.lock, false); assert.equal(s.context.cloud.key, '');
  assert.deepEqual(plain(s.context.LocalStore.deletions), []);
  assert.deepEqual(plain(s.calls.cleared), [{ logout: true }]);
  assert.equal(s.calls.reloads, 0, 'the confirmation is heard before the restart');
  assert.equal(s.calls.timers.at(-1).ms, 3500); s.calls.timers.at(-1).fn(); assert.equal(s.calls.reloads, 1);
  assert.equal(s.$('delete-account-panel').hidden, true); assert.equal(s.$('delete-account-confirm').disabled, false);
});

test('a refused, limited, failed or unreachable deletion leaves every local record in place', async () => {
  for (const [reply, expected] of [[() => json({ error: 'invalid_credentials' }, 403), /passcode is not right/], [() => json({ error: 'auth_rate_limit' }, 429), /Too many attempts/],
    [() => json({ error: 'internal_error' }, 500), /could not be deleted/], [() => { throw new Error('offline'); }, /could not reach your account/]]) {
    const s = controls({ reply });
    await s.run('openDeleteAccount()');
    s.$('delete-account-pin').value = '0000';
    await s.run('confirmDeleteAccount()');
    assert.match(s.calls.spoken.at(-1)[0], expected); assert.match(s.calls.spoken.at(-1)[0], /[Nn]othing was (deleted|removed)/);
    for (const key of PERSONAL) assert(s.storage.has(key), key + ' must survive a failed deletion');
    assert.equal(s.context.state.memory.length, 1); assert.deepEqual(s.calls.cleared, []); assert.equal(s.calls.timers.length, 0);
    assert.equal(s.$('delete-account-panel').hidden, false); assert.equal(s.$('delete-account-confirm').disabled, false);
  }
});

test('a guest confirms without a passcode, and the panel never opens when the account cannot be reached', async () => {
  const guest = controls({ registered: false });
  await guest.run('openDeleteAccount()');
  assert.equal(guest.$('delete-account-pin-field').hidden, true); assert.equal(guest.$('delete-account-note').textContent, 'data_delete_guest');
  assert.deepEqual(guest.calls.focus, ['delete-account-confirm']);
  await guest.run('confirmDeleteAccount()');
  assert.deepEqual(guest.calls.fetch.at(-1), ['POST', '/api/account/delete', { confirm: 'delete_my_account' }]);
  assert(!guest.storage.has('astha.local.v2.accountA'));

  const unreachable = controls();
  unreachable.context.apiGet = async () => { throw new Error('offline'); };
  await unreachable.run('openDeleteAccount()');
  assert.equal(unreachable.$('delete-account-panel').hidden, true); assert.match(unreachable.calls.spoken.at(-1)[0], /nothing was deleted/);

  // Opening again closes it; a spoken request keeps it open instead of toggling.
  const toggled = controls();
  await toggled.run('openDeleteAccount()'); await toggled.run('openDeleteAccount(true)');
  assert.equal(toggled.$('delete-account-panel').hidden, false);
  await toggled.run('openDeleteAccount()');
  assert.equal(toggled.$('delete-account-panel').hidden, true); assert.equal(toggled.$('delete-account-btn').attrs['aria-expanded'], 'false');
  await toggled.run('confirmDeleteAccount()');
  assert.equal(toggled.calls.fetch.filter(call => call[1] === '/api/account/delete').length, 0, 'a closed panel cannot delete');
});

test('without a connected account only this phone is cleared and no request is made', async () => {
  const s = controls({ accountId: null });
  s.storage.set('astha.local.v2.device', 'device-notes'); s.storage.set('astha.owner.v2.device.face', 'device-face');
  await s.run('openDeleteAccount()');
  assert.equal(s.$('delete-account-note').textContent, 'data_delete_local');
  await s.run('confirmDeleteAccount()');
  assert.deepEqual(s.calls.fetch, []); assert.deepEqual(s.calls.cleared, []); assert.equal(s.calls.timers.length, 0);
  assert(!s.storage.has('astha.local.v2.device') && !s.storage.has('astha.owner.v2.device.face'));
  assert(s.storage.has('astha.local.v2.accountA'), 'a signed-out profile on the phone is not this device profile');
  assert.match(s.calls.spoken.at(-1)[0], /saved on this phone are deleted/);
});

test('blocked browser storage is reported instead of claimed as cleared', async () => {
  const s = controls({ failingKeys: ['astha.owner.v2.accountA.face'] });
  await s.run('forgetOwnerBiometrics()');
  assert.match(s.calls.spoken.at(-1)[0], /could not be cleared/); assert.deepEqual(s.calls.settings, []);
  await s.run('openDeleteAccount()'); s.$('delete-account-pin').value = '4826';
  await s.run('confirmDeleteAccount()');
  assert.match(s.calls.spoken.at(-1)[0], /Some copies on this phone could not be cleared/);
});

test('account deletion cancels pending kit work and awaits erasing only its captured profile before local purge', async () => {
  const s = controls(), order = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  s.context.AsthaCameraKit = { accountCleared: () => order.push('cancel-kit') };
  s.context.window.AsthaPairingStore = { forget: async (profile, current) => {
    order.push('forget:' + profile); assert.equal(current(), true); await gate; order.push('erased');
  } };
  await s.run('openDeleteAccount()'); s.$('delete-account-pin').value = '4826';
  const pending = s.run('confirmDeleteAccount()');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(order, ['cancel-kit', 'forget:accountA']);
  assert(s.storage.has('astha.local.v2.accountA'), 'ordinary data is not purged before the vault responds');
  release(); await pending;
  assert.deepEqual(order, ['cancel-kit', 'forget:accountA', 'erased']);
  assert(!s.storage.has('astha.local.v2.accountA'));
  assert.match(s.calls.spoken.at(-1)[0], /everything saved with it are deleted/);
});

test('a pairing erase failure is reported and a changed profile is never purged or signed out', async () => {
  const failed = controls();
  failed.context.AsthaCameraKit = { accountCleared() {} };
  failed.context.window.AsthaPairingStore = { forget: async () => { throw new Error('vault blocked'); } };
  await failed.run('openDeleteAccount()'); failed.$('delete-account-pin').value = '4826';
  await failed.run('confirmDeleteAccount()');
  assert.match(failed.calls.spoken.at(-1)[0], /Some copies on this phone could not be cleared/);

  const switched = controls(); let erased;
  switched.context.window.AsthaPairingStore = { forget: async profile => {
    erased = profile; switched.context.window.ASTHA_LOCAL_ACCOUNT_ID = 'accountB'; switched.context.window.ASTHA_ACCOUNT_ID = 'accountB';
  } };
  await switched.run('openDeleteAccount()'); switched.$('delete-account-pin').value = '4826';
  await switched.run('confirmDeleteAccount()');
  assert.equal(erased, 'accountA');
  assert(switched.storage.has('astha.local.v2.accountB')); assert(switched.storage.has('astha.owner.v2.accountB.face'));
  assert.deepEqual(switched.calls.cleared, []); assert.equal(switched.calls.timers.length, 0);
  assert.match(switched.calls.spoken.at(-1)[0], /Some copies on this phone could not be cleared/);
});

test('forgetting face and voice clears the phone, the live state and any account copy', async () => {
  const s = controls();
  await s.run('forgetOwnerBiometrics()');
  for (const part of ['.face', '.voice', '.lock']) assert(!s.storage.has('astha.owner.v2.accountA' + part));
  assert(s.storage.has('astha.owner.v2.accountB.face')); assert(s.storage.has('astha.local.v2.accountA'), 'notes are not biometric data');
  assert.equal(s.context.owner.face, null); assert.equal(s.context.owner.voice, null); assert.equal(s.context.owner.lock, false); assert.equal(s.context.owner.verifiedAt, 0);
  assert.deepEqual(plain(s.calls.settings), [['PUT', '/api/settings', { face_descriptor: null }]]);
  assert.match(s.calls.spoken.at(-1)[0], /^Your face and voice templates are removed from this phone\.$/);
  const offline = controls();
  offline.context.apiSend = async () => { throw new Error('offline'); };
  await offline.run('forgetOwnerBiometrics()');
  assert(!offline.storage.has('astha.owner.v2.accountA.face')); assert.match(offline.calls.spoken.at(-1)[0], /could not reach your account/);
});

test('export combines the account copy with this phone and says so when the account is unreachable', async () => {
  const s = controls();
  let copied = '';
  s.context.window.Capacitor = { isNativePlatform: () => true };
  s.context.navigator.clipboard = { writeText: async text => { copied = text; } };
  await s.run('exportMyData()');
  const data = JSON.parse(copied);
  assert.equal(data.format, 'astha-device-export-v1'); assert.equal(data.account.format, 'astha-export-v1');
  assert.deepEqual(data.this_phone.notes.memory.map(memory => memory.item), ['চশমা']); assert.deepEqual(data.this_phone.face_template, [0.5]);
  assert.doesNotMatch(copied, /other-profile|personal-provider-key/);
  assert.match(s.calls.spoken.at(-1)[0], /^Your data is copied to the clipboard\.$/);

  const offline = controls();
  offline.context.apiGet = async () => { throw new Error('offline'); };
  offline.context.window.Capacitor = { isNativePlatform: () => true };
  await offline.run('exportMyData()');   // no clipboard either: the reading box receives it
  const fallback = JSON.parse(offline.$('reader-text').value);
  assert.equal(fallback.account, null); assert.deepEqual(fallback.this_phone.face_template, [0.5]);
  assert.match(offline.calls.spoken.at(-1)[0], /could not reach your account\. Only the data on this phone is placed in the reading box/);
});

test('signing out never strands a guest account and signs a registered account out normally', async () => {
  const guest = controls({ registered: false });
  await guest.run('signOut()');
  assert.deepEqual(guest.calls.cleared, []); assert.equal(guest.calls.reloads, 0); assert.equal(guest.calls.logouts, 0);
  assert.match(guest.calls.spoken.at(-1)[0], /guest account/); assert(guest.storage.has('astha.local.v2.accountA'));
  const member = controls();
  await member.run('signOut()');
  assert.deepEqual(plain(member.calls.cleared), [{ logout: true }]); assert.equal(member.calls.logouts, 1); assert.equal(member.calls.reloads, 1);
  assert(member.storage.has('astha.local.v2.accountA'), 'signing out keeps the notes for the next sign-in');
});

// ---- account entry points in the boot script ----
function boot(me) {
  const elements = new Map(), listeners = new Map(), marked = [];
  const element = id => { if (!elements.has(id)) elements.set(id, { id, value: 'typed', hidden: false, textContent: '', attrs: {}, setAttribute(name, value) { this.attrs[name] = String(value); }, focus() { context.document.activeElement = this; } }); return elements.get(id); };
  const page = [0, 1].map(() => ({ inert: false, setAttribute(name) { if (name === 'inert') this.inert = true; }, removeAttribute(name) { if (name === 'inert') this.inert = false; } }));
  const context = {
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    document: { readyState: 'loading', activeElement: null, addEventListener: (name, fn) => listeners.set(name, fn), getElementById: element, querySelectorAll: () => page },
    navigator: {}, location: { reload() {} }, clearTimeout() {}, deadlineSignal: () => undefined, apiUrl: path => path, uiLang: 'en',
    fetch: async path => path === '/api/auth/me' ? (me ? json(me) : json({}, 401)) : json({}, 500),
    addEventListener() {},
  };
  context.window = context; context.__asthaBoot = () => marked.push('boot');
  vm.createContext(context); vm.runInContext(backendSource, context);
  return { context, element, listeners, page, start: listeners.get('DOMContentLoaded') };
}

test('a guest is offered registration, a registered account is offered sign-out, and local mode says so', async () => {
  const guest = boot({ id: 'guestA', name: 'User', phone: null });
  await guest.start();
  assert.equal(guest.context.ASTHA_ACCOUNT_REGISTERED, false);
  assert.equal(guest.element('account-open-btn').hidden, false); assert.equal(guest.element('sign-out-btn').hidden, true);
  assert.match(guest.element('account-row').textContent, /guest account/); assert.equal(guest.element('auth-gate').hidden, true);
  const member = boot({ id: 'memberA', name: 'আস্থা', phone: '01700000001' });
  await member.start();
  assert.equal(member.context.ASTHA_ACCOUNT_REGISTERED, true);
  assert.equal(member.element('account-open-btn').hidden, true); assert.equal(member.element('sign-out-btn').hidden, false);
  assert.equal(member.element('account-row').textContent, 'Signed in as আস্থা.');
  member.context.uiLang = 'bn'; member.context.ASTHA_RENDER_ACCOUNT();
  assert.equal(member.element('account-row').textContent, 'প্রবেশ করেছেন: আস্থা.');
  const local = boot(null);
  await local.start();
  assert.equal(local.context.ASTHA_ACCOUNT_REGISTERED, null); assert.match(local.element('account-row').textContent, /Local mode/);
  assert.equal(local.element('account-open-btn').hidden, false);
});

test('the sign-in dialog opens over an inert page, restores focus on close and clears a typed passcode', async () => {
  const s = boot({ id: 'guestA', name: 'User', phone: null });
  await s.start();
  const opener = s.element('account-open-btn'); opener.focus();
  s.context.openAuthGate();
  assert.equal(s.element('auth-gate').hidden, false); assert(s.page.every(part => part.inert));
  assert.equal(s.context.document.activeElement.id, 'auth-name'); assert.equal(s.element('auth-tab-signup').attrs['aria-pressed'], 'true');
  assert.equal(s.element('auth-passcode').attrs.autocomplete, 'new-password');
  s.context.setAuthTab('login');
  assert.equal(s.element('auth-passcode').attrs.autocomplete, 'current-password'); assert.equal(s.element('auth-name-field').hidden, true);
  s.element('auth-passcode').value = '4826';
  s.listeners.get('keydown')({ key: 'Enter' });
  assert.equal(s.element('auth-gate').hidden, false, 'only Escape closes the dialog');
  s.listeners.get('keydown')({ key: 'Escape' });
  assert.equal(s.element('auth-gate').hidden, true); assert(s.page.every(part => !part.inert));
  assert.equal(s.context.document.activeElement, opener); assert.equal(s.element('auth-passcode').value, '');
  s.context.closeAuthGate();   // closing twice is harmless
  assert.equal(s.context.document.activeElement, opener);
});
