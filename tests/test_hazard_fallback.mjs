import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../tools/module.js', import.meta.url), 'utf8');
const start = source.indexOf('const EdgeAndStairsDetector =');
const end = source.indexOf('async function deleteCalibratedRoom(', start);
assert(start >= 0 && end > start, 'Expected existing local hazard detector source');
const detectorSource = source.slice(start, end);
const frame = { width: 640, height: 480 };

function harness({ ranked = [{ id: 'stairs', p: 0.7 }], geometry = true, cloudReady = true, clipStatus = 'ready', objects = [] } = {}) {
  const calls = { cloud: 0, embedding: 0, geometry: 0, fetch: 0 };
  let now = 100000;
  const context = vm.createContext({
    Date: class extends Date { static now() { return now; } },
    console: { warn() {} },
    state: { lastCocoPreds: objects }, engine: { clip: { status: clipStatus } },
    cloudReady: () => { calls.cloud++; return typeof cloudReady === 'function' ? cloudReady() : cloudReady; },
    fetch: () => { calls.fetch++; throw new Error('Live provider calls are forbidden in this test'); },
    clipEmbedCrops: async () => { calls.embedding++; return [[0.2, 0.8]]; },
    scoreEmbedding: () => ranked,
  });
  vm.runInContext(detectorSource + '\nglobalThis.detector = EdgeAndStairsDetector;', context);
  context.detector.scanStairGeometry = () => { calls.geometry++; return { hasPeriodicSteps: geometry, peaks: geometry ? 4 : 0 }; };
  return { detector: context.detector, calls, setTime: value => { now = value; } };
}

test('configured cloud credentials cannot suppress model-and-geometry local stairs evidence', async () => {
  const s = harness();
  const hazard = await s.detector.evaluate(frame, []);
  assert.equal(hazard?.type, 'stairs');
  assert.match(hazard.en, /possible stairs/);
  assert.match(hazard.en, /mobility aid/);
  assert.match(hazard.bn, /থাকতে পারে/);
  assert.equal(s.calls.embedding, 1);
  assert.equal(s.calls.geometry, 1);
  assert.equal(s.calls.cloud, 0);
  assert.equal(s.calls.fetch, 0);
});

test('local drop-off warnings survive unavailable, configured or failing cloud health', async () => {
  for (const cloudReady of [false, true, () => { throw new Error('health timed out'); }]) {
    const s = harness({ cloudReady, ranked: [{ id: 'drop_off', p: 0.7 }] });
    const hazard = await s.detector.evaluate(frame, []);
    assert.equal(hazard?.type, 'drop_off');
    assert.match(hazard.en, /possible drop-off/);
    assert.doesNotMatch(hazard.en, /safe|clear path|high stage/);
    assert.equal(s.calls.cloud, 0);
    assert.equal(s.calls.fetch, 0);
  }
});

test('stairs still need both local classification and periodic step geometry', async () => {
  for (const config of [
    { ranked: [{ id: 'stairs', p: 0.3 }] },
    { ranked: [{ id: 'stairs', p: 0.7 }], geometry: false },
    { ranked: [{ id: 'book', p: 0.8 }] },
  ]) {
    const s = harness(config);
    assert.equal(await s.detector.evaluate(frame, []), null);
  }
});

test('existing desk context and desk crop false-positive guards are preserved', async () => {
  const seenDesk = harness({ objects: [{ id: 'keyboard', score: 0.9 }] });
  assert.equal(await seenDesk.detector.evaluate(frame, []), null);
  assert.equal(seenDesk.calls.embedding, 0);
  const deskCrop = harness({ ranked: [{ id: 'keyboard', p: 0.8 }, { id: 'stairs', p: 0.6 }] });
  assert.equal(await deskCrop.detector.evaluate(frame, []), null);
  assert.equal(deskCrop.calls.geometry, 0);
});

test('missing frame or unavailable local model does not fabricate hazard evidence', async () => {
  const s = harness({ clipStatus: 'error' });
  assert.equal(await s.detector.evaluate(null, []), null);
  assert.equal(await s.detector.evaluate(frame, []), null);
  assert.equal(s.calls.embedding, 0);
  assert.equal(s.calls.fetch, 0);
});

test('existing warning cooldown remains active after cloud-independent detection', async () => {
  const s = harness();
  assert.equal((await s.detector.evaluate(frame, []))?.type, 'stairs');
  s.setTime(101000);
  assert.equal(await s.detector.evaluate(frame, []), null);
  s.setTime(107000);
  assert.equal((await s.detector.evaluate(frame, []))?.type, 'stairs');
});
