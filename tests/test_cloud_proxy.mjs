import test, { after } from 'node:test';
import assert from 'node:assert/strict';

// Isolated process/database and fake provider configuration; no live provider call is allowed.
Object.assign(process.env, { DB_PROVIDER: 'sqlite', DB_PATH: ':memory:',
  SUPABASE_DB_URL: '', SUPABASE_DB_CA_FILE: '', RENDER_EXTERNAL_URL: '' });
process.env.CLOUD_AI_PROVIDER = 'auto';
process.env.MAIRA_API_KEY = '';
process.env.MAIRA_PROJECT_KEY = '';
process.env.MAIRA_PROFILE_ID = '';
process.env.MAIRA_API_URL = '';
process.env.API_KEY = '';
process.env.PROJECT_KEY = '';
process.env.GEMINI_API_KEY = '';
process.env.GEMINI_MODELS = '';
const { getGeminiModels, DEFAULT_GEMINI_MODELS, callGemini } = await import('../server/gemini.js');
const { agentRouter } = await import('../server/agent.js');
const { db, run, get } = await import('../server/db.js');
after(() => db.close());

const providerReply = result => new Response(JSON.stringify({
  candidates: [{ content: { parts: [{ text: JSON.stringify(result) }] } }],
}), { status: 200, headers: { 'Content-Type': 'application/json' } });

test('Gemini defaults to a documented stable model and bounds explicitly configured fallback IDs', () => {
  assert.deepEqual(DEFAULT_GEMINI_MODELS, ['gemini-3.6-flash']);
  assert.deepEqual(getGeminiModels(''), ['gemini-3.6-flash']);
  assert.deepEqual(getGeminiModels('gemini-3.6-flash, gemini-3.8-flash'), ['gemini-3.6-flash', 'gemini-3.8-flash']);
  assert.deepEqual(getGeminiModels(['gemini-3.6-flash', 'gemini-3.6-flash']), ['gemini-3.6-flash']);
  assert.deepEqual(getGeminiModels('gemini-3-flash-preview'), ['gemini-3-flash-preview']); // explicit operator choice
  for (const invalid of [[], ['gemini-3.6-flash', 'gemini-3.7-flash', 'gemini-3.8-flash', 'gemini-3.5-flash'],
    'gemini-3.6-flash,', 'https://evil.example/model', 'gemini-x/../../secret', ['gemini-x?key=secret'], {}]) {
    assert.throws(() => getGeminiModels(invalid), /exact Gemini model IDs/);
  }
});

test('a missing configured model falls back only to the next configured model', async t => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async url => {
    calls.push(new URL(url).pathname);
    return calls.length === 1 ? new Response('{}', { status: 404 }) :
      providerReply({ en: 'A chair is visible.', bn: 'একটি চেয়ার দেখা যাচ্ছে।' });
  });
  const result = await callGemini({ task: 'describe', apiKey: 'unit-test-key', models: ['gemini-3.6-flash', 'gemini-3.8-flash'] });
  assert.equal(result.bn, 'একটি চেয়ার দেখা যাচ্ছে।');
  assert.deepEqual(calls, ['/v1beta/models/gemini-3.6-flash:generateContent', '/v1beta/models/gemini-3.8-flash:generateContent']);
});

test('rate limits do not trigger additional provider calls and invalid model config never reaches fetch', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls += 1; return new Response('{}', { status: 429 }); });
  await assert.rejects(callGemini({ task: 'describe', apiKey: 'unit-test-key', models: ['gemini-3.6-flash', 'gemini-3.8-flash'] }),
    error => error.code === 'rate_limit');
  assert.equal(calls, 1);
  await assert.rejects(callGemini({ task: 'describe', apiKey: 'unit-test-key', models: ['gemini-x/invalid'] }),
    error => error.code === 'bad_request');
  assert.equal(calls, 1);
});

const handler = agentRouter.stack.find(layer => layer.route?.path === '/agent/run').route.stack[0].handle;
const userId = 'cloud-regression-user';
run('INSERT INTO users (id,name,phone,passcode_hash,passcode_salt,created_at) VALUES (?,?,?,?,?,?)',
  [userId, 'Test user', null, 'unused-test-hash', 'unused-test-salt', Date.now()]);

async function agentRun(body) {
  let result, status = 200;
  await handler({ user: { id: userId }, body }, {
    status(value) { status = value; return this; },
    json(value) { result = value; return this; },
  });
  assert.equal(status, 200);
  assert.equal(result.ok, true);
  const stored = get('SELECT status,result_json FROM agent_tasks WHERE id = ? AND user_id = ?', [result.taskId, userId]);
  assert.equal(stored.status, 'needs_verification');
  assert.equal(result.status, 'needs_verification');
  assert.equal(result.response.success, false);
  assert.equal(result.response.verification_reason, 'server_tools_not_executed');
  assert.equal(JSON.parse(stored.result_json).success, false);
  return result;
}

test('a cloud success claim and client observation cannot mark unexecuted tools completed', async t => {
  process.env.GEMINI_API_KEY = 'unit-test-key';
  t.after(() => { process.env.GEMINI_API_KEY = ''; });
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls += 1;
    return providerReply(calls === 1 ? { goal: 'find wallet', steps: [{ id: 'step_1', tool: 'tool_vision_detect', args: { target_item: 'wallet' } }] } :
      { en: 'The wallet appears ahead.', bn: 'মানিব্যাগটি সামনে দেখা যাচ্ছে।', success: true });
  });
  const result = await agentRun({ goal: 'find wallet', observations: [{ stepId: 'step_1', tool: 'tool_vision_detect', output: { found: true, confidence: 1 } }] });
  assert.equal(calls, 2);
  assert.ok(result.plan.steps.length > 0);
});

test('memory and no-evidence fallbacks remain useful without claiming a checked or completed task', async t => {
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected provider call without credentials'); });
  const noEvidence = await agentRun({ goal: 'find wallet' });
  assert.ok(!noEvidence.response.en.includes('planned and checked'));
  run('INSERT INTO memories (id,user_id,item,location,source,score,created_at) VALUES (?,?,?,?,?,?,?)',
    ['cloud-regression-memory', userId, 'wallet', 'drawer', 'Your note', 0.9, Date.now()]);
  const memory = await agentRun({ goal: 'where is my wallet' });
  assert.ok(memory.response.en.includes('According to your saved records'));
});

