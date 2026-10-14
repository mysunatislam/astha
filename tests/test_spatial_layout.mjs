// Spatial layout from one picture: fitting the depth model to known distances, the three
// directions, and what is said. The depth maps here are synthetic; real accuracy on a
// wearer is unmeasured.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const read = file => fs.readFileSync(new URL('../' + file, import.meta.url), 'utf8');
const FRAME = { width: 640, height: 480 };
const plain = value => JSON.parse(JSON.stringify(value));

function load() {
  const context = vm.createContext({
    engine: { clip: {} }, state: { source: 'pi' }, Date, Math, Number, String, Set, Map, Array, Object, JSON, Infinity,
    t: key => key, tBn: key => key, label: id => id, labelBn: id => ({ chair: 'চেয়ার', person: 'মানুষ' })[id] || id,
    VOCAB_BY_ID: {}, brandMeta: () => null, article: noun => /^[aeiou]/.test(noun) ? 'an' : 'a', withArticle: (noun, pl) => pl ? noun : (/^[aeiou]/.test(noun) ? 'an ' : 'a ') + noun,
  });
  vm.runInContext(read('tools/sensors.js') + '\n' + read('tools/perceive.js') + '\n' + read('tools/spatial.js') +
    '\nglobalThis.api = { AsthaSpatial, measuredPhrase };', context);
  return context.api;
}
// The depth model's output behaves like k / metres + c.
const nearFor = metres => 0.8 / metres + 0.05;
// A synthetic map: each third of the picture at its own distance.
function map(left, ahead, right, w = 60, h = 40) {
  const near = new Float32Array(w * h);
  for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) {
    const x = c / w, d = x < 0.35 ? left : x < 0.65 ? ahead : right;
    near[r * w + c] = Math.min(1, nearFor(d));
  }
  return { near, w, h, fw: FRAME.width, fh: FRAME.height, at: Date.now() };
}
const thing = (id, cx, distM, extra = {}) => ({ id, score: 0.9, distM, flags: {}, bbox: [FRAME.width * (cx - 0.08), FRAME.height * 0.35, FRAME.width * 0.16, FRAME.height * 0.3], ...extra });

test('two or more known distances fix the depth scale; one, or ones that disagree, do not', () => {
  const { AsthaSpatial } = load();
  const fit = AsthaSpatial.fitScale([1, 2, 3].map(m => ({ near: nearFor(m), metres: m, weight: 1 })));
  assert.ok(Math.abs(fit.k - 0.8) < 1e-6 && Math.abs(fit.c - 0.05) < 1e-6);
  assert.ok(Math.abs(AsthaSpatial.metresAt(fit, nearFor(2.5)) - 2.5) < 1e-6);
  assert.equal(AsthaSpatial.metresAt(fit, 0.04), Infinity, 'beyond the fitted range is "far", not a number');
  assert.equal(AsthaSpatial.fitScale([{ near: nearFor(1), metres: 1, weight: 4, measured: true }]), null, 'one distance gives no scale');
  assert.equal(AsthaSpatial.fitScale([{ near: 0.5, metres: 2, weight: 1 }, { near: 0.52, metres: 2.1, weight: 1 }]), null, 'two at the same distance give no scale');
  assert.equal(AsthaSpatial.fitScale([{ near: 0.3, metres: 1, weight: 1 }, { near: 0.8, metres: 3, weight: 1 }]), null, 'nearer must look nearer');
  // A size guess that is badly wrong spoils the fit instead of skewing every distance.
  const spoiled = [{ near: nearFor(1), metres: 1, weight: 4, measured: true }, { near: nearFor(2), metres: 2, weight: 1 }, { near: nearFor(3), metres: 0.4, weight: 1 }];
  assert.equal(AsthaSpatial.fitScale(spoiled), null);
  // Saturated or impossible values are not used.
  assert.equal(AsthaSpatial.fitScale([{ near: 1, metres: 0.5, weight: 1 }, { near: nearFor(2), metres: 2, weight: 1 }]), null);
  assert.equal(AsthaSpatial.fitScale([{ near: nearFor(2), metres: 2, weight: 1 }, { near: nearFor(3), metres: 3, weight: 1 }]).measured, false);
});

test('the layout gives each direction a distance, with the measured one taken as measured', () => {
  const { AsthaSpatial } = load();
  const depth = map(1, 2, 6);
  const objs = [thing('chair', 0.15, 1), thing('person', 0.5, 2)];
  const result = AsthaSpatial.layout(objs, FRAME, depth, null);
  assert.equal(result.scaled, true); assert.equal(result.anchors, 2);
  const byKey = Object.fromEntries(result.sectors.map(s => [s.key, s]));
  assert.ok(Math.abs(byKey.left.metres - 1) < 0.05 && Math.abs(byKey.ahead.metres - 2) < 0.05 && Math.abs(byKey.right.metres - 6) < 0.1);
  assert.equal(byKey.left.object.id, 'chair'); assert.equal(byKey.ahead.measured, false);
  const measured = AsthaSpatial.layout(objs, FRAME, depth, { metres: 1.9, measured: true });
  const ahead = measured.sectors.find(s => s.key === 'ahead');
  assert.equal(ahead.measured, true); assert.equal(ahead.metres, 1.9);
  // An unclaimed sensor reading anchors the middle of the picture on its own.
  const withReading = AsthaSpatial.layout([thing('chair', 0.15, 1)], FRAME, depth, { metres: 2, measured: true });
  assert.equal(withReading.scaled, true);
  assert.ok(Math.abs(withReading.sectors.find(s => s.key === 'right').metres - 6) < 0.2);
  // Things on a screen or in a picture are not distances in the room.
  const onScreen = AsthaSpatial.layout([thing('chair', 0.15, 1), thing('person', 0.5, 2, { flags: { onScreen: true } })], FRAME, depth, null);
  assert.equal(onScreen.scaled, false);
  assert.equal(AsthaSpatial.layout(objs, FRAME, null, null), null, 'no depth map, no layout');
});

test('what is said: measured is measured, estimates are "about", far is "nothing seen", and never "clear" or "safe"', () => {
  const { AsthaSpatial } = load();
  const depth = map(1, 2, 6);
  const words = AsthaSpatial.sentences(AsthaSpatial.layout([thing('chair', 0.15, 1), thing('person', 0.5, 2)], FRAME, depth, { metres: 1.9, measured: true }));
  assert.match(words.en, /^To your left: something about 1 metre away, a chair\. Straight ahead: measured at 1\.9 metres, a person\. To your right: nothing seen within 4 metres\./);
  assert.match(words.en, /estimates from the picture, except the measured one\. Use your cane to confirm\.$/);
  assert.match(words.bn, /বাঁয়ে: প্রায় ১ মিটার দূরে কিছু আছে, চেয়ার।/);
  assert.match(words.bn, /সোজা সামনে: সেন্সরে মাপা ১\.৯ মিটার দূরে, মানুষ।/);
  assert.match(words.bn, /লাঠি দিয়ে নিশ্চিত হয়ে নিন।$/);
  for (const text of [words.en]) assert.doesNotMatch(text, /\b(clear|safe|free|open)\b/i);
  // Half-metre steps for estimates: no false precision.
  const odd = AsthaSpatial.sentences(AsthaSpatial.layout([thing('chair', 0.15, 1.3), thing('person', 0.5, 2.6)], FRAME, map(1.3, 2.6, 3.2), null));
  assert.match(odd.en, /about 1\.5 metres/); assert.match(odd.en, /about 2\.5 metres/); assert.match(odd.en, /about 3 metres/);
  assert.doesNotMatch(odd.en, /measured/);
});

test('without a scale only the nearer side is said, never a number from the picture', () => {
  const { AsthaSpatial } = load();
  const words = AsthaSpatial.sentences(AsthaSpatial.layout([thing('chair', 0.15, 1)], FRAME, map(1, 3, 5), null));
  assert.match(words.en, /^From the picture alone, the nearest things are to your left; I cannot judge the other distances in metres\. Use your cane to confirm\.$/);
  assert.doesNotMatch(words.en, /metre away|metres away|about \d/);
  const sensorOnly = AsthaSpatial.sentences(AsthaSpatial.layout([], FRAME, map(2, 2, 2), { metres: 0.85, measured: true }));
  assert.match(sensorOnly.en, /^Straight ahead: measured at 85 centimetres\./);
});

test('spatial questions reach the layout in both languages without taking over other commands', () => {
  const source = read('tools/offline.js');
  const literal = source.match(/if \((\/\\b\(which way[^\n]*?\/)\.test\(q\)\) \{ answerSpatial\(\)/);
  assert.ok(literal, 'the spatial route exists');
  const routes = [...source.matchAll(/answerSpatial\(\)/g)].length;
  assert.equal(routes, 2, 'it answers in online and offline modes');
  const pattern = vm.runInNewContext(literal[1]);
  for (const yes of ["what's on each side", 'which way should i go', 'where can i walk', 'how far are things on both sides', 'আমার দুই পাশে কী আছে', 'কোন দিকে ফাঁকা'])
    assert.ok(pattern.test(yes), yes);
  for (const no of ['which way is the door', "what's the layout of my room", 'map the room', 'describe my surroundings', 'how far is the chair'])
    assert.ok(!pattern.test(no), no);
});
