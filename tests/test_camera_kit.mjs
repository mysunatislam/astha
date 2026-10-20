// "Remember this ASTHA kit": sealed storage, camera identity, automatic reconnection and
// the spoken states. Everything here is simulated: fake Pis on a fake network, a fake
// IndexedDB and fake timers. TLS, real Wi-Fi, a real Pi and Android are not exercised.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';

const read = path => fs.readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const storeSource = read('web/paired-camera-store.js');
const transportSource = read('web/pi-camera.js');
const nativeSource = read('web/native-device.js');
const uiSource = read('tools/pi-camera-ui.js');
const kitSource = read('tools/camera-kit.js');
const strings = JSON.parse(read('tools/i18n.json')).strings;
const en = key => strings[key][0];
const TOKEN = 'kkkkkkkkkkSecret_Pairing-Code' + 'z'.repeat(20);
const OTHER = 'o'.repeat(48);
const HOST = 'https://hemovasc-pi.local:8443';
const OLD_IP = 'https://172.20.10.11:8443', NEW_IP = 'https://172.20.10.23:8443';
const ID = 'Dev1ce_Identity-0123456';
const jpeg = Uint8Array.from([255, 216, 255, 192, 0, 8, 8, 1, 224, 2, 128, 1, 255, 217]);
const settle = async (rounds = 30) => { for (let i = 0; i < rounds; i++) await new Promise(resolve => setImmediate(resolve)); };
const proof = (token, nonce, id) => crypto.createHmac('sha256', token).update('astha-hello-v1\n' + nonce + '\n' + id).digest('base64url');
// Values made inside the sandbox have its own prototypes; compare their plain data.
const plain = value => JSON.parse(JSON.stringify(value));
const json = value => new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } });

// ---- The sealed store -------------------------------------------------------------------

function fakeIndexedDB() {
  const databases = new Map();
  const later = fn => setTimeout(fn, 0);
  return {
    databases,
    open(name) {
      const request = {};
      later(() => {
        const fresh = !databases.has(name);
        if (fresh) databases.set(name, new Map());
        const stores = databases.get(name);
        const db = {
          objectStoreNames: { contains: store => stores.has(store) },
          createObjectStore: store => stores.set(store, new Map()),
          close() {},
          transaction(storeName) {
            const data = stores.get(storeName), before = new Map(data);
            let outstanding = 0, finished = false;
            const tx = {
              abort() { finished = true; data.clear(); for (const [key, value] of before) data.set(key, value); later(() => tx.onabort?.()); },
              objectStore: () => ({ get: key => run(() => data.get(key)), put: (value, key) => run(() => { data.set(key, value); return key; }), delete: key => run(() => { data.delete(key); }) }),
            };
            const done = () => later(() => { if (!finished && outstanding === 0) { finished = true; tx.oncomplete?.(); } });
            function run(action) {
              const request = {}; outstanding++;
              later(() => { if (finished) return; request.result = action(); request.onsuccess?.(); outstanding--; done(); });
              return request;
            }
            done();
            return tx;
          },
        };
        request.result = db;
        if (fresh) { request.transaction = { abort() {} }; request.onupgradeneeded?.(); }
        request.onsuccess?.();
      });
      return request;
    },
  };
}
function storeSetup(extra = {}) {
  const idb = fakeIndexedDB();
  const context = vm.createContext({ indexedDB: idb, crypto: globalThis.crypto, TextEncoder, TextDecoder, URL, Uint8Array, Array, Object, JSON, Promise, Error, Set,
    setTimeout, clearTimeout, setInterval, clearInterval, ...extra });
  context.window = context;
  vm.runInContext(storeSource, context);
  return { store: context.AsthaPairingStore, idb, context };
}

test('a remembered ClipCam is sealed per profile, never stored as plain text, and forgotten on request', async () => {
  const { store, idb, context } = storeSetup();
  assert.equal(store.kind(), 'browser');
  const saved = await store.save('user-1', { origin: HOST + '/', token: TOKEN, device: { id: ID, name: 'hemovasc-pi', model: 'Raspberry Pi 4\u0007', proof: true, secret: TOKEN } });
  assert.deepEqual(plain(saved), { origin: HOST, fallbacks: [], device: { model: 'Raspberry Pi 4', id: ID, name: 'hemovasc-pi', proof: true }, autoConnect: true, storage: 'browser' });
  const raw = idb.databases.get('astha-paired-camera-v1').get('profiles').get('user-1');
  const flat = JSON.stringify(raw, (key, value) => value instanceof Uint8Array ? Buffer.from(value).toString('latin1') : value);
  assert.equal(flat.includes(TOKEN), false, 'the pairing code is only stored encrypted');
  assert.equal(raw.key.extractable, false, 'the browser key cannot be exported by page code');
  assert.equal('localStorage' in context, false, 'nothing reaches localStorage (it is not even available here)');
  assert.equal((await store.load('user-1')).token, TOKEN);
  assert.equal(await store.load('user-2'), null, 'another person on this device sees nothing');
  assert.equal(await store.forget('user-1'), true);
  assert.equal(await store.load('user-1'), null);
  assert.equal(await store.summary('user-1'), null);
});

test('a new address re-seals the code and keeps the old address only as a fallback', async () => {
  const { store } = storeSetup();
  await store.save('p', { origin: OLD_IP, token: TOKEN });
  const moved = await store.update('p', { origin: HOST });
  assert.equal(moved.origin, HOST); assert.deepEqual(plain(moved.fallbacks), [OLD_IP]);
  assert.equal((await store.load('p')).token, TOKEN, 'the code still opens after re-sealing for the new address');
  assert.equal((await store.update('p', { autoConnect: false })).autoConnect, false);
  assert.equal((await store.summary('p')).autoConnect, false);
  const list = await store.update('p', { fallbacks: [NEW_IP, NEW_IP, HOST, 'https://a.local', 'https://b.local', 'https://c.local', 'https://d.local'] });
  assert.deepEqual(plain(list.fallbacks), [NEW_IP, 'https://a.local', 'https://b.local', 'https://c.local'], 'unique, never the main address, at most four');
  assert.equal(await store.update('missing', { autoConnect: true }), null);
});

test('unsafe addresses, weak codes, bad profiles and cancelled writes are refused without storing anything', async () => {
  const { store } = storeSetup();
  for (const origin of ['http://pi.local:8443', 'https://pi.local:8443/frame', 'https://user:pw@pi.local', 'https://pi.local/?x=1', 'not a url'])
    await assert.rejects(store.save('p', { origin, token: TOKEN }), { code: 'invalid_pairing' });
  await assert.rejects(store.save('p', { origin: HOST, token: 'short' }), { code: 'invalid_pairing' });
  await assert.rejects(store.save('../p', { origin: HOST, token: TOKEN }), { code: 'invalid_profile' });
  await assert.rejects(store.save('p', { origin: HOST, token: TOKEN }, () => false), { code: 'cancelled' });
  assert.equal(await store.summary('p'), null);
  const unavailable = storeSetup({ indexedDB: undefined }).store;
  assert.equal(unavailable.kind(), null);
  await assert.rejects(unavailable.save('p', { origin: HOST, token: TOKEN }), { code: 'unavailable' });
});

test('inside the Android app the record goes to the Keystore vault, and its replies are checked again', async () => {
  let stored = null; const calls = [];
  const strip = ({ token, ...rest }) => rest;
  const pairing = {
    async save(profile, record) { calls.push('save'); stored = { found: true, ...record }; return strip(stored); },
    async load() { calls.push('load'); return stored; },
    async summary() { return stored && strip(stored); },
    async update(profile, changes) { calls.push('update'); stored = { ...stored, ...changes }; return strip(stored); },
    async forget() { calls.push('forget'); stored = null; },
  };
  const { store, idb } = storeSetup({ AsthaNative: { pairing } });
  assert.equal(store.kind(), 'android-keystore');
  assert.equal((await store.save('p', { origin: HOST, token: TOKEN })).storage, 'android-keystore');
  assert.equal(idb.databases.size, 0, 'nothing is written to browser storage in the app');
  assert.equal((await store.load('p')).token, TOKEN);
  assert.deepEqual(plain((await store.update('p', { origin: NEW_IP })).fallbacks), [HOST]);
  for (const bad of [{ found: true, origin: 'http://evil.example', token: TOKEN }, { found: true, origin: HOST, token: 'x' }]) {
    stored = bad; await assert.rejects(store.load('p'), { code: 'invalid_record' });
  }
  await store.forget('p'); assert.equal(await store.load('p'), null);
  assert.deepEqual(calls, ['save', 'load', 'update', 'load', 'load', 'forget', 'load']);
});

test('the Android bridge passes the pairing to the plugin and turns "not found" into null', async () => {
  const calls = [];
  const plugin = { speak() {},
    async cameraPairingSave(options) { calls.push(['save', options]); return { found: true, origin: options.origin, fallbacks: options.fallbacks, device: options.device, autoConnect: true }; },
    async cameraPairingLoad(options) { calls.push(['load', options]); return { found: false }; },
    async cameraPairingSummary() { throw Object.assign(new Error('Keystore unavailable'), { code: 'decrypt_failed' }); },
    async cameraPairingUpdate(options) { calls.push(['update', options]); return { found: false }; },
    async cameraPairingForget(options) { calls.push(['forget', options]); } };
  const context = vm.createContext({ Capacitor: { isNativePlatform: () => true, getPlatform: () => 'android', Plugins: { AsthaNative: plugin } }, Promise, Object, Array, String, Number, Error });
  context.window = context;
  vm.runInContext(nativeSource, context);
  const pairing = context.AsthaNative.pairing;
  const saved = await pairing.save('p', { origin: HOST, token: TOKEN, fallbacks: [OLD_IP, 7], device: { id: ID }, extra: 'dropped' });
  assert.equal(saved.found, true);
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0][1])), { origin: HOST, fallbacks: [OLD_IP], device: { id: ID }, token: TOKEN, profile: 'p' });
  assert.equal(await pairing.load('p'), null);
  assert.equal(await pairing.update('p', { autoConnect: false }), null);
  await assert.rejects(pairing.summary('p'), error => error.code === 'decrypt_failed' && !String(error.message).includes('Keystore'));
  assert.equal(await pairing.forget('p'), true);
});

// ---- Camera identity --------------------------------------------------------------------

function transportSetup(fetch) {
  const calls = [];
  const context = vm.createContext({ document: { hidden: false, addEventListener() {} }, URL, Blob, Uint8Array, AbortController, TextEncoder, crypto: globalThis.crypto, btoa,
    performance: { now: () => 0 }, setTimeout, clearTimeout, createImageBitmap: async () => ({ width: 640, height: 480, close() {} }) });
  context.window = context;
  context.addEventListener = () => {};
  context.fetch = (...args) => { calls.push(args); return fetch(...args); };
  vm.runInContext(transportSource, context);
  return { pi: context.PiCamera, calls };
}
function helloServer({ token = TOKEN, id = ID, status = 200, body } = {}) {
  return async url => {
    const target = new URL(url);
    if (status !== 200) return new Response('', { status });
    if (body !== undefined) return new Response(body, { status: 200 });
    return json({ v: 1, device_id: id, proof: proof(token, target.searchParams.get('nonce'), id) });
  };
}

test('a camera proves it holds the pairing code before ASTHA sends it, with a fresh challenge each time', async () => {
  const h = transportSetup(helloServer());
  assert.deepEqual({ ...(await h.pi.verify({ origin: HOST, token: TOKEN })) }, { reachable: true, supported: true, deviceId: ID });
  assert.deepEqual({ ...(await h.pi.verify({ origin: HOST, token: TOKEN, deviceId: ID })) }, { reachable: true, supported: true, deviceId: ID });
  const [first, second] = h.calls.map(([url]) => new URL(url));
  assert.equal(first.pathname, '/hello'); assert.match(first.searchParams.get('nonce'), /^[A-Za-z0-9_-]{24}$/);
  assert.notEqual(first.searchParams.get('nonce'), second.searchParams.get('nonce'));
  for (const [, options] of h.calls) {
    assert.deepEqual(Object.keys(options.headers), ['Accept'], 'no Authorization header is sent to an unproven device');
    assert.equal(options.credentials, 'omit'); assert.equal(options.redirect, 'error');
  }
  assert.equal(h.calls.some(([url]) => url.includes(TOKEN)), false);
});

test('a forged proof, another identity or a malformed reply is a mismatch; an older camera script or no answer is reported as such', async () => {
  for (const server of [helloServer({ token: OTHER }), helloServer({ body: '{"v":1}' }), helloServer({ body: 'x'.repeat(2000) })])
    await assert.rejects(transportSetup(server).pi.verify({ origin: HOST, token: TOKEN }), { code: 'identity_mismatch' });
  await assert.rejects(transportSetup(helloServer({ id: 'Another_Device_Identity1' })).pi.verify({ origin: HOST, token: TOKEN, deviceId: ID }), { code: 'identity_mismatch' });
  assert.deepEqual({ ...(await transportSetup(helloServer({ status: 401 })).pi.verify({ origin: HOST, token: TOKEN })) }, { reachable: true, supported: false });
  assert.deepEqual({ ...(await transportSetup(async () => { throw new TypeError('Failed to fetch'); }).pi.verify({ origin: HOST, token: TOKEN })) }, { reachable: false, supported: false });
  await assert.rejects(transportSetup(helloServer()).pi.verify({ origin: 'http://pi.local', token: TOKEN }), { code: 'invalid_origin' });
});

// ---- The Pi side ------------------------------------------------------------------------

test('Pi server proves its identity without the token, keeps a stable ID, follows its Wi-Fi address and reports focus', () => {
  const script = String.raw`
import importlib.util, json, threading, urllib.request, urllib.error, hmac, hashlib, base64, subprocess, sys
spec = importlib.util.spec_from_file_location('pi_camera', 'tools/pi-camera-server.py')
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
token = 'a' * 43; origin = 'https://localhost'
server = m.CameraServer(('127.0.0.1', 0), m.make_handler(m.Frames(), token, {origin}, {'model': 'Fixture'}))
thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
def request(headers=None, path='/hello', method='GET'):
    r = urllib.request.Request('http://127.0.0.1:%d%s' % (server.server_port, path), headers=headers or {}, method=method)
    try:
        with urllib.request.urlopen(r, timeout=3) as result: return result.status, dict(result.headers), result.read()
    except urllib.error.HTTPError as error: return error.code, dict(error.headers), error.read()
try:
    nonce = 'N0nce-value_for-the-test'
    status, headers, body = request({'Origin': origin}, '/hello?nonce=' + nonce)
    reply = json.loads(body)
    expected = base64.urlsafe_b64encode(hmac.new(token.encode(), ('astha-hello-v1\n' + nonce + '\n' + reply['device_id']).encode(), hashlib.sha256).digest()).rstrip(b'=').decode()
    assert status == 200 and reply == {'v': 1, 'device_id': m.device_id(token), 'proof': expected}
    assert token not in body.decode() and headers['Cache-Control'] == 'no-store' and headers['Access-Control-Allow-Origin'] == origin
    assert request({'Origin': origin}, '/hello?nonce=short')[0] == 400
    assert request({'Origin': origin}, '/hello?nonce=' + nonce + '&x=1')[0] == 400
    assert request({'Origin': origin}, '/hello')[0] == 400
    assert request({}, '/hello?nonce=' + nonce)[0] == 403
    assert request({'Origin': 'https://evil.example'}, '/hello?nonce=' + nonce)[0] == 403
    preflight = {'Origin': origin, 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'accept', 'Access-Control-Request-Private-Network': 'true'}
    status, headers, _ = request(preflight, '/hello', 'OPTIONS')
    assert status == 204 and headers['Access-Control-Allow-Private-Network'] == 'true'
    status, _, body = request({'Origin': origin, 'Authorization': 'Bearer ' + token}, '/status')
    assert status == 200 and json.loads(body)['device_id'] == m.device_id(token) and json.loads(body)['hello'] is True
    assert request({'Origin': origin}, '/status')[0] == 401, 'everything but /hello still needs the token'
finally:
    server.shutdown(); server.server_close(); thread.join(timeout=2)

identity = m.device_id(token)
assert identity == m.device_id(token) and identity != m.device_id('b' * 43) and len(identity) == 22 and token not in identity

class Run:
    def __init__(self, out, code=0): self.stdout, self.returncode = out, code
def fake(out, code=0): return lambda *args, **kwargs: Run(out, code)
entry = lambda local, scope='global': json.dumps([{'addr_info': [{'local': local, 'scope': scope}]}]).encode()
assert str(m.interface_address('wlan0', fake(entry('192.168.1.50')))) == '192.168.1.50'
assert m.interface_address('wlan0', fake(entry('8.8.8.8'))) is None, 'public addresses are never bound'
assert m.interface_address('wlan0', fake(entry('127.0.0.1', 'host'))) is None
assert m.interface_address('wlan0;reboot', fake(entry('192.168.1.50'))) is None
assert m.interface_address('wlan0', fake(b'not json')) is None and m.interface_address('wlan0', fake(b'', 1)) is None

class Server:
    def __init__(self): self.down = threading.Event()
    def shutdown(self): self.down.set()
addresses = iter(['192.168.1.50', '192.168.1.50', '192.168.1.77'])
target, stopped, changed = Server(), threading.Event(), threading.Event()
watcher = threading.Thread(target=m.watch_address, args=('wlan0', m.private_ipv4('192.168.1.50'), stopped, changed, target, lambda name: m.private_ipv4(next(addresses)), 0.01))
watcher.start(); watcher.join(timeout=5)
assert changed.is_set() and target.down.wait(2), 'a new Wi-Fi address ends the server so systemd restarts it there'

class Source:
    name, started, ended, n = 'fake', False, False, 0
    def start(self): self.started = True
    def capture(self): self.n += 1; return b'\xff\xd8' + bytes(self.n) + b'\xff\xd9'
    def metadata(self): return {'FocusFoM': 100 * self.n, 'ExposureTime': 9000, 'AnalogueGain': 2.0, 'Lux': 120.25, 'Junk': 'dropped'}
    def stop(self): self.ended = True
ticks, source = iter([0, 0, 1, 2, 5]), Source()
report = m.focus_probe(source, 3, None, clock=lambda: next(ticks))
assert source.started and source.ended and report['samples'] == 3
assert report['focus_fom'] == {'min': 100, 'median': 200, 'max': 300} and report['exposure_us']['median'] == 9000
assert m.picamera2_controls() == {}, 'the working picture is unchanged unless a control is asked for'
assert m.picamera2_controls(2.0, 'short') == {'Sharpness': 2.0, 'AeExposureMode': 1}

both = subprocess.run([sys.executable, 'tools/pi-camera-server.py', '--bind', '192.168.1.5', '--bind-interface', 'wlan0', '--cert', 'c', '--key', 'k', '--token-file', 't', '--allow-origin', origin], capture_output=True, text=True)
assert both.returncode == 2 and 'one private bind address' in both.stderr
print('ClipCam identity and server fixtures passed; TLS, Wi-Fi and the camera were not exercised.')
`;
  const result = spawnSync(process.env.ASTHA_PYTHON || 'python', ['-B', '-c', script], { encoding: 'utf8', timeout: 60000 });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.match(result.stdout, /fixtures passed/);
});

// ---- The remembered kit, end to end with the real transport and adapter -----------------

function network() {
  const hosts = new Map(), log = [];
  const device = options => ({ token: TOKEN, id: ID, hello: true, up: true, camera: true, name: 'hemovasc-pi', sequence: 0, run: 'run-1', ...options });
  async function fetch(url, options = {}) {
    const target = new URL(url), auth = options.headers?.Authorization || null;
    log.push({ url, origin: target.origin, path: target.pathname, auth });
    const pi = hosts.get(target.origin);
    if (!pi || !pi.up) throw new TypeError('Failed to fetch');
    if (target.pathname === '/hello') {
      if (!pi.hello) return new Response('', { status: 401 });
      return json({ v: 1, device_id: pi.id, proof: proof(pi.token, target.searchParams.get('nonce'), pi.id) });
    }
    if (auth !== 'Bearer ' + pi.token) return new Response('', { status: 401 });
    if (target.pathname === '/status') return json({ model: 'Raspberry Pi 4 Model B Rev 1.4', backend: 'picamera2', width: 640, height: 480, fps: 4,
      ...(pi.hello ? { device_id: pi.id, hello: true, name: pi.name } : {}) });
    if (target.pathname === '/frame') {
      if (!pi.camera) return new Response('', { status: 503 });
      pi.sequence++;
      return new Response(jpeg, { status: 200, headers: { 'Content-Type': 'image/jpeg', 'Content-Length': String(jpeg.length),
        'X-Astha-Frame-Sequence': String(pi.sequence), 'X-Astha-Frame-Age-Ms': '0', 'X-Astha-Camera-Run': pi.run } });
    }
    return new Response('', { status: 404 });
  }
  return { hosts, log, device, fetch, sentCodeTo: origin => log.some(entry => entry.origin === origin && entry.auth) };
}
function memoryStore(kind = 'browser') {
  const records = new Map();
  const copy = value => value == null ? value : JSON.parse(JSON.stringify(value));
  const summary = record => record ? { origin: record.origin, fallbacks: [...record.fallbacks], device: copy(record.device), autoConnect: record.autoConnect, storage: kind } : null;
  return { records, kind: () => kind,
    async save(profile, { origin, token, device, fallbacks = [] }) { records.set(profile, { origin, token, device: copy(device) || {}, fallbacks, autoConnect: true }); return summary(records.get(profile)); },
    async load(profile) { const record = records.get(profile); return record ? { ...summary(record), token: record.token } : null; },
    async summary(profile) { return summary(records.get(profile)); },
    async update(profile, changes) {
      const record = records.get(profile); if (!record) return null;
      const origin = changes.origin ?? record.origin;
      const fallbacks = [...new Set([...(changes.fallbacks ?? record.fallbacks), ...(origin !== record.origin ? [record.origin] : [])])].filter(item => item !== origin).slice(0, 4);
      Object.assign(record, { origin, fallbacks, device: copy(changes.device ?? record.device), autoConnect: changes.autoConnect ?? record.autoConnect });
      return summary(record);
    },
    async forget(profile) { records.delete(profile); return true; } };
}
function remembered(store, record, profile = 'user-1') {
  store.records.set(profile, { origin: HOST, token: TOKEN, fallbacks: [], autoConnect: true, device: { id: ID, proof: true, name: 'hemovasc-pi' }, ...record });
  return store;
}
function kitSetup({ store = memoryStore(), net = network(), source = null, account = 'user-1', boot = true, identityCrypto = globalThis.crypto } = {}) {
  const elements = new Map(), documentListeners = new Map(), windowListeners = new Map(), timers = new Map(), spoken = [], captions = [], printed = [];
  const pendingCrypto = new Set();
  const cryptoCall = (method, args) => {
    const pending = identityCrypto.subtle[method](...args);
    pendingCrypto.add(pending);
    pending.then(() => pendingCrypto.delete(pending), () => pendingCrypto.delete(pending));
    return pending;
  };
  const trackedCrypto = { getRandomValues: bytes => identityCrypto.getRandomValues(bytes), subtle: {
    importKey: (...args) => cryptoCall('importKey', args), sign: (...args) => cryptoCall('sign', args),
  } };
  // Crypto uses real worker threads, outside the fake clock. A fixed count of event-loop
  // turns does not prove it has finished (CI can run those turns before the worker replies).
  const drain = async () => {
    await settle();
    while (pendingCrypto.size) { await Promise.allSettled([...pendingCrypto]); await settle(); }
  };
  let timerId = 0, now = 1000;
  const element = id => {
    if (!elements.has(id)) elements.set(id, { id, value: '', hidden: false, checked: false, disabled: false, required: true, readOnly: false, textContent: '', width: 640, height: 480, listeners: {},
      setAttribute(key, value) { this[key] = value; }, addEventListener(type, fn) { this.listeners[type] = fn; }, focus() {}, insertBefore() {},
      getContext: () => ({ clearRect() {}, drawImage() {} }) });
    return elements.get(id);
  };
  element('pi-camera-remember').checked = true;
  const on = map => (type, fn) => { if (!map.has(type)) map.set(type, []); map.get(type).push(fn); };
  const pick = index => Object.fromEntries(Object.entries(strings).map(([key, pair]) => [key, pair[index]]));
  const record = (...args) => printed.push(args.map(String).join(' '));
  const context = vm.createContext({
    console: { log: record, info: record, warn: record, error: record, debug: record },
    URL, Blob, Response, Uint8Array, AbortController, TextEncoder, TextDecoder, crypto: trackedCrypto, btoa,
    performance: { now: () => now }, Date: { now: () => now },
    setTimeout: (fn, ms = 0) => { timers.set(++timerId, { fn, at: now + ms }); return timerId; }, clearTimeout: id => timers.delete(id),
    createImageBitmap: async () => ({ width: 640, height: 480, close() {} }),
    document: { hidden: false, getElementById: element, querySelectorAll: () => [], addEventListener: on(documentListeners) },
    I18N: { en: pick(0), bn: pick(1) }, uiLang: 'en', privacyMode: false, privacyTransition: false,
    state: { source, sourceEpoch: 0, cameraPending: false },
    engine: { coco: { status: 'ready' } }, fetch: net.fetch,
    announce: en => spoken.push(en), setCaption: (...args) => captions.push(args.join(' ')),
    stopLiveLoop() {}, stopAllSpeech() {}, startLiveLoop() {}, ensureVisionModels: async () => true,
    AsthaExperience: { invalidate() {}, admit: () => true }, AsthaSensors: { clear() {}, report: () => true },
    ASTHA_LOCAL_ACCOUNT_ID: account, ASTHA_ACCOUNT_ID: account, AsthaPairingStore: store,
  });
  context.window = context;
  context.addEventListener = on(windowListeners);
  context.t = (key, params = {}) => { let value = context.I18N[context.uiLang][key] ?? key; for (const [name, entry] of Object.entries(params)) value = value.split('{' + name + '}').join(entry); return value; };
  vm.runInContext(transportSource + '\n' + uiSource + '\n' + kitSource + `
function showSource(kind) { state.source = kind; state.sourceEpoch++; }
function stopCamera() { AsthaPiCamera.stop({ clearSource: false }); state.source = null; state.cameraPending = false; }
globalThis.ui = AsthaPiCamera; globalThis.kit = AsthaCameraKit;`, context);
  const h = {
    context, store, net, spoken, captions, printed, elements, element, timers, ui: context.ui, kit: context.kit, pi: context.PiCamera,
    async advance(ms = 0) {
      const target = now + ms;
      for (;;) {
        await drain();
        const due = [...timers.entries()].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!due) break;
        timers.delete(due[0]); now = Math.max(now, due[1].at);
        await due[1].fn();
      }
      now = target; await drain();
    },
    async hide(hidden) { context.document.hidden = hidden; for (const fn of documentListeners.get('visibilitychange') || []) fn(); await this.advance(0); },
    async fire(type) { for (const fn of windowListeners.get(type) || []) fn(); await this.advance(0); },
    async say(words) { const handled = context.kit.route(words); await this.advance(0); return handled; },
    requests: () => net.log.length,
  };
  if (boot) { context.ui.boot(); context.kit.boot(); }
  return h;
}

test('the fake clock awaits actual identity crypto before asserting automatic connection state', async () => {
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const identityCrypto = { getRandomValues: bytes => globalThis.crypto.getRandomValues(bytes), subtle: {
    async importKey(...args) { entered(); await gate; return globalThis.crypto.subtle.importKey(...args); },
    sign: (...args) => globalThis.crypto.subtle.sign(...args),
  } };
  const net = network(); net.hosts.set(HOST, net.device());
  const h = kitSetup({ store: remembered(memoryStore()), net, identityCrypto });
  let finished = false;
  const advancing = h.advance(0).then(() => { finished = true; });
  await started; await settle(60);
  assert.equal(h.kit.phase, 'looking', 'identity must finish before a connection is trusted');
  assert.equal(finished, false, 'advancing fake time cannot outrun a pending real crypto operation');
  release(); await advancing;
  assert.equal(h.kit.phase, 'connected'); assert.equal(h.context.state.source, 'pi'); assert(h.ui.frame());
});

test('pair once with Remember; after closing and reopening ASTHA the same ClipCam connects by itself', async () => {
  const net = network(); net.hosts.set(HOST, net.device());
  const store = memoryStore();
  const first = kitSetup({ store, net });
  await first.advance(0);
  assert.equal(first.kit.phase, 'none'); assert.equal(first.element('camera-kit-actions').hidden, true);
  first.element('pi-camera-origin').value = HOST; first.element('pi-camera-token').value = TOKEN;
  await first.ui.connect(); await first.advance(0);
  assert.equal(first.element('pi-camera-token').value, '', 'the code leaves the form at once');
  const saved = store.records.get('user-1');
  assert.equal(saved.token, TOKEN); assert.deepEqual(saved.device, { id: ID, proof: true, model: 'Raspberry Pi 4 Model B Rev 1.4', backend: 'picamera2', name: 'hemovasc-pi' });
  assert.deepEqual(first.spoken, [en('pi_connected'), en('kit_remembered')]);
  assert.equal(first.kit.phase, 'connected'); assert.equal(first.element('pi-camera-token').required, false, 'a remembered ClipCam never needs the code again');
  await first.fire('pagehide');
  assert.equal(first.pi.paired(), false, 'closing ASTHA ends the live link');

  const before = net.log.length;
  const second = kitSetup({ store, net });
  await second.advance(0);
  assert.equal(second.kit.phase, 'connected'); assert.equal(second.context.state.source, 'pi'); assert(second.ui.frame());
  assert.deepEqual(second.spoken, [en('kit_connected')], 'one clear announcement, not two');
  assert.equal(second.element('camera-kit-status').textContent, en('kit_connected'));
  const reopened = net.log.slice(before);
  assert.equal(reopened[0].path, '/hello'); assert.equal(reopened[0].auth, null, 'the camera proved itself before the code was sent');
  assert.equal(await second.say('ASTHA, is my ClipCam connected?'), true);
  assert.equal(second.spoken.at(-1), en('kit_status_live'));
});

test('a Pi reboot is retried quietly, a long outage is handed to automatic reconnection, and no old picture stays live', async () => {
  const net = network(), pi = net.device(); net.hosts.set(HOST, pi);
  const h = kitSetup({ store: remembered(memoryStore()), net });
  await h.advance(0);
  assert.equal(h.kit.phase, 'connected');
  pi.up = false;
  await h.advance(300);
  assert.equal(h.kit.phase, 'interrupted'); assert.equal(h.ui.frame(), null); assert.equal(h.element('pi-preview').hidden, true);
  assert.equal(h.spoken.at(-1), en('pi_reconnecting'));
  await h.advance(50000);
  assert.equal(h.kit.phase, 'waiting'); assert.equal(h.context.state.source, null);
  assert.equal(h.spoken.at(-1), en('kit_lost_keep_looking')); assert.equal(h.spoken.includes(en('pi_connection_lost')), false);
  const said = h.spoken.length, asked = h.requests();
  await h.advance(120000);
  assert.equal(h.spoken.length, said, 'retries are silent'); assert(h.requests() > asked, 'but they continue');
  pi.up = true; pi.sequence = 0; pi.run = 'run-2';
  await h.advance(31000);
  assert.equal(h.kit.phase, 'connected'); assert.equal(h.spoken.at(-1), en('kit_connected')); assert(h.ui.frame());
});

test('after an address change the .local name finds the same proven ClipCam, and the working address is recorded', async () => {
  const net = network(), pi = net.device(); net.hosts.set(HOST, pi); net.hosts.set(NEW_IP, pi);
  const store = remembered(memoryStore(), { origin: OLD_IP });
  const h = kitSetup({ store, net });
  await h.advance(0);
  assert.equal(h.kit.phase, 'connected'); assert.equal(h.pi.origin(), HOST);
  assert.deepEqual(store.records.get('user-1').fallbacks, [HOST]);
  assert.equal(net.sentCodeTo(OLD_IP), false);
  assert.deepEqual(h.spoken, [en('kit_connected')]);
  // Typing only a new address reuses the sealed code.
  await h.say('disconnect my camera');
  h.element('pi-camera-origin').value = NEW_IP; h.element('pi-camera-token').value = '';
  await h.ui.connect(); await h.advance(0);
  assert.equal(h.kit.phase, 'connected'); assert.equal(h.pi.origin(), NEW_IP);
  assert.equal(store.records.get('user-1').origin, NEW_IP); assert(store.records.get('user-1').fallbacks.includes(OLD_IP));
});

test('a different device at the remembered address never receives the code, and cannot make ASTHA forget the ClipCam', async () => {
  const net = network(); net.hosts.set(HOST, net.device({ token: OTHER, id: 'Impostor_Identity_000001' }));
  const store = remembered(memoryStore());
  const h = kitSetup({ store, net });
  await h.advance(0);
  assert.equal(h.kit.phase, 'mismatch'); assert.equal(net.sentCodeTo(HOST), false);
  assert.deepEqual(h.spoken, [en('kit_mismatch')]); assert(store.records.has('user-1'));
  await h.advance(60000);
  assert.equal(h.spoken.length, 1, 'the warning is not repeated on every retry'); assert.equal(net.sentCodeTo(HOST), false);
  // An older device without /hello at a stale fallback address refuses the code: not a revocation.
  const legacy = network(); legacy.hosts.set(OLD_IP, legacy.device({ token: OTHER, hello: false }));
  const kept = remembered(memoryStore(), { device: {}, fallbacks: [OLD_IP] });
  const g = kitSetup({ store: kept, net: legacy });
  await g.advance(0);
  assert.equal(g.kit.phase, 'mismatch'); assert(kept.records.has('user-1'));
});

test('a revoked code is forgotten and never retried, whether refused at reconnection or during a live session', async () => {
  const net = network(); net.hosts.set(HOST, net.device({ token: OTHER, hello: false }));
  const store = remembered(memoryStore(), { device: {} });
  const h = kitSetup({ store, net });
  await h.advance(0);
  assert.equal(h.kit.phase, 'rejected'); assert.equal(store.records.size, 0); assert.deepEqual(h.spoken, [en('kit_rejected')]);
  const asked = h.requests(); await h.advance(120000); await h.fire('online');
  assert.equal(h.requests(), asked, 'a revoked pairing is not retried');

  const live = network(), pi = live.device(); live.hosts.set(HOST, pi);
  const kept = remembered(memoryStore());
  const g = kitSetup({ store: kept, net: live });
  await g.advance(0); assert.equal(g.kit.phase, 'connected');
  pi.token = OTHER;   // the code was replaced on the Pi
  await g.advance(300);
  assert.equal(kept.records.size, 0); assert.equal(g.kit.phase, 'rejected');
  assert.equal(g.spoken.at(-1), en('kit_rejected')); assert.equal(g.spoken.includes(en('pi_pairing_rejected')), false);
  assert.equal(g.context.state.source, null); assert.equal(g.ui.frame(), null);
});

test('Wi-Fi coming back reconnects at once, and nothing is requested while ASTHA is in the background', async () => {
  const net = network(), pi = net.device({ up: false }); net.hosts.set(HOST, pi);
  const h = kitSetup({ store: remembered(memoryStore()), net });
  await h.advance(0);
  assert.equal(h.kit.phase, 'waiting'); assert.deepEqual(h.spoken, [en('kit_waiting')]);
  await h.hide(true);
  const asked = h.requests(); await h.advance(120000);
  assert.equal(h.requests(), asked, 'no searching in the background'); assert.equal(h.timers.size, 0);
  pi.up = true; await h.fire('online');
  assert.equal(h.requests(), asked, 'not even when Wi-Fi returns');
  await h.hide(false);
  assert.equal(h.kit.phase, 'connected'); assert.equal(h.spoken.at(-1), en('kit_connected'));
  // Wi-Fi drops briefly and returns: the transport recovers without the kit or the code.
  pi.up = false; await h.advance(300); pi.up = true; await h.advance(1000);
  assert.equal(h.kit.phase, 'connected'); assert.equal(h.spoken.at(-1), en('pi_reconnected'));
  // A long outage, then the network returns: the online event looks immediately.
  pi.up = false; await h.advance(50000); assert.equal(h.kit.phase, 'waiting');
  pi.up = true; await h.fire('online');
  assert.equal(h.kit.phase, 'connected');
});

test('the camera link pauses in the background and comes back with a fresh picture', async () => {
  const net = network(), pi = net.device(); net.hosts.set(HOST, pi);
  const h = kitSetup({ store: remembered(memoryStore()), net });
  await h.advance(0);
  await h.hide(true);
  assert.equal(h.kit.phase, 'paused'); assert.equal(h.ui.frame(), null); assert.equal(h.pi.paired(), true);
  const asked = h.requests(); await h.advance(10000); assert.equal(h.requests(), asked);
  await h.hide(false); await h.advance(0);
  assert.equal(h.kit.phase, 'connected'); assert(h.ui.frame()); assert(pi.sequence > 1);
});

test('the user stays in control: disconnect holds, a chosen phone camera is never replaced, and forget asks first', async () => {
  const net = network(), pi = net.device(); net.hosts.set(HOST, pi);
  const store = remembered(memoryStore());
  const h = kitSetup({ store, net });
  await h.advance(0);
  assert.equal(await h.say('Disconnect my ClipCam'), true);
  assert.equal(h.kit.phase, 'saved'); assert.equal(h.spoken.at(-1), en('kit_disconnected')); assert.equal(h.pi.paired(), false);
  const asked = h.requests(); await h.fire('online'); await h.advance(60000);
  assert.equal(h.requests(), asked, 'a disconnected ClipCam stays disconnected');
  assert.equal(await h.say('ASTHA, connect to my camera'), true);
  assert.equal(h.kit.phase, 'connected'); assert(h.spoken.includes(en('kit_looking')));

  assert.equal(await h.say('forget this camera'), true); assert.equal(h.spoken.at(-1), en('kit_forget_confirm'));
  assert.equal(await h.say('no'), true); assert.equal(h.spoken.at(-1), en('kit_forget_cancelled')); assert(store.records.has('user-1'));
  await h.say('forget this camera'); await h.say('what time is it'); await h.say('yes');
  assert(store.records.has('user-1'), 'an unrelated answer cancels the pending confirmation');
  await h.say('forget this camera'); assert.equal(await h.say('yes'), true);
  assert.equal(store.records.size, 0); assert.equal(h.spoken.at(-1), en('kit_forgotten')); assert.equal(h.pi.paired(), false); assert.equal(h.kit.phase, 'none');

  const phone = kitSetup({ store: remembered(memoryStore()), net, source: 'camera' });
  await phone.advance(0);
  assert.equal(phone.kit.phase, 'other'); assert.equal(phone.context.state.source, 'camera'); assert.deepEqual(phone.spoken, []);
});

test('LUNEYRA camera commands use the same remembered pairing in both languages', async () => {
  for (const words of ['LUNEYRA, connect to my camera', 'connect to my LUNEYRA ClipCam',
    'লুনেইরা, ক্যামেরা সংযোগ করো', 'ASTHA, connect to my camera', 'আস্থা, ক্যামেরা সংযোগ করো']) {
    const net = network(); net.hosts.set(HOST, net.device());
    const store = remembered(memoryStore()), h = kitSetup({ store, net });
    await h.advance(0); await h.say('disconnect my camera');
    assert.equal(h.pi.paired(), false);
    assert.equal(await h.say(words), true, words);
    assert.equal(h.kit.phase, 'connected', words);
    assert.equal(h.pi.active(), true, words);
    assert.equal(store.records.size, 1, 'renaming must reuse the saved pairing');
  }
});

test('explicit disconnect stays off after reopening, and explicit reconnect restores the saved choice', async () => {
  const net = network(); net.hosts.set(HOST, net.device());
  const store = remembered(memoryStore());
  const first = kitSetup({ store, net }); await first.advance(0);
  await first.kit.disconnect();
  assert.equal(store.records.get('user-1').autoConnect, false);
  await first.fire('pagehide');
  const asked = net.log.length;
  const reopened = kitSetup({ store, net }); await reopened.advance(0);
  await reopened.fire('online'); await reopened.advance(60000);
  assert.equal(net.log.length, asked, 'reopening or network events cannot undo Disconnect');
  await reopened.kit.connect(); await reopened.advance(0);
  assert.equal(reopened.kit.phase, 'connected');
  assert.equal(store.records.get('user-1').autoConnect, true, 'an explicit successful reconnect opts back in');
});

test('without an explicit local profile no shared device pairing is read or written', async () => {
  for (const account of [null, '', '../bad']) {
    const store = remembered(memoryStore(), {}, 'device');
    const net = network(); net.hosts.set(HOST, net.device());
    const h = kitSetup({ store, net, account });
    h.context.ASTHA_ACCOUNT_ID = 'user-1';
    await h.advance(0); await h.kit.connect();
    assert.equal(h.kit.remembered(), false); assert.equal(h.requests(), 0);
    assert.equal(await h.kit.remember({ origin: HOST, token: TOKEN }), false);
    assert.deepEqual([...store.records.keys()], ['device']);
  }
});

test('late pairing verification or storage cannot restore a kit after disconnect, forget, account, hiding or privacy entry', async () => {
  for (const boundary of ['disconnect', 'forget', 'account', 'hidden', 'privacy']) {
    for (const stage of ['verify', 'save']) {
      let release, entered;
      const gate = new Promise(resolve => { release = resolve; });
      const started = new Promise(resolve => { entered = resolve; });
      const store = memoryStore(), net = network(); net.hosts.set(HOST, net.device());
      if (stage === 'verify') {
        const fetch = net.fetch;
        net.fetch = async (url, options) => {
          if (new URL(url).pathname === '/hello') { entered(); await gate; }
          return fetch(url, options);
        };
      } else {
        const save = store.save;
        store.save = async (profile, value, current) => {
          entered(); await gate;
          if (!current()) throw Object.assign(new Error('cancelled'), { code: 'cancelled' });
          return save(profile, value);
        };
      }
      const h = kitSetup({ store, net }); await h.advance(0);
      h.element('pi-camera-origin').value = HOST; h.element('pi-camera-token').value = TOKEN;
      const pending = h.ui.connect(); await started;
      if (boundary === 'disconnect') await h.kit.disconnect();
      if (boundary === 'forget') await h.kit.forget();
      if (boundary === 'account') { h.kit.accountCleared(); h.context.ASTHA_LOCAL_ACCOUNT_ID = 'user-2'; }
      if (boundary === 'hidden') await h.hide(true);
      if (boundary === 'privacy') { h.context.privacyMode = true; h.kit.privacyEntered(); }
      const said = h.spoken.length;
      release(); await pending; await h.advance(0);
      assert.equal(store.records.size, 0, `${boundary} at ${stage} cannot be undone by an earlier save`);
      assert.equal(h.kit.remembered(), false, `${boundary} at ${stage} leaves no stale summary`);
      assert.equal(h.spoken.slice(said).includes(en('kit_remembered')), false);
    }
  }
});

test('privacy entry pauses the kit without saving; leaving privacy needs an explicit reconnect', async () => {
  const net = network(); net.hosts.set(HOST, net.device());
  const store = remembered(memoryStore());
  const h = kitSetup({ store, net }); await h.advance(0);
  assert.equal(h.kit.phase, 'connected');
  const savedBefore = JSON.stringify([...store.records]);
  h.context.privacyMode = true; h.kit.privacyEntered();
  assert.equal(h.pi.paired(), false);
  const requests = h.requests();
  assert.equal(await h.kit.connect(), false);
  assert.equal(await h.kit.remember({ origin: HOST, token: OTHER }), false);
  assert.equal(await h.kit.setAuto(true), false);
  assert.equal(JSON.stringify([...store.records]), savedBefore, 'privacy entry saves no new data');
  await h.kit.setAuto(false);
  assert.equal(store.records.get('user-1').autoConnect, false, 'explicitly disabling reconnection persists while private');
  await h.kit.disconnect(); await h.fire('online'); await h.advance(60000);
  assert.equal(h.requests(), requests, 'no automatic or saved-key connection while private');
  const savedAfter = store.records.get('user-1');
  assert.equal(savedAfter.token, TOKEN, 'disabling access does not replace the saved credential');
  assert.equal(savedAfter.autoConnect, false, 'private Disconnect remains disabled after reopening');
  h.context.privacyMode = false;
  await h.fire('online'); await h.hide(true); await h.hide(false); await h.advance(60000);
  assert.equal(h.requests(), requests, 'turning privacy off does not resume a prior automatic request');
  assert.equal(await h.kit.connect(), true); await h.advance(0);
  assert.equal(h.kit.phase, 'connected');
  h.context.privacyMode = true; h.kit.privacyEntered();
  assert.equal(await h.kit.forget(), true, 'explicit deletion remains available while private');
  assert.equal(store.records.size, 0);
});

test('a legacy kit can reuse its explicitly paired TLS address but never sends its code to an unproven new address', async () => {
  const net = network(); net.hosts.set(HOST, net.device({ hello: false })); net.hosts.set(NEW_IP, net.device({ hello: false }));
  const store = remembered(memoryStore(), { device: {} });
  const h = kitSetup({ store, net }); await h.advance(0);
  assert.equal(h.kit.phase, 'connected', 'existing trusted demo address remains usable');
  assert.equal(net.sentCodeTo(HOST), true);
  await h.kit.disconnect();
  assert.equal(await h.kit.useAddress(NEW_IP), false);
  assert.equal(net.sentCodeTo(NEW_IP), false, 'a TLS-valid new host still needs the pairing proof');
  assert.equal(store.records.get('user-1').origin, HOST);
  assert.equal(h.kit.phase, 'mismatch');
});

test('a replacement manual pairing invalidates an earlier delayed credential save', async () => {
  let release, entered, first = true;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const store = memoryStore(), net = network(), device = net.device(); net.hosts.set(HOST, device);
  const fetch = net.fetch;
  net.fetch = async (url, options) => {
    if (new URL(url).pathname === '/hello' && first) { first = false; entered(); await gate; }
    return fetch(url, options);
  };
  const h = kitSetup({ store, net }); await h.advance(0);
  h.element('pi-camera-origin').value = HOST; h.element('pi-camera-token').value = TOKEN;
  const old = h.ui.connect(); await started;
  device.token = OTHER;
  h.element('pi-camera-token').value = OTHER;
  await h.ui.connect(); await h.advance(0);
  assert.equal(store.records.get('user-1').token, OTHER);
  release(); await old; await h.advance(0);
  assert.equal(store.records.get('user-1').token, OTHER, 'the earlier pairing cannot replace the new code');
  assert.equal(h.spoken.filter(text => text === en('kit_remembered')).length, 1);
});

test('voice commands work in English and Bangla, and ordinary camera requests are left alone', async () => {
  const net = network(), pi = net.device({ up: false }); net.hosts.set(HOST, pi);
  const h = kitSetup({ store: remembered(memoryStore()), net });
  await h.advance(0);
  pi.up = true;
  assert.equal(await h.say('ক্যামেরা সংযোগ করো'), true); assert.equal(h.kit.phase, 'connected');
  assert.equal(await h.say('আমার ক্লিপক্যাম কি সংযুক্ত?'), true); assert.equal(h.spoken.at(-1), en('kit_status_live'));
  assert.equal(await h.say('ক্যামেরা বিচ্ছিন্ন করো'), true); assert.equal(h.kit.phase, 'saved');
  assert.equal(await h.say('reconnect my device'), true); assert.equal(h.kit.phase, 'connected');
  assert.equal(await h.say('ক্লিপক্যাম ভুলে যাও'), true); assert.equal(h.spoken.at(-1), en('kit_forget_confirm'));
  assert.equal(await h.say('না'), true);
  for (const words of ['turn on the camera', 'what is in front of me', 'describe my surroundings', 'read this page'])
    assert.equal(h.kit.route(words), false, words);
  const empty = kitSetup({ net });
  await empty.advance(0);
  assert.equal(empty.kit.route('disconnect my camera'), false, 'with no ClipCam this stays a phone-camera command');
  assert.equal(await empty.say('connect to my camera'), true); assert.equal(empty.spoken.at(-1), en('kit_none'));
});

test('the pairing code never appears in speech, captions, logs, page text, URLs or diagnostics', async () => {
  const net = network(), pi = net.device(); net.hosts.set(HOST, pi);
  const store = memoryStore();
  const h = kitSetup({ store, net });
  await h.advance(0);
  h.element('pi-camera-origin').value = HOST; h.element('pi-camera-token').value = TOKEN;
  await h.ui.connect(); await h.advance(0);
  pi.up = false; await h.advance(50000); pi.up = true; await h.advance(31000);
  await h.say('is my clipcam connected'); h.context.uiLang = 'bn'; h.kit.render();
  const diagnostics = JSON.stringify(h.kit.diagnostics());
  assert.deepEqual(Object.keys(h.kit.diagnostics()).sort(), ['autoConnect', 'identityProven', 'live', 'phase', 'remembered', 'storage', 'transport']);
  for (const text of [...h.spoken, ...h.captions, ...h.printed, ...[...h.elements.values()].map(node => node.textContent + node.value), ...net.log.map(entry => entry.url), diagnostics])
    assert.equal(String(text).includes(TOKEN), false, String(text).slice(0, 80));
  assert.equal(diagnostics.includes('hemovasc'), false, 'no address in diagnostics either');
  assert.equal(h.element('camera-kit-storage').textContent, strings.kit_storage_browser[1]);
});
