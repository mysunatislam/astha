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
  const calls = [], listeners = new Map(), registrations = new Map(), timers = new Map(), frames = [];
  let tick = 0, now = 100;
  const dispatch = (key, reverse = false) => { const callbacks = [...registrations.get(key) || []]; if (reverse) callbacks.reverse(); for (const fn of callbacks) fn(); };
  const addEventListener = (key, fn) => { if (!registrations.has(key)) registrations.set(key, []); registrations.get(key).push(fn); listeners.set(key, () => dispatch(key)); };
  const document = { hidden: false, addEventListener };
  const window = { addEventListener, fetch: (...args) => { calls.push(args); return fetch(...args); } };
  const context = vm.createContext({ window, document, URL, Blob, Uint8Array, AbortController, performance: { now: () => now }, setTimeout: (fn, ms) => { timers.set(++tick, { fn, ms }); return tick; }, clearTimeout: id => timers.delete(id), createImageBitmap: decode || (async () => { const bitmap = { width: 640, height: 480, closed: false, close() { this.closed = true; } }; frames.push(bitmap); return bitmap; }) });
  vm.runInContext(source, context);
  return { pi: window.PiCamera, calls, timers, listeners, document, frames, context, dispatch, advance(ms) { now += ms; }, async run(ms) { const entry = [...timers.entries()].find(([, t]) => t.ms === ms); assert.ok(entry, 'no ' + ms + ' ms timer is pending'); timers.delete(entry[0]); await entry[1].fn(); },
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

// Use the generated application's actual lifecycle handlers and stopCamera with the
// real paired transport/UI. Testing transport.pause alone misses app-level cleanup.
function lifecycleSetup(fetch, { realLoops = false, realAgent = false } = {}) {
  const h = setup(fetch), elements = new Map(), counts = { listeningStops: 0, speechStops: 0, liveStops: 0, sensorClears: 0,
    ingests: 0, updates: 0, refinements: 0, overlays: 0, visionClears: 0, previewClears: 0, pendingCancels: 0, speech: 0 };
  const element = id => {
    if (!elements.has(id)) elements.set(id, {
      id, hidden: true, value: id === 'pi-camera-origin' ? ORIGIN : id === 'pi-camera-token' ? TOKEN : '',
      checked: false, width: 640, height: 480, srcObject: null,
      setAttribute() {}, addEventListener() {}, focus() {}, insertBefore() {}, classList: { toggle() {} },
      getContext: () => ({ drawImage() {}, clearRect() { if (id === 'pi-preview') counts.previewClears++; } }),
    });
    return elements.get(id);
  };
  const pick = index => Object.fromEntries(Object.entries(strings).map(([key, pair]) => [key, pair[index]]));
  Object.assign(h.document, { getElementById: element, querySelectorAll: () => [] });
  Object.assign(h.context, {
    PiCamera: h.pi, I18N: { en: pick(0), bn: pick(1) }, $: element,
    state: { source: null, sourceEpoch: 0, world: new Map(), announced: new Map(), lastCocoPreds: [], lastClipHits: [] }, cameraRequest: 0, imageUrl: null,
    localStorage: { getItem: () => null }, VAULT_KEY: 'synthetic-vault', updateVoiceSupport() {},
    stopListening: () => counts.listeningStops++, stopAllSpeech: () => counts.speechStops++,
    stopLiveLoop: () => counts.liveStops++, startLiveLoop() {}, ensureVisionModels: async () => true,
    AsthaSensors: { clear: () => counts.sensorClears++ },
    AsthaExperience: { invalidate() {}, cancelPending: () => counts.pendingCancels++, admit: () => true },
    AsthaVisionDetails: { sourceChanged: () => counts.visionClears++ },
    showHazard() {}, updateSourceStatus() {}, clearOverlay() {}, renderSeen() {}, announce: () => counts.speech++, setCaption() {},
    engine: { coco: { status: 'ready' }, clip: { status: 'ready' } },
  });
  h.context.t = key => h.context.I18N.en[key] || key;
  const html = fs.readFileSync(new URL('../web/index.html', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const actual = name => {
    const matches = [...html.matchAll(new RegExp('^(?:async )?function ' + name + '\\(', 'gm'))];
    assert(matches.length, 'generated app function missing: ' + name);
    const start = matches.at(-1).index, lineEnd = html.indexOf('\n', start);
    // stopLiveLoop is intentionally one line; the other application functions end at column zero.
    return html.slice(start, name === 'stopLiveLoop' ? lineEnd : html.indexOf('\n}', lineEnd) + 2);
  };
  let runtime = '';
  if (realLoops) {
    const pending = { coco: [], clip: [], edges: [] };
    Object.assign(h.context, {
      console, privacyMode: false, privacyTransition: false,
      captureFrame: () => h.pi.getFrame(),
      runCoco: () => new Promise(resolve => pending.coco.push(resolve)),
      runClipZones: () => new Promise(resolve => pending.clip.push(resolve)),
      ingest: () => counts.ingests++, drawOverlay: () => counts.overlays++, afterLiveUpdate: () => { counts.updates++; counts.speech++; },
      liveRefineAndMirror: async () => counts.refinements++, trackPersonMotion() {}, ownerAutoCheck() {},
      EdgeAndStairsDetector: { evaluate: () => new Promise(resolve => pending.edges.push(resolve)) },
      VoiceEngine: { stop: () => counts.speechStops++, emergencyAlert: () => counts.speech++ },
      reading: { active: false }, stopReader() {}, OfflineEar: { active: false }, logEvent() {},
    });
    const cancellation = /const AsthaCancellation = \{[^]*?\n\};/.exec(html);
    assert(cancellation, 'generated cancellation coordinator missing');
    runtime = cancellation[0] + '\n' + ['captureLocalActionGuard', 'startLiveLoop', 'stopLiveLoop', 'cocoTick', 'clipTick', 'stopAllSpeech'].map(actual).join('\n') +
      '\nglobalThis.cancellation = AsthaCancellation;';
    h.pending = pending;
  }
  if (realAgent) {
    assert(realLoops, 'agent lifecycle tests use actual app cancellation');
    Object.assign(h.context, { esc: text => text, withCamera: () => false, playEarcon() {}, haptic() {},
      serverCloud: { available: true }, apiUrl: path => 'https://api.fixture.invalid' + path,
      remoteProcessingAllowed: () => !h.context.privacyMode && !h.context.privacyTransition, frameToJpeg: () => 'synthetic-image' });
    const start = html.indexOf('const AGENT_SYNONYMS = '), end = html.indexOf('window.AsthaAgent = AsthaAgent;', start);
    assert(start >= 0 && end > start, 'generated agent implementation missing');
    runtime += '\n' + html.slice(start, end + 'window.AsthaAgent = AsthaAgent;'.length);
  }
  vm.runInContext(uiSource + '\n' + actual('showSource') + '\n' + actual('stopCamera') + '\n' + actual('enhancementBoot') + '\n' + runtime +
    '\nglobalThis.piAdapter = AsthaPiCamera; AsthaPiCamera.boot(); enhancementBoot();', h.context);
  return Object.assign(h, { elements, counts, element, ui: h.context.piAdapter });
}

test('generated app preserves Pi pairing across hidden and visible events, including a late aborted frame', async () => {
  for (const reverse of [false, true]) {
    let sequence = 0, delayed = false, release;
    const h = lifecycleSetup(async url => {
      if (url.endsWith('/status')) return new Response(JSON.stringify({ telemetry: true }), { status: 200 });
      if (url.endsWith('/telemetry')) return new Response(JSON.stringify({ seq: sequence, distance_cm: 85, distance_status: 'ok', age_ms: 0 }), { status: 200 });
      const result = reply({ sequence: String(++sequence) });
      if (delayed) return new Promise(resolve => { release = () => resolve(result); });
      return result;
    });
    await h.ui.connect(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.context.state.source, 'pi'); assert.equal(h.pi.active(), true);
    assert.equal(h.element('pi-camera-token').value, '');
    const clearsBefore = h.counts.sensorClears;
    delayed = true;
    const inFlight = h.poll();
    const signal = h.calls.at(-1)[1].signal;
    h.document.hidden = true; h.dispatch('visibilitychange', reverse);
    assert.equal(signal.aborted, true); assert.equal(h.pi.paired(), true, 'app cleanup must retain the transport session');
    assert.equal(h.context.state.source, 'pi'); assert.equal(h.ui.status, 'paused');
    assert.equal(h.pi.active(), false); assert.equal(h.pi.getFrame(), null); assert.equal(h.frames[0].closed, true);
    assert(h.counts.listeningStops >= 1); assert(h.counts.sensorClears > clearsBefore, 'pause withholds the old sensor reading');
    assert.equal([...h.timers.values()].some(timer => [0, 200, 250].includes(timer.ms)), false, 'neither frame nor telemetry polling continues while hidden');
    release(); await inFlight; await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.frames.length, 1, 'the late cancelled response cannot decode or reactivate a preview');
    assert.equal(h.pi.getFrame(), null); assert.equal(h.ui.status, 'paused'); assert.equal(h.timers.size, 0);
    delayed = false; h.document.hidden = false; h.dispatch('visibilitychange', reverse);
    await h.run(0); await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.pi.paired(), true); assert.equal(h.pi.active(), true); assert.equal(h.ui.status, 'connected');
    assert.equal(h.context.state.source, 'pi'); assert.equal(h.pi.getFrame(), h.frames[1]);
    assert.equal(h.calls.filter(([url]) => new URL(url).pathname === '/frame').at(-1)[1].headers.Authorization, 'Bearer ' + TOKEN);
    assert.equal(h.element('pi-camera-token').value, '', 'resume never asks the user to re-enter the code');
    const telemetry = [...h.timers.entries()].find(([, timer]) => timer.ms === 0);
    assert(telemetry, 'telemetry resumes with the retained session');
    h.timers.delete(telemetry[0]); await telemetry[1].fn();
    assert(h.calls.some(([url]) => new URL(url).pathname === '/telemetry'));
    h.dispatch('pagehide', reverse);
    assert.equal(h.pi.paired(), false); assert.equal(h.pi.active(), false); assert.equal(h.pi.getFrame(), null);
    assert.equal(h.context.state.source, null); assert.equal(h.timers.size, 0);
    assert(h.counts.sensorClears > clearsBefore); assert(h.counts.speechStops > 0);
    const requests = h.calls.length;
    h.document.hidden = false; h.dispatch('visibilitychange', reverse);
    assert.equal(h.calls.length, requests); assert.equal(h.timers.size, 0, 'pagehide ends pairing instead of resuming it');
  }
});

test('generated app still stops phone camera tracks and pending camera startup when hidden', () => {
  const h = lifecycleSetup(); let stopped = 0;
  h.context.state.source = 'camera'; h.context.state.cameraPending = true;
  h.element('cam').srcObject = { getTracks: () => [{ stop: () => stopped++ }, { stop: () => stopped++ }] };
  h.document.hidden = true; h.dispatch('visibilitychange');
  assert.equal(stopped, 2); assert.equal(h.element('cam').srcObject, null);
  assert.equal(h.context.state.source, null); assert.equal(h.context.state.cameraPending, false);
  assert.equal(h.context.cameraRequest, 1); assert.equal(h.counts.listeningStops, 1);
  assert.equal(h.pi.paired(), false); assert.equal(h.timers.size, 0);
});

test('actual recognition loops discard pre-pause COCO and CLIP results and restart only with a fresh visible frame', async () => {
  for (const completeAfterResume of [false, true]) {
    let sequence = 0;
    const h = lifecycleSetup(async () => reply({ sequence: String(++sequence) }), { realLoops: true });
    const flush = () => new Promise(resolve => setImmediate(resolve));
    await h.ui.connect(); await flush();
    const oldLoop = h.context.state.liveLoop, oldEpoch = h.context.state.sourceEpoch;
    assert(oldLoop?.active); assert.equal(h.pending.coco.length, 1); assert.equal(h.pending.clip.length, 1);
    h.context.state.world.set('stale', {}); h.context.state.announced.set('stale', true);
    h.context.state.pendingAction = () => assert.fail('cancelled camera action ran');
    h.context.state.pendingRead = true; h.context.state.busy = true; h.context.state.busyToken = Symbol();
    const controller = new AbortController(); h.context.cancellation.controllers.add(controller);
    const localAction = h.context.captureLocalActionGuard();
    const countsBefore = { ...h.counts };
    h.document.hidden = true; h.dispatch('visibilitychange');
    assert.equal(h.pi.paired(), true); assert.equal(h.context.state.source, 'pi');
    assert.equal(oldLoop.active, false); assert.equal(h.context.state.liveLoop, null);
    assert(h.context.state.sourceEpoch > oldEpoch); assert.equal(localAction(), false);
    assert.equal(h.context.state.world.size, 0); assert.equal(h.context.state.announced.size, 0);
    assert.equal(h.context.state.pendingAction, null); assert.equal(h.context.state.pendingRead, false);
    assert.equal(h.context.state.busy, false); assert.equal(h.context.state.busyToken, null);
    assert(controller.signal.aborted); assert(h.counts.pendingCancels > countsBefore.pendingCancels);
    assert(h.counts.speechStops > countsBefore.speechStops); assert(h.counts.visionClears > countsBefore.visionClears);
    assert.equal(h.element('pi-preview').hidden, true); assert(h.counts.previewClears > countsBefore.previewClears);
    const finishOld = async () => {
      const spokenBefore = h.counts.speech;
      h.pending.coco[0]([{ id: 'stale-coco', src: 'coco' }]);
      h.pending.clip[0]({ hits: [{ id: 'stale-clip', src: 'clip' }], center: [] });
      await flush();
      for (const key of ['ingests', 'updates', 'refinements', 'overlays']) assert.equal(h.counts[key], countsBefore[key], key + ' from an obsolete frame');
      assert.equal(h.counts.speech, spokenBefore, 'speech from an obsolete frame');
    };
    if (!completeAfterResume) await finishOld();
    h.document.hidden = false; h.dispatch('visibilitychange');
    assert.equal(h.context.state.liveLoop, null, 'becoming visible cannot analyze a pre-pause picture');
    assert.equal(h.pending.coco.length, 1);
    await h.run(0); await flush();
    const nextLoop = h.context.state.liveLoop;
    assert(nextLoop?.active); assert.notEqual(nextLoop, oldLoop);
    assert.equal(h.pending.coco.length, 2); assert.equal(h.pending.clip.length, 2);
    assert.equal(h.element('pi-preview').hidden, false);
    if (completeAfterResume) await finishOld();
    assert.equal(h.context.state.liveLoop, nextLoop, 'old completions cannot clear the new loop');
    h.pending.coco[1]([]); h.pending.clip[1]({ hits: [], center: [] }); await flush();
    assert.equal(h.counts.ingests, countsBefore.ingests + 2); assert.equal(h.counts.updates, countsBefore.updates + 2);
    assert.equal(h.counts.refinements, countsBefore.refinements + 1, 'fresh recognition resumes normally');
    h.dispatch('pagehide');
  }
});

test('an edge hazard already evaluating before Pi pause cannot speak after pause or a quick resume', async () => {
  let sequence = 0;
  const h = lifecycleSetup(async () => reply({ sequence: String(++sequence) }), { realLoops: true });
  const flush = () => new Promise(resolve => setImmediate(resolve));
  await h.ui.connect(); await flush();
  h.pending.coco[0]([]); await flush();
  assert.equal(h.pending.edges.length, 1);
  h.document.hidden = true; h.dispatch('visibilitychange');
  h.document.hidden = false; h.dispatch('visibilitychange'); await h.run(0); await flush();
  const spokenBefore = h.counts.speech;
  h.pending.edges[0]({ en: 'Old edge warning', bn: 'Old warning', type: 'edge' }); await flush();
  assert.equal(h.counts.speech, spokenBefore, 'a pre-pause hazard must not interrupt the resumed session');
  h.dispatch('pagehide');
});

test('model readiness while Pi is paused cannot start recognition until a fresh visible frame arrives', async () => {
  let sequence = 0, ready;
  const h = lifecycleSetup(async () => reply({ sequence: String(++sequence) }), { realLoops: true });
  h.context.engine.coco.status = 'loading';
  h.context.ensureVisionModels = () => new Promise(resolve => { ready = resolve; });
  const flush = () => new Promise(resolve => setImmediate(resolve));
  await h.ui.connect();
  h.document.hidden = true; h.dispatch('visibilitychange');
  h.context.engine.coco.status = 'ready'; ready(true); await flush();
  assert.equal(h.context.state.liveLoop, null); assert.equal(h.pending.coco.length, 0);
  h.document.hidden = false; h.dispatch('visibilitychange');
  assert.equal(h.context.state.liveLoop, null);
  await h.run(0); await flush();
  assert(h.context.state.liveLoop?.active); assert.equal(h.pending.coco.length, 1);
  h.dispatch('pagehide');
});

test('actual delayed agent planning is aborted on Pi pause and cannot finish in the resumed session', async () => {
  let sequence = 0, finishPlan, planSignal;
  const h = lifecycleSetup(async () => reply({ sequence: String(++sequence) }), { realLoops: true, realAgent: true });
  h.context.fetch = (_url, options) => { planSignal = options.signal; return new Promise(resolve => { finishPlan = resolve; }); };
  const flush = () => new Promise(resolve => setImmediate(resolve));
  await h.ui.connect(); await flush();
  const agent = h.context.window.AsthaAgent;
  const running = agent.run('find my phone'); await flush();
  assert.equal(agent.state, 'PLANNING'); assert.equal(h.context.cancellation.controllers.size, 1);
  h.document.hidden = true; h.dispatch('visibilitychange');
  assert(planSignal.aborted); assert.equal(agent.state, 'IDLE'); assert.equal(agent.currentTask, null);
  h.document.hidden = false; h.dispatch('visibilitychange'); await h.run(0); await flush();
  const speechBefore = h.counts.speech;
  finishPlan(new Response(JSON.stringify({ plan: { steps: [{ tool: 'tool_spatial_guidance', args: { instruction_en: 'Obsolete guidance' } }] } }), { status: 200 }));
  await running;
  assert.equal(agent.state, 'IDLE'); assert.equal(agent.observations.length, 0);
  assert.equal(h.counts.speech, speechBefore); assert.equal(h.context.cancellation.controllers.size, 0);
  h.dispatch('pagehide');
});

test('actual old agent inference cannot overwrite or complete a newer run after Pi resumes', async () => {
  let sequence = 0;
  const h = lifecycleSetup(async () => reply({ sequence: String(++sequence) }), { realLoops: true, realAgent: true });
  h.context.fetch = async () => new Response(JSON.stringify({ plan: { steps: [{ id: 'detect', tool: 'tool_vision_detect', args: { target_item: 'phone' } }] } }), { status: 200 });
  const flush = () => new Promise(resolve => setImmediate(resolve));
  await h.ui.connect(); await flush();
  const agent = h.context.window.AsthaAgent;
  const old = agent.run('find my phone'); await flush();
  assert.equal(agent.state, 'EXECUTING'); assert.equal(h.pending.coco.length, 2);
  h.document.hidden = true; h.dispatch('visibilitychange');
  h.document.hidden = false; h.dispatch('visibilitychange'); await h.run(0); await flush();
  const newer = agent.run('find my new phone'); await flush();
  assert.equal(h.pending.coco.length, 4);
  const speechBefore = h.counts.speech;
  h.pending.coco[1]([{ id: 'phone', score: 0.99, bbox: [0, 0, 100, 100] }]); await old;
  assert.equal(agent.state, 'EXECUTING'); assert.equal(agent.currentTask.goal, 'find my new phone');
  assert.equal(agent.observations.length, 0); assert.equal(h.context.state.lastCocoPreds.length, 0);
  assert.equal(h.counts.speech, speechBefore, 'the old run produces no completion or corrective guidance');
  h.pending.coco[3]([{ id: 'phone', score: 0.9, bbox: [100, 100, 100, 100] }]); await newer;
  assert.equal(agent.state, 'COMPLETED'); assert.equal(agent.observations.length, 1);
  assert.equal(h.context.state.lastCocoPreds[0].score, 0.9); assert.equal(h.counts.speech, speechBefore + 1);
  h.dispatch('pagehide');
});

test('actual agent discards delayed inference when source, account, local owner or privacy changes', async () => {
  for (const change of [h => h.context.state.sourceEpoch++, h => { h.context.window.ASTHA_ACCOUNT_ID = 'other-account'; },
    h => { h.context.LocalStore.KEY = 'other-owner'; }, h => { h.context.privacyMode = true; }]) {
    let sequence = 0;
    const h = lifecycleSetup(async () => reply({ sequence: String(++sequence) }), { realLoops: true, realAgent: true });
    h.context.LocalStore = { KEY: 'initial-owner' };
    h.context.fetch = async () => new Response(JSON.stringify({ plan: { steps: [{ id: 'detect', tool: 'tool_vision_detect', args: { target_item: 'phone' } }] } }), { status: 200 });
    await h.ui.connect(); await new Promise(resolve => setImmediate(resolve));
    const agent = h.context.window.AsthaAgent, running = agent.run('find my phone');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.pending.coco.length, 2);
    const speechBefore = h.counts.speech;
    change(h); h.pending.coco[1]([{ id: 'phone', score: 0.9, bbox: [0, 0, 100, 100] }]); await running;
    assert.equal(agent.state, 'IDLE'); assert.equal(agent.currentTask, null); assert.equal(agent.observations.length, 0);
    assert.equal(h.context.state.lastCocoPreds.length, 0); assert.equal(h.counts.speech, speechBefore);
    h.dispatch('pagehide');
  }
});

test('actual agent OCR does not start fallback or recognition after cancellation during cloud or worker setup', async () => {
  for (const stage of ['cloud', 'worker']) {
    let sequence = 0, release, current = true, workerLoads = 0, recognitions = 0;
    const h = lifecycleSetup(async () => reply({ sequence: String(++sequence) }), { realLoops: true, realAgent: true });
    h.context.cloudReady = () => stage === 'cloud';
    h.context.cloudReadLines = () => new Promise((_, reject) => { release = () => reject(new Error('cancelled')); });
    h.context.ensureOcr = () => { workerLoads++; return new Promise(resolve => { release = () => resolve({ recognize: async () => { recognitions++; return { data: { lines: [] } }; } }); }); };
    const running = h.context.window.AsthaToolRegistry.call('tool_ocr_read', {}, { frame: {}, current: () => current });
    await new Promise(resolve => setImmediate(resolve));
    current = false; release();
    assert.equal((await running).error, 'cancelled'); assert.equal(recognitions, 0);
    assert.equal(workerLoads, stage === 'cloud' ? 0 : 1);
  }
});

test('actual agent planner respects remote consent and completed-task timers cannot clear a newer run', async () => {
  let sequence = 0, planningRequests = 0;
  const h = lifecycleSetup(async () => reply({ sequence: String(++sequence) }), { realLoops: true, realAgent: true });
  h.context.fetch = async () => { planningRequests++; return new Response(JSON.stringify({ plan: { steps: [] } }), { status: 200 }); };
  h.context.remoteProcessingAllowed = () => false;
  const agent = h.context.window.AsthaAgent;
  const fallback = await agent.plan('find my phone', null);
  assert(fallback.steps.length > 0); assert.equal(planningRequests, 0);
  h.context.remoteProcessingAllowed = () => true;
  await h.ui.connect(); await new Promise(resolve => setImmediate(resolve));
  h.context.fetch = async () => new Response(JSON.stringify({ plan: { steps: [{ id: 'rag', tool: 'tool_rag_retrieve', args: {} }] } }), { status: 200 });
  h.context.apiSend = async () => ({ memories: [{ item: 'phone' }], rooms: [] });
  await agent.run('first task'); assert.equal(agent.state, 'COMPLETED');
  const oldTimer = [...h.timers.entries()].find(([, timer]) => timer.ms === 12000); assert(oldTimer);
  await agent.run('second task'); assert.equal(agent.state, 'COMPLETED');
  h.timers.delete(oldTimer[0]); oldTimer[1].fn();
  assert.equal(agent.state, 'COMPLETED'); assert.equal(agent.currentTask.goal, 'second task');
  h.dispatch('pagehide');
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
    engine: { coco: { status: 'ready' } },
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
test('distance readings are polled only from a Pi with a sensor, validated, and stopped with the pairing', async () => {
  const flush = async () => { for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve)); };
  const json = (body, status = 200) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const sample = (seq, extra = {}) => ({ seq, distance_cm: 85.2, distance_status: 'ok', imu: null, imu_status: 'not_found', age_ms: 40, ...extra });
  let sequence = 0, hasSensor = true;
  const queue = [];
  const route = async url => {
    if (url.endsWith('/status')) return json({ model: 'Pi', telemetry: hasSensor });
    if (url.endsWith('/telemetry')) return queue.shift() || json('', 503);
    return reply({ sequence: String(++sequence) });
  };
  const h = setup(route), readings = [];
  await h.pi.connect({ origin: ORIGIN, token: TOKEN, onTelemetry: reading => readings.push(reading) });
  await flush();
  const paths = () => h.calls.map(([url]) => new URL(url).pathname);
  assert.deepEqual(paths(), ['/frame', '/status']);
  queue.push(json(sample(1)));
  await h.run(0); await flush();
  const plain = value => JSON.parse(JSON.stringify(value));   // readings are made inside the sandbox
  assert.deepEqual(plain(readings), [{ distanceM: 0.852, status: 'ok', seq: 1, ageMs: 40 }]);
  assert.equal(h.calls.at(-1)[1].headers.Authorization, 'Bearer ' + TOKEN); assert.equal(h.calls.at(-1)[1].credentials, 'omit');
  // A repeated reading, malformed ones and an unavailable sensor deliver nothing new.
  for (const response of [json(sample(1)), json(sample(2, { distance_cm: '85' })), json(sample(2, { distance_cm: 900 })),
    json(sample(2, { age_ms: 5000 })), json(sample(2, { distance_status: 'made_up' })), json(sample(2, { distance_status: 'out_of_range' })),
    json('{not json'), json('', 503), json('x'.repeat(3000))]) {
    queue.push(response); await h.run(200); await flush();
  }
  assert.equal(readings.length, 1);
  queue.push(json(sample(3, { distance_cm: null, distance_status: 'out_of_range' })));
  await h.run(200); await flush();
  assert.deepEqual(plain(readings.at(-1)), { distanceM: null, status: 'out_of_range', seq: 3, ageMs: 40 });
  // In the background nothing is requested; coming back resumes.
  h.listeners.get('visibilitychange'); h.document.hidden = true; h.listeners.get('visibilitychange')();
  assert.equal([...h.timers.values()].some(timer => timer.ms === 200 || timer.ms === 0), false);
  h.document.hidden = false; h.listeners.get('visibilitychange')();
  queue.push(json(sample(4, { distance_cm: 120 })));
  const telemetryTimer = [...h.timers.entries()].filter(([, timer]) => timer.ms === 0).at(-1);
  h.timers.delete(telemetryTimer[0]); await telemetryTimer[1].fn(); await flush();
  assert.equal(readings.at(-1).distanceM, 1.2);
  h.pi.stop();
  assert.equal([...h.timers.values()].some(timer => timer.ms === 200), false, 'stop ends the polling');
  // A Pi without the sensor is never asked; a rejected token ends the polling.
  hasSensor = false;
  const noSensor = setup(route);
  await noSensor.pi.connect({ origin: ORIGIN, token: TOKEN, onTelemetry: () => assert.fail('no sensor') }); await flush();
  assert.equal(noSensor.calls.some(([url]) => url.endsWith('/telemetry')), false);
  hasSensor = true;
  const rejected = setup(route);
  await rejected.pi.connect({ origin: ORIGIN, token: TOKEN, onTelemetry: () => assert.fail('rejected') }); await flush();
  queue.length = 0; queue.push(json('', 401));
  await rejected.run(0); await flush();
  assert.equal([...rejected.timers.values()].some(timer => timer.ms === 200), false);
  rejected.pi.stop(); noSensor.pi.stop();
});
test('Pi UI passes each distance to the sensor interface with its age and forgets it on stop', async () => {
  let handlers;
  const reports = [];
  const h = uiSetup({ async connect(options) { handlers = options; options.onFrame({ width: 640, height: 480 }); options.onStatus({ state: 'connected' }); },
    stop() {}, active: () => true, paired: () => true, getFrame: () => null,
    describe: async () => ({ model: 'Raspberry Pi 4 Model B Rev 1.4', backend: 'picamera2', width: 640, height: 480, telemetry: true }) });
  h.context.AsthaSensors = { report: (...args) => reports.push(args), clear: () => reports.push('clear') };
  await h.ui.connect();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.elements.get('pi-camera-device').textContent, 'Raspberry Pi 4 Model B Rev 1.4 · picamera2 · 640×480 · distance sensor');
  reports.length = 0;
  const before = Date.now();
  handlers.onTelemetry({ distanceM: 0.85, status: 'ok', seq: 1, ageMs: 40 });
  handlers.onTelemetry({ distanceM: null, status: 'out_of_range', seq: 2, ageMs: 10 });
  assert.equal(reports.length, 1);
  const [channel, metres, origin, at] = reports[0];
  assert.deepEqual([channel, metres, origin], ['front', 0.85, 'ultrasonic']);
  assert.ok(at <= Date.now() - 40 && at >= before - 40, 'the reading is dated by its own age');
  h.ui.stop();
  assert.equal(reports.at(-1), 'clear');
  handlers.onTelemetry({ distanceM: 0.5, status: 'ok', seq: 3, ageMs: 0 });
  assert.equal(reports.at(-1), 'clear', 'a reading after Stop is ignored');
});
