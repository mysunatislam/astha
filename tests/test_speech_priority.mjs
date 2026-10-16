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

function harness({ mode = 'road', audio = true, deviceVoice = true, voiceLang = 'en', banglaVoice = false, realPersonRules = false } = {}) {
  let now = 500000;
  const timers = [], captions = [], earcons = [], haptics = [], banners = [], logs = [], cancelled = [], colors = [];
  const synth = {
    current: null, spoken: [],
    get speaking() { return Boolean(this.current); },
    speak(utterance) { this.current = utterance; this.spoken.push(utterance); },
    // A real engine reports an interrupted utterance through its error event.
    cancel() { const utterance = this.current; this.current = null; if (utterance) { cancelled.push(utterance.text); utterance.onerror?.(); } },
    finish() { const utterance = this.current; this.current = null; utterance?.onend?.(); },
  };
  const nodes = new Map();
  const element = id => { if (!nodes.has(id)) nodes.set(id, { value: '1', textContent: '', hidden: true, setAttribute() {}, addEventListener() {}, focus() {},
    getContext() { return { clearRect() {}, strokeRect() { colors.push(this.strokeStyle); }, fillRect() {}, fillText() {}, setLineDash() {}, measureText: text => ({ width: text.length * 8 }) }; } }); return nodes.get(id); };
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
    article: () => 'a', esc: text => text, themeAccent: () => '#ffd700',
    setMode: next => { context.state.shield = next === 'auto'; context.state.narrate = next === 'auto'; },
    announce: (en, bn) => context.speak(en, bn), stopAllSpeech() {}, captureFrame: () => null,
    $: element, document: { hidden: false, body: element('body'), querySelectorAll: () => [], querySelector: selector => element(selector), addEventListener() {} },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    I18N: { en: {}, bn: {} },
  });
  context.window = { speechSynthesis: synth, ASTHA_ACCOUNT_ID: 'a', ASTHA_LOCAL_ACCOUNT_ID: 'a' };
  vm.runInContext(read('tools/experience.js') + '\n' + voiceSource + '\n' + liveSource +
    '\nglobalThis.experience = AsthaExperience; globalThis.engine = VoiceEngine; globalThis.live = afterLiveUpdate;', context);
  if (realPersonRules) {
    const actual = name => {
      const matches = [...built.matchAll(new RegExp('^function ' + name + '\\(', 'gm'))];
      assert(matches.length, 'generated function missing: ' + name);
      const start = matches.at(-1).index; return built.slice(start, built.indexOf('\n}', start) + 2);
    };
    const vocabulary = between(built, 'const VOCAB = [];', '\nconst COCO_TO_ID =');
    const movement = between(built, 'const REAL_MOBILE_AGENTS =', '\n// ---- Understanding what was said');
    const velocity = between(built, 'const ApproachVelocityTracker =', '\n// ---- Real-Time Stairs,');
    vm.runInContext(vocabulary + '\n' + read('tools/perceive.js') + '\n' + movement + '\n' + velocity + '\n' + actual('drawOverlay') + '\n' + actual('renderSeen') +
      '\nglobalThis.velocity = ApproachVelocityTracker;', context);
    context.state.lastCocoPreds = [];
  }
  context.experience.setContext(mode, true);
  const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
  return { context, synth, timers, captions, earcons, haptics, banners, logs, cancelled, world, settle, nodes, colors,
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

const person = (size = 380, extra = {}) => ({ id: 'person', score: 0.9, src: 'coco', pos: 'ahead', prox: 'very_close',
  bbox: [320 - size / 2, 240 - size / 2, size, size], first: 500000, ...extra });

test('the shipped person detector box, seen chip and summary stay ordinary observations even nearby or moving', () => {
  for (const motion of [null, { dir: 'toward', fast: true }, { dir: 'left', fast: false }]) {
    const h = harness({ realPersonRules: true }), object = person(380, { motion }); h.world.push(object);
    assert.equal(h.context.isHazard(object), false);
    h.context.drawOverlay({ width: 640, height: 480 }, [object], []);
    assert.equal(h.colors.at(-1), '#ffd700', 'ordinary person boxes use the normal detector color');
    h.context.renderSeen();
    assert.doesNotMatch(h.nodes.get('seen-row').innerHTML, /hazard-chip/);
    assert.doesNotMatch(h.nodes.get('seen-list').innerHTML, /tag hz/);
    const summary = h.context.sceneSummary();
    assert.match(summary.en, /person/); assert.doesNotMatch(summary.en, /Careful|danger|attack|collision|threat/i);
    assert.doesNotMatch(summary.bn, /সাবধান|বিপদ|আক্রমণ/);
  }
});

test('a stationary person does not show a banner, sound a hazard earcon or interrupt an answer', async () => {
  for (const mode of ['ask', 'road']) {
    const h = harness({ mode, realPersonRules: true }), object = person(); h.world.push(object);
    h.speak('Here is the answer to your question.', ''); await h.settle();
    for (let frame = 0; frame < 5; frame++) {
      assert.equal(h.context.velocity.evaluate(640, 480, [object]), null);
      h.live(); h.advance(280);
    }
    assert.deepEqual(h.cancelled, []); assert.equal(h.synth.current.text, 'Here is the answer to your question.');
    assert.equal(h.banners.some(Boolean), false); assert.deepEqual(h.earcons, []);
    assert.equal(h.captions.some(caption => caption.tone === 'danger'), false);
  }
});

test('requested surroundings mode still narrates ordinary person movement without a danger tone', async () => {
  const h = harness({ realPersonRules: true }); h.world.push(person(150, { motion: { dir: 'toward', fast: true } }));
  h.live(); await h.settle();
  assert.match(h.synth.current.text, /person.*coming closer/);
  assert.equal(h.captions.at(-1).agent, 'vision'); assert.equal(h.captions.at(-1).tone, null);
  assert.deepEqual(h.earcons, []); assert.equal(h.banners.some(Boolean), false);
});

test('person approach updates need sustained frames and monitoring, and wait for a spoken answer', async () => {
  for (const mode of ['ask', 'road']) {
    const h = harness({ mode, realPersonRules: true });
    assert.equal(h.context.velocity.evaluate(640, 480, [person(170)]), null); h.advance(280);
    assert.equal(h.context.velocity.evaluate(640, 480, [person(220)]), null, 'two boxes alone do not establish a sustained approach'); h.advance(280);
    const alert = h.context.velocity.evaluate(640, 480, [person(300)]);
    if (mode === 'ask') { assert.equal(alert, null); assert.equal(h.experience.acceptHazard('body_collision'), null); continue; }
    assert.equal(alert?.type, 'body_collision'); assert.match(alert.en, /appears to be getting closer/);
    assert.doesNotMatch(alert.en, /attack|intention|will collide|rapidly/i);
    h.speak('Your requested answer is still being spoken.', ''); await h.settle();
    h.engine.emergencyAlert(alert.en, alert.bn, alert.type);
    assert.deepEqual(h.cancelled, []); assert.equal(h.banners.some(Boolean), false);
    h.synth.finish(); await h.settle(); h.advance(5000);
    h.engine.emergencyAlert(alert.en, alert.bn, alert.type); await h.settle();
    assert.equal(h.synth.current.text, alert.en); assert.equal(h.engine.criticalUntil, 0);
  }
});

test('person evidence excludes pictures, weak detections and source changes while monitored stairs and vehicles remain hazards', () => {
  for (const extra of [{ flags: { onScreen: true } }, { flags: { toy: true } }, { flags: { picture: true } }, { score: 0.4 }]) {
    const h = harness({ realPersonRules: true });
    for (const size of [170, 220, 300, 380]) { assert.equal(h.context.velocity.evaluate(640, 480, [person(size, extra)]), null); h.advance(280); }
  }
  const h = harness({ realPersonRules: true });
  h.context.velocity.evaluate(640, 480, [person(170)]); h.advance(280);
  h.context.velocity.evaluate(640, 480, [person(220)]); h.advance(280); h.context.state.sourceEpoch++;
  assert.equal(h.context.velocity.evaluate(640, 480, [person(300)]), null, 'a different source starts new motion evidence');
  const vehicle = person(330, { id: 'car' });
  assert.equal(h.context.isHazard(vehicle), true); assert.equal(h.context.isHazard({ id: 'stairs', score: 0.8 }), true);
  const alert = h.context.velocity.evaluate(640, 480, [vehicle]); assert.equal(alert?.type, 'vehicle_collision');
  h.engine.emergencyAlert(alert.en, alert.bn, alert.type);
  assert(h.earcons.includes('emergency')); assert(h.banners.includes(true));
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

// Obstacle warnings need current, repeated evidence; an object class alone is not enough.
const obstacle = (id, extra = {}) => ({ id, src: 'coco', score: 0.9, pos: 'ahead', prox: 'very_close', bbox: [200, 120, 240, 300], ...extra });

test('stationary furniture: a far chair is an observation, a chair seen twice very close is a cautious obstacle notice', async () => {
  const h = harness({ realPersonRules: true }), now = 500000;
  h.world.push(obstacle('chair', { prox: 'far', first: now - 2000, last: now }));
  h.live(); await h.settle();
  assert.equal(h.captions.some(caption => caption.tone === 'danger'), false); assert.deepEqual(h.earcons, []);
  assert.match(h.synth.current.text, /^new_object:/, 'it is still described as an ordinary observation');
  h.synth.finish(); await h.settle();
  h.world.length = 0; h.world.push(obstacle('chair', { first: now - 600, last: now }));
  h.live(); await h.settle();
  assert.equal(h.synth.current.text, 'hazard_msg:chair,pos_ahead,prox_very_close');
  assert.deepEqual(h.earcons, ['hazard'], 'an ordinary obstacle, not an emergency'); assert.equal(h.engine.criticalUntil, 0);
});

test('noisy detections: one frame of a nearby-looking box, a doubtful box or a weak open-vocabulary match does not warn', async () => {
  const h = harness({ realPersonRules: true }), now = 500000;
  h.context.state.narrate = false;   // only the warning path is under test here
  const chair = obstacle('chair', { first: now, last: now });
  h.world.push(chair, obstacle('bench', { first: now - 900, last: now, flags: { doubtful: true } }),
    { id: 'box', src: 'clip', score: 0.39, pos: 'ahead', first: now - 900, last: now });
  h.live(); await h.settle();
  assert.equal(h.synth.spoken.length, 0); assert.deepEqual(h.earcons, []);
  h.advance(300); chair.last = now + 300;   // the next frame shows it again
  h.live(); await h.settle();
  assert.equal(h.synth.current.text, 'hazard_msg:chair,pos_ahead,prox_very_close', 'a repeated sighting is not suppressed');
});

test('stale evidence: an obstacle not seen for 1.5 s is not announced and its banner is cleared', async () => {
  const h = harness({ realPersonRules: true }), now = 500000;
  h.context.state.narrate = false;
  h.world.push(obstacle('chair', { first: now - 3000, last: now - 2000 }));
  h.live(); await h.settle();
  assert.equal(h.synth.spoken.length, 0); assert.deepEqual(h.earcons, []);
  assert.equal(h.banners.at(-1), false, 'no warning banner for something that is no longer in view');
});

test('without a distance sensor, stairs still warn at once and image-estimated obstacles still warn after a second sighting', async () => {
  const h = harness({ realPersonRules: true }), now = 500000;
  h.world.push({ id: 'stairs', score: 0.8, pos: 'ahead', first: now, last: now });
  h.live(); await h.settle();
  assert.equal(h.synth.current.text, 'Warning! Stairs directly ahead!', 'a single sighting of stairs is never delayed');
  h.synth.finish(); await h.settle(); h.world.length = 0; h.advance(7000);
  const estimated = obstacle('chair', { near01: 0.85, distM: null, distMeasured: false, first: now + 6500, last: now + 7000 });
  h.world.push(estimated);
  h.live(); await h.settle();
  assert.equal(h.synth.current.text, 'hazard_msg:chair,pos_ahead,prox_very_close');
  assert.doesNotMatch(h.synth.current.text, /measured|cm|metre/i, 'an image estimate is never presented as a measurement');
});
