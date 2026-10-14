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
    extractTargetItemFromQuery: () => null, heartPointAt() {}, ...extra,
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
  const measured = { distM: 1.64, distMeasured: true }, estimated = { distM: 1.64 };
  assert.equal(api.distPhrase(measured, false), 'measured at 1.6 metres');
  assert.equal(api.distMetresText({ distM: 0.4, distMeasured: true }, false), 'measured at 40 centimetres');
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
