import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n');
const html = read('web/index.html');
const table = JSON.parse(read('tools/i18n.json'));
const bodyStart = html.indexOf('<body');
const markup = html.slice(bodyStart, html.indexOf('<script', bodyStart));
const script = html.slice(html.indexOf('<script', bodyStart));

// The dictionary exactly as the page builds it: the original object plus the inlined table.
const dictionary = (() => {
  const start = script.indexOf('const I18N = {');
  const end = script.indexOf('\n};', start) + 3;
  const extra = /const I18N_EXTRA = (\{.*\});\n/.exec(script);
  assert(start >= 0 && end > start && extra, 'generated page must define both dictionaries');
  const I18N = vm.runInNewContext(script.slice(start, end) + '; I18N');
  for (const [key, pair] of Object.entries(JSON.parse(extra[1]))) { I18N.en[key] = pair[0]; I18N.bn[key] = pair[1]; }
  return I18N;
})();
const placeholders = text => (text.match(/\{[a-z]+\}/g) || []).sort().join(',');
const BENGALI = /[ঀ-৿]/;

test('every added string has an English and a Bangla form with the same placeholders', () => {
  const keys = Object.keys(table.strings);
  assert(keys.length >= 150);
  for (const key of keys) {
    const pair = table.strings[key];
    assert(Array.isArray(pair) && pair.length === 2, key + ' must be an [English, Bangla] pair');
    assert(pair.every(text => typeof text === 'string' && text.trim()), key + ' must not be empty');
    assert(BENGALI.test(pair[1]), key + ' has no Bangla text');
    assert.equal(placeholders(pair[0]), placeholders(pair[1]), key + ' placeholders differ between languages');
    assert.match(key, /^[a-z][a-z0-9_]*$/);
  }
});

test('both languages define exactly the same keys, including the original dictionary', () => {
  const en = Object.keys(dictionary.en).sort(), bn = Object.keys(dictionary.bn).sort();
  assert.deepEqual(en, bn);
  assert(en.length >= 330);
  for (const key of en) {
    assert.equal(typeof dictionary.en[key], 'string'); assert.equal(typeof dictionary.bn[key], 'string');
    assert.equal(placeholders(dictionary.en[key]), placeholders(dictionary.bn[key]), key + ' placeholders differ between languages');
  }
});

test('every translation hook in the page resolves in both languages and every listed hook was applied', () => {
  const used = [...markup.matchAll(/\sdata-i18n(?:-[a-z-]+)?="([^"]+)"/g)].map(match => match[1]);
  assert(used.length >= 200);
  for (const key of used) assert(key in dictionary.en && key in dictionary.bn, 'unknown translation key in page: ' + key);
  const anchors = new Set();
  for (const [anchor, hooks] of table.hooks) {
    assert(!anchors.has(anchor), 'duplicate hook anchor: ' + anchor); anchors.add(anchor);
    for (const [mode, key] of Object.entries(hooks)) {
      assert(key in dictionary.en, 'hook uses an undefined key: ' + key);
      const attribute = mode === 'text' ? 'data-i18n' : 'data-i18n-' + mode;
      assert(markup.includes(` ${attribute}="${key}"`), `${attribute}="${key}" missing from the generated page`);
    }
  }
  // Keys are only worth carrying if the page or its code reads them.
  for (const key of Object.keys(table.strings)) {
    assert(used.includes(key) || script.includes(`'${key}'`) || script.includes(`.${key}`), 'unused translation key: ' + key);
  }
});

// Text that is correct in both interface languages, or redrawn from state by refreshStateLabels().
const SAME_IN_BOTH = new Set(['Astha — আস্থা', 'English', 'বাংলা + English', 'GPIO 25', 'GPIO 26', 'GPIO 27', 'CLIP ViT-B/32', '120 cm', 'IDLE', '01XXXXXXXXX']);
const STATE_DRIVEN = new Set(['auth-submit', 'hf-label', 'source-status', 'reader-progress', 'eye-pill', 'eye-start', 'private-btn', 'privacy-status',
  'owner-lock-btn', 'cloud-pill', 'calib-status-pill', 'calib-start-btn']);

test('no visible label or assistive attribute in the page is left in English only', () => {
  const untranslated = [];
  for (const match of markup.matchAll(/<([a-z0-9]+)\b([^<>]*)>([^<]*)/g)) {
    const [, tag, attrs, raw] = match;
    if (['svg', 'path', 'circle', 'rect', 'line', 'polyline', 'polygon', 'body'].includes(tag)) continue;
    const id = (/\bid="([^"]+)"/.exec(attrs) || [])[1];
    const text = raw.replace(/\s+/g, ' ').trim();
    if (text && /[A-Za-z]{2}/.test(text) && !/\sdata-i18n(-lead)?="/.test(attrs) && !SAME_IN_BOTH.has(text) && !STATE_DRIVEN.has(id)) untranslated.push(text);
    for (const attr of ['aria-label', 'title', 'placeholder', 'alt']) {
      const value = (new RegExp(`\\s${attr}="([^"]*)"`).exec(attrs) || [])[1];
      if (value && /[A-Za-z]{2}/.test(value) && !attrs.includes(` data-i18n-${attr}="`) && !SAME_IN_BOTH.has(value)) untranslated.push(attr + ': ' + value);
    }
  }
  // Text placed after a child element cannot be reached by any hook.
  for (const match of markup.matchAll(/<\/[a-z0-9]+>([^<]*[A-Za-z]{3}[^<]*)</g)) untranslated.push('trailing: ' + match[1].trim());
  assert.deepEqual(untranslated, []);
  // State-driven elements are really redrawn from the dictionary rather than left as markup.
  const refresh = /function refreshStateLabels\(\) \{[\s\S]*?\n\}/.exec(script)[0];
  for (const id of ['hf-label', 'private-btn', 'privacy-status', 'eye-start', 'eye-pill', 'reader-progress']) assert(refresh.includes(`'${id}'`), id + ' is not redrawn on a language change');
  for (const call of ['renderOwner()', 'updateSourceStatus()', 'ASTHA_RENDER_ACCOUNT()']) assert(refresh.includes(call));
});

test('language application translates leading text and attributes in place without touching child controls', () => {
  const source = read('tools/i18n.js');
  const input = { nodeType: 1 };
  const label = { firstChild: { nodeType: 3, nodeValue: 'Phone number' }, children: [input], getAttribute: name => ({ 'data-i18n-lead': 'auth_phone' })[name] };
  const noText = { firstChild: input, getAttribute: () => 'auth_phone' };
  const attributes = new Map();
  const field = { getAttribute: name => ({ 'data-i18n-placeholder': 'command_placeholder', 'data-i18n-aria-label': 'mic_idle' })[name], setAttribute: (name, value) => attributes.set(name, value) };
  const texts = new Map();
  const calls = [];
  const context = vm.createContext({
    I18N: { en: { mic_idle: 'Tap to speak' }, bn: { mic_idle: 'কথা বলতে চাপুন' } }, I18N_EXTRA: table.strings, uiLang: 'bn',
    document: { querySelectorAll: selector => selector === '[data-i18n-lead]' ? [label, noText] : /placeholder|aria-label/.test(selector) ? [field] : [] },
    $: id => ({ set textContent(value) { texts.set(id, value); } }),
    SiriVoice: { active: true }, privacyMode: true, eye: { active: false }, reader: { active: false, paused: false },
    renderOwner: () => calls.push('owner'), updateSourceStatus: () => calls.push('source'),
    window: { ASTHA_RENDER_ACCOUNT: () => calls.push('account') },
  });
  vm.runInContext('function t(key, params) { let s = I18N[uiLang][key] ?? I18N.en[key] ?? key; if (params) for (const k in params) s = s.split("{" + k + "}").join(params[k]); return s; }\n' + source, context);
  vm.runInContext('applyStaticI18n()', context);
  assert.equal(label.firstChild.nodeValue, 'ফোন নম্বর'); assert.deepEqual(label.children, [input]);
  assert.equal(noText.firstChild, input, 'an element without leading text is left alone');
  assert.equal(attributes.get('placeholder'), table.strings.command_placeholder[1]); assert.equal(attributes.get('aria-label'), 'কথা বলতে চাপুন');
  assert.equal(texts.get('hf-label'), table.strings.hf_on[1]); assert.equal(texts.get('private-btn'), table.strings.privacy_on[1]);
  assert.equal(texts.get('eye-start'), table.strings.eye_start[1]); assert.equal(texts.get('reader-progress'), table.strings.reader_ready[1]);
  assert.deepEqual(calls, ['owner', 'source', 'account']);
  vm.runInContext('uiLang = "en"; SiriVoice.active = false; privacyMode = false; eye.active = true; reader.paused = true; applyStaticI18n()', context);
  assert.equal(label.firstChild.nodeValue, 'Phone number'); assert.equal(attributes.get('aria-label'), 'Tap to speak');
  assert.equal(texts.get('hf-label'), 'Hands-free: off'); assert.equal(texts.get('private-btn'), 'Privacy mode: off');
  assert.equal(texts.get('eye-start'), 'Stop watching my screen'); assert.equal(texts.get('reader-progress'), 'Paused');
  assert.equal(vm.runInContext('t("reader_part", { n: 2, total: 5 })', context), 'Part 2 of 5');
});

// JavaScript's \b only understands ASCII word characters, so a Bangla word between two
// \b never matches. Commands and answers in Bangla were silently ignored because of it.
test('no pattern in the built page guards a Bangla alternative with an ASCII-only word boundary', () => {
  const offenders = [];
  script.split('\n').forEach((line, index) => {
    for (let at = line.indexOf('('); at >= 0; at = line.indexOf('(', at + 1)) {
      let depth = 0, end = -1;
      for (let j = at; j < line.length; j++) {
        if (line[j] === '\\') { j++; continue; }
        if (line[j] === '(') depth++;
        else if (line[j] === ')' && --depth === 0) { end = j; break; }
      }
      if (end < 0) continue;
      const group = line.slice(at, end + 1);
      if (group.length >= 600 || !BENGALI.test(group)) continue;
      if (line.slice(at - 2, at) === '\\b' || line.slice(end + 1, end + 3) === '\\b') offenders.push((index + 1) + ': ' + group.slice(0, 60));
    }
  });
  assert.deepEqual(offenders, []);
});

test('Bangla yes and no answer a confirmation, and Bangla stop and camera commands are recognised', () => {
  const slice = (start, end) => { const a = script.indexOf(start), b = script.indexOf(end, a + start.length); assert(a >= 0 && b > a, start); return script.slice(a, b); };
  const outcomes = [];
  const context = vm.createContext({ Date, state: {}, announce() {}, playEarcon() {} });
  vm.runInContext(slice('function askYesNo(', '\n// ') + '\nglobalThis.ask = askYesNo; globalThis.answer = answerYesNo;', context);
  for (const [reply, expected] of [['হ্যাঁ', 'yes'], ['হ্যাঁ, খোলো', 'yes'], ['না', 'no'], ['না থাক', 'no'], ['yes please', 'yes'], ['No.', 'no'], ['ঠিক আছে', 'yes']]) {
    context.ask('Open it?', 'খুলব?', () => outcomes.push('yes'), () => outcomes.push('no'));
    assert.equal(context.answer(reply), true, reply); assert.equal(outcomes.at(-1), expected, reply);
  }
  // A longer word that merely starts with the same letters is not an answer.
  context.ask('Open it?', 'খুলব?', () => outcomes.push('yes'), () => outcomes.push('no'));
  for (const reply of ['নাম কী', 'november', 'okra']) assert.equal(context.answer(reply), false, reply);
  const stop = vm.runInNewContext(/const STOP_TALKING_REGEX = (\/.*\/i);/.exec(script)[1]);
  for (const phrase of ['থামো', 'আস্থা থামো', 'stop talking', 'please be quiet']) assert.equal(stop.test(phrase), true, phrase);
  for (const phrase of ['unstoppable', 'থামোনা']) assert.equal(stop.test(phrase), false, phrase);
  const camera = new RegExp(/if \(\/((?:[^\/\\\n]|\\.)*start camera(?:[^\/\\\n]|\\.)*)\/i\.test\(q\)\)/.exec(script)[1], 'i');
  assert.equal(camera.test('ক্যামেরা চালু করো'), true); assert.equal(camera.test('start camera'), true);
});
