import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const html = fs.readFileSync(new URL('../web/index.html', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const start = html.indexOf('const I18N = {');
const end = html.indexOf('\n};', start) + 3;
const dictionary = vm.runInNewContext(html.slice(start, end) + '; I18N');
const extra = JSON.parse(/const I18N_EXTRA = (\{.*\});\n/.exec(html)[1]);
for (const [key, pair] of Object.entries(extra)) {
  dictionary.en[key] = pair[0]; dictionary.bn[key] = pair[1];
}
function harness({ yoloFails = false } = {}) {
  const elements = new Map(), log = [];
  const element = id => {
    if (!elements.has(id)) elements.set(id, {
      id, dataset: {}, attributes: new Map(), classes: new Set(), value: '0', textContent: '',
      setAttribute(name, value) { this.attributes.set(name, String(value)); },
      classList: { toggle(name, on) { if (on) elements.get(id).classes.add(name); else elements.get(id).classes.delete(name); } },
    });
    return elements.get(id);
  };
  element('shield-desc').dataset.i18n = 'shield_off';
  element('engine-coco-sub').dataset.i18n = 'engine_coco_sub';
  const fallback = { detect: async () => [] };
  const context = vm.createContext({
    I18N: dictionary, uiLang: 'bn', voiceLang: 'bn', $: element, VOCAB: ['background'],
    state: { shield: true, audio: false, source: null, listening: false, busy: true, hazardCooldown: new Map() },
    engine: { coco: { status: 'idle', model: null }, clip: { status: 'idle' }, ocr: { status: 'idle' } },
    document: { documentElement: {}, querySelectorAll: () => [element('shield-desc'), element('engine-coco-sub')] },
    applyStaticI18n() {}, renderSeen() {}, renderMemory() {}, renderLog() {}, onDistance() {},
    setCaption() {}, speak() {}, playEarcon() {}, showHazard() {}, safetyCheck() {}, announce() {},
    logEvent: text => log.push(text), console: { warn() {}, error() {} }, setTimeout, clearTimeout,
    COCO_CACHE_URL: 'synthetic-model-cache', cocoSsd: { load: async () => fallback },
    YoloDetector: class { provider = 'webgpu'; async load() { if (yoloFails) throw new Error('forced initialization failure'); } },
    localStorage: { setItem() {} },
  });
  const names = ['renderShieldState', 'toggleShield', 'renderDetectorDescription', 'setEngineState', 'applyLanguage', 'loadCoco'];
  const functions = names.map(name => {
    const match = new RegExp('function ' + name + '\\([^]*?\\n\\}').exec(html);
    assert(match, 'generated function missing: ' + name); return match[0];
  });
  vm.runInContext('let cocoPromise = null;\nfunction t(key) { return I18N[uiLang][key] ?? key; }\nfunction tBn(key) { return I18N.bn[key] ?? key; }\n' + functions.join('\n'), context);
  return { context, element, log };
}

test('startup and restored shield state agree with ARIA, style and description in both languages', () => {
  const { context, element } = harness();
  for (const lang of ['bn', 'en']) for (const enabled of [true, false]) {
    context.uiLang = lang; context.state.shield = enabled;
    vm.runInContext('applyLanguage()', context);
    assert.equal(element('shield-btn').attributes.get('aria-pressed'), String(enabled));
    assert.equal(element('shield-btn').classes.has('on'), enabled);
    assert.equal(element('shield-desc').textContent, dictionary[lang][enabled ? 'shield_on' : 'shield_off']);
    assert.equal(element('engine-coco-sub').textContent, dictionary[lang].engine_coco_sub);
  }
});

test('shield toggles use the same bilingual accessible state renderer', () => {
  const { context, element } = harness();
  for (const lang of ['en', 'bn']) {
    context.uiLang = lang; context.state.shield = false;
    for (const enabled of [true, false]) {
      vm.runInContext('toggleShield()', context);
      assert.equal(context.state.shield, enabled);
      assert.equal(element('shield-btn').attributes.get('aria-pressed'), String(enabled));
      assert.equal(element('shield-btn').classes.has('on'), enabled);
      assert.equal(element('shield-desc').textContent, dictionary[lang][enabled ? 'shield_on' : 'shield_off']);
    }
  }
});

test('forced YOLO failure retains actual COCO fallback identity across language changes', async () => {
  const { context, element, log } = harness({ yoloFails: true });
  await vm.runInContext('loadCoco()', context);
  assert.equal(context.engine.coco.type, 'coco-ssd');
  assert.equal(context.engine.coco.status, 'ready');
  for (const lang of ['en', 'bn', 'en']) {
    context.uiLang = lang; vm.runInContext('applyLanguage()', context);
    assert.equal(element('engine-coco-sub').textContent, dictionary[lang].engine_coco_fallback);
    assert.doesNotMatch(element('engine-coco-sub').textContent, /YOLO|WebGL|WebGPU|WASM/i);
  }
  assert.deepEqual(log, ['Vision detector: COCO-SSD (Fallback)']);
});

test('YOLO readiness identifies the model without claiming the requested execution provider', async () => {
  const { context, element, log } = harness();
  await vm.runInContext('loadCoco()', context);
  assert.equal(context.engine.coco.type, 'yolo26n');
  for (const lang of ['en', 'bn']) {
    context.uiLang = lang; vm.runInContext('applyLanguage()', context);
    assert.equal(element('engine-coco-sub').textContent, dictionary[lang].engine_coco_yolo);
    assert.doesNotMatch(element('engine-coco-sub').textContent, /WebGPU|WebGL|WASM/i);
  }
  assert.deepEqual(log, ['Vision detector: YOLO26n']);
});
