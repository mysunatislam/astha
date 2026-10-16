// The Pi's ultrasonic distance in perception: which object a measurement belongs to, and
// that a measured distance is always worded differently from an estimate. Real sensor and
// camera alignment on a wearer is not exercised here.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const perceive = fs.readFileSync(new URL('../tools/perceive.js', import.meta.url), 'utf8');
const sensors = fs.readFileSync(new URL('../tools/sensors.js', import.meta.url), 'utf8');
const FRAME = { width: 640, height: 480 };

function load(extra = {}) {
  const spoken = [];
  const context = vm.createContext({
    engine: { clip: {} }, state: { source: 'pi', scene: null, world: new Map() }, Date, Math, Number, String, Set, Map, Array, Object, JSON,
    t: key => ({ pos_ahead: 'ahead', pos_left: 'to your left' })[key] || key, tBn: key => ({ pos_ahead: 'সামনে' })[key] || key,
    label: id => id, labelBn: id => ({ chair: 'চেয়ার' })[id] || id,
    announce: (en, bn) => spoken.push([en, bn]), withCamera: () => false, worldSorted: () => [], findVocabMatch: () => null,
    extractTargetItemFromQuery: () => null, heartPointAt() {}, VOCAB_BY_ID: {}, withArticle: text => text, article: text => 'a ' + text, ...extra,
  });
  vm.runInContext(sensors + '\n' + perceive + '\nglobalThis.api = { applyMeasuredDistance, annotateGeometry, distPhrase, distMetresText, measuredPhrase, answerHowFar, AsthaSensors };', context);
  return { api: context.api, context, spoken };
}
// A chair box: 40 % of the frame tall, centred, which the size prior puts at roughly 2 m.
const box = (cx, cy, w, h) => [FRAME.width * (cx - w / 2), FRAME.height * (cy - h / 2), FRAME.width * w, FRAME.height * h];
const object = (id, bbox) => ({ id, bbox, score: 0.9 });
const plain = value => JSON.parse(JSON.stringify(value));

test('a measurement is given to the object in the beam whose own estimate agrees with it', () => {
  const { api } = load();
  const chair = object('chair', box(0.5, 0.55, 0.3, 0.4)), side = object('chair', box(0.12, 0.5, 0.2, 0.4));
  for (const o of [chair, side]) api.annotateGeometry(o, FRAME, null);
  const estimate = chair.distM;
  assert.ok(estimate > 0.9 && estimate < 4, 'the size prior gives a rough distance first: ' + estimate);
  const ahead = api.applyMeasuredDistance([side, chair], FRAME, { metres: 1.6, measured: true });
  assert.equal(ahead.object, chair); assert.equal(chair.distMeasured, true); assert.equal(chair.distM, 1.6);
  assert.equal(chair.prox, 'near'); assert.equal(side.distMeasured, false, 'an object outside the beam keeps its estimate');
});

test('an echo that disagrees with every estimate stays an unnamed thing straight ahead', () => {
  const { api } = load();
  const chair = object('chair', box(0.5, 0.55, 0.3, 0.4));
  api.annotateGeometry(chair, FRAME, null);
  const tooNear = api.applyMeasuredDistance([chair], FRAME, { metres: chair.distM / 3, measured: true });
  assert.equal(tooNear.object, null); assert.equal(chair.distMeasured, false);
  assert.equal(api.applyMeasuredDistance([chair], FRAME, null), null, 'no reading, nothing changes');
  assert.equal(api.applyMeasuredDistance([chair], FRAME, { metres: 1, measured: false }), null, 'an estimate is not a measurement');
  // Something on a screen or in a picture cannot be what the sound bounced off.
  const tv = object('chair', box(0.5, 0.5, 0.3, 0.4)); api.annotateGeometry(tv, FRAME, null); tv.flags.onScreen = true;
  assert.equal(api.applyMeasuredDistance([tv], FRAME, { metres: tv.distM, measured: true }).object, null);
});

test('without its own estimate only the object across the very centre can take the measurement', () => {
  const { api } = load();
  const centred = object('unknown thing', box(0.5, 0.5, 0.2, 0.2)), offCentre = object('unknown thing', box(0.58, 0.4, 0.1, 0.1));
  for (const o of [centred, offCentre]) api.annotateGeometry(o, FRAME, null);
  assert.equal(centred.distM, null);
  assert.equal(api.applyMeasuredDistance([offCentre, centred], FRAME, { metres: 0.7, measured: true }).object, centred);
  assert.equal(offCentre.distMeasured, false);
});

test('measured distances are said as measured numbers; estimates stay "about"', () => {
  const { api } = load();
  assert.equal(api.measuredPhrase(0.852, false), 'measured at 85 centimetres');
  assert.equal(api.measuredPhrase(1.64, false), 'measured at 1.6 metres');
  assert.equal(api.measuredPhrase(0.852, true), 'সেন্সরে মাপা ৮৫ সেন্টিমিটার দূরে');
  assert.equal(api.measuredPhrase(1.64, true), 'সেন্সরে মাপা ১.৬ মিটার দূরে');
  api.AsthaSensors.report('front', 1.64, 'ultrasonic');
  const measured = { distM: 1.64, distMeasured: true, distMeasuredAt: api.AsthaSensors.measured().at, distMeasuredEpoch: 0 }, estimated = { distM: 1.64 };
  assert.equal(api.distPhrase(measured, false), 'measured at 1.6 metres');
  api.AsthaSensors.report('front', 0.4, 'ultrasonic');
  assert.equal(api.distMetresText({ distM: 0.4, distMeasured: true, distMeasuredAt: api.AsthaSensors.measured().at, distMeasuredEpoch: 0 }, false), 'measured at 40 centimetres');
  assert.match(api.distPhrase(estimated, false), /^about /);
  assert.doesNotMatch(api.distPhrase(estimated, false), /measured/);
  assert.doesNotMatch(api.distPhrase(estimated, true), /মাপা/);
});

test('re-detecting an object clears an old measured flag before the world model merges it', () => {
  const { api } = load();
  const chair = object('chair', box(0.5, 0.55, 0.3, 0.4));
  api.annotateGeometry(chair, FRAME, null);
  api.applyMeasuredDistance([chair], FRAME, { metres: chair.distM, measured: true });
  const later = object('chair', box(0.15, 0.55, 0.3, 0.4));
  api.annotateGeometry(later, FRAME, null);
  assert.equal(Object.hasOwn(later, 'distMeasured') && later.distMeasured, false, 'written explicitly, so a merge overwrites the old flag');
});

test('"how far" with the Pi sensor answers from the measurement, naming the object only from a fresh scene', () => {
  const { api, context, spoken } = load();
  api.AsthaSensors.report('front', 0.85, 'ultrasonic');
  api.answerHowFar('how far is it');
  assert.deepEqual(plain(spoken.at(-1)), ['Something straight ahead is measured at 85 centimetres.', 'সোজা সামনে কিছু একটা আছে, সেন্সরে মাপা ৮৫ সেন্টিমিটার দূরে।']);
  context.state.scene = { ahead: { metres: 0.85, object: { id: 'chair' } }, at: Date.now() };
  api.answerHowFar('how far is it');
  assert.equal(spoken.at(-1)[0], 'The chair straight ahead is measured at 85 centimetres.');
  context.state.scene.at = Date.now() - 5000;
  api.answerHowFar('how far is it');
  assert.match(spoken.at(-1)[0], /^Something straight ahead/, 'an old scene does not name what is there now');
  // The phone's own camera does not share the sensor's view, and a stale reading is no reading.
  context.state.source = 'camera';
  api.answerHowFar('how far is it');
  assert.match(spoken.at(-1)[0], /cannot judge a distance/);
  context.state.source = 'pi'; api.AsthaSensors.clear();
  api.answerHowFar('how far is it');
  assert.match(spoken.at(-1)[0], /cannot judge a distance/);
});

test('cached object distances cannot be spoken after invalid, expired, changed or disconnected sensor data', () => {
  for (const boundary of ['invalid', 'expired', 'changed', 'disconnected', 'source']) {
    let now = 10000;
    const { api, context, spoken } = load({ Date: class extends Date { static now() { return now; } } });
    const chair = object('chair', box(0.5, 0.55, 0.3, 0.4));
    context.worldSorted = () => [chair]; context.findVocabMatch = () => ({ id: 'chair', en: 'chair', bn: 'চেয়ার' });
    context.extractTargetItemFromQuery = () => 'chair';
    context.state.world.set('chair', chair);
    api.annotateGeometry(chair, FRAME, null); api.AsthaSensors.report('front', 1.6, 'ultrasonic');
    api.applyMeasuredDistance([chair], FRAME, api.AsthaSensors.measured());
    assert.equal(api.distPhrase(chair, false), 'measured at 1.6 metres');
    if (boundary === 'invalid') api.AsthaSensors.report('front', NaN, 'ultrasonic');
    if (boundary === 'expired') now += 1001;
    if (boundary === 'changed') api.AsthaSensors.report('front', 0.3, 'ultrasonic');
    if (boundary === 'disconnected') api.AsthaSensors.clear('front');
    if (boundary === 'source') context.state.source = 'camera';
    assert.equal(api.distPhrase(chair, false), '', boundary + ' must not reuse the cached number');
    assert.equal(api.distMetresText(chair, true), '');
    api.answerHowFar('how far is the chair');
    assert.doesNotMatch(spoken.at(-1)[0], /measured|1\.6|clear|safe/i);
    assert.doesNotMatch(spoken.at(-1)[1], /মাপা|১\.৬/);
  }
});

test('a future-dated sensor sample is not current, and clearing front preserves other sensor channels', () => {
  const { api } = load();
  api.AsthaSensors.report('front', 0.85, 'ultrasonic', 2000);
  assert.equal(api.AsthaSensors.measured('front', 1999), null);
  api.AsthaSensors.report('left', 1.2, 'other', 2000);
  api.AsthaSensors.clear('front');
  assert.equal(api.AsthaSensors.measured('front', 2000), null);
  assert.equal(api.AsthaSensors.measured('left', 2000).metres, 1.2);
});

test('the actual seeker rechecks a copied measured distance before announcing arrival', async () => {
  const offline = fs.readFileSync(new URL('../tools/offline.js', import.meta.url), 'utf8');
  const start = offline.indexOf('const SEEK_TEXT ='), end = offline.indexOf('// "Where is my X?"', start);
  assert(start >= 0 && end > start);
  for (const boundary of ['current', 'expired', 'invalid']) {
    let now = 10000, release;
    const calls = [], { api, context } = load({ Date: class extends Date { static now() { return now; } },
      captureFrame: () => FRAME, heartSet() {}, heartTicks() {}, playEarcon() {}, haptic() {} });
    vm.runInContext(offline.slice(start, end) + '\nglobalThis.seeker = Seeker;', context);
    const chair = object('chair', box(0.5, 0.5, 0.2, 0.2));
    api.AsthaSensors.report('front', 0.4, 'ultrasonic');
    api.applyMeasuredDistance([chair], FRAME, api.AsthaSensors.measured());
    const cand = { cx: 0.5, cy: 0.5, obj: chair, distM: chair.distM, distMeasured: true, near01: 0.9, areaFrac: 0.04 };
    const seeker = context.seeker;
    Object.assign(seeker, { active: true, target: { coco: true, en: 'chair' }, phase: 'found', lastSaidAt: 0,
      locate: () => new Promise(resolve => { release = resolve; }), say: key => calls.push(key), stop: () => { seeker.active = false; }, schedule() {} });
    const pending = seeker.tick();
    if (boundary === 'expired') now += 1001;
    if (boundary === 'invalid') api.AsthaSensors.report('front', NaN, 'ultrasonic');
    release(cand); await pending;
    assert.equal(calls.includes('stop_here'), boundary === 'current', boundary + ' arrival must use a current reading');
    if (boundary !== 'current') { assert.equal(cand.distM, null); assert.equal(cand.near01, null); assert.equal(seeker.active, true); }
  }
});

test('spatial scale anchors and path guidance reject cached measured geometry after expiry', () => {
  let now = 10000;
  const { api, context } = load({ Date: class extends Date { static now() { return now; } } });
  const spatial = fs.readFileSync(new URL('../tools/spatial.js', import.meta.url), 'utf8');
  vm.runInContext(spatial + '\nDepthEngine.nearnessInBox = () => 0.5; DepthEngine.nearnessInRegion = () => 0.5; globalThis.spatial = AsthaSpatial;', context);
  const chair = object('chair', box(0.5, 0.5, 0.3, 0.4));
  api.AsthaSensors.report('front', 0.4, 'ultrasonic');
  api.applyMeasuredDistance([chair], FRAME, api.AsthaSensors.measured());
  context.state.lastCocoPreds = [chair];
  assert.equal(context.spatial.anchorsFrom([chair], FRAME, {}, null).length, 1);
  assert.equal(context.pathObstacles().length, 1);
  now += 1001;
  assert.equal(context.spatial.anchorsFrom([chair], FRAME, {}, null).length, 0);
  assert.equal(context.pathObstacles().length, 0);
});
