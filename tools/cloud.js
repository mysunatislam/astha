
/* =====================================================================
   16. Cloud reasoning (Gemini), modes, owner ID, yes/no follow-ups,
       secure-connection guidance
       The on-device models are fast but guess; with a Gemini key the
       heavy understanding goes to the cloud with a strict "never invent"
       instruction. The key is stored only in this browser.
   ===================================================================== */
const cloud = { key: '', model: 'gemini-flash-latest', models: ['gemini-flash-latest', 'gemini-3.5-flash', 'gemini-3-flash-preview'], lastCallAt: 0, lastVerifyAt: 0, badKeyWarned: false };
const serverCloud = { checked: false, available: false };
// Cloud reasoning is ready ONLY when the user configured a personal Gemini key
// or the backend server explicitly confirmed cloud reasoning is available.
function cloudReady() { return Boolean(cloud.key || serverCloud.available); }
function setGeminiKey(v, silent) {
  cloud.key = (v || '').trim(); cloud.badKeyWarned = false;
  try { localStorage.setItem('astha.gemini', cloud.key); } catch (e) {}
  updateCloudBadge();
  if (!silent) announce(cloud.key ? 'Cloud reasoning is on. My descriptions will be much more accurate now.' : 'Cloud reasoning is off. I am using the on-device models only.',
    cloud.key ? 'ক্লাউড রিজনিং চালু। এখন আমার বর্ণনা অনেক নিখুঁত হবে।' : 'ক্লাউড রিজনিং বন্ধ। শুধু ডিভাইসের মডেল ব্যবহার করছি।', 'system');
}
function updateCloudBadge() {
  const b = $('cloud-pill'); if (!b) return;
  if (serverCloud.available) { b.textContent = 'Cloud: Astha server'; b.className = 'pill ok'; }
  else if (cloud.key) { b.textContent = 'Cloud: personal key'; b.className = 'pill ok'; }
  else if (serverCloud.checked) { b.textContent = 'On-device only'; b.className = 'pill'; }
  else { b.textContent = 'Checking cloud…'; b.className = 'pill'; }
}
// Learn once at boot whether Astha's own server has a Gemini key configured, so the badge and
// cloudReady() are accurate before the first camera action ever calls /api/vision.
async function refreshCloudStatus() {
  try {
    const r = await fetch(apiUrl('/api/health'), { credentials: 'include' });
    if (r.ok) { const d = await r.json(); serverCloud.available = !!d.cloud; }
  } catch (e) { /* offline; personal key (if any) still works */ }
  serverCloud.checked = true;
  updateCloudBadge();
}
function frameToJpeg(frame, maxW = 896) {
  const s = Math.min(1, maxW / frame.width);
  const c = document.createElement('canvas'); c.width = Math.round(frame.width * s); c.height = Math.round(frame.height * s);
  c.getContext('2d').drawImage(frame, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.78).split(',')[1];
}
const ASTHA_SYSTEM = 'You are Astha, a warm and precise visual companion for a blind user in Bangladesh. Speak as "I". Be concrete: colours, materials, printed text, positions (left, ahead, right) and rough distance. Never invent anything you cannot actually see; if unsure, say you are not sure. Do not describe people as animals or objects; say "a person" when a human is visible. Keep spoken answers to one to three short sentences unless transcribing. Return only the requested JSON. "bn" must be natural spoken Bangla with the same meaning as "en".';
const CLOUD_PROMPTS = {
  describe: 'Describe what the camera sees for the blind user. Hazards first (stairs, vehicles, wires on the floor, water, fire), then the main things with position (left, ahead, right) and distance (very close, near, far), then any readable text. Return JSON: {"en": string, "bn": string, "hazard": boolean, "mirror": boolean, "objects": [short English nouns]}. "mirror" is true ONLY if this is clearly the user\'s own reflection in a mirror with the phone visible.',
  identify: 'The user is holding one object near the camera. Say what it is: type, colour, material, brand or model if a logo or printed text shows, and any text on it. If it is a toy, a picture, a screen, or an ID card, say so clearly. Return JSON: {"en": string, "bn": string, "name": short English noun}.',
  clothes: 'Describe the garment in view: type (shirt, saree, salwar kameez, panjabi, dress, t-shirt, lungi...), colours, pattern, and fabric if visible (cotton, silk, denim, wool, synthetic, lace). Say whether a person is wearing it or it is being held. Return JSON: {"en": string, "bn": string, "garment": string, "colour": string}.',
  read: 'Transcribe ALL readable text exactly as printed, in its original script (Bangla or English), keeping line breaks, into "text". If it is a medicine, a sign, a label, a letter or a page, give a one-sentence explanation in "en" and "bn". If there is no readable text, set "text" to "". Return JSON: {"text": string, "en": string, "bn": string}.',
  screen: 'This is a screenshot of the user\'s computer. Return JSON: {"app": name of the foreground app or website, "content": exact transcription of the main editor, document, chat or page text (skip menus, toolbars and sidebars; keep code indentation and line breaks), "dialog": {"present": boolean, "button": text of the safest dismiss button or "", "location": one of "top-left","top","top-right","left","center","right","bottom-left","bottom","bottom-right"}, "error": {"present": boolean, "line": exact error text or "", "fix": one short sentence or ""}, "en": one-sentence spoken summary of where the user is and what is on screen, "bn": the same in Bangla}.',
  verify: (names) => `The on-device detector thinks it sees: ${names}. Look at the frame: say in one short sentence what is really there that matters to a blind person (hazards first, then people and objects with position). If the detector was wrong, do not repeat its mistake. If nothing notable, set "none" true. Return JSON: {"en": string, "bn": string, "none": boolean, "mirror": boolean}.`,
  mirror: 'Is this image the user\'s own reflection in a mirror (a person holding up a phone toward a mirror)? Return JSON: {"mirror": boolean, "en": one sentence describing what the person is wearing if mirror is true else "", "bn": same in Bangla}.',
  vqa: (query, history) => `The visually impaired user asks: "${query}". Prior conversation context: ${history || 'none'}. Look closely at the image. Directly, accurately and concisely answer the user's specific question (e.g. if they ask if their ID card, pen, phone, powerbank, or medication is visible, check carefully). If visible, state its position (left, ahead, right) and details (text, color, brand, or what surface it is on). If not visible, say clearly that it is not visible. Return JSON: {"en": string, "bn": string, "found": boolean, "item": string, "surface": string, "room_hint": string}.`,
  calibrate_video: (roomName) => `The user is holding the camera while walking through or showing a room called "${roomName || 'unnamed room'}". Analyze this video frame for home layout calibration. Identify any detected furniture or landmark structures (e.g. dressing table, reading table, desk, bed, bookshelf, chair, sofa, wardrobe, door, window, mirror, counter). Note their relative positions (left, ahead, right, near, far). Return JSON: {"room": string, "furniture": [string], "landmarks": [string], "en_feedback": string, "bn_feedback": string}. "en_feedback" should be 1 short sentence announcing newly seen furniture (e.g. "I see a dressing table ahead and a chair on your left").`,
  placement: (query, rooms) => `The visually impaired user says: "${query}". They are holding up an object or keeping/placing it on a surface in their home (e.g. moneybag, wallet, powerbank, keys, glasses, medicine, watch, phone, charger). Look closely at the camera frame. Identify the exact object (prefer the name the user said if it matches the object, e.g. "moneybag" or "wallet"). Identify which furniture surface it is resting on or held over (e.g. dressing table, reading table, desk, bed, bookshelf, chair, counter). Identify which room this matches from their calibrated rooms: ${rooms || 'Reading Room'}. Return JSON: {"item": string, "surface": string, "room": string, "en": string, "bn": string}. "en" must be a reassuring confirmation sentence like "Got it. I see your moneybag. Remembered: keeping your moneybag on the dressing table in the reading room." "bn" must be the natural spoken Bangla equivalent.`,
  passive_placement: (rooms) => `The visually impaired user is in their room. Analyze this camera frame for passive object placement.
Look for everyday personal items placed or resting on a furniture surface (or held over it):
Specifically check for: wallet (or moneybag), id card, phone charger, laptop charger, power bank, keys, glasses, lipstick (or smartphone, pill bottle / medicine, watch, bottle, notebook).
Surfaces to identify: dressing table, reading table, desk, bed, bookshelf, sofa, side table, counter.
Match the scene against the user's calibrated rooms: ${rooms || 'Reading Room'}.
If an item is clearly placed/resting on a furniture surface, return JSON:
{"found": true, "item": "wallet", "surface": "dressing table", "room": "Reading Room", "en": "Noted: your wallet is on the dressing table in the reading room.", "bn": "রিডিং রুমের ড্রেসিং টেবিলে আপনার মানিব্যাগ মনে রাখা হলো।"}
If no target item is clearly placed on a surface, return JSON:
{"found": false}`,
};
// `task` here is the fully-resolved prompt text (CLOUD_PROMPTS.describe, etc). Astha's own
// server holds the real Gemini key and is tried first; a personal key pasted into Your
// preferences is only a fallback for when that server is unreachable or has none configured.
async function gemini(task, frame, opts = {}) {
  cloud.lastCallAt = Date.now();
  const image = frame ? frameToJpeg(frame, opts.maxW || 896) : undefined;
  if (serverCloud.available) {
    try {
      const res = await fetch(apiUrl('/api/vision'), {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task: 'custom', prompt: task, image, maxTokens: opts.maxTokens || 900 }),
      });
      if (res.ok) { serverCloud.available = true; serverCloud.checked = true; return await res.json(); }
      if (res.status === 401) { serverCloud.checked = true; serverCloud.available = false; /* not signed in yet; fall through */ }
      else if (res.status === 503) { serverCloud.checked = true; serverCloud.available = false; /* server has no key */ }
      else if (res.status === 429) { throw new Error('rate limit'); }
      // any other server-side failure: fall through to a personal key if the user has one
    } catch (e) { if (String(e.message) === 'rate limit') throw e; /* network error reaching our own server: fall through */ }
  }
  if (!cloud.key) { const e = new Error('no cloud reasoning available'); e.noCloud = true; throw e; }
  const parts = [{ text: task }];
  if (image) parts.push({ inline_data: { mime_type: 'image/jpeg', data: image } });
  const body = { system_instruction: { parts: [{ text: ASTHA_SYSTEM }] }, contents: [{ role: 'user', parts }], generationConfig: { temperature: 0.2, response_mime_type: 'application/json', max_output_tokens: opts.maxTokens || 900 } };
  const order = [cloud.model, ...cloud.models.filter(m => m !== cloud.model)];
  let lastErr = null;
  for (const model of order) {
    let res;
    try {
      res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(cloud.key)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    } catch (e) { throw new Error('network'); }
    if (res.status === 404) { lastErr = new Error('model ' + model + ' not found'); continue; }
    if (res.status === 400 || res.status === 403) { if (!cloud.badKeyWarned) { cloud.badKeyWarned = true; announce('Your personal Gemini key was rejected. Check it in Your preferences.', 'আপনার ব্যক্তিগত জেমিনি কী গ্রহণ হয়নি। প্রেফারেন্সে দেখুন।', 'system'); } throw new Error('bad key'); }
    if (res.status === 429) throw new Error('rate limit');
    if (!res.ok) throw new Error('Gemini ' + res.status);
    const data = await res.json();
    const text = ((((data.candidates || [])[0] || {}).content || {}).parts || []).map(p => p.text || '').join('');
    cloud.model = model;
    return parseJsonLoose(text);
  }
  throw lastErr || new Error('Gemini unavailable');
}
function parseJsonLoose(text) {
  try { return JSON.parse(text); } catch (e) {}
  const m = (text || '').match(/\{[\s\S]*\}/); if (m) { try { return JSON.parse(m[0]); } catch (e) {} }
  return { en: (text || '').trim(), bn: '' };
}
function cloudFail(e) { console.warn('cloud', e); return /rate limit/.test(String(e)); }

// ---- Cloud-backed actions (called first when a key exists; fall back to on-device) ----
async function cloudDescribe() {
  return withBusy(t('analyzing_title'), async () => {
    const frame = captureFrame(896); if (!frame) return;
    heartSet({ x: 0.5, y: 0.5, mode: 'seek', label: 'Looking…' });
    try {
      const r = await gemini(CLOUD_PROMPTS.describe, frame);
      if (r.mirror === true) { await cloudCompliment(frame, r); return; }
      announce(r.en || t('nothing_seen'), r.bn || tBn('nothing_seen'), 'vision'); playEarcon(r.hazard ? 'hazard' : 'confirm'); haptic(r.hazard ? 'RAPID' : 'CONFIRM');
      heartFlash({ x: 0.5, y: 0.5, mode: 'lock', label: (r.objects || [])[0] || '' });
      logEvent('Cloud described: ' + ((r.objects || []).slice(0, 4).join(', ') || 'scene'));
      if (typeof autoRecordMemory === 'function' && Array.isArray(r.objects)) {
        r.objects.slice(0, 3).forEach(obj => autoRecordMemory({ item: obj, location: r.en || 'In front of you', source: 'Scene description' }));
      }
    } catch (e) {
      if (cloudFail(e)) announce('The cloud is busy for a moment; describing on-device.', 'ক্লাউড একটু ব্যস্ত; ডিভাইসেই বর্ণনা করছি।', 'system');
      setTimeout(() => describeScene(true), 20);
    }
  });
}
async function cloudIdentify() {
  return withBusy(t('identify_title'), async () => {
    const frame = captureFrame(896); if (!frame) return;
    heartSet({ x: 0.5, y: 0.5, mode: 'seek', label: 'Looking…' });
    try {
      const r = await gemini(CLOUD_PROMPTS.identify, frame);
      announce(r.en, r.bn, 'vision'); playEarcon('confirm'); haptic('CONFIRM');
      heartFlash({ x: 0.5, y: 0.5, mode: 'lock', label: r.name || '' }); logEvent('Cloud identified: ' + (r.name || ''));
      if (typeof autoRecordMemory === 'function' && r.name) {
        autoRecordMemory({ item: r.name, location: 'Held in front of camera', source: 'Identified object', score: 0.95 });
      }
    } catch (e) {
      cloudFail(e);
      setTimeout(() => identifyObject(true), 20);
    }
  });
}
async function cloudClothes() {
  return withBusy(t('clothes_title'), async () => {
    const frame = captureFrame(896); if (!frame) return;
    try {
      const r = await gemini(CLOUD_PROMPTS.clothes, frame);
      announce(r.en, r.bn, 'vision'); playEarcon('confirm');
      heartFlash({ x: 0.5, y: 0.5, mode: 'lock', label: r.garment || '' }); logEvent('Cloud clothes: ' + (r.colour || '') + ' ' + (r.garment || ''));
      if (typeof autoRecordMemory === 'function' && r.garment) {
        autoRecordMemory({ item: (r.colour ? r.colour + ' ' : '') + r.garment, location: 'Worn or held', source: 'Clothes inspection' });
      }
    } catch (e) {
      cloudFail(e);
      setTimeout(() => inspectClothesAndColor(true), 20);
    }
  });
}
async function cloudCompliment(frame, r) {
  state.complimentIdx = ((state.complimentIdx || 0) + 1) % COMPLIMENTS.length;
  const c = COMPLIMENTS[state.complimentIdx];
  let en = `I can see you in the mirror. ${c[0]}`, bn = `আয়নায় আপনাকে দেখতে পাচ্ছি। ${c[1]}`;
  try { const cl = await gemini(CLOUD_PROMPTS.clothes, frame); if (cl.en) { en += ' ' + cl.en.replace(/^(You are|The person is) wearing/i, 'You are wearing'); bn += ' ' + cl.bn; } } catch (e) {}
  state.lastComplimentAt = Date.now();
  announce(en, bn, 'vision'); playEarcon('confirm'); heartFlash({ x: 0.5, y: 0.45, mode: 'lock', label: '♥' }, 5000);
}
// Read a page with Gemini (much better Bangla than on-device OCR). Returns lines or null on failure.
async function cloudReadLines(frame) {
  const r = await gemini(CLOUD_PROMPTS.read, frame, { maxW: 1024, maxTokens: 2000 });
  const lines = (r.text || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  return { lines, explainEn: r.en || '', explainBn: r.bn || '' };
}
// Auto mode: before speaking about "new" on-device detections, let the cloud check the frame (throttled).
async function cloudVerifyAndSpeak(fresh, fallbackEn, fallbackBn) {
  const now = Date.now();
  if (now - cloud.lastVerifyAt < 6000) return;   // stay quiet rather than chatter
  cloud.lastVerifyAt = now;
  const frame = captureFrame(768); if (!frame) return;
  try {
    const r = await gemini(CLOUD_PROMPTS.verify(fresh.map(o => objLabel(o)).join(', ')), frame, { maxTokens: 600 });
    if (r.mirror === true && now - (state.lastComplimentAt || 0) > 60000) return cloudCompliment(frame, r);
    if (r.none || !r.en) return;
    setCaption(t('new_title'), r.en, 'vision', null, r.bn); speak(r.en, r.bn); heartPointAt(fresh[0]);
  } catch (e) { if (!cloudFail(e)) { setCaption(t('new_title'), fallbackEn, 'vision', null, fallbackBn); speak(fallbackEn, fallbackBn); } }
}
async function cloudScreen(frame) { return gemini(CLOUD_PROMPTS.screen, frame, { maxW: 1280, maxTokens: 2500 }); }

// Conversational Visual Question Answering (VQA)
async function cloudVisualQA(query, frame, history = '') {
  const f = frame || captureFrame(896);
  if (!f) return null;
  heartSet({ x: 0.5, y: 0.5, mode: 'seek', label: 'Looking…' });
  try {
    const prompt = typeof CLOUD_PROMPTS.vqa === 'function' ? CLOUD_PROMPTS.vqa(query, history) : CLOUD_PROMPTS.vqa;
    const r = await Promise.race([
      gemini(prompt, f, { maxTokens: 600 }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Cloud VQA timeout')), 3500))
    ]);
    if (r && (r.en || r.bn)) {
      announce(r.en, r.bn, 'vision');
      playEarcon('confirm');
      heartFlash({ x: 0.5, y: 0.5, mode: 'lock', label: r.item || 'Answer' });
      logEvent('Answered: ' + (r.en || '').slice(0, 50));
      if (typeof autoRecordMemory === 'function' && r.found && r.item) {
        autoRecordMemory({
          item: r.item,
          location: (r.surface ? 'On ' + r.surface : '') + (r.room_hint ? ' in ' + r.room_hint : (r.surface ? '' : 'In front of you')),
          source: 'Visual question answer',
          score: 0.95
        });
      }
      return r;
    }
    return null;
  } catch (e) {
    // Return null silently on cloud failure or timeout so on-device fallback runs without delay
    return null;
  }
}

// Live Video Walkthrough Room Calibration Frame Analyzer
async function cloudCalibrateVideoFrame(frame, roomName) {
  const f = frame || captureFrame(896);
  if (!f) return null;
  try {
    const prompt = typeof CLOUD_PROMPTS.calibrate_video === 'function' ? CLOUD_PROMPTS.calibrate_video(roomName) : CLOUD_PROMPTS.calibrate_video;
    const r = await gemini(prompt, f, { maxTokens: 600 });
    return r;
  } catch (e) {
    cloudFail(e);
    return null;
  }
}

// Voice-First Visual Item Placement & Memory Storage
async function cloudRecordPlacement(query, frame, rooms) {
  return withBusy('Remembering…', async () => {
    const f = frame || captureFrame(896);
    if (!f) return null;
    heartSet({ x: 0.5, y: 0.5, mode: 'seek', label: 'Seeing item…' });
    try {
      const prompt = typeof CLOUD_PROMPTS.placement === 'function' ? CLOUD_PROMPTS.placement(query, rooms) : CLOUD_PROMPTS.placement;
      const r = await gemini(prompt, f, { maxTokens: 600 });
      if (r && (r.en || r.bn)) {
        announce(r.en, r.bn, 'memory');
        playEarcon('confirm');
        haptic('CONFIRM');
        heartFlash({ x: 0.5, y: 0.5, mode: 'lock', label: r.item || 'Item' });
        logEvent('Remembered: ' + (r.item || 'item') + ' on ' + (r.surface || 'surface'));
        if (typeof autoRecordMemory === 'function' && r.item) {
          const locStr = `on the ${r.surface || 'table'} in the ${r.room || 'reading room'}`;
          autoRecordMemory({
            item: r.item,
            location: locStr,
            room: r.room || null,
            furniture: r.surface || null,
            source: 'Voice placement observation',
            score: 0.98
          });
        }
        return r;
      }
      return null;
    } catch (e) {
      cloudFail(e);
      throw e;
    }
  });
}

// Passive Auto-Placement Detection via Gemini Vision (Zero Speech Required)
async function cloudRecordPassivePlacement(frame, rooms) {
  const f = frame || captureFrame(896);
  if (!f) return null;
  try {
    const prompt = typeof CLOUD_PROMPTS.passive_placement === 'function' ? CLOUD_PROMPTS.passive_placement(rooms) : CLOUD_PROMPTS.passive_placement;
    const r = await Promise.race([
      gemini(prompt, f, { maxTokens: 400 }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Passive placement timeout')), 2500))
    ]);
    if (r && r.found && r.item && r.surface) {
      return r;
    }
    return null;
  } catch (e) {
    return null;
  }
}

// ---- Modes: auto (busy area) vs quiet (only when asked) ----------------------
function setMode(mode, silent) {
  state.mode = mode;
  try { localStorage.setItem('astha.mode', mode); } catch (e) {}
  const auto = mode === 'auto';
  state.narrate = auto; $('narrate-switch').setAttribute('aria-checked', auto);
  if (auto !== state.shield) { state.shield = auto; $('shield-btn').setAttribute('aria-pressed', auto); $('shield-btn').classList.toggle('on', auto); $('shield-desc').textContent = t(auto ? 'shield_on' : 'shield_off'); if (!auto) showHazard(false); }
  ['auto', 'quiet'].forEach(m => { const b = $('mode-' + m); if (b) b.setAttribute('aria-pressed', m === mode); });
  if (!silent) { playEarcon('click'); announce(auto ? 'Auto mode. I will speak up about people, vehicles and obstacles around you as they appear.' : 'Quiet mode. I will only speak when you ask me something.', auto ? 'অটো মোড। আশেপাশে মানুষ, গাড়ি বা বাধা এলে আমি নিজে থেকে বলব।' : 'শান্ত মোড। আপনি জিজ্ঞাসা করলেই কেবল বলব।', 'system'); logEvent('Mode: ' + mode); }
}

// ---- Yes / no follow-ups ---------------------------------------------------
function askYesNo(en, bn, onYes, onNo) {
  state.pendingYes = { onYes, onNo, until: Date.now() + 20000 };
  announce(en, bn, 'voice'); playEarcon('click');
}
function answerYesNo(q) {
  const p = state.pendingYes; if (!p) return false;
  if (Date.now() > p.until) { state.pendingYes = null; return false; }
  if (/^(yes|yeah|yep|yup|sure|ok|okay|please|go ahead|do it|read it|হ্যাঁ|হুম|হু|পড়ো|করো|ঠিক আছে|acha|hae|hya|ha)\b/i.test(q.trim())) { state.pendingYes = null; p.onYes && p.onYes(); return true; }
  if (/^(no|nope|nah|not now|later|না|থাক|লাগবে না|na)\b/i.test(q.trim())) { state.pendingYes = null; p.onNo ? p.onNo() : announce('Okay.', 'ঠিক আছে।', 'voice'); return true; }
  return false;
}

// ---- Owner ID: face (face-api) and an experimental voice check (Meyda) -------
const owner = { faceReady: false, faceLoading: null, face: null, voice: null, verifiedAt: 0, lock: false, lastAutoCheck: 0, meydaReady: null };
function loadScript(src) { return new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error('load ' + src)); document.head.appendChild(s); }); }
async function loadFaceLib() {
  if (owner.faceReady) return true;
  if (!owner.faceLoading) owner.faceLoading = (async () => {
    setCaption('Owner ID', 'Loading the face model…', 'system', 'busy');
    await loadScript('https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.14/dist/face-api.js');
    const M = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.14/model/';
    await faceapi.nets.tinyFaceDetector.loadFromUri(M); await faceapi.nets.faceLandmark68TinyNet.loadFromUri(M); await faceapi.nets.faceRecognitionNet.loadFromUri(M);
    owner.faceReady = true;
  })().catch(e => { owner.faceLoading = null; throw e; });
  await owner.faceLoading; return true;
}
async function faceDescriptor(frame) {
  if (!frame || !owner.faceReady) return null;
  const d = await faceapi.detectSingleFace(frame, new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.5 })).withFaceLandmarks(true).withFaceDescriptor();
  return d ? Array.from(d.descriptor) : null;
}
function faceDistance(a, b) { let s = 0; for (let i = 0; i < a.length; i++) s += (a[i] - b[i]) ** 2; return Math.sqrt(s); }
async function enrollOwnerFace() {
  if (withCamera(enrollOwnerFace)) return;
  try { await loadFaceLib(); } catch (e) { return announce('I could not load the face model. Check the internet connection.', 'ফেস মডেল লোড হয়নি। ইন্টারনেট দেখুন।', 'system'); }
  announce('Look at the camera for three seconds. I am learning your face.', 'তিন সেকেন্ড ক্যামেরার দিকে তাকান। আমি আপনার মুখ শিখছি।', 'system');
  const samples = [];
  for (let i = 0; i < 6 && samples.length < 3; i++) {
    await new Promise(r => setTimeout(r, 600));
    const frame = captureFrame(640); if (!frame) continue;
    try { const d = await faceDescriptor(frame); if (d) samples.push(d); } catch (e) { console.warn(e); }
  }
  if (!samples.length) return announce('I could not find a face. Hold the phone at arm\'s length facing you and try again.', 'কোনো মুখ পাইনি। ফোনটি হাত বাড়িয়ে নিজের দিকে ধরে আবার চেষ্টা করুন।', 'system');
  const avg = samples[0].map((_, i) => samples.reduce((s, d) => s + d[i], 0) / samples.length);
  owner.face = avg; owner.verifiedAt = Date.now();
  try { localStorage.setItem('astha.owner.face', JSON.stringify(avg)); } catch (e) {}
  renderOwner(); playEarcon('confirm');
  announce('Done. I will recognise your face from now on.', 'হয়ে গেছে। এখন থেকে আপনার মুখ চিনব।', 'system'); logEvent('Owner face enrolled');
}
async function verifyOwnerFace(silent) {
  if (!owner.face) { if (!silent) announce('You have not shown me your face yet. Say “remember my face”.', 'এখনো আপনার মুখ শেখাননি। বলুন “আমার মুখ মনে রাখো”।', 'system'); return false; }
  if (withCamera(() => verifyOwnerFace(silent))) return false;
  try { await loadFaceLib(); } catch (e) { return false; }
  let ok = false, best = 9;
  for (let i = 0; i < 3 && !ok; i++) {
    const frame = captureFrame(640); if (!frame) break;
    try { const d = await faceDescriptor(frame); if (d) { const dist = faceDistance(d, owner.face); best = Math.min(best, dist); ok = dist < 0.5; } } catch (e) {}
    if (!ok) await new Promise(r => setTimeout(r, 500));
  }
  if (ok) { owner.verifiedAt = Date.now(); renderOwner(); if (!silent) { playEarcon('confirm'); announce('It is you. Welcome back.', 'হ্যাঁ, আপনি। স্বাগতম।', 'system'); } }
  else if (!silent) announce(best < 9 ? 'That face does not match the owner.' : 'I cannot see a face clearly. Face the camera in good light.', best < 9 ? 'এই মুখ মালিকের সাথে মেলে না।' : 'মুখ স্পষ্ট দেখছি না। আলোতে ক্যামেরার দিকে তাকান।', 'system');
  return ok;
}
// Experimental voice check: average MFCC voiceprint. Distinguishes voices roughly; not a security feature.
async function loadMeyda() { if (window.Meyda) return true; if (!owner.meydaReady) owner.meydaReady = loadScript('https://cdn.jsdelivr.net/npm/meyda@5.6.3/dist/web/meyda.min.js'); await owner.meydaReady; return true; }
async function captureVoiceprint(seconds) {
  await loadMeyda();
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const ctx = getAudioContext(); const src = ctx.createMediaStreamSource(stream);
  const frames = [];
  const an = Meyda.createMeydaAnalyzer({ audioContext: ctx, source: src, bufferSize: 1024, featureExtractors: ['mfcc', 'rms'], callback: f => { if (f.rms > 0.015) frames.push(f.mfcc); } });
  an.start(); await new Promise(r => setTimeout(r, seconds * 1000)); an.stop(); stream.getTracks().forEach(t => t.stop());
  if (frames.length < 15) return null;
  const n = frames[0].length; const mean = new Array(n).fill(0), sd = new Array(n).fill(0);
  frames.forEach(f => f.forEach((v, i) => { mean[i] += v / frames.length; }));
  frames.forEach(f => f.forEach((v, i) => { sd[i] += (v - mean[i]) ** 2 / frames.length; }));
  return { mean, sd: sd.map(Math.sqrt), frames: frames.length };
}
function voiceDistance(a, b) { let s = 0; for (let i = 1; i < a.mean.length; i++) s += Math.abs(a.mean[i] - b.mean[i]) / (a.sd[i] + 1e-3); return s / (a.mean.length - 1); }
async function enrollOwnerVoice() {
  announce('After the chime, speak naturally for five seconds. For example, tell me what you did today.', 'শব্দের পর পাঁচ সেকেন্ড স্বাভাবিকভাবে কথা বলুন। যেমন আজ কী করলেন বলুন।', 'system');
  await new Promise(r => setTimeout(r, 4500)); playEarcon('confirm');
  try {
    const vp = await captureVoiceprint(5);
    if (!vp) return announce('I did not hear enough speech. Try again in a quieter place.', 'যথেষ্ট কথা শুনিনি। একটু নীরব জায়গায় আবার চেষ্টা করুন।', 'system');
    owner.voice = vp; try { localStorage.setItem('astha.owner.voice', JSON.stringify(vp)); } catch (e) {}
    renderOwner(); playEarcon('confirm'); announce('Thank you. I have a voiceprint for you now. It is experimental, so your face is the main check.', 'ধন্যবাদ। আপনার কণ্ঠের ছাপ রাখলাম। এটি পরীক্ষামূলক, তাই মুখই প্রধান পরিচয়।', 'system'); logEvent('Owner voice enrolled');
  } catch (e) { announce('I could not use the microphone for the voice check.', 'কণ্ঠ পরীক্ষার জন্য মাইক্রোফোন পাইনি।', 'system'); }
}
async function verifyOwnerVoice() {
  if (!owner.voice) return null;
  try { const vp = await captureVoiceprint(2.5); if (!vp) return null; const d = voiceDistance(owner.voice, vp); return { match: d < 1.1, distance: d }; } catch (e) { return null; }
}
function ownerVerified() { return Date.now() - owner.verifiedAt < 10 * 60 * 1000; }
// Gate for commands when the owner lock is on: face first; voice check as a fallback.
function ownerGate(query) {
  if (!owner.lock || ownerVerified()) return true;
  if (/it'?s me|unlock|remember my face|my face|my voice|আমি|আনলক|আমার মুখ|আমার কণ্ঠ/i.test(query)) return true;
  announce('Owner lock is on. Look at the camera, or say “it is me” so I can check your voice.', 'মালিক লক চালু। ক্যামেরার দিকে তাকান, বা বলুন “আমি” যাতে আপনার কণ্ঠ পরীক্ষা করতে পারি।', 'system');
  verifyOwnerFace(true).then(ok => { if (ok) { announce('It is you. Unlocked. Please say that again.', 'হ্যাঁ, আপনি। আনলক হয়েছে। আবার বলুন।', 'system'); } });
  return false;
}
async function ownerItsMe() {
  const faceOk = await verifyOwnerFace(true);
  if (faceOk) { playEarcon('confirm'); return announce('It is you. Unlocked.', 'হ্যাঁ, আপনি। আনলক হয়েছে।', 'system'); }
  if (owner.voice) {
    announce('Say a few words so I can check your voice.', 'কয়েকটি কথা বলুন, আপনার কণ্ঠ মিলিয়ে দেখি।', 'system');
    await new Promise(r => setTimeout(r, 2500)); playEarcon('confirm');
    const v = await verifyOwnerVoice();
    if (v && v.match) { owner.verifiedAt = Date.now(); renderOwner(); playEarcon('confirm'); return announce('Your voice matches. Unlocked.', 'আপনার কণ্ঠ মিলেছে। আনলক হয়েছে।', 'system'); }
    return announce('I could not confirm your voice. Please face the camera instead.', 'কণ্ঠ নিশ্চিত হয়নি। ক্যামেরার দিকে তাকান।', 'system');
  }
  announce('I could not recognise you. Face the camera in good light, or say “remember my face” to enrol.', 'আপনাকে চিনতে পারিনি। আলোতে ক্যামেরার দিকে তাকান, বা বলুন “আমার মুখ মনে রাখো”।', 'system');
}
function toggleOwnerLock() {
  if (!owner.face && !owner.lock) return announce('Show me your face first: say “remember my face”.', 'আগে আপনার মুখ দেখান: বলুন “আমার মুখ মনে রাখো”।', 'system');
  owner.lock = !owner.lock; try { localStorage.setItem('astha.owner.lock', owner.lock ? '1' : '0'); } catch (e) {}
  renderOwner(); playEarcon('click');
  announce(owner.lock ? 'Owner lock is on. I will only take commands after I recognise you.' : 'Owner lock is off.', owner.lock ? 'মালিক লক চালু। আপনাকে চিনলেই কেবল নির্দেশ মানব।' : 'মালিক লক বন্ধ।', 'system');
}
function renderOwner() {
  const s = $('owner-status'); if (!s) return;
  const bits = [owner.face ? 'Face enrolled' : 'No face yet', owner.voice ? 'voiceprint saved' : 'no voiceprint', owner.lock ? 'lock on' : 'lock off', ownerVerified() ? 'verified ' + fmtTime(new Date(owner.verifiedAt), 'en') : 'not verified'];
  s.textContent = bits.join(' · ');
  const b = $('owner-lock-btn'); if (b) { b.setAttribute('aria-pressed', owner.lock); b.textContent = owner.lock ? 'Owner lock: on' : 'Owner lock: off'; }
}
// Keep the owner verified quietly while a face is in view (auto-refresh every 20 s).
async function ownerAutoCheck() {
  if (!owner.face || !owner.faceReady || state.source !== 'camera' || state.busy) return;
  const now = Date.now(); if (now - owner.lastAutoCheck < 20000 || ownerVerified() && now - owner.verifiedAt < 5 * 60 * 1000) return;
  owner.lastAutoCheck = now;
  if (!state.lastCocoPreds.some(o => o.id === 'person')) return;
  await verifyOwnerFace(true);
}

// ---- Secure connection guidance ---------------------------------------------
function secureBanner() {
  const b = $('secure-banner'); if (!b) return;
  if (window.isSecureContext) { b.hidden = true; return; }
  b.hidden = false;
}

function cloudBoot() {
  try { cloud.key = localStorage.getItem('astha.gemini') || ''; } catch (e) {}
  if ($('gemini-key')) $('gemini-key').value = cloud.key;
  updateCloudBadge();
  refreshCloudStatus();
  let mode = 'auto'; try { mode = localStorage.getItem('astha.mode') || 'auto'; } catch (e) {}
  setMode(mode, true);
  try { const f = localStorage.getItem('astha.owner.face'); if (f) owner.face = JSON.parse(f); const v = localStorage.getItem('astha.owner.voice'); if (v) owner.voice = JSON.parse(v); owner.lock = localStorage.getItem('astha.owner.lock') === '1'; } catch (e) {}
  renderOwner(); secureBanner();
  if (owner.face) loadFaceLib().catch(() => {});
}
