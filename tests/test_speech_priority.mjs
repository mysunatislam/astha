// Speech priority end to end: the interaction manager, the voice engine and the live
// hazard/narration path run together against a recording stand-in for the device voice.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const read = file => fs.readFileSync(new URL('../' + file, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const moduleSource = read('tools/module.js');
const built = read('web/index.html');
const between = (source, start, end) => {
  const a = source.indexOf(start), b = source.indexOf(end, a + start.length);
  assert(a >= 0 && b > a, 'missing source boundary: ' + start);
  return source.slice(a, b);
};
const voiceSource = between(moduleSource, 'const VoiceEngine = {', 'function startReader(');
const liveSource = between(built, 'function afterLiveUpdate() {', '\nfunction showHazard(');

function harness({ mode = 'road', audio = true, deviceVoice = true, voiceLang = 'en', banglaVoice = false } = {}) {
  let now = 500000;
  const timers = [], captions = [], earcons = [], haptics = [], banners = [], logs = [], cancelled = [];
  const synth = {
    current: null, spoken: [],
    get speaking() { return Boolean(this.current); },
    speak(utterance) { this.current = utterance; this.spoken.push(utterance); },
    // A real engine reports an interrupted utterance through its error event.
    cancel() { const utterance = this.current; this.current = null; if (utterance) { cancelled.push(utterance.text); utterance.onerror?.(); } },
    finish() { const utterance = this.current; this.current = null; utterance?.onend?.(); },
  };
  const nodes = new Map();
  const element = id => { if (!nodes.has(id)) nodes.set(id, { value: '1', textContent: '', hidden: true, setAttribute() {}, addEventListener() {}, focus() {} }); return nodes.get(id); };
  const world = [];
  const context = vm.createContext({
    console, Promise, Map, Set, Math, JSON, Object, Array, String, Number, Boolean, RegExp, Error,
    Date: class extends Date { static now() { return now; } },
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimeout() {},
    state: { audio, shield: false, source: 'camera', sourceEpoch: 1, busy: false, listening: false, narrate: true, hazardCooldown: new Map(), announced: new Map() },
    reader: { active: false }, reading: { active: false }, uiLang: 'en', voiceLang, privacyTransition: false,
    voices: banglaVoice ? [{ lang: 'en-US', localService: true }, { lang: 'bn-BD', localService: true }] : [{ lang: 'en-US', localService: true }], refreshVoices() {},
    VoiceEchoFilter: { recordMachineSpeech() {} },
    remoteProcessingAllowed: () => false, offlineError: () => new Error('offline'), backendReachable: () => false,
    apiUrl: path => path, deadlineSignal: () => undefined,
    makeUtterance: (text, lang) => deviceVoice ? { text, lang, rate: 1 } : null, sanitizeForSpeech: text => text,
    stopReader() { context.engine.stop(); },
    playEarcon: name => earcons.push(name), haptic: name => haptics.push(name), showHazard: on => banners.push(on),
    setCaption: (title, text, agent, tone) => captions.push({ title, text, agent, tone }), logEvent: text => logs.push(text),
    t: (key, values) => key + (values ? ':' + Object.values(values).join(',') : ''), tBn: key => key,
    label: id => id, labelBn: id => id, labelWithArticle: id => 'a ' + id, joinList: list => list.join(', '),
    worldSorted: () => world, isHazard: object => Boolean(object.hazard),
    narrateMotion: () => false, cloudReady: () => false, heartPointAt() {}, STRICT_COCO: new Set(), VOCAB_BY_ID: {}, privacyMode: false,
    objLabel: object => object.id, objLabelBn: object => object.id, objLabelWithArticle: object => 'a ' + object.id,
    setMode: next => { context.state.shield = next === 'auto'; context.state.narrate = next === 'auto'; },
    announce: (en, bn) => context.speak(en, bn), stopAllSpeech() {}, captureFrame: () => null,
    $: element, document: { hidden: false, body: element('body'), querySelectorAll: () => [], querySelector: selector => element(selector), addEventListener() {} },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    I18N: { en: {}, bn: {} },
  });
  context.window = { speechSynthesis: synth, ASTHA_ACCOUNT_ID: 'a', ASTHA_LOCAL_ACCOUNT_ID: 'a' };
  vm.runInContext(read('tools/experience.js') + '\n' + voiceSource + '\n' + liveSource +
    '\nglobalThis.experience = AsthaExperience; globalThis.engine = VoiceEngine; globalThis.live = afterLiveUpdate;', context);
  context.experience.setContext(mode, true);
  const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
  return { context, synth, timers, captions, earcons, haptics, banners, logs, cancelled, world, settle, nodes,
    experience: context.experience, engine: context.engine, live: context.live, speak: (en, bn) => context.speak(en, bn),
    advance: ms => { now += ms; } };
}

test('a stairs alert interrupts the answer being spoken and uses the urgent voice', async () => {
  const h = harness();
  h.speak('The label says paracetamol 500 milligrams.', ''); await h.settle();
  assert.equal(h.synth.current.text, 'The label says paracetamol 500 milligrams.');
  h.engine.emergencyAlert('Warning! Stairs directly ahead!', '', 'stairs');
  assert.deepEqual(h.cancelled, ['The label says paracetamol 500 milligrams.']);
  assert.equal(h.synth.current.text, 'Warning! Stairs directly ahead!'); assert.equal(h.synth.current.rate, 1.18);
  assert.deepEqual(h.earcons, ['emergency']); assert.deepEqual(h.haptics, ['RAPID']);
  assert.equal(h.captions.at(-1).tone, 'danger');
});

test('an answer that arrives during an alert waits for it, and only the newest waiting answer is spoken', async () => {
  const h = harness();
  h.engine.emergencyAlert('Stop! Drop-off ahead!', '', 'drop_off');
  h.speak('First answer.', ''); h.speak('Second answer.', ''); await h.settle();
  assert.equal(h.synth.current.text, 'Stop! Drop-off ahead!', 'ordinary speech must not cut the alert short');
  assert.deepEqual(h.cancelled, []);
  h.synth.finish(); await h.settle();
  assert.equal(h.synth.current.text, 'Second answer.');
  assert.deepEqual(h.synth.spoken.map(utterance => utterance.text), ['Stop! Drop-off ahead!', 'Second answer.']);
});

test('the user can always silence an alert, and a waiting answer is dropped with it', async () => {
  const h = harness();
  h.engine.emergencyAlert('Watch out! Vehicle dangerously close directly ahead!', '', 'vehicle_collision');
  h.speak('Queued answer.', ''); await h.settle();
  h.engine.stop(true); await h.settle();
  assert.equal(h.synth.current, null); assert.equal(h.engine.criticalUntil, 0);
  assert.deepEqual(h.synth.spoken.map(utterance => utterance.text), ['Watch out! Vehicle dangerously close directly ahead!']);
  // Nothing is left blocking the next answer.
  h.speak('Next answer.', ''); await h.settle();
  assert.equal(h.synth.current.text, 'Next answer.');
});

test('a voice that never reports the end of an alert cannot block answers forever', async () => {
  const h = harness();
  h.engine.emergencyAlert('Warning! Stairs directly ahead!', '', 'stairs');
  h.speak('Answer after a stuck alert.', ''); await h.settle();
  h.timers.find(timer => timer.ms === 6000).fn(); await h.settle();
  assert.equal(h.synth.spoken.at(-1).text, 'Answer after a stuck alert.');
});

test('a person or furniture warning never interrupts an answer and is an ordinary update when idle', async () => {
  const h = harness();
  h.speak('Reading the whiteboard for you.', ''); await h.settle();
  h.engine.emergencyAlert('Watch out! Person approaching rapidly on your left!', '', 'body_collision');
  assert.deepEqual(h.cancelled, []); assert.equal(h.synth.current.text, 'Reading the whiteboard for you.');
  h.synth.finish(); await h.settle(); h.advance(5000);
  h.engine.emergencyAlert('Watch out! Person approaching rapidly on your left!', '', 'body_collision'); await h.settle();
  assert.equal(h.synth.current.text, 'Watch out! Person approaching rapidly on your left!');
  assert.equal(h.synth.current.rate, 1, 'an update is not delivered as an emergency');
  assert.deepEqual(h.earcons, ['hazard']); assert.equal(h.engine.criticalUntil, 0);
});

test('image-derived hazards are not announced unless ASTHA was asked to watch', () => {
  for (const mode of ['ask', 'classroom']) {
    const h = harness({ mode });
    h.engine.emergencyAlert('Warning! Stairs directly ahead!', '', 'stairs');
    assert.equal(h.synth.spoken.length, 0, mode); assert.equal(h.banners.length, 0, mode); assert.equal(h.captions.length, 0, mode);
  }
});

test('with the voice off an alert still shows its caption and vibrates', () => {
  const h = harness({ audio: false });
  h.engine.emergencyAlert('Warning! Stairs directly ahead!', '', 'stairs');
  assert.equal(h.synth.spoken.length, 0); assert.deepEqual(h.earcons, []);
  assert.equal(h.captions.at(-1).text, 'Warning! Stairs directly ahead!'); assert.deepEqual(h.haptics, ['RAPID']);
});

test('without a device voice an alert uses the normal voice path instead of staying silent', () => {
  const h = harness({ deviceVoice: false }), requests = [];
  h.engine.speak = (text, lang) => { requests.push([text, lang]); return Promise.resolve(true); };
  h.engine.emergencyAlert('Warning! Stairs directly ahead!', 'সতর্ক! সামনে সিঁড়ি!', 'stairs');
  assert.deepEqual(requests, [['Warning! Stairs directly ahead!', 'en']]);
});

test('live detection: a chair waits for the answer and keeps its turn, stairs interrupt at once', async () => {
  const h = harness();
  h.speak('Your charger is on the desk.', ''); await h.settle();
  h.world.push({ id: 'chair', hazard: true, pos: 'left', prox: 'near', score: 0.9, first: 0 });
  h.live();
  assert.deepEqual(h.cancelled, []); assert.equal(h.context.state.hazardCooldown.has('chair'), false, 'an unspoken warning must not use up its cooldown');
  assert.equal(h.banners.at(-1), true, 'the on-screen banner still appears');
  h.world.unshift({ id: 'stairs', hazard: true, pos: 'ahead', score: 0.9, first: 0 });
  h.live();
  assert.equal(h.synth.current.text, 'Warning! Stairs directly ahead!'); assert.equal(h.synth.current.rate, 1.18);
  // Once ASTHA is quiet the chair is mentioned, as an update.
  h.synth.finish(); await h.settle(); h.world.shift(); h.advance(5000);
  h.live(); await h.settle();
  assert.match(h.synth.current.text, /^hazard_msg:chair/); assert.equal(h.synth.current.rate, 1);
});

test('live detection: routine objects are narrated only in surroundings mode and never over speech', async () => {
  for (const mode of ['ask', 'classroom']) {
    const h = harness({ mode }); h.context.state.narrate = true;
    h.world.push({ id: 'cup', pos: 'ahead', score: 0.9, src: 'coco', first: 0 });
    h.live(); await h.settle();
    assert.equal(h.synth.spoken.length, 0, mode);
  }
  const h = harness();
  h.world.push({ id: 'cup', pos: 'ahead', score: 0.9, src: 'coco', first: 0 });
  h.speak('Answering you.', ''); await h.settle();
  h.live(); await h.settle();
  assert.equal(h.synth.current.text, 'Answering you.');
  h.synth.finish(); await h.settle(); h.advance(5000);
  h.live(); await h.settle();
  assert.match(h.synth.current.text, /^new_object/);
});

// ---- Bangla chosen as the voice, on a device that cannot voice it -------------------
const NOTICE = 'This device has no Bangla voice, so I am speaking English. Turn on Online AI to hear my Bangla voice. ';

test('with no Bangla voice available ASTHA speaks English and explains once, instead of staying silent', async () => {
  const h = harness({ voiceLang: 'bn' });
  h.speak('Your tea is on the left.', 'আপনার চা বাঁ দিকে।'); await h.settle();
  assert.equal(h.synth.current.text, NOTICE + 'Your tea is on the left.'); assert.equal(h.synth.current.lang, 'en');
  assert.equal(h.nodes.get('voice-notice').hidden, false, 'the reason is also shown on the page');
  h.synth.finish(); await h.settle();
  h.speak('The door is ahead.', 'দরজা সামনে।'); await h.settle();
  assert.equal(h.synth.current.text, 'The door is ahead.', 'the explanation is given once, not before every answer');
});

test('with a Bangla voice on the device the Bangla text is spoken and no notice appears', async () => {
  const h = harness({ voiceLang: 'bn', banglaVoice: true });
  h.speak('Your tea is on the left.', 'আপনার চা বাঁ দিকে।'); await h.settle();
  assert.equal(h.synth.current.text, 'আপনার চা বাঁ দিকে।'); assert.equal(h.synth.current.lang, 'bn');
  h.synth.finish(); await h.settle();
  assert.equal(h.nodes.get('voice-notice').hidden, true);
});

test('a hazard alert is spoken in English at once when Bangla cannot be voiced', () => {
  const h = harness({ voiceLang: 'bn' });
  h.engine.emergencyAlert('Warning! Stairs directly ahead!', 'সতর্ক! সামনে সিঁড়ি!', 'stairs');
  assert.equal(h.synth.current.text, 'Warning! Stairs directly ahead!'); assert.equal(h.synth.current.rate, 1.18);
  assert.equal(h.nodes.get('voice-notice').hidden, false);
  const withVoice = harness({ voiceLang: 'bn', banglaVoice: true });
  withVoice.engine.emergencyAlert('Warning! Stairs directly ahead!', 'সতর্ক! সামনে সিঁড়ি!', 'stairs');
  assert.equal(withVoice.synth.current.text, 'সতর্ক! সামনে সিঁড়ি!');
});

test('Bangla text with no English equivalent is reported as unspoken, and an interrupted sentence is not repeated in English', async () => {
  const h = harness({ voiceLang: 'bn' });
  assert.equal(await h.engine.speak('পাতার লেখা', 'bn'), false); assert.equal(h.synth.spoken.length, 0);
  // The app voice is tried first when it exists; stopping it must not start an English copy.
  let release; const stops = [];
  h.context.window.AsthaNative = { canSpeak: true, speak: () => new Promise(resolve => { release = resolve; }), stopSpeaking: () => stops.push(true) };
  h.speak('Your tea is on the left.', 'আপনার চা বাঁ দিকে।'); await h.settle();
  h.engine.stop(true); release(false); await h.settle();
  assert.equal(h.synth.spoken.length, 0); assert.deepEqual(stops, [true]);
});
