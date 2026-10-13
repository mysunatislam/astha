// Voice-first interaction manager: assistance modes, speech priority, cancellation of
// stale visual work, page navigation and the personal setup preferences.
// It records how the user wants ASTHA to behave; it makes no medical classification.
const AsthaExperience = (() => {
  const MODES = ['ask', 'road', 'classroom'];
  const PAGES = ['home', 'tools', 'memory', 'devices', 'assessment', 'settings'];
  const PAGE_KEYS = { home: 'page_home', tools: 'page_tools', memory: 'page_memory', devices: 'page_devices', assessment: 'page_assessment', settings: 'page_settings' };
  const MODE_KEYS = { ask: 'mode_desc_ask', road: 'mode_desc_road', classroom: 'mode_desc_classroom' };
  const STATE_KEYS = { idle: 'state_idle', listening: 'state_listening', processing: 'state_processing', speaking: 'state_speaking' };
  const SOURCE_KEYS = { camera: 'device_phone_on', pi: 'device_wifi_on', photo: 'device_image', scene: 'device_image' };

  /* ---- Speech priority ---------------------------------------------------------------
     critical  a credible immediate hazard while hazard monitoring is on; interrupts anything
     high      the user's own command and its answer; never gated here
     medium    updates the user asked to keep receiving (surroundings, whiteboard, shield)
     low       routine observations
     Medium and low wait for the user and for ASTHA's current answer, and stay silent for a
     short while after Stop. Repeats of the same alert are dropped inside its window. */
  const CRITICAL_HAZARDS = new Set(['stairs', 'drop_off', 'vehicle_collision']);
  const CRITICAL_REPEAT = 8000, CRITICAL_GAP = 2500, UPDATE_REPEAT = 30000, UPDATE_GAP = 4000, STOP_QUIET = 10000;
  const spoken = new Map();
  let lastCritical = -Infinity, lastUpdate = -Infinity, quietUntil = 0;

  let mode = 'ask', page = 'home', pending = 0, lastBoard = '', boardTimer = null;
  let lastVisualQuery = '', visualGeneration = 0, contextGeneration = 0;
  let shownState = '', shownDevice = '', spokenGroup = null;
  const text = (en, bn) => uiLang === 'bn' ? bn : en;
  const foregroundBusy = () => state.busy || state.listening || reader.active ||
    (typeof reading !== 'undefined' && reading.active) || asthaSpeaking() || Boolean(VoiceEngine.requestController);
  const busy = () => pending > 0 || foregroundBusy();
  // Image-derived hazard warnings are only credible while the user has asked ASTHA to watch.
  const monitoring = () => mode === 'road' || Boolean(state.shield);
  function say(en, bn) { announce(en, bn, 'system'); }

  function allows(priority) {
    const now = Date.now();
    if (priority === 'high') return true;
    if (priority === 'critical') return monitoring() && now - lastCritical >= CRITICAL_GAP;
    if (busy() || now < quietUntil || now - lastUpdate < UPDATE_GAP) return false;
    return priority === 'medium' || (priority === 'low' && mode === 'road');
  }
  // Returns true when the caller may speak now, and records it so a repeat is suppressed.
  function admit(priority, key, repeatMs) {
    if (!allows(priority)) return false;
    const now = Date.now(), id = priority + ':' + key;
    const repeat = repeatMs ?? (priority === 'critical' ? CRITICAL_REPEAT : UPDATE_REPEAT);
    if (key != null && now - (spoken.has(id) ? spoken.get(id) : -Infinity) < repeat) return false;
    if (key != null) spoken.set(id, now);
    if (priority === 'critical') lastCritical = now; else if (priority !== 'high') lastUpdate = now;
    return true;
  }
  const hazardPriority = type => CRITICAL_HAZARDS.has(String(type)) ? 'critical' : 'medium';
  // 'critical', 'medium' or null. A nearby person, table or chair never outranks an answer.
  function acceptHazard(type) {
    const priority = hazardPriority(type);
    return admit(priority, 'hazard:' + type) ? priority : null;
  }
  // Stop: drop answers that have not been spoken yet and hold back routine updates briefly.
  function cancelPending() {
    visualGeneration++; quietUntil = Date.now() + STOP_QUIET; state.pendingAction = null;
  }

  function renderMode() {
    document.querySelectorAll('[data-astha-context]').forEach(button => button.setAttribute('aria-pressed', button.dataset.asthaContext === mode));
    const status = $('context-status'); if (status) status.textContent = t(MODE_KEYS[mode]);
  }
  function setContext(next, silent = false) {
    if (!MODES.includes(next)) return;
    visualGeneration++; contextGeneration++;
    mode = next; lastBoard = ''; spoken.clear(); quietUntil = 0;
    clearTimeout(boardTimer); boardTimer = null;
    // Keep the established narration and shield controls synchronized with the spoken task.
    setMode(next === 'road' ? 'auto' : 'quiet', true);
    renderMode();
    if (!silent) say(
      next === 'road' ? 'Surroundings mode. I will mention important changes, and warn about stairs, drop-offs and approaching vehicles when I can detect them. I can miss hazards and cannot judge a safe crossing. Keep using your cane or guide.'
        : next === 'classroom' ? 'Whiteboard mode. I will read the board when its text changes and stay quiet about other things. I am not watching for obstacles.'
        : 'I will answer when you ask and stay quiet otherwise. I am not watching for obstacles.',
      next === 'road' ? 'চারপাশ মোড। গুরুত্বপূর্ণ পরিবর্তন জানাব, আর সিঁড়ি, খাদ বা এগিয়ে আসা গাড়ি শনাক্ত করতে পারলে সতর্ক করব। বিপদ বাদ পড়তে পারে, নিরাপদে রাস্তা পার হওয়া নিশ্চিত করতে পারি না। লাঠি বা সঙ্গীর সাহায্য নিন।'
        : next === 'classroom' ? 'হোয়াইটবোর্ড মোড। বোর্ডের লেখা বদলালে পড়ে শোনাব, অন্য বিষয়ে চুপ থাকব। বাধার দিকে নজর রাখছি না।'
        : 'আপনি জিজ্ঞাসা করলে উত্তর দেব, না হলে চুপ থাকব। বাধার দিকে নজর রাখছি না।');
    if (next === 'classroom' && !document.hidden) boardTimer = setTimeout(checkBoard, 5000);
  }
  async function checkBoard() {
    let started = false;
    const generation = visualGeneration;
    const session = contextGeneration;
    const source = state.source, epoch = state.sourceEpoch;
    boardTimer = null;
    try {
      if (mode !== 'classroom' || document.hidden || busy() || !state.source) return;
      const frame = captureFrame(1280); if (!frame) return;
      pending++; started = true;
      let content = '';
      if (cloudReady()) {
        const result = await gemini('Read only legible text on the whiteboard or classroom board in this current image. Ignore people and ordinary furniture. Do not guess missing characters. Return JSON {"text": string}; use empty text if no board is legible.', frame);
        content = typeof result.text === 'string' ? result.text.trim().slice(0, 3000) : '';
      } else {
        // Local OCR cannot reliably isolate a board from the whole scene automatically.
        return;
      }
      if (mode !== 'classroom' || generation !== visualGeneration || source !== state.source || epoch !== state.sourceEpoch || document.hidden || foregroundBusy() || pending > 1) return;
      const normalized = content.replace(/\s+/g, ' ');
      if (normalized && normalized !== lastBoard) {
        // Leave the text unread while the user has asked for quiet, so it is read afterwards.
        if (Date.now() < quietUntil) return;
        lastBoard = normalized; lastUpdate = Date.now();
        say('The board now reads: ' + content, 'বোর্ডে এখন লেখা: ' + content);
      }
    } catch { /* An unavailable model never becomes a fabricated board update. */ }
    finally {
      if (started) pending = Math.max(0, pending - 1);
      if (mode === 'classroom' && session === contextGeneration && !document.hidden && !boardTimer) boardTimer = setTimeout(checkBoard, 12000);
    }
  }
  function route(query) {
    const q = String(query || '').toLowerCase().replace(/^(?:hey\s+)?astha[,!\s]*|^আস্থা[,।\s]*/i, '').trim();
    if (guide) { answerGuide(q); return true; }
    if (/^(?:start |begin )?(?:the )?(?:guided|voice|spoken) setup$|^set me up$|গাইডেড সেটআপ|কণ্ঠে সেটআপ|সেটআপ শুরু করো/.test(q.replace(/[.!?।\s]+$/, ''))) { showPage('assessment', { speakTitle: false }); startGuide(); return true; }
    // Hands-free needs continuous recognition, which this browser or app does not have.
    if (!handsFreeAvailable() && /hands.?free|keep listening|always listen|হ্যান্ডস.?ফ্রি|সবসময় শোনো/.test(q)) {
      say('Hands-free listening is not available here yet. Tap the microphone, wait for the chime, then ask.', 'হ্যান্ডস-ফ্রি শোনা এখানে এখনও নেই। মাইক্রোফোনে চাপ দিন, শব্দের পরে জিজ্ঞাসা করুন।');
      return true;
    }
    if (/busy road|busy street|keep updating|update me everything|walking outside|ব্যস্ত রাস্তা|রাস্তায় আছি|চারপাশ জানাও/.test(q)) { setContext('road'); if (!state.source) withCamera(() => {}); return true; }
    if (/(?:i am|i'm|we are|we're).*(?:classroom|safe place)|(?:focus on|only|just|keep).*(?:whiteboard|board)|(?:classroom|whiteboard) mode|ক্লাসরুমে আছি|শ্রেণিকক্ষে আছি|নিরাপদ জায়গায় আছি|শুধু.*(?:বোর্ড|হোয়াইটবোর্ড)/.test(q)) {
      setContext('classroom');
      if (!state.source) withCamera(() => {});
      return true;
    }
    if (/stop updates|only when i ask|quiet mode|আপডেট বন্ধ|জিজ্ঞাসা করলে|শান্ত মোড/.test(q)) { setContext('ask'); return true; }
    // Stop silences ASTHA and drops unspoken answers. The chosen mode stays until changed.
    if (/^(?:stop|stop talking|cancel|be quiet|quiet|silence|enough|shut up|halt|থামো|থামুন|বন্ধ করো|চুপ|চুপ কর|চুপ করো|কথা বন্ধ|স্টপ|thamo|chup|bondho koro)[.!।\s]*$/.test(q)) { cancelPending(); stopAllSpeech(); if (typeof AsthaAgent !== 'undefined') AsthaAgent.cancel?.(); return true; }
    // Page names are whole commands, so a question that merely mentions one is still answered.
    const bare = q.replace(/[.!?।\s]+$/, '');
    const open = '(?:open |go to |show )?', kholo = '(?: খোলো| দেখাও|ে যাও)?';
    const pages = [
      ['home', new RegExp('^(?:' + open + '(?:the )?home|go home|হোম' + kholo + ')$')],
      ['assessment', new RegExp('^(?:' + open + '(?:my )?(?:setup|personal setup|assessment)|(?:আমার পছন্দ|নিজের পছন্দ|সেটআপ)' + kholo + ')$')],
      ['devices', new RegExp('^(?:' + open + '(?:my |connected )?devices|(?:সংযুক্ত )?ডিভাইস' + kholo + ')$')],
      ['settings', new RegExp('^(?:' + open + '(?:the )?settings|সেটিংস' + kholo + ')$')],
      ['memory', new RegExp('^(?:' + open + '(?:my )?(?:memory|memories)|স্মৃতি' + kholo + ')$')],
      ['tools', new RegExp('^(?:' + open + '(?:the )?(?:camera view|camera tools|tools)|ক্যামেরা(?: খোলো| দেখাও))$')],
    ];
    for (const [name, pattern] of pages) if (pattern.test(bare)) { showPage(name); return true; }
    if (typeof AsthaScreenAccess !== 'undefined' && AsthaScreenAccess.route(query)) return true;
    if (lastVisualQuery && /^(?:check again|look again|is it still there|and now|আবার দেখো|এখনো আছে|এখন কী)[?।.!\s]*$/.test(q)) { handleVisualQA(lastVisualQuery); return true; }
    // Historical recall keeps its existing path. Current visual questions take a fresh frame.
    if (!/where did i|last seen|remember|কোথায় রেখেছিলাম|মনে রাখ/.test(q) &&
        /can you.*(?:see|find|where)|(?:where is|where's|find) my|দেখতে পাচ্ছ|আমার.+কোথায়/.test(q)) {
      handleVisualQA(query); return true;
    }
    return false;
  }
  async function visualTask(query, run) {
    const mine = ++visualGeneration; lastVisualQuery = query; pending++;
    const epoch = state.sourceEpoch, source = state.source;
    const account = window.ASTHA_ACCOUNT_ID, localAccount = window.ASTHA_LOCAL_ACCOUNT_ID;
    const current = () => mine === visualGeneration && epoch === state.sourceEpoch && source === state.source &&
      account === window.ASTHA_ACCOUNT_ID && localAccount === window.ASTHA_LOCAL_ACCOUNT_ID && !document.hidden;
    try {
      const photo = ['image', 'photo', 'scene'].includes(state.source);
      const en = photo ? 'Checking the selected image.' : 'Checking the current camera view.';
      const bn = photo ? 'নির্বাচিত ছবিটি দেখছি।' : 'ক্যামেরার বর্তমান দৃশ্য দেখছি।';
      setCaption(t('analyzing_title'), en, 'vision', 'busy', bn);
      if (state.audio) await VoiceEngine.speak(voiceLang === 'bn' ? bn : en, voiceLang);
      if (!current()) return;
      return await run(current);
    } finally { pending = Math.max(0, pending - 1); }
  }

  /* ---- Pages: one task per screen -------------------------------------------------- */
  function showPage(next, { focus = true, speakTitle = true } = {}) {
    if (!PAGES.includes(next)) return;
    page = next;
    document.body?.setAttribute('data-view', next);
    const standalone = { assessment: 'assessment-page', devices: 'devices-page' };
    for (const [name, id] of Object.entries(standalone)) { const panel = $(id); if (panel) panel.hidden = next !== name; }
    const main = document.querySelector('main'); if (main) main.hidden = Object.hasOwn(standalone, next);
    document.querySelectorAll('[data-astha-page]').forEach(button => button.setAttribute('aria-current', button.dataset.asthaPage === next ? 'page' : 'false'));
    const title = $('page-title');
    if (title) { title.textContent = t(PAGE_KEYS[next]); if (focus) { title.setAttribute('tabindex', '-1'); title.focus(); } }
    spokenGroup = null;
    if (!speakTitle || !state.audio) return;
    if (next === 'assessment') readAssessment();
    else if (next === 'devices') say('Connected devices. Pair a Wi-Fi camera, or try the Braille controller practice mode.', 'সংযুক্ত ডিভাইস। ওয়াই-ফাই ক্যামেরা জুড়ুন, অথবা ব্রেইল কন্ট্রোলারের অনুশীলন মোড চালান।');
    else say(I18N.en[PAGE_KEYS[next]], I18N.bn[PAGE_KEYS[next]]);
  }

  /* ---- Personal setup --------------------------------------------------------------- */
  const PREF_KEY = 'astha.accessibility.v2';
  const CHOICES = { vision: ['none', 'light', 'low', 'unspecified'], language: ['bn', 'en'], feedback: ['detailed', 'brief', 'text'],
    textSize: ['normal', 'large', 'xlarge'], theme: ['mulberry-apricot', 'navy-cyan', 'monochrome', 'clinical-yellow'], speechRate: ['0.8', '1', '1.2', '1.5'] };
  const SETS = { devices: ['phone_camera', 'smart_glasses', 'clip_camera', 'braille_controller'], modes: ['ask', 'road', 'classroom'] };
  const DEFAULTS = Object.freeze({ vision: 'unspecified', feedback: 'detailed', textSize: 'normal', theme: 'mulberry-apricot', speechRate: '1', devices: [], modes: ['ask', 'road', 'classroom'], haptics: true });
  let preferences = { ...DEFAULTS };

  // Anything outside the known choices is dropped, whether it came from storage or the server.
  function sanitize(input) {
    const clean = { ...DEFAULTS };
    if (!input || typeof input !== 'object') return clean;
    for (const [key, allowed] of Object.entries(CHOICES)) if (allowed.includes(input[key])) clean[key] = input[key];
    for (const [key, allowed] of Object.entries(SETS)) if (Array.isArray(input[key])) clean[key] = allowed.filter(item => input[key].includes(item));
    if (!clean.modes.includes('ask')) clean.modes.unshift('ask');
    if (typeof input.haptics === 'boolean') clean.haptics = input.haptics;
    return clean;
  }
  // The device copy belongs to one account. Another person signing in on this phone must
  // neither inherit it nor have it uploaded into their account.
  const owner = () => window.ASTHA_LOCAL_ACCOUNT_ID || null;
  function readLocal() {
    try {
      const saved = JSON.parse(localStorage.getItem(PREF_KEY) || 'null');
      return saved && typeof saved === 'object' && saved.owner === owner() ? saved : null;
    } catch { return null; }
  }
  function writeLocal(record) { try { localStorage.setItem(PREF_KEY, JSON.stringify({ ...record, owner: owner() })); } catch {} }
  const field = name => document.querySelector('#assessment-form [name="' + name + '"]:checked');
  const boxes = name => [...document.querySelectorAll('#assessment-form [name="' + name + '"]')];
  function readForm() {
    const values = {};
    for (const key of ['vision', 'language', 'feedback']) { const chosen = field('pref-' + key); if (chosen) values[key] = chosen.value; }
    for (const [key, id] of [['textSize', 'pref-text-size'], ['theme', 'pref-theme'], ['speechRate', 'pref-speech-rate']]) { const control = $(id); if (control) values[key] = control.value; }
    for (const key of ['devices', 'modes']) values[key] = boxes('pref-' + key).filter(box => box.checked).map(box => box.value);
    const haptics = $('pref-haptics'); if (haptics) values.haptics = Boolean(haptics.checked);
    return sanitize(values);
  }
  function fillForm(values) {
    for (const key of ['vision', 'language', 'feedback']) {
      const value = key === 'language' ? values.language || uiLang : values[key];
      boxes('pref-' + key).forEach(input => { input.checked = input.value === value; });
    }
    for (const [key, id] of [['textSize', 'pref-text-size'], ['theme', 'pref-theme'], ['speechRate', 'pref-speech-rate']]) { const control = $(id); if (control) control.value = values[key]; }
    for (const key of ['devices', 'modes']) boxes('pref-' + key).forEach(box => { box.checked = values[key].includes(box.value); });
    const haptics = $('pref-haptics'); if (haptics) haptics.checked = values.haptics;
  }
  // Apply through the established controls so both views of each setting stay consistent.
  // The spoken language follows only an explicit Save: it can be chosen separately from
  // the interface language, and that choice must survive the next start.
  function applyPreferences(values, { explicit = false } = {}) {
    preferences = values;
    if (values.language && values.language !== uiLang) setUiLanguage(values.language);
    if (explicit && values.language && values.language !== voiceLang) setVoiceLanguage(values.language, true);
    if ((values.feedback !== 'text') !== Boolean(state.audio)) toggleAudio();
    const style = $('description-style'); if (style) style.value = values.feedback === 'brief' ? 'short' : 'detailed';
    const rate = $('speech-rate'); if (rate) rate.value = values.speechRate;
    if (typeof savePreferences === 'function' && style && rate) savePreferences();
    if (document.documentElement.getAttribute('data-font-size') !== values.textSize) { applyFontSize(values.textSize); if ($('font-select')) $('font-select').value = values.textSize; }
    if (document.documentElement.getAttribute('data-theme') !== values.theme) { applyClinicalTheme(values.theme); if ($('theme-select')) $('theme-select').value = values.theme; }
    state.haptics = values.haptics;
    document.querySelectorAll('[data-astha-context]').forEach(button => { button.hidden = !values.modes.includes(button.dataset.asthaContext); });
    if (!values.modes.includes(mode)) setContext('ask', true);
  }
  function setupStatus(key) { const status = $('assessment-status'); if (status) status.textContent = key ? t(key) : ''; }
  async function syncPreferences(record) {
    if (typeof apiSend !== 'function' || !window.ASTHA_ACCOUNT_ID) return false;
    const account = window.ASTHA_ACCOUNT_ID;
    try {
      const saved = await apiSend('PUT', '/api/preferences', { preferences: record.values });
      if (account !== window.ASTHA_ACCOUNT_ID) return false;
      writeLocal({ values: record.values, updated_at: saved.updated_at, synced: true });
      return true;
    } catch { return false; }
  }
  async function saveAssessment(event) {
    event?.preventDefault();
    await commit(readForm());
  }
  async function commit(values) {
    fillForm(values);
    const record = { values, updated_at: Date.now(), synced: false };
    writeLocal(record);
    applyPreferences(values, { explicit: true });
    setupStatus('setup_saving');
    const synced = await syncPreferences(record);
    setupStatus(synced ? 'setup_saved_account' : 'setup_saved_device');
    showPage('home', { speakTitle: false });
    say(synced ? 'Your setup is saved to your account.' : 'Your setup is saved on this device. It will be copied to your account when ASTHA can reach the server.',
      synced ? 'আপনার পছন্দ অ্যাকাউন্টে রাখা হয়েছে।' : 'আপনার পছন্দ এই ডিভাইসে রাখা হয়েছে। সার্ভারে সংযোগ পেলে অ্যাকাউন্টে তোলা হবে।');
  }
  // A setting changed elsewhere in the app (header menus, Settings) replaces the saved
  // setup answer, so the two never disagree on the next start.
  function adopt(key, value) {
    const local = readLocal();
    if (!local?.values || local.values[key] === value || !CHOICES[key]?.includes(value)) return;
    const record = { values: sanitize({ ...local.values, [key]: value }), updated_at: Date.now(), synced: false };
    preferences = record.values; writeLocal(record); fillForm(record.values); syncPreferences(record);
  }
  // After sign-in the account's saved setup wins; an unsynced local setup is uploaded instead.
  async function loadAccountPreferences() {
    const local = readLocal();
    if (local?.values) { fillForm(sanitize(local.values)); applyPreferences(sanitize(local.values)); }
    if (typeof apiSend !== 'function' || !window.ASTHA_ACCOUNT_ID) return;
    const account = window.ASTHA_ACCOUNT_ID;
    if (local?.values && local.synced === false) { await syncPreferences(local); return; }
    try {
      const saved = await apiSend('GET', '/api/preferences');
      if (account !== window.ASTHA_ACCOUNT_ID || !saved?.preferences) return;
      const values = sanitize(saved.preferences);
      writeLocal({ values, updated_at: saved.updated_at, synced: true });
      fillForm(values); applyPreferences(values);
    } catch { /* Offline or signed out: the device copy stays in effect. */ }
  }
  // A shared phone must not keep the previous person's vision and device answers.
  function accountCleared() {
    try { localStorage.removeItem(PREF_KEY); localStorage.removeItem('astha.accessibility.v1'); } catch {}
    preferences = { ...DEFAULTS }; fillForm(preferences); setupStatus('');
  }
  /* ---- Guided setup: the same answers, given by voice -------------------------------
     ASTHA asks one short question at a time and listens. While it is running every
     request is taken as an answer, so "one" or "yes" never reaches another feature. */
  const YES = /^(?:yes|yeah|yep|sure|ok|okay|please|হ্যাঁ|হুম|জি|জ্বি|চাই|ha|hae)(?![A-Za-z0-9_\u0980-\u09FF])/, NO = /^(?:no|nope|nah|না|চাই না|লাগবে না|na)(?![A-Za-z0-9_\u0980-\u09FF])/;
  const GUIDE = [
    { key: 'vision', en: 'How much do you rely on vision? Say one if you are blind. Two if you can tell light or large shapes. Three if you have low vision. Four if you prefer not to say.',
      bn: 'আপনি দৃষ্টির ওপর কতটা নির্ভর করেন? দৃষ্টিহীন হলে বলুন এক। আলো বা বড় আকার বুঝলে দুই। স্বল্পদৃষ্টি হলে তিন। জানাতে না চাইলে চার।',
      options: [['none', /\b(?:1|one|blind)\b|এক|১|দৃষ্টিহীন|অন্ধ/], ['light', /\b(?:2|two|light|shapes?)\b|দুই|২|আলো/], ['low', /\b(?:3|three|low)\b|তিন|৩|স্বল্প|কম দেখ/], ['unspecified', /\b(?:4|four|prefer not|rather not)\b|চার|৪|জানাতে চাই না/]] },
    { key: 'language', en: 'Which language should I use? Say Bangla or English.', bn: 'আমি কোন ভাষা ব্যবহার করব? বলুন বাংলা অথবা ইংরেজি।',
      options: [['bn', /\b(?:1|one|bangla|bengali)\b|বাংলা|এক|১/], ['en', /\b(?:2|two|english)\b|ইংরেজি|ইংলিশ|দুই|২/]] },
    { key: 'feedback', en: 'How should I answer? Say one for full descriptions. Two for short answers. Three for text only, without speech.',
      bn: 'আমি কীভাবে উত্তর দেব? বিস্তারিত বর্ণনার জন্য বলুন এক। সংক্ষিপ্ত উত্তরের জন্য দুই। কথা না বলে শুধু লেখার জন্য তিন।',
      options: [['detailed', /\b(?:1|one|full|detailed?)\b|এক|১|বিস্তারিত/], ['brief', /\b(?:2|two|short|brief)\b|দুই|২|সংক্ষ/], ['text', /\b(?:3|three|text|silent)\b|তিন|৩|লেখা/]] },
    { key: 'road', en: 'Do you want surroundings updates on your home screen, for when you are walking? Say yes or no.', bn: 'হাঁটার সময়ের জন্য হোম পর্দায় চারপাশের খবর চান? হ্যাঁ বা না বলুন।', options: [[true, YES], [false, NO]] },
    { key: 'classroom', en: 'Do you want whiteboard focus on your home screen, for classrooms? Say yes or no.', bn: 'শ্রেণিকক্ষের জন্য হোম পর্দায় হোয়াইটবোর্ডে মনোযোগ চান? হ্যাঁ বা না বলুন।', options: [[true, YES], [false, NO]] },
  ];
  let guide = null;
  async function askGuide(prefixEn = '', prefixBn = '') {
    const mine = guide; if (!mine) return;
    const step = GUIDE[mine.step], en = prefixEn + step.en, bn = prefixBn + step.bn;
    setCaption(t('page_assessment'), en, 'system', null, bn);
    if (state.audio) await VoiceEngine.speak(voiceLang === 'bn' ? bn : en, voiceLang);
    // Listen for the answer without another tap, once per question.
    if (guide === mine && mine.asked !== mine.step && !state.listening && typeof toggleListening === 'function') { mine.asked = mine.step; toggleListening(); }
  }
  function startGuide() {
    if (!state.audio) toggleAudio();
    guide = { step: 0, asked: -1, values: {} };
    askGuide('I will ask five short questions. Say repeat, back, skip or cancel at any time. ', 'আমি পাঁচটি ছোট প্রশ্ন করব। যেকোনো সময় বলুন আবার, পেছনে, বাদ দাও বা বাতিল। ');
  }
  function endGuide(en, bn) { guide = null; if (en) say(en, bn); }
  async function finishGuide() {
    const answers = guide.values; guide = null;
    const values = { ...preferences };
    for (const key of ['vision', 'language', 'feedback']) if (answers[key] !== undefined) values[key] = answers[key];
    const modes = new Set(values.modes);
    for (const key of ['road', 'classroom']) if (answers[key] !== undefined) { if (answers[key]) modes.add(key); else modes.delete(key); }
    values.modes = [...modes];
    // Larger text is the one display change a low-vision answer implies.
    if (answers.vision === 'low' && values.textSize === 'normal') values.textSize = 'large';
    await commit(sanitize(values));
  }
  function answerGuide(q) {
    if (/^(?:stop|cancel|quit|exit|বাতিল|থামো|থামুন|বন্ধ করো)(?![A-Za-z0-9_\u0980-\u09FF])/.test(q)) { stopAllSpeech(); endGuide('Setup cancelled. Nothing was changed.', 'সেটআপ বাতিল হয়েছে। কিছুই বদলানো হয়নি।'); return; }
    if (/^(?:repeat|again|say that again|আবার|আবার বলো)(?![A-Za-z0-9_\u0980-\u09FF])/.test(q)) { guide.asked = -1; askGuide(); return; }
    if (/^(?:back|previous|go back|পেছনে|আগের)(?![A-Za-z0-9_\u0980-\u09FF])/.test(q)) { guide.step = Math.max(0, guide.step - 1); guide.asked = -1; askGuide(); return; }
    const skipped = /^(?:skip|next|বাদ দাও|পরের)(?![A-Za-z0-9_\u0980-\u09FF])/.test(q);
    const match = skipped ? null : GUIDE[guide.step].options.find(([, pattern]) => pattern.test(q));
    if (!skipped && !match) { guide.asked = -1; askGuide('I did not catch that. ', 'বুঝতে পারিনি। '); return; }
    if (match) guide.values[GUIDE[guide.step].key] = match[0];
    guide.step++; guide.asked = -1;
    if (guide.step < GUIDE.length) askGuide(); else finishGuide();
  }
  function readAssessment() {
    say('Personal setup. Each question is read when you reach it. Tab moves to the next choice, and Space or Enter selects it. Your answers only change how Astha presents information. Choose Save when you finish. Or say “start guided setup” and I will ask the main questions one at a time.',
      'নিজের পছন্দ। প্রতিটি প্রশ্নে পৌঁছালে তা পড়ে শোনানো হবে। ট্যাব দিয়ে পরের পছন্দে যান, স্পেস বা এন্টার দিয়ে বাছুন। উত্তরগুলো শুধু আস্থার উপস্থাপনা বদলায়। শেষ হলে সংরক্ষণ বেছে নিন। অথবা বলুন “গাইডেড সেটআপ শুরু করো”, আমি মূল প্রশ্নগুলো একটি একটি করে জিজ্ঞাসা করব।');
  }
  // Spoken instructions for each question: read its heading once when focus enters it.
  function speakGroup(event) {
    const group = event.target?.closest?.('fieldset, .setup-question');
    if (!group || group === spokenGroup || !state.audio) return;
    spokenGroup = group;
    const heading = group.querySelector('legend, .setup-label');
    const hint = group.querySelector('.setup-hint');
    const words = [heading?.textContent, hint?.textContent].filter(Boolean).join('. ').replace(/\s+/g, ' ').trim();
    if (words) VoiceEngine.speak(words, uiLang);
  }

  /* ---- Presence: what ASTHA is doing right now -------------------------------------- */
  function presence() {
    if (state.listening) return 'listening';
    if (asthaSpeaking()) return 'speaking';
    if (state.busy || pending > 0 || VoiceEngine.requestController) return 'processing';
    return 'idle';
  }
  function renderPresence(force = false) {
    const next = presence();
    if (force || next !== shownState) {
      shownState = next;
      const avatar = $('astha-avatar'); if (avatar) avatar.setAttribute('data-state', next);
      const status = $('astha-state');
      if (status) {
        // ASTHA's own voice already reports each step; avoid a second, overlapping reading.
        status.setAttribute('aria-live', state.audio ? 'off' : 'polite');
        status.textContent = t(STATE_KEYS[next]);
      }
    }
    const device = Object.hasOwn(SOURCE_KEYS, state.source) ? SOURCE_KEYS[state.source] : 'device_camera_off';
    if (force || device !== shownDevice) {
      shownDevice = device;
      const label = $('device-status'); if (label) label.textContent = t(device);
    }
  }
  function refreshLabels() {
    renderMode(); renderPresence(true);
    const title = $('page-title'); if (title) title.textContent = t(PAGE_KEYS[page]);
    // The header language menu and the setup question are two views of one choice.
    boxes('pref-language').forEach(input => { input.checked = input.value === uiLang; });
    adopt('language', uiLang);
  }

  const handsFreeAvailable = () => typeof window !== 'undefined' && Boolean(window.SpeechRecognition || window.webkitSpeechRecognition);
  // A control that silently does nothing is worse than no control for someone who cannot see it.
  function reflectHandsFree() {
    const button = $('hf-btn'), hint = document.querySelector('.mic-hint');
    if (button) button.hidden = !handsFreeAvailable();
    if (hint && !handsFreeAvailable()) { hint.setAttribute('data-i18n', 'mic_hint_tap'); hint.textContent = t('mic_hint_tap'); }
  }
  function boot() {
    // A remembered road mode must not silently resume camera analysis in a new session.
    setContext('ask', true);
    reflectHandsFree();
    $('assessment-guided')?.addEventListener('click', startGuide);
    document.querySelectorAll('[data-astha-page]').forEach(button => button.addEventListener('click', () => showPage(button.dataset.asthaPage)));
    document.querySelectorAll('[data-astha-context]').forEach(button => button.addEventListener('click', () => setContext(button.dataset.asthaContext)));
    $('assessment-form')?.addEventListener('submit', saveAssessment);
    $('assessment-form')?.addEventListener('focusin', speakGroup);
    $('assessment-read')?.addEventListener('click', () => { if (!state.audio) toggleAudio(); readAssessment(); });
    for (const [id, key] of [['font-select', 'textSize'], ['theme-select', 'theme'], ['speech-rate', 'speechRate']]) {
      $(id)?.addEventListener('change', event => adopt(key, event.target.value));
    }
    document.addEventListener('visibilitychange', () => { if (document.hidden) { visualGeneration++; contextGeneration++; clearTimeout(boardTimer); boardTimer = null; } else if (mode === 'classroom' && !boardTimer) boardTimer = setTimeout(checkBoard, 5000); });
    fillForm(preferences);
    showPage('home', { focus: false, speakTitle: false });
    loadAccountPreferences();
    renderPresence(true);
    if (typeof setInterval === 'function') setInterval(renderPresence, 200);
  }
  return { route, visualTask, allows, admit, acceptHazard, hazardPriority, cancelPending, setContext, showPage, boot,
    refreshLabels, accountCleared, loadAccountPreferences, sanitize, adopt, startGuide,
    get guiding() { return Boolean(guide); },
    routineAllowed: () => allows('low'),
    invalidate() { visualGeneration++; },
    get mode() { return mode; }, get page() { return page; }, get busy() { return busy(); },
    get preferences() { return { ...preferences }; } };
})();
