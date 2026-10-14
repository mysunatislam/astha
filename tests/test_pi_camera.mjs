import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
const source = fs.readFileSync(new URL('../web/pi-camera.js', import.meta.url), 'utf8');
const uiSource = fs.readFileSync(new URL('../tools/pi-camera-ui.js', import.meta.url), 'utf8');
const strings = JSON.parse(fs.readFileSync(new URL('../tools/i18n.json', import.meta.url), 'utf8')).strings;
const TOKEN = 'a'.repeat(43), ORIGIN = 'https://astha-pi.local:8443';
const jpeg = Uint8Array.from([255, 216, 255, 192, 0, 8, 8, 1, 224, 2, 128, 1, 255, 217]);
function reply({ status = 200, age = '0', sequence = '1', bytes = jpeg, type = 'image/jpeg', headers = {} } = {}) {
  return new Response(bytes, { status, headers: { 'Content-Type': type, 'Content-Length': String(bytes.length), 'X-Astha-Frame-Sequence': sequence, 'X-Astha-Frame-Age-Ms': age, ...headers } });
}
function setup(fetch = async () => reply(), decode) {
  const calls = [], listeners = new Map(), timers = new Map(), frames = [];
  let tick = 0, now = 100;
  const document = { hidden: false, addEventListener: (key, fn) => listeners.set(key, fn) };
  const window = { addEventListener: (key, fn) => listeners.set(key, fn), fetch: (...args) => { calls.push(args); return fetch(...args); } };
  vm.runInNewContext(source, { window, document, URL, Blob, Uint8Array, AbortController, performance: { now: () => now }, setTimeout: (fn, ms) => { timers.set(++tick, { fn, ms }); return tick; }, clearTimeout: id => timers.delete(id), createImageBitmap: decode || (async () => { const bitmap = { width: 640, height: 480, closed: false, close() { this.closed = true; } }; frames.push(bitmap); return bitmap; }) });
  return { pi: window.PiCamera, calls, timers, listeners, document, frames, advance(ms) { now += ms; }, async run(ms) { const entry = [...timers.entries()].find(([, t]) => t.ms === ms); assert.ok(entry, 'no ' + ms + ' ms timer is pending'); timers.delete(entry[0]); await entry[1].fn(); },
    async poll() { await this.run(250); } };
}
test('explicit pairing requires HTTPS and reports ready only after a validated decoded frame', async () => {
  const h = setup(), status = [];
  await assert.rejects(h.pi.connect({ origin: 'http://astha-pi.local:8443', token: TOKEN }), { code: 'invalid_origin' });
  await assert.rejects(h.pi.connect({ origin: ORIGIN + '/stream', token: TOKEN }), { code: 'invalid_origin' });
  await assert.rejects(h.pi.connect({ origin: ORIGIN, token: 'weak' }), { code: 'invalid_pairing_token' });
  assert.equal(h.calls.length, 0);
  await h.pi.connect({ origin: ORIGIN, token: TOKEN, onStatus: value => status.push(value.state) });
  assert.deepEqual(status, ['connecting', 'connected']);
  assert.equal(h.pi.active(), true);
  assert.equal(h.pi.getFrame(), h.frames[0]);
  const [url, options] = h.calls[0];
  assert.equal(url, ORIGIN + '/frame');
  assert.equal(options.credentials, 'omit');
  assert.equal(options.redirect, 'error');
  assert.equal(options.cache, 'no-store');
  assert.deepEqual(Object.keys(options.headers).sort(), ['Accept', 'Authorization']);
  assert.equal(options.headers.Authorization, 'Bearer ' + TOKEN);
  h.pi.stop(); assert.equal(h.pi.active(), false); assert.equal(h.pi.getFrame(), null); assert.equal(h.frames[0].closed, true);
});
test('unauthorized, stale, malformed, oversized and non-JPEG frames never become ready', async () => {
  for (const fixture of [{ status: 401 }, { status: 403 }, { age: '3000' }, { sequence: '0' }, { type: 'text/html' }, { headers: { 'Content-Length': '3000000' } }, { bytes: Uint8Array.from([255, 216, 255, 192, 0, 8, 8, 20, 0, 20, 0, 1]) }]) {
    const h = setup(async () => reply(fixture));
    await assert.rejects(h.pi.connect({ origin: ORIGIN, token: TOKEN }));
    assert.equal(h.pi.active(), false); assert.equal(h.pi.getFrame(), null); assert.equal(h.frames.length, 0);
  }
});
test('single flight polling rejects repeated sequences and drops frames after freshness expires', async () => {
  const h = setup();
  await h.pi.connect({ origin: ORIGIN, token: TOKEN });
  h.advance(2501);
  assert.equal(h.pi.getFrame(), null); assert.equal(h.pi.active(), false);
  await h.poll();
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[1][0], ORIGIN + '/frame?after=1');
  assert.equal(h.pi.getFrame(), null);
  assert.equal(h.frames[0].closed, true);
});
test('a new decoded sequence replaces the owned frame without overlapping frame requests', async () => {
  let sequence = 0, pending, simultaneous = 0, maximum = 0;
  const h = setup(async () => {
    simultaneous++; maximum = Math.max(maximum, simultaneous);
    if (sequence) await new Promise(resolve => { pending = resolve; });
    simultaneous--; return reply({ sequence: String(++sequence) });
  });
  const statuses = [];
  await h.pi.connect({ origin: ORIGIN, token: TOKEN, onStatus: status => statuses.push(status.state) });
  const next = h.poll();
  assert.equal(h.timers.size, 1); // Only this request's deadline; no next poll yet.
  assert.equal(h.calls.length, 2);
  pending(); await next;
  assert.equal(maximum, 1); assert.equal(h.frames[0].closed, true); assert.equal(h.pi.getFrame(), h.frames[1]);
  assert.deepEqual(statuses, ['connecting', 'connected']); // Avoid live-region spam.
  h.pi.stop();
});
test('encoded payload limits apply even when Content-Length is absent', async () => {
  const h = setup(async () => {
    const response = reply({ bytes: new Uint8Array(2 * 1024 * 1024 + 1) });
    response.headers.delete('Content-Length');
    return response;
  });
  await assert.rejects(h.pi.connect({ origin: ORIGIN, token: TOKEN }), { code: 'frame_too_large' });
  assert.equal(h.frames.length, 0); assert.equal(h.pi.active(), false);
});
test('stop aborts an in-flight fetch and ignores its late response', async () => {
  let resolve;
  const h = setup(() => new Promise(done => { resolve = done; }));
  const connecting = h.pi.connect({ origin: ORIGIN, token: TOKEN });
  h.pi.stop();
  assert.equal(h.calls[0][1].signal.aborted, true);
  resolve(reply());
  await assert.rejects(connecting, { code: 'stopped' });
  assert.equal(h.frames.length, 0); assert.equal(h.pi.getFrame(), null); assert.equal(h.timers.size, 0);
});
test('late image decode is closed after a new connection or Stop', async () => {
  let release;
  const bitmap = { width: 640, height: 480, closed: false, close() { this.closed = true; } };
  const h = setup(undefined, () => new Promise(resolve => { release = resolve; }));
  const connected = h.pi.connect({ origin: ORIGIN, token: TOKEN });
  await new Promise(resolve => setImmediate(resolve));
  h.pi.stop(); release(bitmap);
  await assert.rejects(connected, { code: 'stopped' });
  assert.equal(bitmap.closed, true); assert.equal(h.pi.active(), false);
});
test('leaving the page ends the pairing; going to the background only pauses it', async () => {
  let n = 0;
  const h = setup(async () => reply({ sequence: String(++n) })), status = [];
  await h.pi.connect({ origin: ORIGIN, token: TOKEN, onStatus: value => status.push(value.state) });
  h.document.hidden = true; h.listeners.get('visibilitychange')();
  assert.equal(h.pi.active(), false); assert.equal(h.pi.getFrame(), null); assert.equal(h.frames[0].closed, true);
  assert.equal(h.timers.size, 0, 'no pictures are requested in the background'); assert.equal(h.pi.paired(), true);
  h.document.hidden = false; h.listeners.get('visibilitychange')();
  await h.run(0);
  assert.equal(h.pi.active(), true); assert.equal(h.calls.at(-1)[1].headers.Authorization, 'Bearer ' + TOKEN);
  assert.deepEqual(status, ['connecting', 'connected', 'paused', 'reconnecting', 'connected']);
  h.listeners.get('pagehide')();
  assert.equal(h.pi.paired(), false); assert.equal(h.pi.active(), false); assert.equal(h.timers.size, 0);
});
test('a dropped link is retried with backoff, old pictures are withheld, and a long outage ends the pairing', async () => {
  let n = 0, down = false;
  const h = setup(async () => { if (down) throw new TypeError('network'); return reply({ sequence: String(++n) }); }), status = [];
  await h.pi.connect({ origin: ORIGIN, token: TOKEN, onStatus: value => status.push(value.state + (value.code ? ':' + value.code : '')) });
  down = true; await h.poll();
  assert.equal(h.pi.getFrame(), null); assert.equal(h.pi.active(), false); assert.equal(h.pi.paired(), true);
  assert.equal(h.frames[0].closed, true, 'a picture from before the outage is never analysed');
  assert.deepEqual(status, ['connecting', 'connected', 'reconnecting:connection_failed']);
  await h.run(500); await h.run(1000);
  assert.ok([...h.timers.values()].some(timer => timer.ms === 2000), 'retries back off');
  assert.equal(status.length, 3, 'one announcement per outage, not one per retry');
  down = false; await h.run(2000);
  assert.equal(h.pi.active(), true); assert.equal(status.at(-1), 'connected');
  down = true; await h.poll();
  h.advance(45001); await h.run(500);
  assert.equal(h.pi.paired(), false); assert.equal(status.at(-1), 'error:connection_lost'); assert.equal(h.timers.size, 0);
});
test('a failure before the first picture is final, and a rejected pairing is never retried', async () => {
  const first = setup(async () => { throw new TypeError('network'); });
  await assert.rejects(first.pi.connect({ origin: ORIGIN, token: TOKEN }), { code: 'connection_failed' });
  assert.equal(first.pi.paired(), false); assert.equal(first.timers.size, 0);
  let n = 0, revoked = false;
  const h = setup(async () => reply(revoked ? { status: 401 } : { sequence: String(++n) })), status = [];
  await h.pi.connect({ origin: ORIGIN, token: TOKEN, onStatus: value => status.push(value.state + (value.code ? ':' + value.code : '')) });
  revoked = true; await h.poll();
  assert.equal(status.at(-1), 'error:pairing_rejected'); assert.equal(h.pi.paired(), false); assert.equal(h.timers.size, 0);
});
test('a restarted camera is accepted by its new run, but a replayed picture is not', async () => {
  let next = { sequence: '7', headers: { 'X-Astha-Camera-Run': 'run-a' } }, down = false;
  const h = setup(async () => { if (down) throw new TypeError('network'); return reply(next); });
  await h.pi.connect({ origin: ORIGIN, token: TOKEN });
  down = true; await h.poll(); down = false;
  await h.run(500);
  assert.equal(h.pi.active(), false, 'the same picture from the same run is a replay');
  next = { sequence: '1', headers: { 'X-Astha-Camera-Run': 'run-b' } };
  await h.run(1000);
  assert.equal(h.pi.active(), true);
  assert.equal(new URL(h.calls.at(-1)[0]).searchParams.has('after'), false, 'a restarted camera counts from one again');
});
test('low-data pacing is bounded and the camera description is reduced to display text', async () => {
  const h = setup(async url => new URL(url).pathname === '/status'
    ? new Response(JSON.stringify({ model: 'Raspberry Pi Model B Rev 2\u0007', os: 'Raspbian GNU/Linux 10', backend: 'picamera', width: 640, height: 480, fps: 2, token: 'leak', extra: { nested: true } }), { status: 200 })
    : reply());
  await h.pi.connect({ origin: ORIGIN, token: TOKEN, interval: 1000 });
  assert.ok([...h.timers.values()].some(timer => timer.ms === 1000));
  assert.deepEqual({ ...(await h.pi.describe()) }, { model: 'Raspberry Pi Model B Rev 2', os: 'Raspbian GNU/Linux 10', backend: 'picamera', width: 640, height: 480, fps: 2 });
  assert.equal(h.calls.at(-1)[1].credentials, 'omit');
  for (const [interval, expected] of [[5, 250], [999999, 5000], [undefined, 250]]) {
    const paced = setup(); await paced.pi.connect({ origin: ORIGIN, token: TOKEN, interval });
    assert.ok([...paced.timers.values()].some(timer => timer.ms === expected), String(interval));
  }
});
test('capture request deadline aborts and disconnected frames cannot enter inference', async () => {
  const h = setup((_, options) => new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new DOMException('timeout', 'AbortError')))));
  const connect = h.pi.connect({ origin: ORIGIN, token: TOKEN });
  [...h.timers.values()].find(t => t.ms === 3000).fn();
  await assert.rejects(connect, { code: 'frame_timeout' });
  assert.equal(h.pi.active(), false); assert.equal(h.pi.getFrame(), null);
});
test('decode deadline rejects promptly and a late decoded bitmap is closed', async () => {
  let release;
  const bitmap = { width: 640, height: 480, closed: false, close() { this.closed = true; } };
  const h = setup(undefined, () => new Promise(resolve => { release = resolve; }));
  const connecting = h.pi.connect({ origin: ORIGIN, token: TOKEN });
  await new Promise(resolve => setImmediate(resolve));
  [...h.timers.values()].find(t => t.ms === 3000).fn();
  await assert.rejects(connecting, { code: 'frame_timeout' });
  assert.equal(h.pi.getFrame(), null); assert.equal(h.pi.active(), false);
  release(bitmap); await new Promise(resolve => setImmediate(resolve));
  assert.equal(bitmap.closed, true); assert.equal(h.timers.size, 0);
});
test('Pi server fixture imports without hardware and gates origin, pairing, stale frames and byte limits', () => {
  const script = String.raw`
import importlib.util, json, threading, urllib.request, urllib.error, time
spec = importlib.util.spec_from_file_location('pi_camera', 'tools/pi-camera-server.py')
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
frames = m.Frames(); token = 'a' * 43; origin = 'https://localhost'
info = {'model': 'Fixture board', 'backend': 'fixture', 'width': 640, 'height': 480, 'fps': 4.0, 'run': 'fixture-run'}
server = m.CameraServer(('127.0.0.1', 0), m.make_handler(frames, token, {origin}, info))
thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
def request(headers=None, path='/frame', method='GET'):
    request = urllib.request.Request('http://127.0.0.1:%d%s' % (server.server_port, path), headers=headers or {}, method=method)
    try:
        with urllib.request.urlopen(request, timeout=3) as result: return result.status, dict(result.headers), result.read()
    except urllib.error.HTTPError as error: return error.code, dict(error.headers), error.read()
try:
    assert request()[0] == 403
    assert request({'Origin': origin})[0] == 401
    assert request({'Origin': origin}, '/status')[0] == 401
    headers = {'Origin': origin, 'Authorization': 'Bearer ' + token}
    assert request(headers)[0] == 503
    frames.put(b'\xff\xd8fixture-jpeg\xff\xd9')
    status, result_headers, body = request(headers)
    assert status == 200 and body.startswith(b'\xff\xd8') and result_headers['Cache-Control'] == 'no-store'
    assert result_headers['Access-Control-Allow-Origin'] == origin
    assert 'Access-Control-Allow-Credentials' not in result_headers
    assert result_headers['X-Astha-Frame-Sequence'] == '1'
    assert result_headers['X-Astha-Camera-Run'] == 'fixture-run'
    assert 'X-Astha-Camera-Run' in result_headers['Access-Control-Expose-Headers']
    assert 'Connection' not in result_headers, 'a paired client keeps its TLS connection'
    assert request({'Origin': origin}, '/status')[1]['Connection'] == 'close'
    status, result_headers, body = request(headers, '/status')
    described = json.loads(body.decode('utf-8'))
    assert status == 200 and described == {'model': 'Fixture board', 'backend': 'fixture', 'width': 640, 'height': 480, 'fps': 4.0}
    assert request(headers, '/status?x=1')[0] == 400
    assert request(headers, '/frame?after=1')[0] == 503
    assert request(headers, '/frame?after=1&other=2')[0] == 400
    frames.at = time.monotonic() - 3
    assert request(headers)[0] == 503
    frames.put(b'\xff\xd8' + b'x' * m.MAX_BYTES)
    assert frames.sequence == 1
    preflight = {'Origin': origin, 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization'}
    assert request(preflight, method='OPTIONS')[0] == 204
    assert request(preflight, '/status', method='OPTIONS')[0] == 204
    assert request(preflight, '/other', method='OPTIONS')[0] == 403
    preflight['Access-Control-Request-Private-Network'] = 'true'
    assert request(preflight, method='OPTIONS')[1]['Access-Control-Allow-Private-Network'] == 'true'
    preflight['Access-Control-Request-Headers'] = 'cookie'
    assert request(preflight, method='OPTIONS')[0] == 403
finally:
    server.shutdown(); server.server_close(); thread.join(timeout=2)

# Capture method selection never assumes a particular camera stack.
assert m.choose_backend('auto', []) is None
assert m.choose_backend('auto', ['picamera', 'raspistill']) == 'picamera'
assert m.choose_backend('auto', ['picamera2', 'picamera', 'rpicam-still']) == 'picamera2'
assert m.choose_backend('rpicam-still', ['picamera2']) is None
assert m.choose_backend('raspistill', ['raspistill']) == 'raspistill'
assert isinstance(m.available_backends(), list)
board = m.describe_board()
assert set(board) == {'model', 'revision', 'os', 'machine', 'python', 'memory_mb'} and all(board[key] != '' for key in board)
legacy = m.CommandSource('raspistill', 640, 480, 70, 300).command
assert legacy == ['raspistill', '-n', '-t', '300', '-w', '640', '-h', '480', '-q', '70', '-o', '-']
modern = m.CommandSource('rpicam-still', 320, 240, 60, 1).command
assert modern == ['rpicam-still', '-n', '-t', '1', '--width', '320', '--height', '240', '-q', '60', '-o', '-']

# A NoIR camera needs its own colour tuning; only a plain installed file name is accepted.
import os, sys, tempfile, types
with tempfile.TemporaryDirectory() as folder:
    open(os.path.join(folder, 'imx219_noir.json'), 'w').close()
    assert m.tuning_path('imx219_noir.json', [folder]) == os.path.join(folder, 'imx219_noir.json')
    assert m.noir_tunings([folder, os.path.join(folder, 'missing')]) == ['imx219_noir.json']
    for name in ('../imx219_noir.json', '/tmp/imx219_noir.json', 'sub/imx219_noir.json', '.json', 'imx219_noir.txt', '', None):
        assert m.tuning_path(name, [folder]) is None, name
    assert m.tuning_path('imx477_noir.json', [folder]) is None
tuned = m.CommandSource('rpicam-still', 320, 240, 60, 1, '/usr/share/libcamera/ipa/rpi/vc4/imx219_noir.json').command
assert tuned[-4:] == ['--tuning-file', '/usr/share/libcamera/ipa/rpi/vc4/imx219_noir.json', '-o', '-']
seen = {}
class FakeCamera:
    def __init__(self, **kwargs): seen.clear(); seen.update(kwargs); self.options = {}
    def create_video_configuration(self, **kwargs): return kwargs
    def configure(self, config): pass
real_picamera2 = sys.modules.get('picamera2')
sys.modules['picamera2'] = types.SimpleNamespace(Picamera2=FakeCamera)
try:
    m.Picamera2Source(640, 480, 70, 300, '/x/imx219_noir.json')
    assert seen == {'tuning': '/x/imx219_noir.json'}
    m.Picamera2Source(640, 480, 70, 300)
    assert seen == {}, 'without --tuning picamera2 keeps its default tuning'
finally:
    if real_picamera2 is None: sys.modules.pop('picamera2', None)
    else: sys.modules['picamera2'] = real_picamera2

# ESP32 telemetry: only well-formed samples pass, field by field.
good = {'type': 'sample', 'v': 1, 'seq': 5, 'ms': 900, 'distance_cm': 85.2, 'distance_status': 'ok',
        'imu': {'ax': 0.01, 'ay': -0.02, 'az': 0.99, 'gx': 0.4, 'gy': -0.1, 'gz': 0.0, 'temp_c': 29.1}, 'imu_status': 'ok'}
parsed = m.telemetry_sample(json.dumps(dict(good, extra='dropped')).encode())
assert parsed == {'seq': 5, 'distance_cm': 85.2, 'distance_status': 'ok', 'imu': good['imu'], 'imu_status': 'ok'}
no_imu = dict(good, imu=None, imu_status='not_found', distance_cm=None, distance_status='out_of_range')
assert m.telemetry_sample(json.dumps(no_imu))['imu'] is None
for bad in [dict(good, type='hello'), dict(good, v=2), dict(good, seq=-1), dict(good, seq=True), dict(good, distance_cm=-3),
            dict(good, distance_cm=900), dict(good, distance_cm='85'), dict(good, distance_status='ok', distance_cm=None),
            dict(good, distance_status='out_of_range'), dict(good, distance_status='made_up'),
            dict(good, imu=dict(good['imu'], ax=float('nan'))), dict(good, imu=dict(good['imu'], gz=9999)),
            dict(good, imu={'ax': 1}), dict(good, imu_status='not_found'), dict(good, imu_status='broken')]:
    assert m.telemetry_sample(json.dumps(bad)) is None, bad
for noise in [b'', b'ets Jul 29 2019 12:21:46', b'{', b'[1,2]', b'\xff\xfe', b'{"type":"sample"' + b' ' * 2000 + b'}']:
    assert m.telemetry_sample(noise) is None

# /telemetry has the same gates as pictures, and refuses a reading older than a second.
telemetry = m.Telemetry()
server = m.CameraServer(('127.0.0.1', 0), m.make_handler(m.Frames(), token, {origin}, {'model': 'Fixture'}, telemetry))
thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
try:
    assert request({'Origin': origin}, '/telemetry')[0] == 401
    assert request({'Authorization': 'Bearer ' + token}, '/telemetry')[0] == 403
    headers = {'Origin': origin, 'Authorization': 'Bearer ' + token}
    assert request(headers, '/telemetry')[0] == 503
    telemetry.put(parsed)
    status, result_headers, body = request(headers, '/telemetry')
    reading = json.loads(body)
    assert status == 200 and reading['distance_cm'] == 85.2 and reading['imu']['az'] == 0.99 and 0 <= reading['age_ms'] < 1000
    assert result_headers['Cache-Control'] == 'no-store'
    assert request(headers, '/telemetry?x=1')[0] == 400
    telemetry.at = time.monotonic() - 2
    assert request(headers, '/telemetry')[0] == 503
    preflight = {'Origin': origin, 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization'}
    assert request(preflight, '/telemetry', method='OPTIONS')[0] == 204
finally:
    server.shutdown(); server.server_close(); thread.join(timeout=2)
# Without --telemetry the path does not exist.
plain = m.CameraServer(('127.0.0.1', 0), m.make_handler(m.Frames(), token, {origin}, {'model': 'Fixture'}))
thread = threading.Thread(target=plain.serve_forever, daemon=True); thread.start(); server = plain
try:
    assert request({'Origin': origin, 'Authorization': 'Bearer ' + token}, '/telemetry')[0] == 400
    assert request({'Origin': origin, 'Access-Control-Request-Method': 'GET'}, '/telemetry', method='OPTIONS')[0] == 403
finally:
    plain.shutdown(); plain.server_close(); thread.join(timeout=2)

# The serial reader skips boot noise and split lines, and reopens a port that fails.
class FakePort:
    def __init__(self, chunks): self.chunks = list(chunks); self.closed = False
    in_waiting = 0
    def read(self, size):
        if size == 0: return b''
        if not self.chunks: raise OSError('unplugged')
        return self.chunks.pop(0)
    def close(self): self.closed = True
line = json.dumps(good).encode()
ports = [FakePort([b'rst:0x1 boot\r\n' + line[:20], line[20:] + b'\r\n', b'']), FakePort([json.dumps(dict(good, seq=6)).encode() + b'\n'])]
opened, latest, stopped = [], m.Telemetry(), threading.Event()
def opener():
    if not ports: stopped.set(); raise OSError('gone')
    opened.append(ports.pop(0)); return opened[-1]
worker = threading.Thread(target=m.telemetry_loop, args=(opener, latest, stopped), daemon=True); worker.start()
worker.join(timeout=10)
assert not worker.is_alive() and latest.received == 2 and latest.sample['seq'] == 6
assert all(port.closed for port in opened)

# The capture loop keeps only the newest picture and survives a failing camera.
class Source:
    def __init__(self): self.calls = 0
    def capture(self):
        self.calls += 1
        if self.calls == 2: raise RuntimeError('camera busy')
        return b'\xff\xd8' + bytes([self.calls]) + b'\xff\xd9'
latest = m.Frames(); stopped = threading.Event(); source = Source()
worker = threading.Thread(target=m.capture_loop, args=(source, latest, stopped, 15), daemon=True); worker.start()
deadline = time.monotonic() + 5
while latest.sequence < 2 and time.monotonic() < deadline: time.sleep(0.02)
stopped.set(); worker.join(timeout=2)
assert latest.sequence >= 2 and source.calls >= 3 and latest.jpeg.startswith(b'\xff\xd8')
print('Pi HTTP handler fixtures passed; TLS and hardware not exercised.')
`;
  const result = spawnSync(process.env.ASTHA_PYTHON || 'python', ['-B', '-c', script], { encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.match(result.stdout, /fixtures passed/);
});
function uiSetup(transport) {
  const elements = new Map(), listeners = new Map(), cleared = [], invalidated = [], starts = [], spoken = [];
  for (const id of ['pi-camera-form', 'pi-camera-origin', 'pi-camera-token', 'pi-camera-status', 'pi-camera-device', 'pi-camera-saver', 'pi-camera-connect', 'pi-camera-stop', 'pi-preview', 'viewport', 'overlay']) elements.set(id, {
    id, value: id === 'pi-camera-origin' ? ORIGIN : id === 'pi-camera-token' ? TOKEN : '', hidden: true, checked: false, width: 640, height: 480,
    setAttribute(key, value) { this[key] = value; }, addEventListener(key, fn) { listeners.set(id + ':' + key, fn); }, focus() {},
    getContext() { return { clearRect: () => cleared.push(id), drawImage() {} }; }, insertBefore() {},
  });
  const pick = index => Object.fromEntries(Object.entries(strings).map(([key, pair]) => [key, pair[index]]));
  const context = {
    I18N: { en: pick(0), bn: pick(1) }, uiLang: 'en', state: { source: null, sourceEpoch: 0 }, PiCamera: transport,
    document: { hidden: false, getElementById: id => elements.get(id), querySelectorAll: () => [], addEventListener: (key, fn) => listeners.set('document:' + key, fn) },
    addEventListener: (key, fn) => listeners.set('window:' + key, fn),
    stopLiveLoop() {}, stopAllSpeech() {}, ensureVisionModels: async () => true, startLiveLoop: () => starts.push(true),
    announce: (en, bn) => spoken.push([en, bn]), setCaption() {},
    AsthaExperience: { invalidate: () => invalidated.push(true), admit: () => true },
  };
  context.t = key => context.I18N[context.uiLang][key];
  context.window = context;
  context.showSource = source => { context.state.source = source; context.state.sourceEpoch++; };
  context.stopCamera = () => { context.state.source = null; };
  vm.createContext(context);
  vm.runInContext(uiSource + '\nwindow.adapter = AsthaPiCamera;', context);
  context.adapter.boot();
  return { context, elements, listeners, cleared, invalidated, starts, spoken, ui: context.adapter };
}
test('Pi UI activates only after a frame, clears the pairing input and stops stale source work', async () => {
  let handlers, live = false, stopped = 0;
  const bitmap = { width: 640, height: 480 };
  const h = uiSetup({ async connect(options) { handlers = options; assert.equal(options.token, TOKEN); assert.equal(options.interval, 250); options.onFrame(bitmap); live = true; options.onStatus({ state: 'connected' }); },
    stop() { live = false; stopped++; }, active: () => live, paired: () => live, getFrame: () => live ? bitmap : null, describe: async () => null });
  await h.ui.connect({ preventDefault() {} });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.context.state.source, 'pi'); assert.equal(h.elements.get('pi-preview').hidden, false);
  assert.equal(h.elements.get('pi-camera-token').value, ''); assert.equal(h.ui.frame(), bitmap); assert.equal(h.starts.length, 1);
  assert.deepEqual(h.spoken, [['Wi-Fi camera connected.', strings.pi_connected[1]]], 'the connection is spoken, in both languages');
  assert.equal(h.elements.get('pi-camera-stop').disabled, false);
  h.ui.stop();
  assert.equal(h.context.state.source, null); assert.equal(h.elements.get('pi-preview').hidden, true);
  assert.equal(h.ui.frame(), null); assert.equal(h.invalidated.length, 1); assert.ok(stopped >= 1);
  handlers.onFrame(bitmap); // The obsolete callback cannot revive the preview.
  assert.equal(h.context.state.source, null);
  h.context.uiLang = 'bn'; h.ui.refreshLabels();
  assert.match(h.elements.get('pi-camera-status').textContent, /ওয়াই-ফাই/);
});
test('Pi UI speaks a dropped and restored link, keeps the pairing across a pause and ends on a final error', async () => {
  let handlers;
  const h = uiSetup({ async connect(options) { handlers = options; options.onFrame({ width: 640, height: 480 }); options.onStatus({ state: 'connected' }); },
    stop() {}, active: () => true, paired: () => true, getFrame: () => null,
    describe: async () => ({ model: 'Raspberry Pi Model B Rev 2', backend: 'picamera', width: 640, height: 480 }) });
  h.elements.get('pi-camera-saver').checked = true;
  await h.ui.connect();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(handlers.interval, 1000, 'low-data mode asks for one picture per second');
  assert.equal(h.elements.get('pi-camera-device').textContent, 'Raspberry Pi Model B Rev 2 · picamera · 640×480');
  handlers.onStatus({ state: 'reconnecting', code: 'frame_timeout' });
  assert.equal(h.ui.status, 'reconnecting'); assert.equal(h.context.state.source, 'pi', 'the pairing is kept while retrying');
  assert.equal(h.invalidated.length, 1, 'an answer built on the lost picture is cancelled');
  handlers.onStatus({ state: 'connected' });
  handlers.onStatus({ state: 'paused' });
  assert.equal(h.ui.status, 'paused'); assert.equal(h.context.state.source, 'pi');
  handlers.onStatus({ state: 'reconnecting', code: 'resumed' });
  handlers.onStatus({ state: 'connected' });
  assert.deepEqual(h.spoken.map(pair => pair[0]), ['Wi-Fi camera connected.', 'The Wi-Fi camera link dropped. Trying to reconnect.', 'Wi-Fi camera reconnected.', 'Wi-Fi camera reconnected.']);
  h.elements.get('pi-camera-token').value = 'unsent-private-code';
  handlers.onStatus({ state: 'error', code: 'connection_lost' });
  assert.equal(h.context.state.source, null); assert.equal(h.ui.status, 'connection_lost');
  assert.match(h.spoken.at(-1)[0], /could not be reached again/); assert.equal(h.elements.get('pi-camera-token').value, '');
  assert.equal(h.elements.get('pi-preview').hidden, true); assert.equal(h.elements.get('pi-camera-form')['aria-busy'], 'false');
  assert.equal(h.elements.get('pi-camera-device').hidden, true);
});
test('a rejected pairing is explained aloud and leaves the phone camera available', async () => {
  const h = uiSetup({ async connect() { throw Object.assign(new Error('pairing_rejected'), { code: 'pairing_rejected' }); }, stop() {}, active: () => false, paired: () => false, getFrame: () => null });
  await h.ui.connect();
  assert.equal(h.ui.status, 'pairing_rejected'); assert.equal(h.context.state.source, null);
  assert.deepEqual(h.spoken.map(pair => pair[0]), ['Pairing was rejected. Check the camera address and private pairing code.']);
  assert.equal(h.elements.get('pi-camera-connect').disabled, false);
});
