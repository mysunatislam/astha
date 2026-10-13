import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../tools/experience.js', import.meta.url), 'utf8');
const moduleSource = fs.readFileSync(new URL('../tools/module.js', import.meta.url), 'utf8');
const cloudSource = fs.readFileSync(new URL('../tools/cloud.js', import.meta.url), 'utf8');
const offlineSource = fs.readFileSync(new URL('../tools/offline.js', import.meta.url), 'utf8');
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function harness() {
  const timers = new Map(), elements = new Map(), events = new Map(), announcements = [], questions = [], requests = [], frames = [], modes = [];
  let nextTimer = 0, now = 100000;
  const element = id => {
    if (!elements.has(id)) elements.set(id, { hidden: false, checked: false, value: '', textContent: '', attributes: {}, dataset: {}, listeners: {},
      setAttribute(key, value) { this.attributes[key] = value; }, focus() {}, addEventListener(name, fn) { this.listeners[name] = fn; } });
    return elements.get(id);
  };
  const contextButtons = ['ask', 'road', 'classroom'].map(name => Object.assign(element('context-' + name), { dataset: { asthaContext: name } }));
  const pageButtons = ['home', 'tools', 'memory', 'devices', 'assessment', 'settings'].map(name => Object.assign(element('page-' + name), { dataset: { asthaPage: name } }));
  const storage = new Map(), applied = [];
  const context = {
    window: { ASTHA_ACCOUNT_ID: 'experience-account-a', ASTHA_LOCAL_ACCOUNT_ID: 'experience-account-a' },
    privacyTransition: false,
    uiLang: 'en', voiceLang: 'en', state: { audio: false, source: 'camera', busy: false, listening: false, shield: false },
    I18N: { en: new Proxy({}, { get: (_, key) => key }), bn: new Proxy({}, { get: (_, key) => key }) },
    toggleAudio() { context.state.audio = !context.state.audio; }, savePreferences() {},
    applyFontSize: size => applied.push(['font', size]), applyClinicalTheme: theme => applied.push(['theme', theme]),
    setUiLanguage: next => { context.uiLang = next; }, setVoiceLanguage: next => { context.voiceLang = next; },
    reader: { active: false }, reading: { active: false }, speaking: false,
    Date: class extends Date { static now() { return now; } },
    VoiceEngine: { requestController: null, speak: async () => true },
    asthaSpeaking: () => context.speaking,
    setMode: (...args) => modes.push(args), announce: (en, bn, kind) => announcements.push({ en, bn, kind }),
    setCaption: (...args) => context.captions.push(args), captions: [], t: key => key,
    stopAllSpeech: () => { context.stops++; }, stops: 0,
    AsthaAgent: { cancel: () => { context.agentCancels++; } }, agentCancels: 0,
    handleVisualQA: query => questions.push(query), withCamera: () => { context.cameraRequests++; }, cameraRequests: 0,
    captureFrame: resolution => { const frame = { resolution, serial: frames.length + 1 }; frames.push(frame); return frame; },
    cloudReady: () => true, gemini: async (prompt, frame) => { requests.push({ prompt, frame }); return { text: '' }; },
    setTimeout: (fn, ms) => { const id = ++nextTimer; timers.set(id, { fn, ms }); return id; },
    clearTimeout: id => timers.delete(id),
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) }, $: element,
    document: { hidden: false, body: element('body'), documentElement: { getAttribute: name => name === 'data-theme' ? 'mulberry-apricot' : 'normal' },
      querySelectorAll: selector => selector === '[data-astha-context]' ? contextButtons : selector === '[data-astha-page]' ? pageButtons : [],
      querySelector: selector => selector === 'main' ? element('main') : element(selector),
      addEventListener: (name, fn) => events.set(name, fn) },
  };
  vm.createContext(context); vm.runInContext(source + '\nglobalThis.experience = AsthaExperience;', context);
  async function tick() {
    const entry = timers.entries().next().value;
    assert(entry, 'a classroom poll must be scheduled');
    timers.delete(entry[0]); return entry[1].fn();
  }
  return { context, experience: context.experience, timers, events, announcements, questions, requests, frames, modes, elements, tick, storage, applied,
    advance: milliseconds => { now += milliseconds; } };
}

test('boot selects ask mode without starting a camera or classroom requests', () => {
  const h = harness();
  h.experience.setContext('road', true);
  h.experience.boot();
  assert.equal(h.experience.mode, 'ask'); assert.equal(h.experience.routineAllowed(), false);
  assert.deepEqual(h.modes.at(-1), ['quiet', true]);
  assert.equal(h.context.cameraRequests, 0); assert.equal(h.requests.length, 0); assert.equal(h.timers.size, 0);
});

test('routine surroundings cannot interrupt speaking, listening, reading or an active question', async () => {
  const h = harness(); h.experience.setContext('road', true);
  assert.equal(h.experience.routineAllowed(), true);
  for (const [object, property, value] of [[h.context.state, 'busy', true], [h.context.state, 'listening', true],
    [h.context.reader, 'active', true], [h.context.reading, 'active', true], [h.context, 'speaking', true],
    [h.context.VoiceEngine, 'requestController', {}]]) {
    const original = object[property]; object[property] = value;
    assert.equal(h.experience.routineAllowed(), false, property); object[property] = original;
  }
  const hold = deferred();
  const answering = h.experience.visualTask('Can you see my pen?', () => hold.promise);
  assert.equal(h.experience.routineAllowed(), false);
  hold.resolve(); await answering;
  assert.equal(h.experience.routineAllowed(), true);
});

test('a nearby person or furniture never interrupts an answer, and repeats are bounded', () => {
  const h = harness(); h.experience.setContext('road', true);
  h.context.speaking = true;
  for (const id of ['person', 'desk', 'dining table', 'chair', 'body_collision']) assert.equal(h.experience.acceptHazard(id), null, id);
  h.context.speaking = false;
  assert.equal(h.experience.acceptHazard('person'), 'medium');
  h.advance(4001); assert.equal(h.experience.acceptHazard('person'), null, 'the same update is not repeated');
  assert.equal(h.experience.acceptHazard('chair'), 'medium');
  assert.equal(h.experience.acceptHazard('dining table'), null, 'updates are spaced apart');
  h.advance(30001); assert.equal(h.experience.acceptHazard('person'), 'medium');
});

test('a credible hazard interrupts an answer, but only while ASTHA has been asked to watch', () => {
  const h = harness();
  for (const mode of ['ask', 'classroom']) {
    h.experience.setContext(mode, true);
    for (const id of ['stairs', 'drop_off', 'vehicle_collision']) assert.equal(h.experience.acceptHazard(id), null, mode + ' ' + id);
  }
  h.experience.setContext('road', true);
  Object.assign(h.context.state, { listening: true, busy: true }); h.context.speaking = true;
  assert.equal(h.experience.acceptHazard('stairs'), 'critical');
  assert.equal(h.experience.acceptHazard('stairs'), null, 'a duplicate warning is suppressed');
  assert.equal(h.experience.acceptHazard('vehicle_collision'), null, 'alerts do not pile up within moments of each other');
  h.advance(2501); assert.equal(h.experience.acceptHazard('vehicle_collision'), 'critical');
  h.advance(5000); assert.equal(h.experience.acceptHazard('stairs'), null);
  h.advance(3001); assert.equal(h.experience.acceptHazard('stairs'), 'critical');
  // The Safety shield switch asks ASTHA to watch without changing the chosen mode.
  h.experience.setContext('ask', true); h.context.state.shield = true; h.advance(9000);
  assert.equal(h.experience.acceptHazard('drop_off'), 'critical');
});

test('Stop holds back routine updates for a while, never a hazard alert, and keeps the chosen mode', () => {
  const h = harness(); h.experience.setContext('road', true);
  assert.equal(h.experience.allows('medium'), true); assert.equal(h.experience.allows('low'), true);
  assert.equal(h.experience.route('stop'), true);
  assert.equal(h.experience.mode, 'road', 'a mode stays active until it is changed or cancelled');
  assert.equal(h.experience.allows('medium'), false); assert.equal(h.experience.allows('low'), false);
  assert.equal(h.experience.acceptHazard('drop_off'), 'critical');
  h.advance(10001); assert.equal(h.experience.allows('medium'), true);
  assert.equal(h.experience.route('stop updates'), true); assert.equal(h.experience.mode, 'ask');
});

test('routine observations exist only in surroundings mode; requested updates work in any mode when idle', () => {
  const h = harness();
  for (const [mode, low] of [['ask', false], ['classroom', false], ['road', true]]) {
    h.experience.setContext(mode, true);
    assert.equal(h.experience.allows('low'), low, mode); assert.equal(h.experience.allows('medium'), true, mode);
    h.context.state.listening = true;
    assert.equal(h.experience.allows('medium'), false, mode); assert.equal(h.experience.allows('high'), true, mode);
    h.context.state.listening = false;
  }
});

test('a classroom board change found during the quiet period after Stop is read afterwards, not dropped', async () => {
  const h = harness(), readings = ['Homework: page 12', 'Homework: page 12'];
  h.context.gemini = async () => ({ text: readings.shift() });
  h.experience.setContext('classroom', true); h.experience.route('stop');
  await h.tick(); assert.equal(h.announcements.length, 0);
  h.advance(10001); await h.tick();
  assert.equal(h.announcements.length, 1); assert.equal(h.announcements[0].en, 'The board now reads: Homework: page 12');
});

test('voice navigation opens each page and says nothing while the voice is off', () => {
  const h = harness(); h.experience.boot();
  for (const [phrase, page] of [['open devices', 'devices'], ['settings', 'settings'], ['show my memory', 'memory'], ['camera view', 'tools'],
    ['personal setup', 'assessment'], ['go home', 'home'], ['আস্থা, সংযুক্ত ডিভাইস', 'devices'], ['হোম', 'home']]) {
    assert.equal(h.experience.route(phrase), true, phrase); assert.equal(h.experience.page, page, phrase);
    assert.equal(h.elements.get('body').attributes['data-view'], page);
    assert.equal(h.elements.get('page-' + page).attributes['aria-current'], 'page');
  }
  assert.equal(h.elements.get('assessment-page').hidden, true); assert.equal(h.elements.get('main').hidden, false);
  assert.equal(h.announcements.length, 0);
  h.context.state.audio = true; h.experience.route('open devices');
  assert.equal(h.announcements.length, 1); assert.equal(h.elements.get('devices-page').hidden, false); assert.equal(h.elements.get('main').hidden, true);
});

test('a question that merely mentions a page name is still answered as a question', () => {
  const h = harness(); h.experience.boot();
  for (const query of ['What are my settings for the alarm?', 'Which devices are on the table?', 'Describe my memory card']) {
    assert.equal(h.experience.route(query), false, query); assert.equal(h.experience.page, 'home');
  }
});

test('setup answers outside the known choices are dropped and answering when asked cannot be removed', () => {
  const h = harness();
  const clean = h.experience.sanitize({ vision: 'legally-blind', language: 'fr', feedback: 'brief', textSize: 'xlarge', theme: 'x', speechRate: 3,
    devices: ['clip_camera', 'toaster', 'braille_controller'], modes: ['classroom'], haptics: 'yes', diagnosis: 'private' });
  assert.deepEqual(JSON.parse(JSON.stringify(clean)), { vision: 'unspecified', feedback: 'brief', textSize: 'xlarge', theme: 'mulberry-apricot', speechRate: '1',
    devices: ['clip_camera', 'braille_controller'], modes: ['ask', 'classroom'], haptics: true });
});

test('saved setup goes to the account, stays on the device when the server is unreachable, and is cleared on sign-out', async () => {
  const KEY = 'astha.accessibility.v2';
  const h = harness(), sent = []; h.experience.boot();
  h.context.apiSend = async (method, path, body) => { sent.push({ method, path, body }); return { ok: true, updated_at: 4242 }; };
  const submit = () => h.elements.get('assessment-form').listeners.submit({ preventDefault() {} });
  await submit();
  assert.deepEqual(sent.map(call => [call.method, call.path]), [['PUT', '/api/preferences']]);
  assert.deepEqual(Object.keys(sent[0].body), ['preferences']); assert.deepEqual([...sent[0].body.preferences.modes], ['ask']);
  assert.deepEqual(JSON.parse(h.storage.get(KEY)).synced, true); assert.equal(JSON.parse(h.storage.get(KEY)).updated_at, 4242);
  assert.equal(h.elements.get('assessment-status').textContent, 'setup_saved_account'); assert.equal(h.experience.page, 'home');
  h.context.apiSend = async () => { throw new Error('offline'); };
  await submit();
  assert.equal(JSON.parse(h.storage.get(KEY)).synced, false); assert.equal(h.elements.get('assessment-status').textContent, 'setup_saved_device');
  // The unsynced device copy is uploaded the next time the account loads.
  h.context.apiSend = async (method, path) => { sent.push({ method, path }); return { updated_at: 5000 }; };
  await h.experience.loadAccountPreferences();
  assert.deepEqual([sent.at(-1).method, sent.at(-1).path], ['PUT', '/api/preferences']); assert.equal(JSON.parse(h.storage.get(KEY)).synced, true);
  h.experience.accountCleared(); assert.equal(h.storage.has(KEY), false);
});

test('a device copy left by another account is neither applied nor uploaded', async () => {
  const KEY = 'astha.accessibility.v2', h = harness(), sent = []; h.experience.boot();
  h.storage.set(KEY, JSON.stringify({ values: { vision: 'none', textSize: 'xlarge' }, updated_at: 1, synced: false, owner: 'someone-else' }));
  h.context.apiSend = async (method, path, body) => { sent.push([method, path, body]); return { preferences: null, updated_at: null }; };
  await h.experience.loadAccountPreferences();
  assert.deepEqual(sent.map(call => call[0]), ['GET'], 'the other person\'s answers are never sent to this account');
  assert.equal(h.experience.preferences.vision, 'unspecified'); assert.deepEqual(h.applied, []);
  // This account's own unsynced copy is still uploaded.
  h.storage.set(KEY, JSON.stringify({ values: { vision: 'low' }, updated_at: 2, synced: false, owner: 'experience-account-a' }));
  await h.experience.loadAccountPreferences();
  assert.equal(sent.at(-1)[0], 'PUT'); assert.equal(sent.at(-1)[2].preferences.vision, 'low');
});

test('a setting changed elsewhere updates the saved setup, and the voice language follows only an explicit Save', async () => {
  const KEY = 'astha.accessibility.v2', h = harness(), sent = []; h.experience.boot();
  h.context.apiSend = async (method, path, body) => { sent.push([method, body]); return method === 'GET' ? { preferences: { language: 'en', textSize: 'large' }, updated_at: 5 } : { updated_at: 6 }; };
  h.context.uiLang = 'bn'; h.context.voiceLang = 'bn';
  await h.experience.loadAccountPreferences();
  assert.equal(h.context.uiLang, 'en'); assert.equal(h.context.voiceLang, 'bn', 'a separately chosen voice language survives loading the setup');
  // The user picks extra-large text in the header menu.
  h.elements.get('font-select').listeners.change({ target: { value: 'xlarge' } });
  await Promise.resolve(); await Promise.resolve();
  assert.equal(JSON.parse(h.storage.get(KEY)).values.textSize, 'xlarge'); assert.equal(sent.at(-1)[0], 'PUT'); assert.equal(sent.at(-1)[1].preferences.textSize, 'xlarge');
  // ...and switches the interface to Bangla there too.
  h.context.uiLang = 'bn'; h.experience.refreshLabels();
  assert.equal(JSON.parse(h.storage.get(KEY)).values.language, 'bn');
  h.experience.adopt('textSize', 'enormous'); assert.equal(JSON.parse(h.storage.get(KEY)).values.textSize, 'xlarge', 'an unknown value is ignored');
  // Without any saved setup, changing a menu creates nothing.
  const fresh = harness(); fresh.experience.boot(); fresh.experience.adopt('textSize', 'large');
  assert.equal(fresh.storage.size, 0);
});

test('the account copy of the setup is applied on sign-in, and a reply for a previous account is ignored', async () => {
  const h = harness(); h.experience.boot();
  h.context.apiSend = async () => ({ preferences: { textSize: 'xlarge', feedback: 'text', modes: ['classroom'], unknown: 1 }, updated_at: 77 });
  h.context.state.audio = true;
  await h.experience.loadAccountPreferences();
  assert.equal(h.experience.preferences.textSize, 'xlarge'); assert.deepEqual(h.applied, [['font', 'xlarge']]);
  assert.equal(h.context.state.audio, false, 'text-only feedback turns the voice off');
  assert.deepEqual([...h.experience.preferences.modes], ['ask', 'classroom']);
  const other = harness(); other.experience.boot();
  other.context.apiSend = async () => { other.context.window.ASTHA_ACCOUNT_ID = 'experience-account-b'; return { preferences: { textSize: 'large' }, updated_at: 78 }; };
  await other.experience.loadAccountPreferences();
  assert.equal(other.experience.preferences.textSize, 'normal'); assert.equal(other.storage.size, 0);
});

test('English and Bangla context commands preserve historical recall and direct visual questions', () => {
  const h = harness();
  assert.equal(h.experience.route('Astha, I am on a busy road'), true); assert.equal(h.experience.mode, 'road');
  assert.equal(h.experience.route('আস্থা, ক্লাসরুমে আছি'), true); assert.equal(h.experience.mode, 'classroom');
  assert.equal(h.experience.route('only when I ask'), true); assert.equal(h.experience.mode, 'ask');
  for (const query of ['Where did I leave my keys?', 'আমার চাবি কোথায় রেখেছিলাম?', 'remember my wallet']) assert.equal(h.experience.route(query), false, query);
  assert.equal(h.experience.route('Can you see my pink pen?'), true);
  assert.equal(h.questions.at(-1), 'Can you see my pink pen?');
});

test('a direct whiteboard question does not silently replace the user question with a context change', () => {
  const h = harness();
  assert.equal(h.experience.route('Can you see the whiteboard?'), true);
  assert.equal(h.questions.at(-1), 'Can you see the whiteboard?');
  assert.equal(h.experience.mode, 'ask');
  assert.equal(h.experience.route('Read the whiteboard'), false, 'the existing reading route must receive this command');
});

test('a new visual question invalidates a pending older result without releasing the new task priority', async () => {
  const h = harness(); h.experience.setContext('road', true);
  const first = deferred(), second = deferred(); let firstCurrent, secondCurrent;
  const older = h.experience.visualTask('Can you see my pen?', current => { firstCurrent = current; return first.promise; });
  const newer = h.experience.visualTask('Where is my charger?', current => { secondCurrent = current; return second.promise; });
  assert.equal(firstCurrent(), false); assert.equal(secondCurrent(), true); assert.equal(h.experience.busy, true);
  first.resolve(); await older; assert.equal(h.experience.busy, true);
  second.resolve(); await newer; assert.equal(h.experience.busy, false);
});

test('stop phrases invalidate late visual results and stop speech and agent work', async () => {
  for (const phrase of ['stop', 'cancel', 'stop talking', 'be quiet', 'চুপ করো', 'থামো']) {
    const h = harness(), hold = deferred(); let current;
    const pending = h.experience.visualTask('Can you see my pen?', value => { current = value; return hold.promise; });
    assert.equal(h.experience.route(phrase), true, phrase);
    assert.equal(current(), false, phrase + ' must invalidate the answer');
    assert.equal(h.context.stops, 1); assert.equal(h.context.agentCancels, 1);
    hold.resolve(); await pending; assert.equal(h.experience.busy, false);
  }
});

test('stop during the spoken checking acknowledgement prevents the detector from starting', async () => {
  const h = harness(), acknowledgment = deferred(); h.context.state.audio = true;
  h.context.VoiceEngine.speak = () => acknowledgment.promise;
  let runs = 0;
  const pending = h.experience.visualTask('Can you see my pen?', () => { runs++; });
  h.experience.route('stop'); acknowledgment.resolve(); await pending;
  assert.equal(runs, 0); assert.equal(h.experience.busy, false);
});

test('check again reruns the last visual question and retains selected-image wording', async () => {
  for (const source of ['photo', 'scene', 'image']) {
    const h = harness(); h.context.state.source = source;
    await h.experience.visualTask('Can you see a pink pen?', () => {});
    assert.equal(h.context.captions[0][1], 'Checking the selected image.', source);
    assert.equal(h.experience.route('check again'), true); assert.equal(h.questions.at(-1), 'Can you see a pink pen?');
  }
});

test('classroom announces changed legible board text once, ignoring whitespace changes and empty reads', async () => {
  const h = harness(), readings = ['Chapter 1\nExample A', 'Chapter 1  Example A', '', 'Chapter 2'];
  h.context.gemini = async (prompt, frame) => { h.requests.push({ prompt, frame }); return { text: readings.shift() }; };
  h.experience.setContext('classroom', true);
  await h.tick(); await h.tick(); await h.tick(); await h.tick();
  assert.equal(h.requests.length, 4); assert.equal(h.announcements.length, 2);
  assert.equal(h.announcements[0].en, 'The board now reads: Chapter 1\nExample A');
  assert.equal(h.announcements[1].en, 'The board now reads: Chapter 2');
  assert(h.requests.every(request => request.frame.resolution === 1280));
  assert.match(h.requests[0].prompt, /current image.*Do not guess/);
});

test('a late classroom result cannot interrupt newly active speech or listening', async () => {
  for (const activity of ['listening', 'speaking']) {
    const h = harness(), hold = deferred();
    h.context.gemini = () => hold.promise; h.experience.setContext('classroom', true);
    const pending = h.tick();
    if (activity === 'listening') h.context.state.listening = true; else h.context.speaking = true;
    hold.resolve({ text: 'Old board text' }); await pending;
    assert.equal(h.announcements.length, 0, activity);
  }
});

test('a classroom request from a previous context session cannot speak after returning to classroom', async () => {
  const h = harness(), hold = deferred(); h.context.gemini = () => hold.promise;
  h.experience.setContext('classroom', true); const pending = h.tick();
  h.experience.setContext('road', true); h.experience.setContext('classroom', true);
  hold.resolve({ text: 'Previous classroom frame' }); await pending;
  assert.equal(h.announcements.length, 0);
});

test('changing the image source while a board read is pending suppresses the old image text', async () => {
  const h = harness(), hold = deferred(); h.context.gemini = () => hold.promise; h.context.state.sourceEpoch = 1;
  h.experience.setContext('classroom', true); const board = h.tick();
  h.context.state.source = 'photo'; h.context.state.sourceEpoch++;
  hold.resolve({ text: 'Text from the previous camera image' }); await board;
  assert.equal(h.announcements.length, 0);
  assert.equal(h.timers.size, 1, 'a later poll may inspect the newly selected image');
});

test('a foreground visual question suppresses an old board result but preserves later classroom polling', async () => {
  const h = harness(), hold = deferred(); h.context.gemini = () => hold.promise;
  h.experience.setContext('classroom', true); const board = h.tick();
  await h.experience.visualTask('Can you see my pen?', () => {});
  hold.resolve({ text: 'Board before the question' }); await board;
  assert.equal(h.announcements.length, 0);
  assert.equal(h.timers.size, 1, 'the selected classroom context must continue checking after the foreground question');
});

test('changing the selected image or account invalidates an in-flight visual answer', async () => {
  for (const change of ['source', 'account', 'local-account']) {
    const h = harness(), hold = deferred(); h.context.state.sourceEpoch = 1; let current;
    const answer = h.experience.visualTask('Can you see my pink pen?', predicate => { current = predicate; return hold.promise; });
    if (change === 'source') h.context.state.sourceEpoch++;
    else if (change === 'account') h.context.window.ASTHA_ACCOUNT_ID = 'experience-account-b';
    else h.context.window.ASTHA_LOCAL_ACCOUNT_ID = 'experience-account-b';
    assert.equal(current(), false, change);
    hold.resolve(); await answer; assert.equal(h.experience.busy, false);
  }
});

test('hiding the app invalidates board results and cannot restart polling until visible', async () => {
  const h = harness(), hold = deferred(); h.experience.boot(); h.context.gemini = () => hold.promise;
  h.experience.setContext('classroom', true); const pending = h.tick();
  h.context.document.hidden = true; h.events.get('visibilitychange')();
  hold.resolve({ text: 'Hidden board result' }); await pending;
  assert.equal(h.announcements.length, 0); assert.equal(h.timers.size, 0);
  h.context.document.hidden = false; h.events.get('visibilitychange')(); assert.equal(h.timers.size, 1);
});

test('unavailable cloud OCR produces no fabricated board update or background provider request', async () => {
  const h = harness(); h.context.cloudReady = () => false; h.experience.setContext('classroom', true);
  await h.tick(); assert.equal(h.requests.length, 0); assert.equal(h.announcements.length, 0);
  h.context.cloudReady = () => true; h.context.gemini = async () => { throw new Error('synthetic provider outage'); };
  await h.tick(); assert.equal(h.announcements.length, 0); assert.equal(h.experience.busy, false);
});

test('each visual question captures a new frame instead of reusing previous conversation evidence', async () => {
  const h = harness(), seen = [];
  const section = moduleSource.slice(moduleSource.indexOf('const conversationHistory ='), moduleSource.indexOf('function extractTargetItemFromQuery('));
  h.context.withCamera = () => false;
  h.context.cloudVisualQA = async (question, frame, history, current) => {
    seen.push({ question, frame, history }); assert.equal(current(), true);
    return { en: 'Synthetic answer', bn: 'পরীক্ষামূলক উত্তর' };
  };
  vm.runInContext(section, h.context);
  await h.context.handleVisualQA('Can you see my pink pen?');
  await h.context.handleVisualQA('Where is my charger now?');
  assert.equal(seen.length, 2); assert.notEqual(seen[0].frame, seen[1].frame);
  assert.equal(seen[0].frame.resolution, 896); assert.equal(seen[1].frame.serial, 2);
  assert.match(seen[1].history, /User: Can you see my pink pen/);
});

test('local visual questions never infer a pen colour or table relation from other objects', async () => {
  const h = harness();
  const section = moduleSource.slice(moduleSource.indexOf('function extractTargetItemFromQuery('), moduleSource.indexOf('function smartFallback('));
  Object.assign(h.context, {
    withBusy: (_label, run) => run(), ensureVisionModels: async () => {},
    runCoco: async () => [{ id: 'mouse', score: 0.99, bbox: [0, 0, 50, 50] }, { id: 'dining table', score: 0.99, bbox: [0, 0, 640, 400] }],
    VOCAB_BY_ID: { keys: { id: 'keys', en: 'keys', bn: 'চাবি' } }, VOCAB: [],
    recordConversationTurn() {}, posFromX: () => 'ahead', label: id => id, labelBn: id => id,
    I18N: { en: { pos_ahead: 'ahead' }, bn: { pos_ahead: 'সামনে' } },
  });
  vm.runInContext(section, h.context);
  await h.context.handleOnDeviceVisualQA('Can you see my pink pen on the table?');
  assert.equal(h.announcements.length, 1);
  assert.match(h.announcements[0].en, /cannot confirm that specific item/);
  assert.doesNotMatch(h.announcements[0].en, /pink|on the table|I found/);
});

test('a canceled local detector result cannot announce or replace the displayed detections', async () => {
  const h = harness(), detected = deferred(); let current = true;
  const section = moduleSource.slice(moduleSource.indexOf('function extractTargetItemFromQuery('), moduleSource.indexOf('function smartFallback('));
  const previous = [{ id: 'previous-frame' }]; h.context.state.lastCocoPreds = previous;
  Object.assign(h.context, { withBusy: (_label, run) => run(), ensureVisionModels: async () => {},
    runCoco: () => detected.promise, VOCAB_BY_ID: {}, VOCAB: [], recordConversationTurn() {} });
  vm.runInContext(section, h.context);
  const pending = h.context.handleOnDeviceVisualQA('Can you see my keys?', () => current);
  await Promise.resolve(); current = false; detected.resolve([{ id: 'keys', score: 0.99 }]); await pending;
  assert.equal(h.announcements.length, 0); assert.equal(h.context.state.lastCocoPreds, previous);
});

test('a canceled cloud visual response cannot announce, save a memory or claim a location', async () => {
  const h = harness(), reply = deferred(), saves = []; let current = true;
  const section = cloudSource.slice(cloudSource.indexOf('async function cloudVisualQA('), cloudSource.indexOf('// Live Video Walkthrough Room Calibration'));
  Object.assign(h.context, { heartSet() {}, heartFlash() {}, logEvent() {}, playEarcon() {},
    autoRecordMemory: value => saves.push(value), CLOUD_PROMPTS: { vqa: () => 'Synthetic VQA question' }, gemini: () => reply.promise });
  vm.runInContext(section, h.context);
  const pending = h.context.cloudVisualQA('Can you see my pen?', { serial: 'current-frame' }, '', () => current);
  current = false; reply.resolve({ en: 'Old pen answer', bn: 'পুরনো উত্তর', found: true, item: 'pen', surface: 'table', room_hint: 'room' });
  assert.equal(await pending, null); assert.equal(h.announcements.length, 0); assert.equal(saves.length, 0);
});

test('the Stop control that is live in the page cancels pending answers and ends even a hazard alert', async () => {
  const h = harness(), hold = deferred(), stops = []; let current;
  const section = offlineSource.slice(offlineSource.indexOf('function stopAllSpeech()'), offlineSource.indexOf('// ---- "Works without internet"'));
  assert.match(section, /^function stopAllSpeech\(\)/);
  Object.assign(h.context, { stopReader() {}, stopListening() {}, OfflineEar: { active: false } }); h.context.VoiceEngine.stop = user => stops.push(user);
  vm.runInContext(section, h.context);
  h.experience.setContext('road', true);
  const answer = h.experience.visualTask('Can you see my pen?', predicate => { current = predicate; return hold.promise; });
  h.context.stopAllSpeech(); assert.equal(current(), false);
  assert.deepEqual(stops, [true], 'the user can always silence an alert');
  hold.resolve(); await answer;
  assert.equal(h.experience.allows('medium'), false); assert.equal(h.experience.mode, 'road');
});

test('the page has exactly one live Stop definition after the modules are joined in build order', () => {
  // Function declarations are hoisted, so the last one wins. It must be the cancelling one.
  const built = fs.readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
  const last = built.slice(built.lastIndexOf('\nfunction stopAllSpeech() {'));
  assert.match(last.slice(0, 400), /AsthaExperience\.cancelPending\(\)/);
  assert.match(last.slice(0, 400), /VoiceEngine\.stop\(true\)/);
});
