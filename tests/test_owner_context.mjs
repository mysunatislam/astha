import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source = fs.readFileSync(new URL('../tools/cloud.js', import.meta.url), 'utf8');
const section = source.slice(source.indexOf('const owner ='), source.indexOf('// ---- Secure connection guidance'));
function harness(initial = new Map()) {
  const messages = [];
  const context = {
    window: { ASTHA_ACCOUNT_ID: 'accountA', ASTHA_LOCAL_ACCOUNT_ID: 'accountA' },
    localStorage: { getItem: key => initial.get(key) ?? null, setItem: (key, value) => initial.set(key, value) },
    privacyMode: false, privacyTransition: false, $: () => null, announce: message => messages.push(message),
    withCamera: () => false, captureFrame: () => ({}), playEarcon() {}, logEvent() {},
    setTimeout: callback => { callback(); return 1; }, console,
  };
  vm.createContext(context); vm.runInContext(section, context);
  const run = script => vm.runInContext(script, context);
  run('owner.faceReady = true; refreshOwnerContext()');
  return { context, initial, messages, run };
}
test('owner biometric records are scoped per account without importing legacy globals', () => {
  const face = Array(128).fill(0.1);
  const s = harness(new Map([['astha.owner.face', JSON.stringify(face)], ['astha.owner.lock', '1'],
    ['astha.owner.v2.accountA.face', JSON.stringify(face)], ['astha.owner.v2.accountA.lock', '1']]));
  assert.equal(s.run('owner.lock'), true);
  s.context.window.ASTHA_LOCAL_ACCOUNT_ID = 'accountB';
  s.context.window.ASTHA_ACCOUNT_ID = 'accountB';
  s.run('refreshOwnerContext()');
  assert.equal(s.run('owner.face'), null);
  assert.equal(s.run('owner.voice'), null);
  assert.equal(s.run('owner.lock'), false);
  assert.equal(s.run('owner.verifiedAt'), 0);
  s.context.window.ASTHA_LOCAL_ACCOUNT_ID = null;
  s.context.window.ASTHA_ACCOUNT_ID = null;
  s.run('refreshOwnerContext()');
  assert.equal(s.run('owner.face'), null);
});
test('malformed biometric values never enable owner lock', () => {
  const s = harness(new Map([['astha.owner.v2.accountA.face', '[1,2]'], ['astha.owner.v2.accountA.lock', '1'],
    ['astha.owner.v2.accountA.voice', '{"mean":[1,2],"sd":[-1,0]}']]));
  assert.equal(s.run('owner.face'), null); assert.equal(s.run('owner.voice'), null); assert.equal(s.run('owner.lock'), false);
});
test('late face enrollment cannot write a template or verify a different account', async () => {
  const s = harness(); let resolveFace;
  s.context.faceDescriptor = () => new Promise(resolve => { resolveFace = resolve; });
  const enrollment = s.context.enrollOwnerFace();
  await new Promise(resolve => setImmediate(resolve));
  s.context.window.ASTHA_LOCAL_ACCOUNT_ID = 'accountB'; s.context.window.ASTHA_ACCOUNT_ID = 'accountB';
  s.run('refreshOwnerContext()');
  s.context.faceDescriptor = async () => Array(128).fill(0.1);
  resolveFace(Array(128).fill(0.1)); await enrollment;
  assert.equal(s.run('owner.face'), null); assert.equal(s.run('owner.verifiedAt'), 0);
  assert.equal(s.initial.has('astha.owner.v2.accountA.face'), false);
  assert.equal(s.initial.has('astha.owner.v2.accountB.face'), false);
});
test('late voice enrollment is discarded after sign-out', async () => {
  const s = harness(); let resolveVoice;
  s.context.captureVoiceprint = () => new Promise(resolve => { resolveVoice = resolve; });
  const enrollment = s.context.enrollOwnerVoice();
  await new Promise(resolve => setImmediate(resolve));
  s.context.window.ASTHA_LOCAL_ACCOUNT_ID = null; s.context.window.ASTHA_ACCOUNT_ID = null;
  s.run('refreshOwnerContext()');
  resolveVoice({ mean: [1,2], sd: [1,1] }); await enrollment;
  assert.equal(s.run('owner.voice'), null);
  assert.equal(s.initial.has('astha.owner.v2.accountA.voice'), false);
});
test('privacy mode never starts biometric enrollment', async () => {
  const s = harness(); s.context.privacyMode = true;
  s.context.captureVoiceprint = () => { throw new Error('privacy leak'); };
  await s.context.enrollOwnerVoice(); await s.context.enrollOwnerFace();
  assert.equal(s.messages.length, 0);
});

