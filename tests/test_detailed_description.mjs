import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
const source = fs.readFileSync(new URL('../tools/cloud.js', import.meta.url), 'utf8');
const promptSource = source.slice(source.indexOf('const CLOUD_PROMPTS ='), source.indexOf('// Existing callers'));
const describeSource = source.slice(source.indexOf('async function cloudDescribe('), source.indexOf('async function cloudIdentify('));
function harness({ fail = false } = {}) {
  const calls = [], context = vm.createContext({
    withBusy: async (title, run) => run(), t: x => x, tBn: x => x, captureFrame: () => ({ width: 640, height: 480 }),
    heartSet() {}, heartFlash() {}, announce() {}, playEarcon() {}, haptic() {}, logEvent() {},
    gemini: async (prompt, frame, options) => { calls.push({ prompt, options }); if (fail) throw new Error('synthetic'); return { en: 'A desk.', bn: 'টেবিল।', objects: [] }; },
    AsthaVisionDetails: { describeResult: (frame, words, provider) => calls.push({ words, provider }) },
    cloudFail: () => false, scheduleCloudFallback: run => run(), describeScene: (...args) => calls.push({ fallback: args }),
  });
  vm.runInContext(promptSource + describeSource, context);
  return { calls, run: code => vm.runInContext(code, context) };
}
test('explicit detail requests use longer prompt and return actual result to the description card; ordinary describe stays short', async () => {
  const h = harness(); await h.run('cloudDescribe()');
  assert.match(h.calls[0].prompt, /at most two short sentences/); assert.equal(h.calls[0].options.maxTokens, undefined);
  assert.equal(h.calls[1].words.en, 'A desk.'); assert.equal(h.calls[1].provider, 'online');
  await h.run('cloudDescribe(true)');
  assert.match(h.calls[2].prompt, /four to six concise sentences/); assert.equal(h.calls[2].options.maxTokens, 1500);
  assert.equal(h.calls[3].words.bn, 'টেবিল।');
});
test('a failed online detailed request preserves the explicit detail choice on existing local fallback', async () => {
  const h = harness({ fail: true }); await h.run('cloudDescribe(true)');
  assert.deepEqual(Array.from(h.calls[1].fallback), [true, true]);
  assert.equal(h.calls.some(c => c.words), false, 'failed requests publish no invented description');
});
