// Actual UI message flow with a controlled native bridge; no phone behavior is simulated as evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../tools/messages.js', import.meta.url), 'utf8');
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const settle = () => new Promise(resolve => setImmediate(resolve));
function harness() {
  const said = [], nodes = new Map(), listeners = {}, calls = [];
  const status = { consent: true, enabled: true, background: false };
  const element = id => {
    if (!nodes.has(id)) nodes.set(id, { hidden: true, checked: false, textContent: '', setAttribute() {}, addEventListener() {} });
    return nodes.get(id);
  };
  const bridge = { status: async () => ({ ...status }),
    setConsent: async granted => { status.consent = granted; if (!granted) status.background = false; },
    setBackground: async (on, lang) => { calls.push({ on, lang }); await behavior(on); },
    openSettings: async () => {}, onMessage() {},
  };
  let behavior = async on => { status.background = on; };
  const context = vm.createContext({ window: { AsthaNative: { messages: bridge } },
    document: { hidden: false, getElementById: element, addEventListener: (key, fn) => { listeners[key] = fn; } },
    voiceLang: 'en', uiLang: 'en', t: key => key, announce: (en, bn) => said.push({ en, bn }),
    setTimeout: () => 1, clearTimeout() {}, AsthaExperience: { admit: () => true },
  });
  vm.runInContext(source + '\nglobalThis.messages = AsthaMessages;', context);
  return { context, messages: context.messages, status, said, calls, listeners, element, bridge,
    behavior: fn => { behavior = fn; }, fail: code => { behavior = async () => { throw { code }; }; } };
}
async function ready() { const h = harness(); h.messages.boot(); await settle(); return h; }

test('background enable failures name the actual denied capability and restore the off checkbox', async () => {
  const reasons = [
    ['notifications_permission', /Allow LUNEYRA notifications/, /নোটিফিকেশন চালু/],
    ['notifications_disabled', /Allow LUNEYRA notifications/, /নোটিফিকেশন চালু/],
    ['service_disabled', /notification access/, /নোটিফিকেশন অ্যাক্সেস/],
    ['permission', /microphone access/, /মাইক্রোফোন/],
    ['consent_required', /Turn on message help/, /বার্তা সহায়তা চালু/],
    ['foreground_required', /Keep LUNEYRA open/, /লুনেইরা খোলা/],
    ['not_started', /did not start/, /চালু করেনি/],
  ];
  for (const [code, english, bangla] of reasons) {
    const h = await ready(); h.fail(code); h.element('messages-background').checked = true;
    await h.messages.setBackground(true);
    assert.match(h.said.at(-1).en, english, code); assert.match(h.said.at(-1).bn, bangla, code);
    assert.equal(h.element('messages-background').checked, false); assert.equal(h.messages.background, false);
  }
});

test('a late enable success or failure cannot contradict a newer disable', async () => {
  for (const reject of [false, true]) {
    const h = await ready(), wait = deferred(); h.behavior(on => on ? wait.promise : Promise.resolve());
    const enabling = h.messages.setBackground(true); await settle();
    await h.messages.setBackground(false); const before = JSON.stringify(h.said);
    if (reject) wait.reject({ code: 'notifications_permission' }); else wait.resolve();
    await enabling; assert.equal(JSON.stringify(h.said), before); assert.equal(h.messages.background, false);
    assert.equal(h.element('messages-background').checked, false);
  }
});

test('withdrawing message consent invalidates a pending background enable announcement', async () => {
  const h = await ready(), wait = deferred(); h.behavior(() => wait.promise);
  const enabling = h.messages.setBackground(true); await settle();
  await h.messages.toggle(); const before = JSON.stringify(h.said);
  wait.resolve(); await enabling; assert.equal(JSON.stringify(h.said), before);
  assert.equal(h.status.consent, false); assert.equal(h.messages.background, false);
});

test('hidden-page and canceled enables cannot speak; returning reads actual native status', async () => {
  const hidden = await ready(), wait = deferred(); hidden.behavior(() => wait.promise);
  const enabling = hidden.messages.setBackground(true); await settle();
  hidden.context.document.hidden = true; hidden.listeners.visibilitychange(); const before = JSON.stringify(hidden.said);
  wait.reject({ code: 'cancelled' }); await enabling; assert.equal(JSON.stringify(hidden.said), before);
  hidden.context.document.hidden = false; hidden.listeners.visibilitychange(); await settle();
  assert.equal(hidden.messages.background, false); assert.equal(hidden.element('messages-background').checked, false);
  const canceled = await ready(); canceled.fail('cancelled'); canceled.element('messages-background').checked = true;
  await canceled.messages.setBackground(true); assert.equal(canceled.said.length, 0);
  assert.equal(canceled.element('messages-background').checked, false);
});

test('normal enable and disable preserve spoken bilingual confirmations and actual state', async () => {
  const h = await ready(); h.context.voiceLang = 'bn'; await h.messages.setBackground(true);
  assert.equal(h.calls[0].lang, 'bn'); assert.equal(h.messages.background, true);
  assert.equal(h.element('messages-background').checked, true); assert.match(h.said.at(-1).en, /even when the phone is locked/);
  assert.match(h.said.at(-1).bn, /ফোন লক থাকলেও/);
  await h.messages.setBackground(false); assert.equal(h.messages.background, false);
  assert.equal(h.element('messages-background').checked, false); assert.match(h.said.at(-1).en, /while she is open/);
});

test('old status replies or failures cannot replace newer disable, consent or foreground state', async () => {
  for (const boundary of ['disable', 'consent', 'hidden', 'refresh']) {
    for (const rejected of [false, true]) {
      const h = await ready(), wait = deferred();
      h.bridge.status = () => wait.promise;
      const old = h.messages.refresh();
      h.bridge.status = async () => ({ ...h.status });
      if (boundary === 'disable') await h.messages.setBackground(false);
      if (boundary === 'consent') await h.messages.toggle();
      if (boundary === 'hidden') { h.context.document.hidden = true; h.listeners.visibilitychange(); }
      if (boundary === 'refresh') { h.status.background = false; await h.messages.refresh(); }
      const before = { status: h.messages.status, background: h.messages.background, checked: h.element('messages-background').checked };
      if (rejected) wait.reject(new Error('old status failure'));
      else wait.resolve({ consent: true, enabled: true, background: true });
      await old;
      assert.deepEqual({ status: h.messages.status, background: h.messages.background, checked: h.element('messages-background').checked }, before,
        boundary + (rejected ? ' rejected' : ' resolved'));
    }
  }
});
