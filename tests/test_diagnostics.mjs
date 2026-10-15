import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../tools/diagnostics.js', import.meta.url), 'utf8');
function harness() {
  let milliseconds = 100;
  const context = vm.createContext({ performance: { now: () => milliseconds } });
  vm.runInContext(source + '\nglobalThis.diagnostics = AsthaDiagnostics;', context);
  return { diagnostics: context.diagnostics, at: value => { milliseconds = value; } };
}
const plain = value => JSON.parse(JSON.stringify(value));

test('timing is disabled by default and disabling clears all local records', () => {
  const { diagnostics: d, at } = harness();
  assert.equal(d.snapshot().enabled, false); assert.equal(d.start('perception'), null);
  assert.equal(d.setEnabled('true'), false);
  d.setEnabled(true); const token = d.start('perception'); at(115); d.finish(token);
  assert.equal(d.snapshot().stages.perception.durationMs, 15);
  d.setEnabled(false);
  assert(Object.values(d.snapshot().stages).every(value => value === null));
  d.setEnabled(true); assert.equal(d.finish(token), false, 're-enabling cannot revive old work');
});

test('actual helper measures monotonic success, error and cancellation without error content', () => {
  const { diagnostics: d, at } = harness(); d.setEnabled(true);
  for (const [index, status] of ['success', 'error', 'cancel'].entries()) {
    at(100 + index * 20); const token = d.start('reasoning', { request: index });
    at(109 + index * 20); assert.equal(d.finish(token, status), true);
    assert.deepEqual(plain(d.snapshot().stages.reasoning), { status, durationMs: 9, request: index, sourceEpoch: 0 });
    assert.equal(d.finish(token, status), false, 'a completion is consumed exactly once');
  }
});

test('older overlapping completion cannot overwrite the latest measurement', () => {
  const { diagnostics: d, at } = harness(); d.setEnabled(true);
  const older = d.start('perception', { request: 1 });
  at(110); const newer = d.start('perception', { request: 2 });
  at(140); assert.equal(d.finish(older, 'error'), false);
  assert.equal(d.snapshot().stages.perception.status, 'running');
  assert.equal(d.finish(newer), true);
  assert.equal(d.snapshot().stages.perception.durationMs, 30);
  assert.equal(d.start('perception', { request: 1 }), null, 'an older task must not replace newer task state');
});

test('source changes and reset invalidate pending work without changing opt-in', () => {
  const { diagnostics: d } = harness(); d.setEnabled(true);
  const previous = d.start('reasoning', { sourceEpoch: 0, request: 20 });
  assert.equal(d.setSourceEpoch(1), true); assert.equal(d.finish(previous), false);
  assert.equal(d.start('reasoning', { sourceEpoch: 0 }), null);
  const current = d.start('reasoning', { sourceEpoch: 1, request: 1 });
  assert(current, 'a new source may have a fresh request generation');
  d.reset(); assert.equal(d.finish(current), false); assert.equal(d.snapshot().enabled, true);
  assert.equal(d.snapshot().sourceEpoch, 1);
});

test('an untagged measurement cannot erase the latest numeric task generation', () => {
  const { diagnostics: d } = harness(); d.setEnabled(true);
  const tagged = d.start('reasoning', { request: 2 });
  const untagged = d.start('reasoning');
  assert.equal(d.start('reasoning', { request: 1 }), null);
  assert.equal(d.finish(tagged), false); assert.equal(d.finish(untagged), true);
  d.reset(); assert(d.start('reasoning', { request: 1 }), 'reset clears the task-generation watermark');
});

test('capture-to-first-audio is independent of speech setup and completion', () => {
  const { diagnostics: d, at } = harness(); d.setEnabled(true);
  const capture = d.start('capture_to_audio', { request: 3 });
  at(140); const synthesis = d.start('speech', { request: 3 });
  at(215); d.finish(synthesis); d.finish(capture);
  assert.equal(d.snapshot().stages.speech.durationMs, 75);
  assert.equal(d.snapshot().stages.capture_to_audio.durationMs, 115);
  at(999); assert.equal(d.finish(capture), false, 'playback completion cannot change first-audio timing');
});

test('only fixed stages, numeric identifiers and finite durations enter snapshots', () => {
  const { diagnostics: d, at } = harness(); d.setEnabled(true);
  const secret = 'synthetic-private-prompt-and-key';
  for (const options of [null, [], { request: secret }, { sourceEpoch: secret }, { prompt: secret },
    { request: NaN }, { request: Infinity }, { request: -1 }, { request: 1.5 }, { sourceEpoch: -1 }]) {
    assert.equal(d.start('reasoning', options), null);
  }
  assert.equal(d.start(secret), null); assert.equal(d.setSourceEpoch(secret), false);
  assert.equal(d.finish({}, secret), false);
  at(NaN); assert.equal(d.start('reasoning'), null);
  at(200); const token = d.start('reasoning'); at(Infinity); assert.equal(d.finish(token), false);
  at(205); assert.equal(d.finish(token, 'error'), true);
  assert(!JSON.stringify(d.snapshot()).includes(secret));
  assert.equal(d.snapshot().stages.reasoning.durationMs, 5);
});

test('clock regression never creates a negative measurement or changes clock origin', () => {
  const { diagnostics: d, at } = harness(); d.setEnabled(true);
  const token = d.start('perception'); at(90); d.finish(token);
  assert.equal(d.snapshot().stages.perception.durationMs, 0);
  const next = d.start('perception'); at(112); d.finish(next);
  assert.equal(d.snapshot().stages.perception.durationMs, 12);
});

test('records remain bounded after thousands of overlapping starts', () => {
  const { diagnostics: d } = harness(); d.setEnabled(true);
  let first, last;
  for (let request = 0; request < 5000; request++) {
    last = d.start('reasoning', { request }); first ||= last;
  }
  assert.equal(d.finish(first), false); assert.equal(d.finish(last), true);
  assert.equal(Object.keys(d.snapshot().stages).length, 4);
  assert.equal(Object.values(d.snapshot().stages).filter(Boolean).length, 1);
  assert(JSON.stringify(d.snapshot()).length < 500);
});

test('subscribers receive defensive snapshots, unsubscribe and cannot break assistance', () => {
  const { diagnostics: d } = harness(); const changes = [];
  const unsubscribe = d.subscribe(value => changes.push(value));
  d.subscribe(() => { throw new Error('synthetic UI failure'); });
  d.setEnabled(true); const token = d.start('speech'); d.finish(token, 'cancel');
  assert.equal(changes.length, 4);
  assert.equal(changes[0].enabled, false); assert.equal(changes[2].stages.speech.status, 'running');
  assert.throws(() => { changes[3].stages.speech.status = 'success'; }, TypeError);
  assert.equal(d.snapshot().stages.speech.status, 'cancel');
  unsubscribe(); d.reset(); assert.equal(changes.length, 4);
});

test('debug subscriptions are bounded and require no DOM, storage, network or wall clock', () => {
  const { diagnostics: d } = harness(); const counts = [];
  for (let index = 0; index < 20; index++) { counts[index] = 0; d.subscribe(() => { counts[index]++; }); }
  d.setEnabled(true);
  assert(counts.slice(0, 16).every(count => count === 2));
  assert(counts.slice(16).every(count => count === 0));
  const token = d.start('perception'); assert.equal(d.finish(token), true);
});
