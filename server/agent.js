// Autonomous Agent Engine with Tool Orchestration, Planning, and Verification Loop
import { Router } from 'express';
import { nanoid } from 'nanoid';
import { callGemini, hasCloudAI } from './gemini.js';
import { searchRAG, formatRagContextForPrompt, expandQueryTerms } from './rag.js';
import { all, get, run } from './db.js';

export const agentRouter = Router();

// Standard Tool Declarations
export const AGENT_TOOLS = [
  {
    name: 'tool_vision_detect',
    description: 'Detects objects, people, landmarks, and spatial positions in the camera frame.',
    parameters: {
      type: 'object',
      properties: {
        target_item: { type: 'string', description: 'Specific object or category to detect (e.g. "glasses", "wallet", "table")' },
        min_confidence: { type: 'number', description: 'Minimum confidence threshold (0.0 to 1.0, default 0.5)' }
      },
      required: ['target_item']
    }
  },
  {
    name: 'tool_visual_inspect_crop',
    description: 'Zooms into a specific crop region of the frame for high-resolution inspection (e.g., verifying item state, ports, color, or condition).',
    parameters: {
      type: 'object',
      properties: {
        region: { type: 'string', enum: ['center', 'top-left', 'top-right', 'bottom-left', 'bottom-right', 'custom'], description: 'Region of interest' },
        feature_to_verify: { type: 'string', description: 'Specific visual detail to verify (e.g., "is it folded", "cable type", "color")' }
      },
      required: ['feature_to_verify']
    }
  },
  {
    name: 'tool_ocr_read',
    description: 'Reads printed or handwritten text, labels, signs, or medicine prescriptions in Bangla and English.',
    parameters: {
      type: 'object',
      properties: {
        focus_area: { type: 'string', description: 'Area to read, e.g. "center label", "entire page", "bottle text"' }
      }
    }
  },
  {
    name: 'tool_spatial_guidance',
    description: 'Generates directional instructions to guide the blind user to adjust camera position or move closer.',
    parameters: {
      type: 'object',
      properties: {
        direction: { type: 'string', enum: ['pan_left', 'pan_right', 'tilt_up', 'tilt_down', 'move_closer', 'step_back', 'hold_steady'], description: 'Guidance direction' },
        instruction_en: { type: 'string', description: 'Friendly English instruction for the blind user' },
        instruction_bn: { type: 'string', description: 'Natural spoken Bangla instruction for the blind user' }
      },
      required: ['direction', 'instruction_en', 'instruction_bn']
    }
  },
  {
    name: 'tool_rag_retrieve',
    description: 'Retrieves relevant past item memories, calibrated room landmarks, and user accessibility preferences.',
    parameters: {
      type: 'object',
      properties: {
        search_query: { type: 'string', description: 'Keywords or concept to look up in memory' }
      },
      required: ['search_query']
    }
  },
  {
    name: 'tool_memory_save',
    description: 'Saves a confirmed object placement or landmark observation into persistent user memory.',
    parameters: {
      type: 'object',
      properties: {
        item: { type: 'string', description: 'Name of the confirmed object' },
        location: { type: 'string', description: 'Confirmed room and surface' }
      },
      required: ['item', 'location']
    }
  },
  {
    name: 'tool_safety_scan',
    description: 'Scans for immediate drop-offs, stairs, high stage edges, or fast-approaching obstacles.',
    parameters: {
      type: 'object',
      properties: {
        area: { type: 'string', description: 'Area to scan, default "ground_path"' }
      }
    }
  }
];

// ---- Prompt Templates for Planner and Evaluator ----
const PLANNER_PROMPT = (goal, ragContext, visualSummary) => `You are the Autonomous Task Planner for Astha, an AI companion for a blind user in Bangladesh.
Goal: "${goal}"

Available Tools:
1. tool_rag_retrieve(search_query) -> Look up room landmarks & where items were last seen.
2. tool_vision_detect(target_item, min_confidence) -> Scan current frame for candidate objects/furniture.
3. tool_visual_inspect_crop(region, feature_to_verify) -> Zoom in to verify fine details (folded, color, brand, condition).
4. tool_ocr_read(focus_area) -> Read text/labels/medicine info.
5. tool_spatial_guidance(direction, instruction_en, instruction_bn) -> Guide user to pan/tilt camera if item is out of view.
6. tool_memory_save(item, location) -> Save confirmed item location.
7. tool_safety_scan(area) -> Check for path obstacles.

User Context & RAG Knowledge:
${ragContext || 'None available yet.'}

Current Visual Sensory State:
${visualSummary || 'Camera live frame available.'}

Instructions:
- Decompose the goal into 2 to 4 precise, sequential steps.
- Each step MUST specify:
  - id: short string (e.g. "step_1")
  - tool: one of the available tool names
  - args: parameters for the tool
  - purpose: what this step achieves
  - acceptance_criteria: clear condition that verifies whether the step succeeded (e.g. "target_found === true and confidence >= 0.6")
- If the item was last seen in a specific room/furniture according to RAG, start with verifying that context.
- Return JSON strictly matching:
{
  "goal": string,
  "summary": string,
  "steps": [
    {
      "id": string,
      "tool": string,
      "args": object,
      "purpose": string,
      "acceptance_criteria": string
    }
  ]
}`;

const EVALUATOR_PROMPT = (step, toolOutput, goal) => `You are the Verification Evaluator in Astha's closed-loop autonomous system.
Overall Goal: "${goal}"
Current Step: ${JSON.stringify(step)}
Observed Tool Output: ${JSON.stringify(toolOutput)}

Evaluate whether the step succeeded according to its purpose and acceptance criteria:
- Did the tool return confident, unambiguous information?
- If an object was searched for, was it actually located?
- If text was read, is it clear or noisy?
- If the step failed (e.g. item not found, frame blurry, low confidence), what autonomous corrective action should Astha take?
  (e.g., guide user to pan/tilt, re-examine a crop, or ask for steady camera).

Return JSON strictly matching:
{
  "verified": boolean,
  "score": number (0.0 to 1.0),
  "evaluation_reason": string,
  "needs_correction": boolean,
  "corrective_action": {
    "type": "guidance" | "crop" | "reorient" | "retry" | "none",
    "direction": "pan_left" | "pan_right" | "tilt_down" | "tilt_up" | "move_closer" | "hold_steady" | "none",
    "instruction_en": string,
    "instruction_bn": string
  }
}`;

const SYNTHESIZER_PROMPT = (goal, completedSteps, finalFindings) => `You are Astha, speaking to a blind user in Bangladesh.
User's Goal: "${goal}"
Execution Steps & Verified Findings:
${JSON.stringify(finalFindings, null, 2)}

Provide a warm, reassuring, concise response (1-3 sentences) summarizing the final answer.
Hazards or negative findings must be stated clearly without sugar-coating.
Return JSON strictly matching:
{
  "en": string,
  "bn": string,
  "success": boolean
}`;

// Helper: Rule-based fallback planner when cloud/Gemini is unavailable
export function generateHeuristicPlan(goal, ragData) {
  const g = goal.toLowerCase();
  const steps = [];

  // 1. RAG step if looking for items or locations
  if (/where|find|locate|কই|কোথায়|কোথায়|আমার|my/i.test(g)) {
    steps.push({
      id: 'step_rag',
      tool: 'tool_rag_retrieve',
      args: { search_query: goal },
      purpose: 'Look up past observations and room landmark records',
      acceptance_criteria: 'retrieved_records_count >= 0'
    });
  }

  // 2. Vision detect step
  const targetMatch = g.match(/(?:find|where is|locate|see|detect|check|my)\s+([a-z\s]+?)(?:$|[,.;!?]|\s+and|\s+on|\s+in|\s+with)/i);
  const targetItem = targetMatch ? targetMatch[1].trim() : 'item';
  steps.push({
    id: 'step_detect',
    tool: 'tool_vision_detect',
    args: { target_item: targetItem, min_confidence: 0.55 },
    purpose: `Scan frame to locate ${targetItem}`,
    acceptance_criteria: 'found === true && confidence >= 0.55'
  });

  // 3. OCR or crop inspection if specified
  if (/read|text|label|written|dose|prescription|লেখা|পড়|পড়/i.test(g)) {
    steps.push({
      id: 'step_ocr',
      tool: 'tool_ocr_read',
      args: { focus_area: 'center' },
      purpose: 'Read printed text and labels',
      acceptance_criteria: 'text_length > 0'
    });
  } else if (/color|colour|condition|clean|folded|broken|damage|রং|রঙ/i.test(g)) {
    steps.push({
      id: 'step_inspect',
      tool: 'tool_visual_inspect_crop',
      args: { region: 'center', feature_to_verify: 'condition and attributes' },
      purpose: 'Verify object attributes and condition',
      acceptance_criteria: 'attribute_determined === true'
    });
  }

  return {
    goal,
    summary: `Heuristic plan with ${steps.length} steps`,
    steps
  };
}

// Helper: Rule-based fallback evaluator
export function evaluateHeuristicStep(step, toolOutput) {
  if (!toolOutput) {
    return {
      verified: false,
      score: 0,
      evaluation_reason: 'No tool output returned',
      needs_correction: true,
      corrective_action: {
        type: 'guidance',
        direction: 'hold_steady',
        instruction_en: 'Hold the camera steady while I look again.',
        instruction_bn: 'ক্যামেরাটি স্থির রাখুন, আমি আবার দেখছি।'
      }
    };
  }

  if (step.tool === 'tool_vision_detect') {
    const target = String(step.args?.target_item || '').toLowerCase().trim();
    const item = typeof toolOutput.item === 'string' ? toolOutput.item.toLowerCase().trim() : '';
    const found = toolOutput.found === true && item && target && (target === item || expandQueryTerms(target).includes(item));
    const score = Number.isFinite(toolOutput.confidence) && toolOutput.confidence >= 0 && toolOutput.confidence <= 1 ? toolOutput.confidence : 0;
    const minimum = Number.isFinite(step.args?.min_confidence) ? Math.max(0.5, step.args.min_confidence) : 0.5;
    if (found && score >= minimum) {
      return { verified: true, score, evaluation_reason: 'Target detected with acceptable confidence', needs_correction: false };
    }
    // Corrective action: advise user to pan/tilt
    return {
      verified: false,
      score,
      evaluation_reason: 'Target item not clearly visible in current frame',
      needs_correction: true,
      corrective_action: {
        type: 'guidance',
        direction: 'tilt_down',
        instruction_en: 'I do not see it in this angle; please tilt the camera down toward the surface.',
        instruction_bn: 'এই কোণ থেকে দেখতে পাচ্ছি না; ক্যামেরাটি টেবিলের দিকে আরেকটু নামান।'
      }
    };
  }

  if (step.tool === 'tool_ocr_read') {
    const textLen = (toolOutput.text || '').trim().length;
    if (textLen >= 3) {
      return { verified: true, score: 0.9, evaluation_reason: 'Readable text acquired', needs_correction: false };
    }
    return {
      verified: false,
      score: 0.3,
      evaluation_reason: 'No readable text identified in current view',
      needs_correction: true,
      corrective_action: {
        type: 'guidance',
        direction: 'move_closer',
        instruction_en: 'Please move the camera a little closer to read the text clearly.',
        instruction_bn: 'লেখা স্পষ্ট পড়তে ক্যামেরাটি আরেকটু কাছে নিন।'
      }
    };
  }

  const supported = {
    tool_rag_retrieve: () => toolOutput.found === true && [toolOutput.memories, toolOutput.rooms].some(rows => Array.isArray(rows) && rows.length > 0),
    tool_spatial_guidance: () => toolOutput.delivered === true,
    tool_memory_save: () => toolOutput.saved === true,
  };
  const verified = !toolOutput.error && !!supported[step.tool]?.();
  return { verified, score: verified ? 1 : 0, evaluation_reason: verified ? 'Supported tool result received; this does not establish visual or path safety' : 'No supported verification evidence', needs_correction: false };
}

// ---- API Routes ----

// 1. Plan Route
agentRouter.post('/agent/plan', async (req, res) => {
  const { goal, image } = req.body || {};
  if (!goal) return res.status(400).json({ error: 'goal_required' });

  try {
    const ragData = await searchRAG(req.user.id, goal, { limit: 5 });
    const ragContext = formatRagContextForPrompt(ragData);

    let plan = null;
    if (hasCloudAI()) {
      try {
        const prompt = PLANNER_PROMPT(goal, ragContext, image ? 'Camera frame provided' : 'No frame');
        plan = await callGemini({ customPrompt: prompt, imageBase64: image, userId: req.user?.id || 'astha-user' });
      } catch (err) {
        console.warn('Planner fallback to heuristic:', err.message);
      }
    }

    if (!plan || !plan.steps || !plan.steps.length) {
      plan = generateHeuristicPlan(goal, ragData);
    }

    const taskId = nanoid();
    const now = Date.now();
    run(
      'INSERT INTO agent_tasks (id, user_id, goal, plan_json, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?)',
      [taskId, req.user.id, goal, JSON.stringify(plan), 'planned', now, now]
    );

    res.json({ ok: true, taskId, plan, ragContext });
  } catch (err) {
    console.error('Agent plan error:', err);
    res.status(500).json({ error: 'agent_plan_failed', message: err.message });
  }
});

// 2. Evaluate / Verification Route
agentRouter.post('/agent/evaluate', async (req, res) => {
  const { step, toolOutput, goal } = req.body || {};
  if (!step || !toolOutput) return res.status(400).json({ error: 'step_and_toolOutput_required' });

  try {
    let evaluation = null;
    if (hasCloudAI()) {
      try {
        const prompt = EVALUATOR_PROMPT(step, toolOutput, goal || 'General task');
        evaluation = await callGemini({ customPrompt: prompt, userId: req.user?.id || 'astha-user' });
      } catch (err) {
        console.warn('Evaluator fallback to heuristic:', err.message);
      }
    }

    if (!evaluation || evaluation.verified === undefined) {
      evaluation = evaluateHeuristicStep(step, toolOutput);
    }
    // Generated text cannot override missing target evidence or an unsupported tool.
    const evidence = evaluateHeuristicStep(step, toolOutput);
    if (!evidence.verified) evaluation = evidence;

    res.json({ ok: true, evaluation });
  } catch (err) {
    console.error('Agent evaluate error:', err);
    res.status(500).json({ error: 'agent_evaluate_failed', message: err.message });
  }
});

// 3. Planning/synthesis route. Actual tool execution remains in the client agent loop.
agentRouter.post('/agent/run', async (req, res) => {
  const { goal, image, observations = [] } = req.body || {};
  if (!goal) return res.status(400).json({ error: 'goal_required' });

  try {
    // 1. RAG retrieval
    const ragData = await searchRAG(req.user.id, goal, { limit: 5 });
    const ragContext = formatRagContextForPrompt(ragData);

    // 2. Plan generation
    let plan = null;
    if (hasCloudAI()) {
      try {
        plan = await callGemini({
          customPrompt: PLANNER_PROMPT(goal, ragContext, image ? 'Camera frame provided' : 'No frame'),
          imageBase64: image,
          userId: req.user?.id || 'astha-user'
        });
      } catch (e) {
        console.warn('Planner fallback to heuristic:', e.message);
      }
    }
    if (!plan || !plan.steps) {
      plan = generateHeuristicPlan(goal, ragData);
    }

    // 3. Synthesize response based on findings & RAG
    let response = null;
    const combinedFindings = {
      goal,
      ragMatches: ragData.results.slice(0, 3),
      clientObservations: observations,
      planSteps: plan.steps
    };

    if (hasCloudAI()) {
      try {
        response = await callGemini({
          customPrompt: SYNTHESIZER_PROMPT(goal, plan.steps, combinedFindings),
          imageBase64: image,
          userId: req.user?.id || 'astha-user'
        });
      } catch (e) {
        console.warn('Synthesizer fallback:', e.message);
      }
    }

    if (!response || !response.en) {
      // Heuristic synthesis
      const topMemory = ragData.memories[0];
      if (topMemory) {
        response = {
          en: `According to your saved records, your ${topMemory.title} was last seen at ${topMemory.content}.`,
          bn: `আপনার সংরক্ষিত তথ্য অনুযায়ী, আপনার ${topMemory.title} শেষবার দেখা গিয়েছিল ${topMemory.content}-এ।`,
          success: false
        };
      } else {
        response = {
          en: `I have planned the steps for ${goal}. Please point the camera directly at the surface so I can verify.`,
          bn: `${goal}-এর জন্য পরিকল্পনা করা হয়েছে। নিশ্চিত হতে ক্যামেরাটি টেবিল বা নির্দিষ্ট স্থানের দিকে ধরুন।`,
          success: false
        };
      }
    }

    // A generated plan, historical memory or model's success claim is not verified tool execution.
    // This route has not executed any declared tools; preserve the client loop and require verification.
    response = { ...response, success: false, verification_reason: 'server_tools_not_executed' };
    const status = 'needs_verification';
    const taskId = nanoid();
    const now = Date.now();
    run(
      'INSERT INTO agent_tasks (id, user_id, goal, plan_json, status, result_json, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)',
      [taskId, req.user.id, goal, JSON.stringify(plan), status, JSON.stringify(response), now, now]
    );

    res.json({
      ok: true,
      taskId,
      status,
      plan,
      rag: ragData,
      response
    });
  } catch (err) {
    console.error('Agent run error:', err);
    res.status(500).json({ error: 'agent_run_failed', message: err.message });
  }
});
