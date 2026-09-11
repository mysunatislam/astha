import assert from 'node:assert';
import fs from 'node:fs';

console.log('=== Running Client Agentic Framework Unit Tests ===');

// Mock browser globals
globalThis.window = globalThis;
globalThis.state = {
  memory: [
    { item: 'phone charger', location: 'On the bedside table in the bedroom', source: 'Manual', time: new Date().toISOString() }
  ],
  spatialHome: [
    { name: 'Bedroom', notes: 'Bed in center, bedside table on right with lamp', updated: new Date().toISOString() }
  ],
  world: new Map()
};

globalThis.announce = (en, bn, cat) => {
  console.log(`  [Spoken Announce]: "${en}" | "${bn}"`);
};
globalThis.playEarcon = (sound) => {};
globalThis.haptic = (pattern) => {};
globalThis.captureFrame = () => ({ width: 640, height: 480 });
globalThis.serverCloud = { checked: true, available: false };
globalThis.cloudReady = () => false;
globalThis.ensureVisionModels = async () => true;
globalThis.runCoco = async () => [
  { id: 'cell phone', score: 0.88, bbox: [100, 100, 80, 140] }
];
globalThis.$ = (id) => null;
globalThis.esc = (s) => s;
globalThis.withCamera = (fn) => false;

// Load tools/agent.js into runtime
const agentPath = new URL('../tools/agent.js', import.meta.url);
const agentCode = fs.readFileSync(agentPath, 'utf8');
const runAgentScript = new Function(agentCode);
runAgentScript();

assert(globalThis.ClientRAG, 'ClientRAG should be initialized on window');
assert(globalThis.AsthaToolRegistry, 'AsthaToolRegistry should be initialized on window');
assert(globalThis.AsthaEvaluator, 'AsthaEvaluator should be initialized on window');
assert(globalThis.AsthaAgent, 'AsthaAgent should be initialized on window');
console.log('Test 1: Global definitions and module loading... PASS');

// 2. Test Client RAG with Associative Expansion
console.log('Test 2: Client RAG Search & Associative 2-Hop Landmark Retrieval...');
const ragSearch = globalThis.ClientRAG.search('where is my charger');
assert(ragSearch.memories.length > 0, 'Should find charger memory');
assert(ragSearch.memories[0].location.includes('bedside table'), 'Should point to bedside table');
assert(ragSearch.rooms.length > 0, 'Associative RAG should pull Bedroom layout from memory reference');
console.log('  -> Found memory:', ragSearch.memories[0].title, 'at', ragSearch.memories[0].location);
console.log('  -> Associatively retrieved room:', ragSearch.rooms[0].title, '-', ragSearch.rooms[0].notes);
console.log('  -> PASS');

// 3. Test Tool Registry Execution
console.log('Test 3: AsthaToolRegistry Execution...');
const ragToolRes = await globalThis.AsthaToolRegistry.call('tool_rag_retrieve', { search_query: 'charger' }, {});
assert(ragToolRes.found === true, 'Tool call should return found true');
assert(ragToolRes.summary.includes('Bedside') || ragToolRes.summary.includes('bedside'), 'Summary should mention bedside table');
console.log('  -> tool_rag_retrieve executed cleanly');

const visionToolRes = await globalThis.AsthaToolRegistry.call('tool_vision_detect', { target_item: 'cell phone' }, { frame: { width: 640, height: 480 } });
assert(visionToolRes.found === true, 'Vision detect tool should find target');
assert(visionToolRes.position === 'left', 'Position should be calculated as left');
console.log('  -> tool_vision_detect returned position:', visionToolRes.position);
console.log('  -> PASS');

// 4. Test Evaluator & Verification Loop
console.log('Test 4: Client AsthaEvaluator Verification & Self-Correction...');
const testStep = { id: 'step_detect', tool: 'tool_vision_detect', args: { target_item: 'keys', min_confidence: 0.5 } };
// Fails because keys are not present in the current view
const failedObs = { found: false, confidence: 0 };
const evalRes = globalThis.AsthaEvaluator.evaluate(testStep, failedObs, 'Find my keys');
assert(evalRes.verified === false, 'Evaluation must be false');
assert(evalRes.needsCorrection === true, 'Must require self-correction');
assert(evalRes.correction.instruction_en.includes('tilt') || evalRes.correction.instruction_en.includes('pan'), 'Must give camera adjustment guidance');
console.log('  -> Self-correction guidance:', evalRes.correction.instruction_en);
console.log('  -> PASS');

// 5. End-to-End Simulation of AsthaAgent.run()
console.log('Test 5: End-to-End AsthaAgent.run() Execution Simulation...');
await globalThis.AsthaAgent.run('where is my phone');
assert(globalThis.AsthaAgent.state === 'COMPLETED', 'Agent state should reach COMPLETED');
assert(globalThis.AsthaAgent.observations.length >= 2, 'Agent should have executed plan steps');
console.log('  -> Completed steps count:', globalThis.AsthaAgent.observations.length);
console.log('  -> Final agent state:', globalThis.AsthaAgent.state);
console.log('  -> PASS');

console.log('\n=== All Client Agentic Framework Unit Tests PASSED Successfully! ===\n');
process.exit(0);
