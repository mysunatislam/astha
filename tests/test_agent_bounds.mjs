import test, { after } from 'node:test';
import assert from 'node:assert/strict';

// Isolated in-memory database and a fake provider key; fetch is mocked in every test.
Object.assign(process.env, { DB_PROVIDER: 'sqlite', DB_PATH: ':memory:',
  SUPABASE_DB_URL: '', SUPABASE_DB_CA_FILE: '', RENDER_EXTERNAL_URL: '' });
process.env.CLOUD_AI_PROVIDER = 'auto';
for (const name of ['MAIRA_API_KEY', 'MAIRA_PROJECT_KEY', 'MAIRA_PROFILE_ID', 'MAIRA_API_URL', 'API_KEY', 'PROJECT_KEY', 'GEMINI_API_KEY', 'GEMINI_MODELS']) process.env[name] = '';
const { agentRouter, sanitizePlan, sanitizeEvaluation, sanitizeSpokenResponse, AGENT_TOOLS } = await import('../server/agent.js');
const { applyRetention, RETENTION } = await import('../server/retention.js');
const { isBody, isText, isFrame, jsonWithin, clipText, MAX_FRAME_CHARS } = await import('../server/validate.js');
const { db, run, get, all } = await import('../server/db.js');
after(() => db.close());

const providerReply = result => new Response(JSON.stringify({
  candidates: [{ content: { parts: [{ text: JSON.stringify(result) }] } }],
}), { status: 200, headers: { 'Content-Type': 'application/json' } });
const userId = 'agent-bounds-user';
run('INSERT INTO users (id,name,phone,passcode_hash,passcode_salt,created_at) VALUES (?,?,?,?,?,?)',
  [userId, 'Bounds user', null, 'unused-test-hash', 'unused-test-salt', Date.now()]);
function route(path) {
  const handle = agentRouter.stack.find(layer => layer.route?.path === path).route.stack[0].handle;
  return async body => {
    const reply = { status: 200, body: undefined };
    await handle({ user: { id: userId }, body }, {
      status(value) { reply.status = value; return this; },
      json(value) { reply.body = value; return this; },
    });
    return reply;
  };
}
const step = (overrides = {}) => ({ id: 'step_1', tool: 'tool_vision_detect', args: { target_item: 'wallet' }, purpose: 'Look', acceptance_criteria: 'found', ...overrides });

test('shared validators bound scalars, frames and nested JSON', () => {
  assert(isBody({})); assert(!isBody([])); assert(!isBody(null)); assert(!isBody('text'));
  assert(isText('চশমা', 4)); assert(!isText('চশমা!', 4)); assert(!isText('  ', 4)); assert(isText('', 4, false)); assert(!isText(7, 4, false));
  assert(isFrame(undefined)); assert(isFrame(null)); assert(isFrame('AAAA'));
  assert(!isFrame(1)); assert(!isFrame({})); assert(!isFrame('A'.repeat(MAX_FRAME_CHARS + 1)));
  assert(jsonWithin({ a: 'চ' }, 11)); assert(!jsonWithin({ a: 'চ' }, 10)); assert(!jsonWithin(undefined, 100));
  const circular = {}; circular.self = circular; assert(!jsonWithin(circular, 100));
  assert.equal(clipText('abcdef', 3), 'abc'); assert.equal(clipText(5, 3), ''); assert.equal(clipText(null, 3, 'none'), 'none');
});

test('a generated plan keeps only bounded steps for declared tools', () => {
  const plan = sanitizePlan({ goal: 'ignored provider goal', summary: 's'.repeat(900), extra: 'dropped', steps: [
    step({ purpose: 'p'.repeat(900), unexpected: 'dropped' }),
    step({ id: { nested: true }, tool: 'tool_ocr_read', args: 'not an object' }),
    step({ id: 'i'.repeat(65), tool: 'tool_safety_scan', args: { area: 'x'.repeat(4000) }, purpose: 12, acceptance_criteria: null }),
  ] }, 'find wallet');
  assert.deepEqual(Object.keys(plan), ['goal', 'summary', 'steps']);
  assert.equal(plan.goal, 'find wallet'); assert.equal(plan.summary.length, 500);
  assert.deepEqual(plan.steps.map(item => Object.keys(item)), Array(3).fill(['id', 'tool', 'args', 'purpose', 'acceptance_criteria']));
  assert.equal(plan.steps[0].purpose.length, 300); assert.deepEqual(plan.steps[0].args, { target_item: 'wallet' });
  assert.equal(plan.steps[1].id, 'step_2'); assert.deepEqual(plan.steps[1].args, {});
  assert.equal(plan.steps[2].id, 'step_3'); assert.deepEqual(plan.steps[2].args, {});
  assert.equal(plan.steps[2].purpose, ''); assert.equal(plan.steps[2].acceptance_criteria, '');
  for (const invalid of [null, 'plan', [], {}, { steps: 'none' }, { steps: [] }, { steps: Array(7).fill(step()) },
    { steps: [step(), step({ tool: 'tool_shell_exec' })] }, { steps: [step({ tool: undefined })] }, { steps: ['tool_vision_detect'] },
    { steps: [step({ tool: 'constructor' })] }]) {
    assert.equal(sanitizePlan(invalid, 'find wallet'), null);
  }
  assert.equal(AGENT_TOOLS.length, 7);
});

test('generated evaluations and spoken answers are reduced to their declared, bounded fields', () => {
  assert.deepEqual(sanitizeEvaluation({ verified: true, score: 7, evaluation_reason: 'r'.repeat(900), needs_correction: 'yes', injected: 'dropped',
    corrective_action: { type: 'run_command', direction: 'jump', instruction_en: 'e'.repeat(900), instruction_bn: 5, extra: 1 } }),
  { verified: true, score: 0, evaluation_reason: 'r'.repeat(500), needs_correction: false,
    corrective_action: { type: 'none', direction: 'none', instruction_en: 'e'.repeat(300), instruction_bn: '' } });
  assert.deepEqual(sanitizeEvaluation({ verified: false, score: 0.4, needs_correction: true, corrective_action: { type: 'guidance', direction: 'step_back' } }),
    { verified: false, score: 0.4, evaluation_reason: '', needs_correction: true,
      corrective_action: { type: 'guidance', direction: 'step_back', instruction_en: '', instruction_bn: '' } });
  assert.deepEqual(sanitizeEvaluation({ verified: false, score: NaN }), { verified: false, score: 0, evaluation_reason: '', needs_correction: false });
  for (const invalid of [null, [], 'verified', {}, { verified: 'true' }, { verified: 1 }]) assert.equal(sanitizeEvaluation(invalid), null);

  assert.deepEqual(sanitizeSpokenResponse({ en: 'It is on the table.', bn: 'টেবিলে আছে।', success: true, extra: {} }), { en: 'It is on the table.', bn: 'টেবিলে আছে।' });
  assert.deepEqual(sanitizeSpokenResponse({ en: 'Only English.' }), { en: 'Only English.', bn: '' });
  for (const invalid of [null, [], {}, { en: '' }, { en: '   ' }, { en: 5 }, { en: 'x'.repeat(2001) }, { en: 'ok', bn: ['bn'] }, { en: 'ok', bn: 'ব'.repeat(2001) }]) {
    assert.equal(sanitizeSpokenResponse(invalid), null);
  }
});

test('a provider plan naming an undeclared tool is replaced by the heuristic plan before storage', async t => {
  process.env.GEMINI_API_KEY = 'unit-test-key';
  t.after(() => { process.env.GEMINI_API_KEY = ''; });
  const marker = 'provider-injected-marker';
  t.mock.method(globalThis, 'fetch', async () => providerReply({ summary: marker,
    steps: [step(), { id: 'step_2', tool: 'tool_delete_everything', args: { marker }, purpose: marker }] }));
  const planned = await route('/agent/plan')({ goal: 'find my wallet' });
  assert.equal(planned.status, 200);
  assert.match(planned.body.plan.summary, /^Heuristic plan/);
  assert(planned.body.plan.steps.every(item => AGENT_TOOLS.some(tool => tool.name === item.tool)));
  const stored = get('SELECT plan_json FROM agent_tasks WHERE id = ? AND user_id = ?', [planned.body.taskId, userId]);
  assert(!stored.plan_json.includes(marker) && !JSON.stringify(planned.body).includes(marker));
});

test('a valid provider plan is stored in its bounded shape and oversized fields never reach the row', async t => {
  process.env.GEMINI_API_KEY = 'unit-test-key';
  t.after(() => { process.env.GEMINI_API_KEY = ''; });
  t.mock.method(globalThis, 'fetch', async () => providerReply({ goal: 'provider goal', summary: 'Look on the desk', huge: 'h'.repeat(50000),
    steps: [step({ purpose: 'p'.repeat(5000), args: { target_item: 'wallet', padding: 'a'.repeat(5000) } })] }));
  const planned = await route('/agent/plan')({ goal: 'find my wallet' });
  assert.equal(planned.status, 200);
  assert.deepEqual(planned.body.plan, { goal: 'find my wallet', summary: 'Look on the desk',
    steps: [{ id: 'step_1', tool: 'tool_vision_detect', args: {}, purpose: 'p'.repeat(300), acceptance_criteria: 'found' }] });
  const stored = get('SELECT plan_json FROM agent_tasks WHERE id = ? AND user_id = ?', [planned.body.taskId, userId]);
  assert.deepEqual(JSON.parse(stored.plan_json), planned.body.plan);
  assert(stored.plan_json.length < 1000);
});

test('a malformed generated evaluation or answer falls back instead of reaching the caller', async t => {
  process.env.GEMINI_API_KEY = 'unit-test-key';
  t.after(() => { process.env.GEMINI_API_KEY = ''; });
  const evidence = { step: step(), toolOutput: { found: true, item: 'wallet', confidence: 0.9 }, goal: 'find wallet' };
  let reply = { verified: 'definitely', score: 1, evaluation_reason: 'trust me' };
  t.mock.method(globalThis, 'fetch', async () => providerReply(reply));
  const fallback = await route('/agent/evaluate')(evidence);
  assert.equal(fallback.status, 200);
  assert.equal(fallback.body.evaluation.evaluation_reason, 'Target detected with acceptable confidence');
  reply = { verified: true, score: 0.8, evaluation_reason: 'Seen on the desk', needs_correction: false, leaked: 'dropped',
    corrective_action: { type: 'shell', direction: 'none', instruction_en: 'ok', instruction_bn: 'ঠিক আছে' } };
  const accepted = await route('/agent/evaluate')(evidence);
  assert.deepEqual(accepted.body.evaluation, { verified: true, score: 0.8, evaluation_reason: 'Seen on the desk', needs_correction: false,
    corrective_action: { type: 'none', direction: 'none', instruction_en: 'ok', instruction_bn: 'ঠিক আছে' } });
  // Generated approval still cannot replace missing evidence.
  const unsupported = await route('/agent/evaluate')({ ...evidence, toolOutput: { found: true, item: 'person', confidence: 0.99 } });
  assert.equal(unsupported.body.evaluation.verified, false);

  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => providerReply(++calls === 1 ? { steps: [step()] } : { en: ['not', 'a', 'sentence'], bn: 7, success: true }));
  const run1 = await route('/agent/run')({ goal: 'find wallet' });
  assert.equal(run1.status, 200); assert.equal(calls, 2);
  assert.equal(typeof run1.body.response.en, 'string'); assert.equal(typeof run1.body.response.bn, 'string');
  assert.equal(run1.body.response.success, false); assert.equal(run1.body.status, 'needs_verification');
});

test('retention accepts only its fixed tables and a failed prune never fails the caller', async () => {
  assert.deepEqual(Object.keys(RETENTION), ['memories', 'rooms', 'events', 'agent_tasks', 'knowledge_docs']);
  assert(Object.isFrozen(RETENTION) && Object.values(RETENTION).every(Object.isFrozen));
  for (const table of ['users', 'memories; DROP TABLE users', 'constructor', '', undefined]) {
    await assert.rejects(applyRetention(table, userId), /Unsupported retention table/);
  }
  const insert = db.prepare('INSERT INTO events (id,user_id,kind,text,created_at) VALUES (?,?,?,?,?)');
  // Equal timestamps still prune deterministically, by id.
  for (let i = 0; i < 205; i++) insert.run('tie-' + String(i).padStart(3, '0'), userId, 'note', 'event', 5000);
  assert.equal(await applyRetention('events', userId), true);
  const remaining = all('SELECT id FROM events WHERE user_id = ? ORDER BY id', [userId]).map(row => row.id);
  assert.equal(remaining.length, 200); assert.equal(remaining[0], 'tie-005'); assert.equal(remaining.at(-1), 'tie-204');
  db.exec("CREATE TRIGGER block_event_prune BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT, 'synthetic prune failure'); END;");
  try {
    insert.run('tie-999', userId, 'note', 'event', 6000);
    assert.equal(await applyRetention('events', userId), false);
  } finally { db.exec('DROP TRIGGER block_event_prune'); }
  assert.equal(get('SELECT COUNT(*) AS n FROM events WHERE user_id = ?', [userId]).n, 201);
});
