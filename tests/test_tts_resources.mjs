import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { MsEdgeTTS } from '../server/node_modules/msedge-tts/dist/index.js';
import { synthesize } from '../server/tts.js';

function fakeProvider(t, { metadata = async () => {}, stream = () => Readable.from([Buffer.from('mp3')]) } = {}) {
  const calls = { inputs: [], closed: 0, metadata: 0, streams: [] };
  t.mock.method(MsEdgeTTS.prototype, 'setMetadata', async function (...args) {
    calls.metadata++;
    return metadata(...args);
  });
  t.mock.method(MsEdgeTTS.prototype, 'toStream', input => {
    calls.inputs.push(input);
    const audioStream = stream();
    calls.streams.push(audioStream);
    return { audioStream, metadataStream: null };
  });
  t.mock.method(MsEdgeTTS.prototype, 'close', () => { calls.closed++; });
  return calls;
}

test('speech escapes SSML input, closes resources and does not cache private text/audio', async t => {
  const calls = fakeProvider(t);
  const privateText = 'ওষুধ & <voice name="other"> hello \'world\'';
  for (let i = 0; i < 2; i++) assert.equal((await synthesize(privateText, 'bn-female')).toString(), 'mp3');
  assert.deepEqual(calls.inputs, Array(2).fill('ওষুধ &amp; &lt;voice name=&quot;other&quot;&gt; hello &apos;world&apos;'));
  assert.equal(calls.metadata, 2);
  assert.equal(calls.closed, 2);
  assert.ok(calls.streams.every(stream => stream.destroyed));
});

test('speech rejects malformed text and already-cancelled requests before provider initialization', async t => {
  const calls = fakeProvider(t);
  for (const text of ['', ' ', {}, 'x'.repeat(901)]) await assert.rejects(synthesize(text), /Invalid speech text/);
  const controller = new AbortController();
  controller.abort(new Error('Caller stopped'));
  await assert.rejects(synthesize('hello', 'en-female', { signal: controller.signal }), /Caller stopped/);
  assert.equal(calls.metadata, 0);
});

test('hung metadata has a deadline; late completion never starts synthesis', async t => {
  let finishMetadata;
  const calls = fakeProvider(t, { metadata: () => new Promise(resolve => { finishMetadata = resolve; }) });
  await assert.rejects(synthesize('hello', 'en-female', { timeoutMs: 20 }), /deadline/);
  assert.ok(calls.closed >= 1);
  finishMetadata();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls.inputs, []);
  assert.ok(calls.closed >= 2);
});

test('caller cancellation destroys a hung audio stream and closes its provider', async t => {
  const calls = fakeProvider(t, { stream: () => new Readable({ read() {} }) });
  const controller = new AbortController();
  const result = synthesize('hello', 'en-female', { signal: controller.signal });
  await new Promise(resolve => setImmediate(resolve));
  controller.abort(new Error('Connection gone'));
  await assert.rejects(result, /Connection gone/);
  assert.equal(calls.streams[0].destroyed, true);
  assert.ok(calls.closed >= 1);
});

test('hung audio reaches deadline and closes its resources', async t => {
  const calls = fakeProvider(t, { stream: () => new Readable({ read() {} }) });
  await assert.rejects(synthesize('hello', 'en-female', { timeoutMs: 20 }), /deadline/);
  assert.equal(calls.streams[0].destroyed, true);
  assert.ok(calls.closed >= 1);
});

test('empty, oversized and broken provider audio fail instead of returning successful speech', async t => {
  let kind = 'empty';
  const calls = fakeProvider(t, { stream: () => {
    if (kind === 'empty') return Readable.from([]);
    if (kind === 'oversized') return Readable.from([Buffer.alloc(2 * 1024 * 1024 + 1)]);
    return Readable.from((async function* () { yield Buffer.from('partial'); throw new Error('Provider broke'); })());
  } });
  await assert.rejects(synthesize('hello'), /empty/);
  kind = 'oversized';
  await assert.rejects(synthesize('hello'), /too large/);
  kind = 'broken';
  await assert.rejects(synthesize('hello'), /Provider broke/);
  assert.ok(calls.streams.every(stream => stream.destroyed));
  assert.equal(calls.closed, 3);
});
