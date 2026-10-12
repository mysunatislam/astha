import assert from 'node:assert';
// Select disposable storage before evaluating application imports, even in a configured shell.
Object.assign(process.env, { DB_PROVIDER: 'sqlite', DB_PATH: ':memory:',
  SUPABASE_DB_URL: '', SUPABASE_DB_CA_FILE: '', RENDER_EXTERNAL_URL: '' });
const { expandQueryTerms, searchRAG, formatRagContextForPrompt } = await import('../server/rag.js');
const { generateHeuristicPlan, evaluateHeuristicStep, AGENT_TOOLS } = await import('../server/agent.js');
const { run, get } = await import('../server/db.js');

console.log('=== Running Server RAG & Agent Unit Tests ===');

// 1. Synonym Expansion Test
console.log('Test 1: Bilingual Query Synonym Expansion...');
const terms = expandQueryTerms('আমার wallet কোথায়');
assert(terms.includes('wallet'), 'Should contain "wallet"');
assert(terms.includes('moneybag') || terms.includes('মানিব্যাগ'), 'Should contain bilingual synonym for wallet');
console.log('  -> Terms expanded:', terms);
console.log('  -> PASS');

// 2. RAG Search & Context Assembly Test
console.log('Test 2: RAG Search & Context Assembly...');
// Create a temporary test user and seed memory
const testUserId = 'test_user_' + Date.now();
const testPhone = '019' + Math.floor(10000000 + Math.random() * 90000000);
run('INSERT INTO users (id, name, phone, passcode_hash, passcode_salt, created_at) VALUES (?,?,?,?,?,?)',
  [testUserId, 'Test User', testPhone, 'hash', 'salt', Date.now()]);
const roomId = 'room_' + Date.now();
const memId = 'mem_' + Date.now();
run('INSERT INTO rooms (id, user_id, name, notes, updated_at) VALUES (?,?,?,?,?)',
  [roomId, testUserId, 'Reading Room', 'Dressing table on left, bookshelf ahead, wooden desk by window', Date.now()]);
run('INSERT INTO memories (id, user_id, item, location, source, score, created_at) VALUES (?,?,?,?,?,?,?)',
  [memId, testUserId, 'moneybag', 'On the dressing table in the reading room', 'Manual Note', 0.95, Date.now()]);

const ragRes = await searchRAG(testUserId, 'where is my wallet');
assert(ragRes.results.length > 0, 'Should find relevant results via synonym matching');
console.log('  -> RAG matches found:', ragRes.results.length);
assert(ragRes.memories.some(m => m.title.includes('moneybag')), 'Should match moneybag for wallet query');
assert(ragRes.rooms.some(r => r.title.includes('Reading Room')), 'Should match Reading Room');

const contextBlock = formatRagContextForPrompt(ragRes);
assert(contextBlock.includes('Dressing table'), 'Context block should mention dressing table landmark');
console.log('  -> Context block generated successfully');
console.log('  -> PASS');

// 3. Autonomous Task Planner Test
console.log('Test 3: Autonomous Task Decomposition & Step Planning...');
const plan = generateHeuristicPlan('Find my glasses, check if they are folded, and read the label on the case', ragRes);
assert(plan.steps && plan.steps.length >= 2, 'Should decompose goal into multiple sequential steps');
console.log(`  -> Generated ${plan.steps.length} plan steps:`);
plan.steps.forEach((s, idx) => console.log(`     ${idx + 1}. [${s.tool}] ${s.purpose}`));

assert(plan.steps.some(s => s.tool === 'tool_vision_detect'), 'Must include vision detect step');
assert(plan.steps.some(s => s.tool === 'tool_ocr_read' || s.tool === 'tool_visual_inspect_crop'), 'Must include inspect/ocr step');
console.log('  -> PASS');

// 4. Closed-Loop Evaluator & Self-Correction Verification Test
console.log('Test 4: Evaluator & Verification Loop...');
const visionStep = plan.steps.find(s => s.tool === 'tool_vision_detect');

// Case A: Target Found
const successOutput = { found: true, confidence: 0.85, item: 'glasses', position: 'ahead' };
const evalSuccess = evaluateHeuristicStep(visionStep, successOutput);
assert(evalSuccess.verified === true, 'High-confidence detection should pass verification');
assert(evalSuccess.needs_correction === false, 'Should not need correction on success');
console.log('  -> Verification Success branch: PASS');

// Case B: Target Missing / Low Confidence -> Evaluator triggers Self-Correction
const failOutput = { found: false, confidence: 0.1, objects: ['desk', 'monitor'] };
const evalFail = evaluateHeuristicStep(visionStep, failOutput);
assert(evalFail.verified === false, 'Missing target must fail verification');
assert(evalFail.needs_correction === true, 'Failed detection must trigger self-correction');
assert(evalFail.corrective_action && evalFail.corrective_action.type === 'guidance', 'Must generate spatial guidance correction');
assert(evalFail.corrective_action.instruction_en && evalFail.corrective_action.instruction_bn, 'Guidance must be bilingual');
console.log(`  -> Autonomous Self-Correction Guidance generated: "${evalFail.corrective_action.instruction_en}" / "${evalFail.corrective_action.instruction_bn}"`);
console.log('  -> Verification Self-Correction branch: PASS');

// Cleanup test user
run('DELETE FROM users WHERE id = ?', [testUserId]);

console.log('\n=== All Server RAG & Agent Unit Tests PASSED Successfully! ===\n');
