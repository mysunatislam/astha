import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const offline = fs.readFileSync(new URL('../tools/offline.js', import.meta.url), 'utf8');
const agent = fs.readFileSync(new URL('../tools/agent.js', import.meta.url), 'utf8');
const moduleSource = fs.readFileSync(new URL('../tools/module.js', import.meta.url), 'utf8');
const base = fs.readFileSync(new URL('../tools/base.html', import.meta.url), 'utf8');
const localGuard = base.slice(base.indexOf('function captureLocalActionGuard()'), base.indexOf('async function withBusy('));
const extractTarget = moduleSource.slice(moduleSource.indexOf('function extractTargetItemFromQuery('), moduleSource.indexOf('function findVocabMatch('));
const VOCAB = [
  { id: 'wallet', en: 'wallet', bn: 'মানিব্যাগ', al: ['purse'] },
  { id: 'keys', en: 'keys', bn: 'চাবি', al: ['keychain'] },
];

function harness() {
  const messages = [], questions = [], searches = [], requests = [], backing = new Map(), elements = new Map();
  const context = {
    window: { ASTHA_ACCOUNT_ID: 'spatial-account-a', ASTHA_LOCAL_ACCOUNT_ID: 'spatial-account-a' },
    state: { memory: [], spatialHome: [], log: [], currentRoom: 'Inferred room' },
    localStorage: { getItem: key => backing.get(key) ?? null, setItem: (key, value) => backing.set(key, value), removeItem: key => backing.delete(key) },
    privacyMode: false, privacyTransition: false, navigator: { onLine: false }, document: { hidden: false },
    engine: { coco: {}, clip: { status: 'idle' }, ocr: {} }, DepthEngine: { status: 'idle' },
    VOCAB_BY_ID: Object.fromEntries(VOCAB.map(item => [item.id, item])),
    crypto: { randomUUID: () => 'spatial-local-note' }, console: { warn() {}, log() {} },
    setTimeout: () => 1, clearTimeout() {},
    $: id => { if (!elements.has(id)) elements.set(id, { value: '', focus() {} }); return elements.get(id); },
    esc: value => String(value), t: key => key, memoryDate: () => 'saved date',
    announce: (en, bn, kind) => messages.push({ en, bn, kind }),
    askYesNo: (en, bn, yes) => questions.push({ en, bn, yes }),
    playEarcon() {}, haptic() {}, heartSet() {}, heartHide() {}, heartFlash() {}, logEvent() {}, renderLog() {},
    apiSend: async (...args) => { requests.push(args); throw Object.assign(new Error('offline'), { quiet: true }); },
    apiGet: async () => ({ memories: [], rooms: [] }), remoteProcessingAllowed: () => false,
    findVocabMatch: text => VOCAB.find(item => [item.id, item.en, item.bn, ...item.al].includes(text)),
    withBusy: (_label, action) => action(), captureFrame: () => ({ width: 640, height: 480 }),
    ensureVisionModels: async () => {}, runCoco: async () => [],
    label: id => id, labelBn: id => id, objLabel: object => object.id, objLabelBn: object => object.id,
  };
  vm.createContext(context);
  vm.runInContext(localGuard + extractTarget + offline + '\nglobalThis.spatial = { findItems, memoryRecallText, handleOnDevicePlacement, Seeker };', context);
  context.spatial.Seeker.start = (...args) => searches.push(args);
  return { context, ...context.spatial, messages, questions, searches, requests, backing };
}

test('saved camera and photo observations retain historical provenance and never claim a current placement', () => {
  for (const [source, label] of [['Camera observation', 'Camera observation'], ['Uploaded photo', 'Photo observation']]) {
    const h = harness();
    h.context.state.memory = [{ item: 'wallet', location: 'In the left of the image; physical location unconfirmed', source, time: '2020-01-01T12:00:00.000Z' }];
    h.findItems('Where did I leave my wallet?');
    assert.equal(h.questions.length, 1);
    assert.match(h.questions[0].en, new RegExp(label));
    assert.match(h.questions[0].en, /saved|2020/);
    assert.match(h.questions[0].en, /current location is not confirmed/);
    assert.match(h.questions[0].bn, /বর্তমান অবস্থান নিশ্চিত নয়/);
    assert.doesNotMatch(h.questions[0].en, /You kept|I see|I found|was left at/);
    assert.equal(h.searches.length, 0, 'historical recall must not start the camera before the follow-up is accepted');
    h.questions[0].yes();
    assert.deepEqual(h.searches[0], ['wallet', 'find']);
  }
});

test('Bangla recall selects the newest equally relevant user note and preserves its uncertainty', () => {
  const h = harness();
  h.context.state.memory = [
    { item: 'keys', location: 'old drawer', source: 'Your note', time: '2020-01-01T12:00:00.000Z' },
    { item: 'keys', location: 'door hook', source: 'Your note', time: '2025-01-01T12:00:00.000Z' },
  ];
  h.findItems('আমার চাবি কোথায়?');
  assert.equal(h.questions.length, 1);
  assert.match(h.questions[0].en, /Your note.*door hook/);
  assert.doesNotMatch(h.questions[0].en, /old drawer/);
  assert.match(h.questions[0].en, /current location is not confirmed/);
});

test('unknown or future recording times are not narrated as a fresh sighting', () => {
  const h = harness();
  for (const time of [undefined, null, '', 'not-a-date', '2999-01-01T00:00:00.000Z']) {
    const result = h.memoryRecallText({ item: 'wallet', location: 'drawer', source: 'Your note', time });
    assert.match(result.en, /unknown time/);
    assert.doesNotMatch(result.en, /just now|Invalid Date|1970/);
  }
});

test('private historical recall stays local and does not offer or begin camera search', () => {
  const h = harness();
  h.context.privacyMode = true;
  h.context.state.memory = [{ item: 'wallet', location: 'drawer', source: 'Your note', time: new Date().toISOString() }];
  h.findItems('Where is my wallet?');
  assert.equal(h.messages.length, 1);
  assert.match(h.messages[0].en, /current location is not confirmed/);
  assert.equal(h.questions.length, 0); assert.equal(h.searches.length, 0); assert.equal(h.requests.length, 0);
});

test('voice placement requires a named physical place and never silently adds an inferred room', async () => {
  const h = harness();
  h.context.runCoco = async () => [{ id: 'wallet', bbox: [20, 20, 40, 40], score: 0.9 }, { id: 'table', bbox: [0, 0, 500, 400], score: 0.9 }];
  await h.handleOnDevicePlacement('I am keeping my wallet here', 'wallet');
  assert.equal(h.context.state.memory.length, 0);
  assert.match(h.messages.at(-1).en, /Tell me the place to save/);
  await h.handleOnDevicePlacement('I am keeping my wallet on the table', 'wallet');
  assert.equal(h.context.state.memory.length, 1);
  assert.equal(h.context.state.memory[0].location, 'on the table');
  assert.equal(h.context.state.memory[0].source, 'Voice placement');
  assert.doesNotMatch(h.context.state.memory[0].location, /Inferred room/);
});

test('placement analysis cannot save into a different account or a newly private session', async () => {
  for (const change of ['account', 'privacy']) {
    const h = harness();
    h.context.runCoco = async () => {
      if (change === 'account') {
        h.context.window.ASTHA_ACCOUNT_ID = 'spatial-account-b'; h.context.window.ASTHA_LOCAL_ACCOUNT_ID = 'spatial-account-b';
      } else h.context.privacyMode = true;
      return [];
    };
    await h.handleOnDevicePlacement('I am keeping my wallet on the table', 'wallet');
    assert.equal(h.context.state.memory.length, 0); assert.equal(h.requests.length, 0);
  }
});

function agentHarness() {
  const messages = [];
  const context = { window: {}, state: { memory: [], spatialHome: [] }, console: { log() {} },
    announce: (en, bn) => messages.push({ en, bn }), playEarcon() {}, haptic() {}, setTimeout() {},
    remoteProcessingAllowed: () => false, captureFrame: () => null };
  vm.createContext(context); vm.runInContext(agent, context);
  return { context, ClientRAG: context.window.ClientRAG, AsthaAgent: context.window.AsthaAgent,
    AsthaToolRegistry: context.window.AsthaToolRegistry, messages };
}

test('client RAG carries saved time and provenance into historical context and agent recap', async () => {
  const h = agentHarness();
  h.context.state.memory = [{ item: 'wallet', location: 'drawer', source: 'Uploaded photo', time: '2020-01-01T12:00:00.000Z' }];
  const result = h.ClientRAG.search('wallet');
  assert.equal(result.memories[0].source, 'Uploaded photo');
  assert.equal(result.memories[0].time, '2020-01-01T12:00:00.000Z');
  const block = h.ClientRAG.formatContextBlock(result);
  assert.match(block, /Historical saved records do not confirm current object locations/);
  assert.match(block, /2020-01-01T12:00:00.000Z; Source: Uploaded photo/);
  h.AsthaAgent.observations = [{ tool: 'tool_rag_retrieve', output: result }];
  await h.AsthaAgent.synthesizeFinalAnswer('where is my wallet');
  assert.match(h.messages[0].en, /Photo observation.*2020.*drawer/);
  assert.match(h.messages[0].en, /current location is not confirmed/);
  assert.doesNotMatch(h.messages[0].en, /I do not see|I found|was left at/);
});

test('server RAG memory content is normalized without losing time/source or inventing a found result', async () => {
  const h = agentHarness();
  h.context.remoteProcessingAllowed = () => true; h.context.serverCloud = { available: true };
  h.context.apiSend = async () => ({ memories: [{ title: 'wallet', content: 'drawer', source: 'Your note', time: 1577880000000 }], rooms: [] });
  const result = await h.AsthaToolRegistry.call('tool_rag_retrieve', { search_query: 'wallet' }, {});
  assert.equal(result.memories[0].location, 'drawer'); assert.equal(result.memories[0].source, 'Your note');
  assert.equal(result.memories[0].time, 1577880000000);
  h.context.apiSend = async () => ({ memories: [], rooms: [] });
  assert.equal((await h.AsthaToolRegistry.call('tool_rag_retrieve', { search_query: 'wallet' }, {})).found, false);
});
