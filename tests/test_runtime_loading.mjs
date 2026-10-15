// These tests exercise startup dependencies with deferred scripts, not CDN or model speed.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const loader = fs.readFileSync(new URL('../tools/runtime-loader.js', import.meta.url), 'utf8');
const base = fs.readFileSync(new URL('../tools/base.html', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const pipeline = base.slice(base.indexOf('async function ensureVisionModels() {'), base.indexOf('function captureFrame('));
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function harness({ yoloFails = false } = {}) {
  const scripts = [], timers = new Map(), events = [], worker = { recognize() {} }, fallback = { detect() {} };
  let nextTimer = 0;
  const context = vm.createContext({
    document: {
      head: { appendChild: script => scripts.push(script) },
      createElement: tag => tag === 'canvas' ? { getContext: () => ({}) } : {
        removed: false, remove() { this.removed = true; },
      },
    },
    navigator: {}, console: { log() {}, warn() {}, error() {} },
    setTimeout: callback => { const id = ++nextTimer; timers.set(id, callback); return id; },
    clearTimeout: id => timers.delete(id),
    engine: { coco: { status: 'idle', model: null }, ocr: { status: 'idle', workers: {} } },
    setEngineState: (name, status) => { context.engine[name].status = status; },
    setProgress() {}, logEvent: message => events.push(message), announce() {}, t: key => key,
    $: () => ({ value: 'eng+ben' }),
  });
  vm.runInContext(loader + '\n' + pipeline + '\nYoloDetector.getCachedModel = async () => new ArrayBuffer(8);', context);
  const run = script => vm.runInContext(script, context);
  const load = script => {
    if (script.src.includes('onnxruntime-web')) context.ort = { InferenceSession: { create: async () => {
      if (yoloFails) throw new Error('Synthetic model initialization failure');
      events.push('yolo initialized'); return {};
    } } };
    else if (script.src.includes('@tensorflow/tfjs')) context.tf = {};
    else if (script.src.includes('coco-ssd')) context.cocoSsd = { load: async () => { events.push('coco initialized'); return fallback; } };
    else if (script.src.includes('tesseract.js')) context.Tesseract = { createWorker: async langs => { events.push('ocr initialized ' + langs); return worker; } };
    else throw new Error('Unexpected runtime: ' + script.src);
    script.onload();
  };
  return { context, scripts, timers, events, worker, fallback, load, run };
}

test('loading the app declares local inference without requesting any runtime or model', () => {
  const h = harness();
  assert.deepEqual(h.scripts, []);
  assert.deepEqual(h.events, []);
  assert.equal(h.timers.size, 0);
  const html = fs.readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
  assert.doesNotMatch(html, /<script\b[^>]*src=["']https:\/\/cdn\.jsdelivr\.net/);
  const boot = html.slice(html.indexOf('window.__asthaBoot = function boot() {'));
  assert.doesNotMatch(boot, /setTimeout\([^\n]*loadCoco/);
});

test('concurrent model requests share one runtime and never download the fallback or OCR on YOLO success', async () => {
  const h = harness();
  const first = h.run('loadCoco()'), second = h.run('loadCoco()'), ready = h.run('ensureVisionModels()');
  assert.equal(first, second);
  await flush();
  assert.equal(h.scripts.length, 1); assert.match(h.scripts[0].src, /onnxruntime-web@1\.21\.0/);
  h.load(h.scripts[0]);
  assert.equal(await ready, true); await first;
  assert.equal(h.context.engine.coco.type, 'yolo26n');
  assert.equal(h.scripts.length, 1); assert.equal(h.timers.size, 0);
  assert.deepEqual(h.events, ['yolo initialized', 'Vision detector: YOLO26n', 'log_models']);
});

test('a failed YOLO model lazily loads TensorFlow before COCO and preserves the working fallback', async () => {
  const h = harness({ yoloFails: true }), ready = h.run('ensureVisionModels()');
  await flush(); h.load(h.scripts[0]); await flush();
  assert.equal(h.scripts.length, 2); assert.match(h.scripts[1].src, /@tensorflow\/tfjs@4\.20\.0/);
  h.load(h.scripts[1]); await flush();
  assert.equal(h.scripts.length, 3); assert.match(h.scripts[2].src, /coco-ssd@2\.2\.3/);
  h.load(h.scripts[2]);
  assert.equal(await ready, true);
  assert.equal(h.context.engine.coco.model, h.fallback);
  assert.equal(h.context.engine.coco.type, 'coco-ssd');
  assert.equal(h.scripts.some(script => script.src.includes('tesseract')), false);
  assert.equal(h.timers.size, 0);
});

test('a CDN failure still permits COCO fallback and a later local model retry', async () => {
  const h = harness(), first = h.run('ensureVisionModels()');
  await flush(); h.scripts[0].onerror(); await flush();
  assert.equal(h.scripts[0].removed, true);
  h.load(h.scripts[1]); await flush();
  h.scripts[2].onerror();
  assert.equal(await first, false); assert.equal(h.context.engine.coco.status, 'error');
  const retry = h.run('ensureVisionModels()'); await flush();
  assert.equal(h.scripts.length, 4); assert.match(h.scripts[3].src, /onnxruntime-web/);
  h.load(h.scripts[3]); assert.equal(await retry, true);
  assert.equal(h.context.engine.coco.type, 'yolo26n'); assert.equal(h.timers.size, 0);
});

test('OCR waits for its own runtime and reuses the worker without loading object detectors', async () => {
  const h = harness(), pending = h.run('ensureOcr()');
  await flush();
  assert.deepEqual(h.events, []); assert.equal(h.scripts.length, 1);
  assert.match(h.scripts[0].src, /tesseract\.js@5\.1\.1/);
  h.load(h.scripts[0]); assert.equal(await pending, h.worker);
  assert.equal(await h.run('ensureOcr()'), h.worker); assert.equal(h.scripts.length, 1);
  assert.deepEqual(h.events, ['ocr initialized eng+ben']); assert.equal(h.timers.size, 0);
});

test('runtime callers share a bounded wait, then can retry after a stalled CDN', async () => {
  const h = harness(), first = h.run("ensureVisionRuntime('ocr')"), second = h.run("ensureVisionRuntime('ocr')");
  assert.equal(first, second); await flush();
  assert.equal(h.scripts.length, 1);
  const rejected = assert.rejects(first, /timed out/);
  [...h.timers.values()][0](); await rejected;
  assert.equal(h.scripts[0].removed, true); assert.equal(h.scripts[0].onload, null);
  const retry = h.run("ensureVisionRuntime('ocr')"); await flush();
  assert.equal(h.scripts.length, 2); h.load(h.scripts[1]); await retry;
  assert.equal(h.timers.size, 0);
});
