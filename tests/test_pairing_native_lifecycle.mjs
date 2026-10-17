import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const storeSource = fs.readFileSync(new URL('../web/paired-camera-store.js', import.meta.url), 'utf8');
const bridgeSource = fs.readFileSync(new URL('../web/native-device.js', import.meta.url), 'utf8');
const TOKEN = 'synthetic_pairing_for_tests_' + 'x'.repeat(20), ORIGIN = 'https://camera.local:8443';
function setup() {
  let record = null, sealed = null, serial = 0, release, began;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { began = resolve; });
  const records = new Map();
  let delay = false, rollbackFail = false;
  const write = async value => {
    const before = sealed;
    sealed = (++serial).toString(16).padStart(4, '0'); record = { ...value }; records.set(sealed, record);
    const result = { ...record, rollback: { before, after: sealed } }; delete result.token;
    if (delay) { began(); await gate; }
    return result;
  };
  const pairing = {
    save: async (profile, value) => write(value),
    load: async () => record,
    summary: async () => { if (!record) return null; const { token, ...rest } = record; return rest; },
    update: async (profile, value) => write({ ...record, ...value }),
    rollback: async (profile, receipt) => {
      if (rollbackFail) throw new Error('mock write refused');
      if (sealed !== receipt.after) return;
      sealed = receipt.before; record = sealed ? records.get(sealed) : null;
    },
    forget: async () => { record = null; sealed = null; },
  };
  const context = vm.createContext({ URL, TextEncoder, TextDecoder, Uint8Array, setTimeout, clearTimeout, setInterval, clearInterval,
    window: { AsthaNative: { pairing } } });
  vm.runInContext(storeSource, context);
  return { store: context.window.AsthaPairingStore, pairing, started, release, get record() { return record; },
    delay: () => { delay = true; }, refuseRollback: () => { rollbackFail = true; } };
}

test('a native save committed during cancellation is compensated before another operation sees it', async () => {
  const h = setup(); h.delay(); let current = true;
  const pending = h.store.save('profile1', { origin: ORIGIN, token: TOKEN }, () => current);
  await h.started; current = false; h.release();
  await assert.rejects(pending, { code: 'cancelled' });
  assert.equal(h.record, null); assert.equal(await h.store.summary('profile1'), null);
});

test('a cancelled native update restores its prior encrypted record and a newer native write survives compensation', async () => {
  for (const newer of [false, true]) {
    const h = setup(); await h.store.save('p', { origin: ORIGIN, token: TOKEN }); h.delay(); let current = true;
    const pending = h.store.update('p', { autoConnect: false }, () => current);
    await h.started;
    const laterWrite = newer ? h.pairing.save('p', { origin: ORIGIN, token: TOKEN, autoConnect: false, device: { model: 'newer' } }) : null;
    current = false; h.release();
    if (laterWrite) await laterWrite;
    await assert.rejects(pending, { code: 'cancelled' });
    assert.equal(h.record.autoConnect, !newer);
    assert.equal(h.record.device?.model, newer ? 'newer' : undefined);
  }
});

test('failed native compensation is reported as storage failure and successful summaries expose no receipt', async () => {
  const h = setup(); const saved = await h.store.save('p', { origin: ORIGIN, token: TOKEN });
  assert.equal(saved.rollback, undefined); assert.equal(saved.token, undefined);
  h.delay(); h.refuseRollback(); let current = true;
  const pending = h.store.update('p', { autoConnect: false }, () => current);
  await h.started; current = false; h.release();
  await assert.rejects(pending, { code: 'storage_failed' });
});

test('the native bridge passes only an opaque encrypted rollback receipt and keeps errors categorical', async () => {
  const calls = [];
  const plugin = { speak() {}, cameraPairingRollback: async value => { calls.push(value); throw { code: 'storage_failed', message: 'private diagnostics' }; } };
  const context = vm.createContext({ Capacitor: { isNativePlatform: () => true, getPlatform: () => 'android', Plugins: { AsthaNative: plugin } } });
  context.window = context; vm.runInContext(bridgeSource, context);
  await assert.rejects(context.AsthaNative.pairing.rollback('p', { before: null, after: '0011', token: TOKEN }),
    error => error.code === 'storage_failed' && !error.message.includes('private diagnostics'));
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [{ profile: 'p', before: null, after: '0011' }]);
});
