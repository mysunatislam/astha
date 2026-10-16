/* =====================================================================
   Astha Autonomous Agentic Engine
   Provides:
   1. Standardized Tool Orchestration (Vision, Crop, OCR, Guidance, RAG, Memory, Safety)
   2. Client & Cloud Retrieval-Augmented Generation (RAG) over Room & Item Vaults
   3. Goal Decomposition & Autonomous Task Planning
   4. Closed-Loop Verification Evaluator with Self-Correction Feedback Loop
   5. Accessible Spoken & Visual Transparency for Blind/Visually Impaired Users
   ===================================================================== */

const AGENT_SYNONYMS = {
  wallet: ['moneybag', 'purse', 'billfold', 'মানিব্যাগ', 'মানিবেগ', 'ওয়ালেট'],
  moneybag: ['wallet', 'purse', 'মানিব্যাগ', 'মানিবেগ', 'ওয়ালেট'],
  glasses: ['spectacles', 'sunglasses', 'eyeglasses', 'specs', 'চশমা', 'রোদচশমা'],
  charger: ['adapter', 'power cable', 'usb cable', 'চার্জার', 'এডাপ্টার'],
  'laptop charger': ['laptop adapter', 'power brick', 'ল্যাপটপ চার্জার', 'চার্জার'],
  'phone charger': ['mobile charger', 'usb-c charger', 'ফোন চার্জার', 'চার্জার'],
  phone: ['mobile', 'cellphone', 'smartphone', 'ফোন', 'মোবাইল', 'সেলফোন'],
  keys: ['keychain', 'car key', 'door key', 'চাবি', 'চাবির গোছা'],
  powerbank: ['battery pack', 'portable battery', 'পাওয়ার ব্যাংক', 'পাওয়ারব্যাংক'],
  medicine: ['prescription', 'pills', 'tablets', 'medication', 'ওষুধ', 'ঔষধ', 'ট্যাবলেট'],
  table: ['desk', 'counter', 'surface', 'dressing table', 'reading table', 'টেবিল', 'ডেস্ক'],
  'dressing table': ['vanity', 'dresser', 'ড্রেসিং টেবিল'],
  'reading table': ['study desk', 'work table', 'পড়ার টেবিল', 'রিডিং টেবিল'],
  bed: ['mattress', 'bedstead', 'বিছানা', 'খাট']
};

const ClientRAG = {
  expandTerms(query) {
    const q = String(query || '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ');
    const words = q.split(/\s+/).filter(w => w.length >= 2);
    const terms = new Set(words);
    for (const [key, syns] of Object.entries(AGENT_SYNONYMS)) {
      if (q.includes(key) || syns.some(s => q.includes(s))) {
        terms.add(key);
        syns.forEach(s => terms.add(s));
      }
    }
    return Array.from(terms);
  },

  search(query, limit = 5) {
    const terms = this.expandTerms(query);
    const now = Date.now();

    // 1. Memories
    const mems = (state.memory || []).map(m => {
      const text = `${m.item} ${m.location} ${m.source || ''}`.toLowerCase();
      let score = 0;
      for (const t of terms) {
        if (text.includes(t)) score += (t.length >= 4 ? 3 : 1.5);
      }
      const hoursAgo = Math.max(0, (now - new Date(m.time).getTime()) / (1000 * 3600));
      if (score > 0 && hoursAgo < 2) score += 2;
      else if (score > 0 && hoursAgo < 24) score += 1;
      return { type: 'memory', title: m.item, location: m.location, source: m.source, time: m.time, score };
    }).filter(m => m.score > 0).sort((a, b) => b.score - a.score);

    // 2. Associative 2-hop RAG expansion from top memories to room landmarks
    const associativeTerms = new Set(terms);
    mems.slice(0, 3).forEach(m => {
      const locWords = this.expandTerms(m.location);
      locWords.forEach(w => associativeTerms.add(w));
    });
    const roomSearchTerms = Array.from(associativeTerms);

    // 3. Spatial Rooms
    const rooms = (state.spatialHome || []).map(r => {
      const text = `${r.name} ${r.notes}`.toLowerCase();
      let score = 0;
      for (const t of roomSearchTerms) {
        if (text.includes(t)) score += (t.length >= 4 ? 3.5 : 2);
      }
      return { type: 'room', title: r.name, notes: r.notes, updated: r.updated, score };
    }).filter(r => r.score > 0).sort((a, b) => b.score - a.score);

    const topMems = mems.slice(0, limit);
    const topRooms = rooms.slice(0, limit);

    return {
      query,
      terms,
      memories: topMems,
      rooms: topRooms,
      hasContext: topMems.length > 0 || topRooms.length > 0
    };
  },

  formatContextBlock(ragResult) {
    const lines = ['Historical saved records do not confirm current object locations.'];
    if (ragResult.rooms && ragResult.rooms.length) {
      lines.push('Saved Room Notes (not a verified map):');
      ragResult.rooms.forEach(r => lines.push(`- ${r.title}: ${r.notes}`));
    }
    if (ragResult.memories && ragResult.memories.length) {
      lines.push('Past Item Memories:');
      ragResult.memories.forEach(m => {
        const recorded = m.time === null || m.time === undefined || m.time === '' ? NaN : new Date(m.time).getTime();
        const timestamp = Number.isFinite(recorded) ? new Date(recorded).toISOString() : 'unknown';
        lines.push(`- ${m.title}: ${m.location ?? m.content} (Saved: ${timestamp}; Source: ${m.source || 'unknown'})`);
      });
    }
    return lines.join('\n');
  }
};

// Tool callbacks share the owning run's source/account/privacy snapshot.
function agentToolCurrent(ctx) { return !ctx?.current || ctx.current(); }

const AsthaToolRegistry = {
  tools: {},

  register(name, desc, fn) {
    this.tools[name] = { name, desc, execute: fn };
  },

  async call(name, args, context) {
    if (!agentToolCurrent(context)) return { error: 'cancelled' };
    const tool = this.tools[name];
    if (!tool) throw new Error(`Unknown tool: ${name}`);
    console.log(`[Agent Tool] Calling ${name}:`, args);
    const result = await tool.execute(args, context);
    return agentToolCurrent(context) ? result : { error: 'cancelled' };
  }
};

// Register Standard Tools
AsthaToolRegistry.register('tool_rag_retrieve', 'Retrieves relevant memories and room landmarks', async (args, ctx) => {
  if (!agentToolCurrent(ctx)) return { error: 'cancelled' };
  const q = args.search_query || '';
  const local = ClientRAG.search(q);
  // Try server RAG if online
  if (typeof apiSend === 'function' && remoteProcessingAllowed() && serverCloud.available) {
    try {
      const srv = await apiSend('POST', '/api/rag/query', { query: q, limit: 5 });
      if (!agentToolCurrent(ctx)) return { error: 'cancelled' };
      if (srv) {
        const memories = Array.isArray(srv.memories) ? srv.memories.map(m => ({ ...m, location: m.location ?? m.content })) : local.memories;
        const rooms = Array.isArray(srv.rooms) ? srv.rooms : local.rooms;
        return {
          found: memories.length > 0 || rooms.length > 0,
          memories,
          rooms,
          summary: srv.contextBlock || ClientRAG.formatContextBlock(local)
        };
      }
    } catch (_) {}
  }
  return {
    found: local.hasContext,
    memories: local.memories,
    rooms: local.rooms,
    summary: ClientRAG.formatContextBlock(local)
  };
});

AsthaToolRegistry.register('tool_vision_detect', 'Scans camera frame for target object or obstacles', async (args, ctx) => {
  if (!agentToolCurrent(ctx)) return { error: 'cancelled' };
  const target = (args.target_item || '').toLowerCase().trim();
  const minConf = args.min_confidence || 0.45;
  const frame = ctx.frame || captureFrame(640);
  if (!frame) return { found: false, error: 'no_frame' };

  await ensureVisionModels();
  if (!agentToolCurrent(ctx)) return { error: 'cancelled' };
  const cocoObjs = await runCoco(frame);
  if (!agentToolCurrent(ctx)) return { error: 'cancelled' };
  state.lastCocoPreds = cocoObjs;

  // 1. Direct COCO hit
  const hit = cocoObjs.find(o => (o.id.toLowerCase().includes(target) || target.includes(o.id.toLowerCase())) && o.score >= minConf);
  if (hit) {
    const cx = (hit.bbox[0] + hit.bbox[2] / 2) / frame.width;
    const pos = cx < 0.35 ? 'left' : cx > 0.65 ? 'right' : 'ahead';
    return {
      found: true,
      item: hit.id,
      confidence: hit.score,
      position: pos,
      bbox: hit.bbox,
      objects: cocoObjs.map(o => o.id)
    };
  }

  // 2. MobileCLIP open-vocab ranking
  if (engine.clip && engine.clip.status === 'ready') {
    const centerBbox = centerRect(frame, 0.6);
    const [emb] = await clipEmbedCrops(frame, [centerBbox]);
    if (!agentToolCurrent(ctx)) return { error: 'cancelled' };
    const ranked = scoreEmbedding(emb).filter(r => r.id !== '_bg');
    const clipHit = ranked.find(r => r.id.toLowerCase().includes(target) || target.includes(r.id.toLowerCase()));
    if (clipHit && clipHit.p >= Math.min(minConf, 0.35)) {
      return {
        found: true,
        item: clipHit.id,
        confidence: clipHit.p,
        position: 'ahead',
        bbox: [centerBbox.x, centerBbox.y, centerBbox.s, centerBbox.s],
        objects: ranked.slice(0, 3).map(r => r.id)
      };
    }
  }

  return {
    found: false,
    confidence: 0,
    objects: cocoObjs.map(o => o.id),
    message: `Target ${target} not clearly seen in this view.`
  };
});

AsthaToolRegistry.register('tool_visual_inspect_crop', 'Zooms into a region to verify details and attributes', async (args, ctx) => {
  if (!agentToolCurrent(ctx)) return { error: 'cancelled' };
  const frame = ctx.frame || captureFrame(896);
  if (!frame) return { inspected: false, error: 'no_frame' };
  const region = args.region || 'center';
  const rect = region === 'top-left' ? { x: 0, y: 0, s: frame.width * 0.5 }
    : region === 'top-right' ? { x: frame.width * 0.5, y: 0, s: frame.width * 0.5 }
    : region === 'bottom-left' ? { x: 0, y: frame.height * 0.5, s: frame.width * 0.5 }
    : region === 'bottom-right' ? { x: frame.width * 0.5, y: frame.height * 0.5, s: frame.width * 0.5 }
    : centerRect(frame, 0.5);

  const cropped = cropToCanvas(frame, rect);
  const colors = extractDominantColor(cropped);

  return {
    inspected: true,
    region,
    feature: args.feature_to_verify,
    dominant_color: colorName(colors.top),
    color_confidence: colors.top.pct,
    details: `Inspected ${region} region; top color is ${colorName(colors.top)}`
  };
});

AsthaToolRegistry.register('tool_ocr_read', 'Transcribes text from camera view or crop', async (args, ctx) => {
  if (!agentToolCurrent(ctx)) return { error: 'cancelled' };
  const frame = ctx.frame || captureFrame(896);
  if (!frame) return { text: '', lines: [] };

  // Try Cloud OCR if available
  if (cloudReady()) {
    try {
      const res = await cloudReadLines(frame);
      if (!agentToolCurrent(ctx)) return { error: 'cancelled' };
      if (res && res.lines && res.lines.length) {
        return { text: res.lines.join(' '), lines: res.lines, explain: res.explainEn };
      }
    } catch (_) { if (!agentToolCurrent(ctx)) return { error: 'cancelled' }; }
  }

  // Fallback to on-device Tesseract
  try {
    if (!agentToolCurrent(ctx)) return { error: 'cancelled' };
    const worker = await ensureOcr();
    if (!agentToolCurrent(ctx)) return { error: 'cancelled' };
    const { data } = await worker.recognize(frame);
    if (!agentToolCurrent(ctx)) return { error: 'cancelled' };
    const lines = (data.lines || [])
      .filter(l => l.confidence >= 55)
      .map(l => cleanOcrLine(l.text))
      .filter(l => l.length >= 2);
    return { text: lines.join(' '), lines, confidence: data.confidence };
  } catch (err) {
    return { text: '', lines: [], error: err.message };
  }
});

AsthaToolRegistry.register('tool_spatial_guidance', 'Provides directional alignment audio and haptics to user', async (args, ctx) => {
  if (!agentToolCurrent(ctx)) return { error: 'cancelled' };
  const en = args.instruction_en || 'Please adjust the camera slightly.';
  const bn = args.instruction_bn || 'ক্যামেরাটি কিছুটা নাড়ান।';
  announce(en, bn, 'guidance');
  playEarcon('tick');
  if (args.direction === 'hold_steady') haptic('CONFIRM');
  else haptic('WARNING');
  return { delivered: true, direction: args.direction };
});

AsthaToolRegistry.register('tool_memory_save', 'Saves a confirmed item location into memory', async (args, ctx) => {
  const item = args.item;
  const loc = args.location;
  // Model-generated arguments cannot authorize persistence; the caller must own approval.
  if (!item || !loc || ctx?.memorySaveApproved !== true) return { saved: false, error: 'explicit_approval_required' };
  if (!agentToolCurrent(ctx)) return { error: 'cancelled' };
  if (typeof autoRecordMemory === 'function') {
    const entry = await autoRecordMemory({ item, location: loc, source: 'Approved agent note', score: null, approved: true });
    return { saved: !!entry, item, location: loc };
  }
  return { saved: false };
});

AsthaToolRegistry.register('tool_safety_scan', 'Evaluates walking path for stairs, drops, and obstacles', async (args, ctx) => {
  if (!agentToolCurrent(ctx)) return { error: 'cancelled' };
  const frame = ctx.frame || captureFrame(640);
  if (!frame) return { safe: null, error: 'no_frame' };
  const cocoObjs = await runCoco(frame);
  if (!agentToolCurrent(ctx)) return { error: 'cancelled' };
  const hazard = await EdgeAndStairsDetector.evaluate(frame, cocoObjs);
  if (!agentToolCurrent(ctx)) return { error: 'cancelled' };
  return {
    safe: null, // A camera scan cannot establish a safe walking path.
    hazard: hazard ? hazard.labelEn : null,
    hazard_bn: hazard ? hazard.labelBn : null
  };
});

// Autonomous Evaluator & Self-Correction Engine
const AsthaEvaluator = {
  evaluate(step, toolOutput, goal) {
    if (!toolOutput) {
      return {
        verified: false,
        score: 0,
        needsCorrection: true,
        correction: {
          type: 'guidance',
          direction: 'hold_steady',
          instruction_en: 'Hold the camera steady for a clearer look.',
          instruction_bn: 'ক্যামেরাটি স্থির রাখুন যাতে পরিষ্কার দেখতে পাই।'
        }
      };
    }

    if (step.tool === 'tool_vision_detect') {
      const target = String(step.args?.target_item || '').toLowerCase().trim();
      const item = typeof toolOutput.item === 'string' ? toolOutput.item.toLowerCase().trim() : '';
      const matches = target && item && (target === item || ClientRAG.expandTerms(target).includes(item));
      if (toolOutput.found === true && matches && Number.isFinite(toolOutput.confidence) && toolOutput.confidence <= 1 && toolOutput.confidence >= (step.args?.min_confidence || 0.45)) {
        return { verified: true, score: toolOutput.confidence, needsCorrection: false };
      }
      // Failure: Target not found in frame -> Autonomous self-correction (pan/tilt guidance)
      return {
        verified: false,
        score: 0.2,
        needsCorrection: true,
        correction: {
          type: 'guidance',
          direction: 'tilt_down',
          instruction_en: `I do not see the ${step.args.target_item || 'item'} here. Please tilt the camera down toward the table or pan slightly left.`,
          instruction_bn: `এখানে ${step.args.target_item || 'জিনিসটি'} দেখতে পাচ্ছি না। ক্যামেরাটি টেবিলের দিকে আরেকটু নামান বা বামে ঘুরান।`
        }
      };
    }

    if (step.tool === 'tool_ocr_read') {
      const len = (toolOutput.text || '').trim().length;
      if (len >= 3) return { verified: true, score: 0.9, needsCorrection: false };
      return {
        verified: false,
        score: 0.25,
        needsCorrection: true,
        correction: {
          type: 'guidance',
          direction: 'move_closer',
          instruction_en: 'Move the camera about 10 centimeters closer so I can read the text.',
          instruction_bn: 'লেখা স্পষ্ট পড়তে ক্যামেরাটি প্রায় ১০ সেন্টিমিটার কাছে নিন।'
        }
      };
    }

    const supported = {
      tool_rag_retrieve: () => toolOutput.found === true && [toolOutput.memories, toolOutput.rooms].some(rows => Array.isArray(rows) && rows.length > 0),
      tool_spatial_guidance: () => toolOutput.delivered === true,
      tool_memory_save: () => toolOutput.saved === true,
    };
    const verified = !toolOutput.error && !!supported[step.tool]?.();
    return { verified, score: verified ? 1 : 0, needsCorrection: false };
  }
};

// Autonomous Agent Coordinator State Machine
const AsthaAgent = {
  state: 'IDLE', // IDLE, PLANNING, EXECUTING, EVALUATING, CORRECTING, COMPLETED
  currentTask: null,
  activePlan: null,
  stepIndex: 0,
  retries: 0,
  maxRetries: 2,
  observations: [],
  runGeneration: 0,
  plannerController: null,

  cancel() {
    this.runGeneration++;
    this.plannerController?.abort(); this.plannerController = null;
    this.currentTask = null; this.activePlan = null; this.observations = [];
    this.state = 'IDLE'; this.stepIndex = 0; this.retries = 0;
    this.updateUI();
  },

  updateUI() {
    const card = $('agent-status-card');
    if (!card) return;
    if (this.state === 'IDLE' || !this.currentTask) {
      card.hidden = true;
      return;
    }
    card.hidden = false;
    const stateBadge = $('agent-state-badge');
    const goalText = $('agent-goal-text');
    const stepList = $('agent-step-list');
    const retryText = $('agent-retry-count');

    if (stateBadge) {
      stateBadge.textContent = this.state;
      stateBadge.className = `pill ${this.state === 'COMPLETED' ? 'ok' : this.state === 'CORRECTING' ? 'hazard' : ''}`;
    }
    if (goalText) goalText.textContent = this.currentTask.goal;
    if (retryText) retryText.textContent = this.retries > 0 ? `Retries: ${this.retries}` : '';

    if (stepList && this.activePlan && this.activePlan.steps) {
      stepList.innerHTML = this.activePlan.steps.map((s, idx) => {
        const isDone = idx < this.stepIndex;
        const isCur = idx === this.stepIndex && this.state !== 'COMPLETED';
        const icon = isDone ? '✅' : isCur ? '⏳' : '⚪';
        return `<div class="step-item ${isCur ? 'active-step' : ''}" style="margin:4px 0; font-size:0.92rem;">
          ${icon} <strong>${esc(s.purpose || s.id)}</strong> (${esc(s.tool)})
        </div>`;
      }).join('');
    }
  },

  async plan(goal, frame, current = () => true) {
    if (!current()) return null;
    this.state = 'PLANNING';
    this.updateUI();

    // 1. RAG retrieval
    const ragContext = ClientRAG.search(goal);
    const formattedRag = ClientRAG.formatContextBlock(ragContext);

    // 2. Try Server Planner if available
    if (typeof apiUrl === 'function' && serverCloud.available && typeof remoteProcessingAllowed === 'function' && remoteProcessingAllowed()) {
      const controller = new AbortController();
      this.plannerController = controller;
      if (typeof AsthaCancellation !== 'undefined') AsthaCancellation.controllers.add(controller);
      try {
        const frameB64 = frame ? frameToJpeg(frame, 896) : undefined;
        const res = await fetch(apiUrl('/api/agent/plan'), {
          method: 'POST',
          credentials: 'include',
          signal: controller.signal,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ goal, image: frameB64 })
        });
        if (!current()) return null;
        if (res.ok) {
          const data = await res.json();
          if (!current()) return null;
          if (data.plan && data.plan.steps && data.plan.steps.length) {
            return data.plan;
          }
        }
      } catch (err) {
        if (!current()) return null;
        console.warn('Server planner fallback to client:', err);
      } finally {
        if (this.plannerController === controller) this.plannerController = null;
        if (typeof AsthaCancellation !== 'undefined') AsthaCancellation.controllers.delete(controller);
      }
    }

    // 3. Fallback Client Heuristic Planner
    const steps = [];
    if (ragContext.hasContext) {
      steps.push({
        id: 'step_rag',
        tool: 'tool_rag_retrieve',
        args: { search_query: goal },
        purpose: 'Retrieve room landmarks & past object placements'
      });
    }

    const targetMatch = goal.match(/(?:find|where is|locate|see|check|my)\s+([a-z\s]+?)(?:$|\s+and|\s+on|\s+in)/i);
    const targetItem = targetMatch ? targetMatch[1].trim() : 'item';

    steps.push({
      id: 'step_detect',
      tool: 'tool_vision_detect',
      args: { target_item: targetItem, min_confidence: 0.45 },
      purpose: `Locate ${targetItem} in frame`
    });

    if (/read|text|label|written|dose|prescription|লেখা|পড়|পড়/i.test(goal)) {
      steps.push({
        id: 'step_ocr',
        tool: 'tool_ocr_read',
        args: { focus_area: 'center' },
        purpose: 'Read text and labels'
      });
    } else if (/color|clean|folded|condition|রং/i.test(goal)) {
      steps.push({
        id: 'step_inspect',
        tool: 'tool_visual_inspect_crop',
        args: { region: 'center', feature_to_verify: 'condition' },
        purpose: 'Verify condition and attributes'
      });
    }

    return {
      goal,
      summary: `Autonomous plan with ${steps.length} steps`,
      steps
    };
  },

  async run(goal) {
    if (typeof document !== 'undefined' && document.hidden) return;
    if (withCamera(() => AsthaAgent.run(goal))) return;
    this.cancel();
    const mine = this.runGeneration;
    const ownerCurrent = typeof captureLocalActionGuard === 'function' ? captureLocalActionGuard() : () => true;
    const current = () => mine === this.runGeneration && ownerCurrent();
    if (!current()) return;
    try {
    this.currentTask = { goal, startedAt: Date.now() };
    this.observations = [];
    this.retries = 0;
    this.stepIndex = 0;

    announce(`Planning how to check: ${goal}.`, `পরিকল্পনা করছি: ${goal}।`, 'agent');
    playEarcon('tick');

    const frame = captureFrame(896);
    const plan = await this.plan(goal, frame, current);
    if (!current() || !plan) return;
    this.activePlan = plan;
    this.updateUI();

    // Execute steps in verification loop
    while (this.stepIndex < this.activePlan.steps.length) {
      if (!current()) return;
      const step = this.activePlan.steps[this.stepIndex];
      this.state = 'EXECUTING';
      this.updateUI();

      const currentFrame = captureFrame(896);
      const ctx = { frame: currentFrame, goal, observations: this.observations, current };

      let toolOutput = null;
      try {
        toolOutput = await AsthaToolRegistry.call(step.tool, step.args || {}, ctx);
      } catch (err) {
        if (!current()) return;
        toolOutput = { error: err.message };
      }
      if (!current()) return;

      this.observations.push({ stepId: step.id, tool: step.tool, output: toolOutput });

      // Verification loop
      this.state = 'EVALUATING';
      this.updateUI();

      const evalResult = AsthaEvaluator.evaluate(step, toolOutput, goal);

      if (evalResult.verified) {
        // Step succeeded
        playEarcon('click');
        this.stepIndex++;
        this.retries = 0;
      } else if (evalResult.needsCorrection && this.retries < this.maxRetries) {
        // Step failed -> Autonomous Self-Correction Loop
        this.state = 'CORRECTING';
        this.retries++;
        this.updateUI();

        if (evalResult.correction) {
          await AsthaToolRegistry.call('tool_spatial_guidance', evalResult.correction, ctx);
          if (!current()) return;
          // Wait 2.2 seconds for user to adjust physical camera position
          await new Promise(r => setTimeout(r, 2200));
          if (!current()) return;
        }
        // Retry the current step with updated camera frame
        continue;
      } else {
        // Exhausted retries or non-recoverable: advance to conclude with best effort
        this.stepIndex++;
      }
    }

    // Task Completion & Final Response Synthesis
    if (!current()) return;
    this.state = 'COMPLETED';
    this.updateUI();

    await this.synthesizeFinalAnswer(goal, current);
    } finally {
      if (mine === this.runGeneration && !ownerCurrent()) this.cancel();
    }
  },

  async synthesizeFinalAnswer(goal, current = () => true) {
    if (!current()) return;
    const visionObs = this.observations.find(o => o.tool === 'tool_vision_detect' && o.output && o.output.found);
    const ocrObs = this.observations.find(o => o.tool === 'tool_ocr_read' && o.output && o.output.text);
    const ragObs = this.observations.find(o => o.tool === 'tool_rag_retrieve' && o.output && o.output.memories && o.output.memories.length);

    let en = '', bn = '';

    if (visionObs && visionObs.output) {
      const item = visionObs.output.item;
      const pos = visionObs.output.position;
      en = `I found your ${item} directly ${pos} of you.`;
      bn = `আপনার ${item} ঠিক ${pos === 'left' ? 'বামে' : pos === 'right' ? 'ডানে' : 'সামনে'} দেখতে পেয়েছি।`;

      if (ocrObs && ocrObs.output && ocrObs.output.text) {
        en += ` The text on it says: "${ocrObs.output.text.slice(0, 60)}".`;
        bn += ` এর গায়ে লেখা: "${ocrObs.output.text.slice(0, 60)}"।`;
      }
    } else if (ragObs && ragObs.output && ragObs.output.memories.length) {
      const topMem = ragObs.output.memories[0];
      const source = String(topMem.source || '').trim();
      const photo = /photo|uploaded/i.test(source);
      const note = /^(your note|manual|voice placement|approved agent note|voice note|user-confirmed)/i.test(source);
      const camera = !photo && !note && /camera|observation|identified|ocr|visual/i.test(source);
      const provenance = photo ? ['Photo observation', 'ছবির পর্যবেক্ষণ'] : note ? ['Your note', 'আপনার নোট'] :
        camera ? ['Camera observation', 'ক্যামেরার পর্যবেক্ষণ'] : ['Saved record', 'সংরক্ষিত তথ্য'];
      const recorded = topMem.time === null || topMem.time === undefined || topMem.time === '' ? NaN : new Date(topMem.time).getTime();
      const when = Number.isFinite(recorded) && recorded <= Date.now() + 60000 ? new Date(recorded) : null;
      en = `${provenance[0]} for ${topMem.title}, saved ${when ? when.toLocaleString('en-GB') : 'at an unknown time'}, reports: ${topMem.location ?? topMem.content}. Its current location is not confirmed.`;
      bn = `${topMem.title}-এর ${provenance[1]}, সংরক্ষিত ${when ? when.toLocaleString('bn-BD') : 'সময় জানা নেই'}, বলছে: ${topMem.location ?? topMem.content}। বর্তমান অবস্থান নিশ্চিত নয়।`;
    } else {
      en = `I completed the scan for ${goal}. It does not appear to be within this camera view. Try turning slowly or pointing at a different surface.`;
      bn = `${goal}-এর জন্য স্ক্যান শেষ করেছি। এই দৃশ্যে দেখতে পাইনি। ক্যামেরাটি অন্য দিকে ঘুরিয়ে চেষ্টা করুন।`;
    }

    announce(en, bn, 'agent');
    playEarcon('confirm');
    haptic('CONFIRM');

    setTimeout(() => {
      if (current() && this.state === 'COMPLETED') {
        this.state = 'IDLE';
        this.updateUI();
      }
    }, 12000);
  }
};

window.ClientRAG = ClientRAG;
window.AsthaToolRegistry = AsthaToolRegistry;
window.AsthaEvaluator = AsthaEvaluator;
window.AsthaAgent = AsthaAgent;

