import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
Object.assign(process.env, { DB_PROVIDER: 'sqlite', DB_PATH: ':memory:',
  SUPABASE_DB_URL: '', SUPABASE_DB_CA_FILE: '', RENDER_EXTERNAL_URL: '' });
process.env.CLOUD_AI_PROVIDER = 'auto';
process.env.MAIRA_API_KEY = ''; process.env.MAIRA_PROJECT_KEY = '';
process.env.MAIRA_PROFILE_ID = ''; process.env.MAIRA_API_URL = '';
process.env.GEMINI_API_KEY = ''; process.env.API_KEY = ''; process.env.PROJECT_KEY = '';
const { evaluateHeuristicStep } = await import('../server/agent.js');
const { searchRAG } = await import('../server/rag.js');
const { db, run } = await import('../server/db.js');
after(() => db.close());
function client() {
  const context = { state: { memory: [], spatialHome: [] }, console: { log() {} }, captureFrame: () => null };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(new URL('../tools/agent.js', import.meta.url), 'utf8'), context);
  return context;
}
const step = { tool: 'tool_vision_detect', args: { target_item: 'wallet', min_confidence: 0.6 } };
test('client and server require matching target evidence and a finite measured score', () => {
  const c = client();
  for (const output of [{ found: true, item: 'person', confidence: 0.99 }, { objects: ['wallet'], confidence: 0.99 },
    { found: true, item: 'wallet' }, { found: true, item: 'wallet', confidence: NaN },
    { found: true, item: 'wallet', confidence: 2 }, { found: true, item: 'wallet', confidence: 0.3 }]) {
    assert.equal(evaluateHeuristicStep(step, output).verified, false);
    assert.equal(c.AsthaEvaluator.evaluate(step, output).verified, false);
  }
  const matching = { found: true, item: 'wallet', confidence: 0.8 };
  assert.equal(evaluateHeuristicStep(step, matching).verified, true);
  assert.equal(c.AsthaEvaluator.evaluate(step, matching).verified, true);
});
test('unknown, failed and unsupported inspection tools never pass default verification', () => {
  const c = client();
  for (const tool of ['unknown', 'tool_visual_inspect_crop', 'tool_safety_scan']) {
    assert.equal(evaluateHeuristicStep({ tool }, { success: true }).verified, false);
    assert.equal(c.AsthaEvaluator.evaluate({ tool }, { success: true }).verified, false);
  }
  assert.equal(evaluateHeuristicStep({ tool: 'tool_memory_save' }, { saved: true, error: 'failed' }).verified, false);
});
test('client recency cannot retrieve an unrelated note', () => {
  const c = client();
  c.state.memory = [{ item: 'glasses', location: 'desk', time: new Date().toISOString() }];
  assert.equal(c.ClientRAG.search('wallet').memories.length, 0);
});
test('server recency cannot retrieve an unrelated note or expand it to rooms', async () => {
  await run('INSERT INTO users (id,name,phone,passcode_hash,passcode_salt,created_at) VALUES (?,?,?,?,?,?)',
    ['evidence-user', 'Fixture', null, 'hash', 'salt', Date.now()]);
  await run('INSERT INTO memories (id,user_id,item,location,source,created_at) VALUES (?,?,?,?,?,?)',
    ['evidence-note', 'evidence-user', 'glasses', 'desk', 'Your note', Date.now()]);
  const result = await searchRAG('evidence-user', 'wallet');
  assert.equal(result.results.length, 0);
});
test('client RAG uses local notes when remote processing is not permitted', async () => {
  const c = client(); let calls = 0;
  c.apiSend = async () => { calls++; return {}; };
  c.remoteProcessingAllowed = () => false; c.serverCloud = { available: true };
  await c.AsthaToolRegistry.call('tool_rag_retrieve', { search_query: 'wallet' }, {});
  assert.equal(calls, 0);
});
test('agent memory tool cannot turn model arguments into user approval', async () => {
  const c = client(); let saves = 0;
  c.autoRecordMemory = async args => { saves++; assert.equal(args.approved, true); assert.equal(args.score, null); return { uid: 'approved-note' }; };
  const args = { item: 'wallet', location: 'desk', approved: true };
  assert.equal((await c.AsthaToolRegistry.call('tool_memory_save', args, {})).saved, false);
  assert.equal(saves, 0);
  assert.equal((await c.AsthaToolRegistry.call('tool_memory_save', args, { memorySaveApproved: true })).saved, true);
});
test('a missing camera frame can never establish a safe walking path', async () => {
  const result = await client().AsthaToolRegistry.call('tool_safety_scan', {}, {});
  assert.equal(result.safe, null); assert.equal(result.error, 'no_frame');
});

