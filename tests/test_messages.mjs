// The message agent on the page: it announces a message, and sends only the words the user
// confirmed with a yes. The Android side is a stand-in here; none of this proves behaviour on
// a phone or in any messaging app.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../tools/messages.js', import.meta.url), 'utf8');

function harness({ native = true, consent = true, enabled = true, background = false, admit = () => true, online = false, suggestion } = {}) {
  const said = [], replies = [], backgrounds = [], timers = [], elements = new Map(), listeners = {};
  let handler = null, clock = 1000;
  const status = { consent, enabled, background };
  const bridge = {
    status: async () => ({ ...status }),
    setConsent: async granted => { status.consent = granted; if (!granted) status.background = false; },
    openSettings: async () => {},
    reply: async (key, text) => { replies.push([key, text]); return true; },
    setBackground: async (on, lang) => { backgrounds.push([on, lang]); status.background = on; },
    onMessage: fn => { handler = fn; },
  };
  const element = id => {
    if (!elements.has(id)) elements.set(id, { hidden: true, checked: false, textContent: '', attributes: {}, listeners: {},
      setAttribute(key, value) { this.attributes[key] = value; }, addEventListener(name, fn) { this.listeners[name] = fn; } });
    return elements.get(id);
  };
  const context = vm.createContext({
    window: native ? { AsthaNative: { messages: bridge } } : {},
    document: { getElementById: element, hidden: false, addEventListener: (name, fn) => { listeners[name] = fn; } },
    announce: (en, bn) => said.push({ en, bn }),
    t: key => key,
    voiceLang: 'en', uiLang: 'en',
    AsthaExperience: { admit: (...args) => admit(...args) },
    cloudReady: () => online,
    gemini: async () => suggestion,
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout: () => {},
    Date: { now: () => clock },
    Promise, String, Object, Array, Boolean, Error, JSON,
  });
  vm.runInContext(source + '\nglobalThis.AsthaMessages = AsthaMessages;', context);
  const settle = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
  return {
    messages: context.AsthaMessages, context, said, replies, backgrounds, timers, element, settle, status, listeners,
    deliver: message => handler(message),
    advance: ms => { clock += ms; },
  };
}

const MESSAGE = { key: '0|com.facebook.orca|7', app: 'Messenger', sender: 'Rina', text: 'Are you coming?', canReply: true };

async function ready(options) {
  const h = harness(options);
  h.messages.boot(); await h.settle();
  return h;
}

test('a browser has no message agent: the panel stays hidden and requests pass through', async () => {
  const h = harness({ native: false });
  h.messages.boot(); await h.settle();
  assert.equal(h.element('messages-access').hidden, true); assert.equal(h.element('messages-web').hidden, false, 'it says where the feature lives');
  assert.equal(h.messages.route('reply on my way'), false);
});

test('nothing is announced until the user has consented and Android access is on', async () => {
  for (const options of [{ consent: false }, { enabled: false }]) {
    const h = await ready(options);
    h.deliver(MESSAGE);
    assert.deepEqual(h.said, [], JSON.stringify(options));
    assert.equal(h.messages.route('reply on my way'), false);
  }
});

test('a dictated reply is read back and sent only after yes', async () => {
  const h = await ready();
  h.deliver(MESSAGE);
  assert.match(h.said.at(-1).en, /^New message from Messenger, Rina: Are you coming\? Say reply/);
  assert.equal(h.messages.route('Astha, reply on my way'), true);
  assert.equal(h.messages.stage, 'confirm'); assert.match(h.said.at(-1).en, /“on my way” to Rina\. Say yes to send it/);
  assert.deepEqual(h.replies, [], 'nothing is sent before the yes');
  assert.equal(h.messages.route('yes'), true); await h.settle();
  assert.deepEqual(h.replies, [[MESSAGE.key, 'on my way']]); assert.equal(h.said.at(-1).en, 'Sent to Rina.');
  assert.equal(h.messages.route('yes'), false, 'a second yes sends nothing');
});

test('anything but a clear yes at the confirm step sends nothing', async () => {
  for (const answer of ['maybe', 'no', 'yesterday', 'what did you say', "yes, don't send it", 'yes no', 'okay cancel', 'sure but wait', 'send it later', 'go ahead no', 'হ্যাঁ না পাঠিও না', 'ঠিক আছে বাতিল', 'পাঠাও না']) {
    const h = await ready();
    h.deliver(MESSAGE); h.messages.route('reply see you soon');
    assert.equal(h.messages.route(answer), true, answer); await h.settle();
    assert.deepEqual(h.replies, [], answer); assert.equal(h.said.at(-1).en, 'Okay, nothing was sent.');
  }
});
test('a changed notification revision cancels an old confirmation and requires a new reply', async () => {
  const h = await ready();
  h.deliver({ ...MESSAGE, key: 'immutable-revision-1', conversation: 'same-notification' });
  h.messages.route('reply on my way');
  assert.equal(h.messages.stage, 'confirm');
  h.deliver({ ...MESSAGE, key: 'immutable-revision-2', conversation: 'same-notification', sender: 'Different person', text: 'Different conversation' });
  h.messages.route('yes'); await h.settle();
  assert.deepEqual(h.replies, []);
  h.messages.route('reply please call me');
  h.messages.route('yes'); await h.settle();
  assert.deepEqual(h.replies, [['immutable-revision-2', 'please call me']]);
});
test('a hidden page drops message drafts and never speaks or sends a reply', async () => {
  const h = await ready();
  h.deliver(MESSAGE); h.messages.route('reply on my way');
  const announced = h.said.length;
  h.context.document.hidden = true; h.listeners.visibilitychange();
  h.deliver({ ...MESSAGE, key: 'hidden-message' });
  assert.equal(h.messages.route('yes'), false); await h.settle();
  assert.equal(h.messages.stage, null); assert.equal(h.messages.pending, 0);
  assert.equal(h.said.length, announced); assert.deepEqual(h.replies, []);
});

test('reply without words asks for them, and cancel while composing sends nothing', async () => {
  const h = await ready();
  h.deliver(MESSAGE);
  h.messages.route('reply'); assert.equal(h.messages.stage, 'compose'); assert.match(h.said.at(-1).en, /What should I say to Rina/);
  h.messages.route('never mind'); await h.settle();
  assert.deepEqual(h.replies, []); assert.equal(h.messages.stage, null);
});

test('Bangla answers work the same way', async () => {
  const h = await ready();
  h.deliver(MESSAGE);
  assert.equal(h.messages.route('উত্তর দাও আমি আসছি'), true); assert.equal(h.messages.stage, 'confirm');
  assert.equal(h.messages.route('হ্যাঁ'), true); await h.settle();
  assert.deepEqual(h.replies, [[MESSAGE.key, 'আমি আসছি']]);
});

test('a suggested reply needs online processing and is still confirmed before sending', async () => {
  const offline = await ready();
  offline.deliver(MESSAGE); offline.messages.route('suggest a reply');
  assert.equal(offline.messages.stage, 'compose'); assert.match(offline.said.at(-1).en, /only suggest a reply when online processing is allowed/);
  const online = await ready({ online: true, suggestion: { reply: 'Yes, see you at six!' } });
  online.deliver(MESSAGE); online.messages.route('suggest a reply'); await online.settle();
  assert.equal(online.messages.stage, 'confirm'); assert.match(online.said.at(-1).en, /I suggest sending “Yes, see you at six!” to Rina/);
  assert.deepEqual(online.replies, []);
});

test('a message waits while the user is busy, and expires two minutes after it was read', async () => {
  let free = false;
  const h = await ready({ admit: () => free });
  h.deliver(MESSAGE);
  assert.deepEqual(h.said, [], 'not read over the current answer'); assert.equal(h.timers.at(-1).ms, 3000);
  free = true; h.timers.at(-1).fn();
  assert.match(h.said.at(-1).en, /New message from Messenger, Rina/);
  h.advance(120001);
  assert.equal(h.messages.route('reply on my way'), false, 'an old message is not answered by accident');
});

test('message text is cleaned and bounded, and a repeated notification replaces the waiting one', async () => {
  let free = false;
  const h = await ready({ admit: () => free });
  h.deliver({ ...MESSAGE, text: 'first' });
  h.deliver({ ...MESSAGE, text: 'newest' });
  h.deliver({ ...MESSAGE, key: 'other', sender: '' });
  assert.equal(h.messages.pending, 1, 'one conversation waiting, and a message without a sender is dropped');
  free = true; h.timers.at(-1).fn();
  assert.match(h.said.at(-1).en, /Rina: newest/);
  const long = await ready();
  long.deliver({ ...MESSAGE, text: 'line one\nline\u0000two ' + 'x'.repeat(600) });
  const text = long.said.at(-1).en.split('Rina: ')[1].split(' Say reply')[0];
  assert.equal(text.length, 500); assert.match(text, /^line one line two x/);
});

test('reading aloud with the phone locked is a separate choice that follows the voice language', async () => {
  const h = await ready();
  assert.equal(h.element('messages-background-area').hidden, false, 'offered once message help is on');
  assert.equal(h.element('messages-web').hidden, true);
  await h.element('messages-background').listeners.change({ target: { checked: true } });
  assert.deepEqual(h.backgrounds, [[true, 'en']]); assert.equal(h.messages.background, true);
  assert.match(h.said.at(-1).en, /even when the phone is locked\. A notification shows/);
  h.context.voiceLang = 'bn'; h.messages.refreshLabels(); await h.settle();
  assert.deepEqual(h.backgrounds.at(-1), [true, 'bn']);
  await h.messages.toggle();
  assert.equal(h.status.consent, false); assert.equal(h.messages.background, false, 'withdrawing consent turns it off too');
  assert.equal(h.element('messages-background-area').hidden, true);
});
