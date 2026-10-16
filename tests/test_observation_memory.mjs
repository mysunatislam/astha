import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../tools/observation-memory.js', import.meta.url), 'utf8');
const cloud = fs.readFileSync(new URL('../tools/cloud.js', import.meta.url), 'utf8');
const read = file => fs.readFileSync(new URL('../' + file, import.meta.url), 'utf8');
function harness() {
  let now = 1700000000000, generation = 0;
  const storage = new Map(), saved = [], said = [], elements = new Map(), listeners = new Map();
  const context = {
    Date: class extends Date { static now() { return now; } },
    window: { ASTHA_ACCOUNT_ID: 'accountA', ASTHA_LOCAL_ACCOUNT_ID: 'accountA', addEventListener() {} },
    document: { hidden: false, addEventListener: (name, fn) => listeners.set(name, fn) },
    privacyMode: false, privacyTransition: false,
    state: { source: 'pi', sourceEpoch: 1, busy: false, listening: false, pendingYes: null },
    owner: { lock: false }, ownerVerified: () => false,
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    $: id => { if (!elements.has(id)) elements.set(id, { addEventListener() {} }); return elements.get(id); },
    announce: (...args) => said.push(args), asthaSpeaking: () => false, remoteProcessingAllowed: () => true, activeSourceEl: () => ({}),
    AsthaExperience: { busy: false, guiding: false, mode: 'ask', allows: () => true },
    VOCAB_BY_ID: { laptop: { en: 'laptop', bn: 'ল্যাপটপ' }, 'cell phone': { en: 'phone', bn: 'ফোন' }, eyeglasses: { en: 'eyeglasses', bn: 'চশমা' }, wallet: { en: 'wallet', bn: 'মানিব্যাগ' }, 'id card': { en: 'ID card', bn: 'পরিচয়পত্র' }, keys: { en: 'keys', bn: 'চাবি' } },
    autoRecordMemory: value => { saved.push(value); return value; },
  };
  context.captureLocalActionGuard = () => {
    const account = context.window.ASTHA_ACCOUNT_ID, local = context.window.ASTHA_LOCAL_ACCOUNT_ID, epoch = context.state.sourceEpoch, gen = generation;
    return () => account === context.window.ASTHA_ACCOUNT_ID && local === context.window.ASTHA_LOCAL_ACCOUNT_ID && epoch === context.state.sourceEpoch && gen === generation && !context.document.hidden;
  };
  context.askYesNo = (en, bn, onYes, onNo) => { said.push([en, bn]); context.state.pendingYes = { onYes, onNo, until: now + 20000 }; };
  vm.createContext(context); vm.runInContext(source + '\nglobalThis.memoryPolicy = AsthaObservationMemory;', context);
  const policy = context.memoryPolicy;
  const frame = () => { const f = { width: 640, height: 480 }; policy.capture(f); return f; };
  const object = (id = 'laptop', overrides = {}) => ({ id, detectorId: id, score: 0.91, detectorScore: 0.91, src: 'yolo26n', pos: 'left', bbox: [20, 40, 100, 90], ...overrides });
  const observe = (id = 'wallet', overrides = {}, f = frame()) => { policy.observeCloud(f, [{ item: id, visible: true, clarity: 'clear', position: 'right', ...overrides }]); return f; };
  const local = (id = 'laptop', overrides = {}) => { for (let i = 0; i < 3; i++) { now += 250; policy.observeLocal(frame(), [object(id, overrides)]); } };
  return { context, policy, storage, saved, said, frame, object, observe, local, listeners, elements,
    advance: ms => { now += ms; }, cancel: () => { generation++; policy.stop(); }, now: () => now };
}

test('automatic memory defaults off, is explicit, account-scoped, and reachable in both languages', () => {
  const h = harness(); h.local(); h.observe();
  assert.equal(h.saved.length, 0); assert.equal(h.policy.selected(), false);
  assert.equal(h.policy.route('Astha, enable automatic memory'), true);
  assert.equal(h.policy.selected(), true); assert.match(h.said.at(-1)[1], /পরিচয়পত্র/);
  h.context.window.ASTHA_LOCAL_ACCOUNT_ID = 'accountB'; h.context.window.ASTHA_ACCOUNT_ID = 'accountB';
  assert.equal(h.policy.selected(), false); h.local(); assert.equal(h.saved.length, 0);
  h.context.window.ASTHA_LOCAL_ACCOUNT_ID = 'accountA'; h.context.window.ASTHA_ACCOUNT_ID = 'accountA';
  assert.equal(h.policy.selected(), true);
  assert.equal(h.policy.route('স্বয়ংক্রিয় স্মৃতি বন্ধ করো'), true); assert.equal(h.policy.selected(), false);
  assert.equal(h.policy.route('read the words enable automatic memory'), false);
  assert.equal(h.policy.route('দরকারি জিনিস নিজে থেকে মনে রাখো'), true);
});

test('local saves require repeated direct high-score stable boxes, with truthful location and capture time', () => {
  const h = harness(); h.policy.setEnabled(true);
  const first = h.frame(); h.policy.observeLocal(first, [h.object()]); h.policy.observeLocal(first, [h.object()]);
  assert.equal(h.saved.length, 0);
  h.advance(250); h.policy.observeLocal(h.frame(), [h.object()]); assert.equal(h.saved.length, 0);
  h.advance(250); h.policy.observeLocal(h.frame(), [h.object()]);
  assert.equal(h.saved.length, 1); const saved = h.saved[0];
  assert.equal(saved.approved, true); assert.equal(saved.observedAt, h.now()); assert.equal(saved.preserveLocation, true);
  assert.match(saved.location, /Possible sighting.*left.*physical location unconfirmed/);
  assert.doesNotMatch(saved.location, /room|desk|table|your/i); assert.match(saved.locationBn, /নিশ্চিত নয়/);
  h.local(); assert.equal(h.saved.length, 1);
});

test('CLIP hypotheses, relabelled guesses, unstable/invalid/low-score boxes and missing capture metadata cannot auto-save', () => {
  for (const overrides of [{ src: 'clip' }, { score: 0.2, detectorScore: 0.2 }, { detectorId: 'handbag', id: 'wallet' }, { bbox: [0, 0, -1, 90] }, { pos: 'in your room' }]) {
    const h = harness(); h.policy.setEnabled(true); h.local('laptop', overrides); assert.equal(h.saved.length, 0, JSON.stringify(overrides));
  }
  const h = harness(); h.policy.setEnabled(true); h.policy.observeLocal({}, [h.object()]);
  h.policy.observeCloud({}, [{ item: 'wallet', visible: true, clarity: 'clear', position: 'right' }]);
  assert.equal(h.saved.length, 0);
});

test('only the exact five core categories save automatically from structured current-image evidence', () => {
  for (const [id, expected] of [['laptop', 'laptop'], ['phone', 'phone'], ['glasses', 'eyeglasses'], ['wallet', 'wallet'], ['id card', 'ID card']]) {
    const h = harness(); h.policy.setEnabled(true); const f = h.frame(); h.advance(1000); h.observe(id, {}, f);
    assert.equal(h.saved.length, 1, id); assert.equal(h.saved[0].item, expected);
    assert.equal(h.saved[0].observedAt, h.now() - 1000); assert.equal(h.saved[0].score, null);
    assert.doesNotMatch(JSON.stringify(h.saved[0]), /jpeg|base64|identity_number|name/i);
  }
  for (const [id, overrides] of [['person', {}], ['wallet', { visible: false }], ['wallet', { clarity: 'uncertain' }], ['wallet', { position: 'desk' }], ['ID 12345', {}]]) {
    const h = harness(); h.policy.setEnabled(true); h.observe(id, overrides); h.policy.tick(); assert.equal(h.saved.length, 0, id); assert.equal(h.context.state.pendingYes, null);
  }
});

test('provider-supplied approval, ownership and location claims cannot authorize another object or bypass opt-in', () => {
  const h = harness(); h.policy.setEnabled(true);
  h.observe('keys', { approved: true, memorySaveApproved: true, consent: true, location: 'your bedroom', room: 'Bedroom', name: 'Private person' });
  assert.equal(h.saved.length, 0); h.policy.tick(); assert(h.context.state.pendingYes);
  h.context.state.pendingYes.onYes(); assert.equal(h.saved.length, 1);
  assert.doesNotMatch(JSON.stringify(h.saved[0]), /Bedroom|bedroom|Private person|memorySaveApproved|consent/);
  const disabled = harness(); disabled.observe('wallet', { approved: true, consent: true });
  assert.equal(disabled.saved.length, 0); assert.equal(disabled.context.state.pendingYes, null);
});

test('other selected personal objects require yes; no/timeout never save and offers do not interrupt a task', () => {
  const h = harness(); h.policy.setEnabled(true); h.observe('keys'); assert.equal(h.saved.length, 0);
  h.context.state.busy = true; h.policy.tick(); assert.equal(h.context.state.pendingYes, null);
  h.context.state.busy = false; h.context.AsthaExperience.mode = 'reading'; h.policy.tick(); assert.equal(h.context.state.pendingYes, null);
  h.context.AsthaExperience.mode = 'ask'; h.policy.tick(); assert.match(h.said.at(-1)[1], /মনে রাখব/);
  const p = h.context.state.pendingYes; h.context.state.pendingYes = null; p.onYes();
  assert.equal(h.saved.length, 1); assert.equal(h.saved[0].item, 'keys');
  const no = harness(); no.policy.setEnabled(true); no.observe('keys'); no.policy.tick(); no.context.state.pendingYes.onNo();
  no.context.state.pendingYes = null; no.advance(60001); no.observe('keys'); no.policy.tick(); assert.equal(no.saved.length, 0); assert.equal(no.context.state.pendingYes, null);
  const expired = harness(); expired.policy.setEnabled(true); expired.observe('keys'); expired.policy.tick(); expired.context.state.pendingYes = null; expired.advance(50000); expired.policy.tick(); assert.equal(expired.saved.length, 0);
});

test('an existing dialogue owns yes/no, and stale source/account/privacy/Stop/disable/hidden results never save', () => {
  const h = harness(); h.policy.setEnabled(true); h.observe('keys'); const existing = { onYes() {} }; h.context.state.pendingYes = existing; h.policy.tick(); assert.equal(h.context.state.pendingYes, existing);
  for (const invalidate of [s => { s.context.state.sourceEpoch++; }, s => { s.context.window.ASTHA_LOCAL_ACCOUNT_ID = 'accountB'; }, s => { s.context.privacyMode = true; }, s => { s.context.privacyTransition = true; }, s => { s.context.document.hidden = true; }, s => s.cancel(), s => s.policy.setEnabled(false), s => { s.context.owner.lock = true; }, s => { s.context.remoteProcessingAllowed = () => false; }, s => { s.context.activeSourceEl = () => null; }]) {
    const s = harness(); s.policy.setEnabled(true); const f = s.frame(); s.observe('keys', {}, f); s.policy.tick(); const p = s.context.state.pendingYes;
    invalidate(s); s.observe('wallet', {}, f); p.onYes(); assert.equal(s.saved.length, 0, invalidate.toString());
  }
});

test('ignored approval expires without a command, allowing a later fresh offer while unrelated dialogs stay intact', () => {
  const h = harness(); h.policy.setEnabled(true); h.observe('keys'); h.policy.tick();
  assert(h.context.state.pendingYes); h.advance(20001); h.policy.tick();
  assert.equal(h.context.state.pendingYes, null); assert.equal(h.saved.length, 0);
  h.advance(40000); h.observe('book'); h.policy.tick(); assert(h.context.state.pendingYes);
  const existing = { until: h.now() - 1, onYes() {} }; h.context.state.pendingYes = existing;
  h.advance(20001); h.policy.tick(); assert.equal(h.context.state.pendingYes, existing);
});

test('photos/demo sources cannot become automatic camera memories, and old cloud results are discarded', () => {
  for (const kind of ['scene', 'photo', null]) { const h = harness(); h.policy.setEnabled(true); h.context.state.source = kind; h.local(); h.observe(); assert.equal(h.saved.length, 0); }
  const h = harness(); h.policy.setEnabled(true); const f = h.frame(); h.advance(45001); h.observe('wallet', {}, f); assert.equal(h.saved.length, 0);
});

test('deletion suppresses recreation, clear disables saving, and saved preference exports without other accounts', () => {
  const h = harness(); h.policy.setEnabled(true); h.observe('wallet'); assert.equal(h.saved.length, 1);
  h.policy.forget('wallet'); h.advance(300001); h.observe('wallet'); assert.equal(h.saved.length, 1);
  assert.equal(h.policy.exportPreference().enabled, true);
  h.policy.clear(); h.observe('phone'); h.local(); assert.equal(h.policy.selected(), false); assert.equal(h.saved.length, 1);
  assert.equal(h.storage.size, 0);
});

test('UI control has translated explanation, lifecycle hooks, generated inclusion and no extra model/API pipeline', () => {
  const base = read('tools/base.html'), build = read('tools/build.py'), offline = read('tools/offline.js'), account = read('tools/account.js');
  assert.match(base, /id="auto-memory-enabled" type="checkbox" aria-describedby="auto-memory-help"/);
  const i18n = JSON.parse(read('tools/i18n.json')).strings;
  assert.equal(i18n.auto_memory_label.length, 2); assert.match(i18n.auto_memory_help[1], /অনুমতি/);
  assert.match(build, /offline_js \+= "\\n" \+ observation_memory_js/);
  assert.match(read('web/index.html'), /const AsthaObservationMemory/);
  assert.match(offline, /AsthaObservationMemory\.forget\(forgotten.item\)/); assert.match(offline, /AsthaObservationMemory\.clear\(\)/);
  assert.match(account, /automatic_memory:/); assert.match(account, /AsthaObservationMemory\.clear\(\)/);
  assert.match(read('web/backend.js'), /AsthaObservationMemory\.reset\(\)/);
  assert.doesNotMatch(source, /fetch\(|gemini\(|ensureVision|setInterval\(|toDataURL/);
  assert.match(cloud, /opts.observeMemory.*AsthaObservationMemory.prompt\(frame\)/);
  assert.match(cloud, /AsthaObservationMemory.observeCloud\(frame, result.memory_observations\)/);
});
