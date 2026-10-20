// "Which AI is working": the generated app's actual online request function drives the
// panel, so an answer is credited to online AI only when a request really returned one.
// Fake server and clock; no provider, network or key is involved.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const read = path => fs.readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const built = read('web/index.html').replace(/\r\n/g, '\n');
const strings = JSON.parse(read('tools/i18n.json')).strings;
const en = key => strings[key][0];
function actual(name) {
  const matches = [...built.matchAll(new RegExp('^(?:async )?function ' + name + '\\(', 'gm'))];
  assert(matches.length, 'generated function missing: ' + name);
  const start = matches.at(-1).index;
  return built.slice(start, built.indexOf('\n}\n', start) + 3);
}
const moduleSource = (() => {
  const start = built.indexOf('const AsthaAiStatus = (() => {');
  assert(start >= 0, 'AI status module is not in the generated app');
  return built.slice(start, built.indexOf('\n})();\n', start) + 6);
})();

function setup({ reply = async () => new Response(JSON.stringify({ en: 'A desk with a laptop.', bn: 'একটি ডেস্ক।' }), { status: 200 }) } = {}) {
  const nodes = new Map(), spoken = [], requests = [], timers = [];
  let clock = 1000, mode = 'gemini', consent = true;
  const node = id => { if (!nodes.has(id)) nodes.set(id, { textContent: '' }); return nodes.get(id); };
  const pick = index => Object.fromEntries(Object.entries(strings).map(([key, pair]) => [key, pair[index]]));
  const context = vm.createContext({
    console, Promise, Error, JSON, Object, Array, String, Math, AbortController, Response, URL,
    Date, performance: { now: () => clock },
    I18N: { en: pick(0), bn: pick(1) }, uiLang: 'en', $: node,
    document: { hidden: false }, window: { ASTHA_ACCOUNT_ID: 'user-1' },
    state: { source: 'pi', sourceEpoch: 3, liveLoop: { active: true } }, engine: { coco: { status: 'ready' } },
    PiCamera: { active: () => true },
    cloud: { lastCallAt: 0 }, serverCloud: { checked: true, available: true, provider: 'maira' },
    Subscription: { getMode: () => mode }, remoteProcessingAllowed: () => consent, updateCloudBadge() {},
    apiUrl: path => 'https://astha-preview.example' + path, deadlineSignal: (ms, signal) => signal, frameToJpeg: () => 'data:image/jpeg;base64,AAAA',
    setTimeout: fn => { timers.push(fn); return timers.length; }, setInterval() {},
    announce: (english, bangla) => spoken.push({ en: english, bn: bangla }),
    fetch: async (url, options) => { requests.push({ url, body: JSON.parse(options.body) }); return reply(() => { clock += 5600; }); },
  });
  vm.runInContext(moduleSource + '\n' + actual('gemini') + '\n' + actual('scheduleCloudFallback') + '\nglobalThis.status = AsthaAiStatus;', context);
  return { context, nodes, node, spoken, requests, timers, status: context.status,
    text: () => ['ai-status-camera', 'ai-status-boxes', 'ai-status-online', 'ai-status-last'].map(id => node(id).textContent),
    setMode: value => { mode = value; }, setConsent: value => { consent = value; }, advance: ms => { clock += ms; } };
}

test('an answer is credited to online AI only after a request was sent and answered, with its time', async () => {
  const h = setup({ reply: async passTime => { passTime(); return new Response(JSON.stringify({ en: 'A desk.', bn: 'ডেস্ক।' }), { status: 200 }); } });
  h.status.render();
  assert.equal(h.node('ai-status-last').textContent, en('ai_last_none'));
  const result = await h.context.gemini('Describe the scene for the user.', { width: 640 });
  assert.equal(result.en, 'A desk.');
  assert.equal(h.status.online.state, 'answered'); assert.equal(h.status.online.ms, 5600);
  assert.match(h.node('ai-status-last').textContent, /^Online answer at \d\d:\d\d:\d\d, in 5\.6 seconds\.$/);
  assert.equal(h.node('ai-status-online').textContent, 'Online: Maira AI through the LUNEYRA server, allowed for this session.');
  assert.equal(h.node('ai-status-boxes').textContent, en('ai_boxes_running'));
  assert.equal(h.node('ai-status-camera').textContent, en('ai_camera_pi_live'));
  assert.equal(h.requests.length, 1);
  for (const text of h.text()) assert.doesNotMatch(text, /Describe the scene|data:image|AAAA|astha-preview|key/i, 'no request content, image or address is shown');
});

test('a missing service, a failure or a device fallback is never shown as an online answer', async () => {
  const none = setup(); none.context.serverCloud.available = false;
  await assert.rejects(none.context.gemini('prompt', null));
  assert.equal(none.requests.length, 0); assert.equal(none.status.online.state, 'failed'); assert.equal(none.status.online.reason, 'unavailable');
  none.status.render();
  assert.equal(none.node('ai-status-online').textContent, en('ai_online_unavailable'));
  assert.match(none.node('ai-status-last').textContent, /^The online request at .* failed: the service was unavailable\.$/);
  let ran = 0;
  none.context.scheduleCloudFallback(() => ran++); none.timers.shift()();
  assert.equal(ran, 1);
  assert.match(none.node('ai-status-last').textContent, /^This device answered at .*, because the online request failed\.$/);

  for (const [status, reason] of [[503, 'unavailable'], [429, 'busy'], [500, 'unavailable']]) {
    const h = setup({ reply: async () => new Response('{}', { status }) });
    await assert.rejects(h.context.gemini('prompt', null));
    assert.equal(h.requests.length, 1); assert.equal(h.status.online.state, 'failed', String(status)); assert.equal(h.status.online.reason, reason, String(status));
  }
  const malformed = setup({ reply: async () => new Response('[1, 2]', { status: 200 }) });
  await assert.rejects(malformed.context.gemini('prompt', null));
  assert.equal(malformed.status.online.reason, 'error');

  let release;
  const slow = setup({ reply: () => new Promise(resolve => { release = resolve; }) });
  const controller = new AbortController();
  const pending = slow.context.gemini('prompt', null, { signal: controller.signal });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(slow.status.online.state, 'running'); slow.status.render();
  assert.equal(slow.node('ai-status-last').textContent, en('ai_last_running'));
  controller.abort(); release(new Response('{}', { status: 200 }));
  await assert.rejects(pending);
  assert.equal(slow.status.online.state, 'cancelled');
});

test('on-device mode, missing permission, the picture source and the local boxes are reported plainly', () => {
  const h = setup();
  h.setMode('offline'); h.status.render();
  assert.equal(h.node('ai-status-online').textContent, en('ai_online_offline_mode'));
  h.setMode('gemini'); h.setConsent(false); h.status.render();
  assert.equal(h.node('ai-status-online').textContent, en('ai_online_consent'));
  h.context.PiCamera.active = () => false; h.status.render();
  assert.equal(h.node('ai-status-camera').textContent, en('ai_camera_pi_waiting'), 'a stalled ClipCam is never called live');
  for (const [source, key] of [['camera', 'ai_camera_phone'], ['photo', 'ai_camera_photo'], ['scene', 'ai_camera_demo'], [null, 'ai_camera_none']]) {
    h.context.state.source = source; h.status.render(); assert.equal(h.node('ai-status-camera').textContent, en(key));
  }
  h.context.state.liveLoop = null; h.status.render(); assert.equal(h.node('ai-status-boxes').textContent, en('ai_boxes_ready'));
  h.context.engine.coco.status = 'loading'; h.status.render(); assert.equal(h.node('ai-status-boxes').textContent, en('ai_boxes_off'));
});

test('"which AI are you using" is answered in English and Bangla from what actually happened', async () => {
  const h = setup();
  await h.context.gemini('prompt', null);
  assert.equal(h.status.route('ASTHA, which AI are you using?'), true);
  const said = h.spoken.at(-1);
  assert.match(said.en, /^Online: Maira AI through the LUNEYRA server, allowed for this session\. Online answer at .*\. The boxes on the picture come from this device, not from online AI\.$/);
  assert.match(said.bn, /মায়রা এআই/); assert.match(said.bn, /এই ডিভাইস থেকে আসে/);
  for (const words of ['are you online', 'Is Gemini working?', 'কোন এআই ব্যবহার করছ?', 'অনলাইন না অফলাইন', 'LUNEYRA, which AI are you using?', 'লুনেইরা, কোন এআই ব্যবহার করছ?']) assert.equal(h.status.route(words), true, words);
  for (const words of ['describe the room', 'what is in front of me', 'read this', 'connect to my camera']) assert.equal(h.status.route(words), false, words);
  h.context.uiLang = 'bn'; h.status.render();
  assert.match(h.node('ai-status-last').textContent, /[০-৯]/, 'Bangla shows Bangla digits');
});
