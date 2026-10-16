// Opt-in observations reuse existing camera inference. No images, identity text,
// people, inferred ownership or invented rooms/surfaces are saved here.
const AsthaObservationMemory = (() => {
  const PREFIX = 'astha.auto_memory.v1.';
  const CORE = new Set(['laptop', 'cell phone', 'eyeglasses', 'wallet', 'id card']);
  const OTHER = new Set(['keys', 'phone charger', 'laptop charger', 'power bank', 'watch', 'handbag', 'backpack', 'umbrella', 'book', 'notebook', 'pen', 'mouse', 'remote', 'medicine strip', 'pill bottle']);
  const POSITIONS = new Set(['left', 'ahead', 'right']);
  const ALIASES = { phone: 'cell phone', smartphone: 'cell phone', glasses: 'eyeglasses', spectacles: 'eyeglasses', 'identity card': 'id card' };
  const SCHEMA = '\nAlso return "memory_observations": at most 3 entries {"item": canonical English noun, "position": "left"|"ahead"|"right", "visible": true, "clarity": "clear"}. Include only clearly visible physical portable objects, never pictures/screens/reflections, people, faces, names, numbers or other text. Canonical nouns: laptop, cell phone, eyeglasses, wallet, id card, keys, phone charger, laptop charger, power bank, watch, handbag, backpack, umbrella, book, notebook, pen, mouse, remote, medicine strip, pill bottle. Omit uncertain identity or position. Use [] when none. Seeing an object does not establish ownership or placement.';
  let frames = new WeakMap(), revision = 0, sequence = 0, activeKey = null, pending = null, offered = null;
  let lastOffer = -Infinity, quietUntil = 0, booted = false;
  const sightings = new Map(), recorded = new Map(), suppressed = new Set();
  const canonical = item => { const name = String(item || '').trim().toLowerCase(); return ALIASES[name] || name; };
  function key() {
    const id = window.ASTHA_LOCAL_ACCOUNT_ID || window.ASTHA_ACCOUNT_ID;
    return typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id) ? PREFIX + id : null;
  }
  function reset() {
    revision++; frames = new WeakMap(); sightings.clear(); pending = null;
    if (offered && state.pendingYes === offered) state.pendingYes = null;
    offered = null;
  }
  function contextKey() {
    const next = key();
    if (activeKey !== next) { reset(); recorded.clear(); suppressed.clear(); activeKey = next; lastOffer = -Infinity; }
    return next;
  }
  function selected() {
    const current = contextKey();
    try { return Boolean(current && localStorage.getItem(current) === '1'); } catch { return false; }
  }
  function enabled() {
    return selected() && !privacyMode && !privacyTransition && !document.hidden && ['camera', 'pi'].includes(state.source) &&
      !(typeof owner !== 'undefined' && owner.lock && (typeof ownerVerified !== 'function' || !ownerVerified()));
  }
  function labels(item) {
    const entry = typeof VOCAB_BY_ID === 'undefined' ? null : VOCAB_BY_ID[item];
    return [entry?.en || (item === 'cell phone' ? 'phone' : item === 'eyeglasses' ? 'glasses' : item), entry?.bn || item];
  }
  function render() {
    const control = $('auto-memory-enabled');
    if (control) { control.checked = selected(); control.disabled = !key() || privacyMode || privacyTransition; }
  }
  function setEnabled(on) {
    if (privacyMode || privacyTransition || !contextKey() || (on && typeof owner !== 'undefined' && owner.lock && (typeof ownerVerified !== 'function' || !ownerVerified()))) {
      announce('Automatic memory is unavailable in privacy mode or before your profile is ready.', 'গোপনীয়তা মোডে বা প্রোফাইল তৈরি হওয়ার আগে স্বয়ংক্রিয় স্মৃতি চালু করা যায় না।', 'memory');
      render(); return false;
    }
    try { localStorage.setItem(key(), on ? '1' : '0'); }
    catch { announce('I could not save that preference.', 'পছন্দটি সংরক্ষণ করতে পারিনি।', 'memory'); render(); return false; }
    reset(); recorded.clear(); suppressed.clear(); quietUntil = 0; render();
    announce(on ? 'Automatic memory is on while the camera is active. I will save possible sightings of laptops, phones, glasses, wallets and ID cards, with the time and image position. I will ask before saving other selected personal objects. Pictures and ID text are not saved. Turn it off at any time.' : 'Automatic memory is off. Existing memories are unchanged.',
      on ? 'ক্যামেরা চালু থাকলে স্বয়ংক্রিয় স্মৃতি চালু। ল্যাপটপ, ফোন, চশমা, মানিব্যাগ ও পরিচয়পত্রের সম্ভাব্য দেখা, সময় ও ছবিতে অবস্থান রাখব। অন্য বাছাই করা ব্যক্তিগত জিনিস রাখতে আগে জিজ্ঞাসা করব। ছবি বা পরিচয়পত্রের লেখা রাখব না। যেকোনো সময় বন্ধ করতে পারবেন।' : 'স্বয়ংক্রিয় স্মৃতি বন্ধ। আগের স্মৃতি অপরিবর্তিত আছে।', 'memory');
    return true;
  }
  function route(query) {
    const q = String(query || '').toLowerCase().trim().replace(/[.!?।]+$/, '').replace(/^(?:hey\s+)?astha[,!\s]*|^আস্থা[,।\s]*/i, '').trim();
    if (/^(?:(?:enable|turn on|start) automatic (?:object )?memory|automatically remember (?:my )?(?:important (?:things|objects)|essentials)|স্বয়ংক্রিয় স্মৃতি চালু করো|দরকারি জিনিস নিজে থেকে মনে রাখো)$/.test(q)) { setEnabled(true); return true; }
    if (/^(?:(?:disable|turn off|stop) automatic (?:object )?memory|stop automatically remembering|স্বয়ংক্রিয় স্মৃতি বন্ধ করো|নিজে থেকে মনে রাখা বন্ধ করো)$/.test(q)) { setEnabled(false); return true; }
    return false;
  }
  function capture(frame) {
    if (!enabled() || !frame || typeof frame !== 'object') return;
    frames.set(frame, { at: Date.now(), sequence: ++sequence, revision, key: contextKey(), current: captureLocalActionGuard(), local: false, cloud: false });
  }
  function current(meta, maxAge = 3500) {
    return Boolean(meta && enabled() && meta.key === contextKey() && meta.revision === revision && meta.current() &&
      (typeof activeSourceEl !== 'function' || activeSourceEl()) &&
      Date.now() >= meta.at && Date.now() - meta.at <= maxAge);
  }
  function save(candidate) {
    if (!current(candidate.meta, 45000) || suppressed.has(candidate.item) || (candidate.kind === 'cloud' && !remoteProcessingAllowed())) return;
    const dedupe = candidate.item + '|' + candidate.position, now = Date.now();
    if (now - (recorded.get(dedupe) ?? -Infinity) < 300000) return;
    const names = labels(candidate.item), position = candidate.position;
    // The shared write API still rejects unapproved saves. This coordinator applies
    // the explicit opt-in / individual approval policy to current visual evidence.
    const saved = autoRecordMemory({ item: names[0],
      location: `Possible sighting in the ${position === 'ahead' ? 'centre' : position} of the camera image; physical location unconfirmed`,
      locationBn: `ক্যামেরার ছবির ${position === 'left' ? 'বাম' : position === 'right' ? 'ডান' : 'মাঝের'} দিকে সম্ভাব্য দেখা; বাস্তব অবস্থান নিশ্চিত নয়`,
      source: candidate.kind === 'cloud' ? 'Camera observation (online, possible)' : 'Camera observation (detector, possible)',
      score: candidate.score, observedAt: candidate.meta.at, approved: true, preserveLocation: true });
    recorded.set(dedupe, now);
    Promise.resolve(saved).catch(() => {});
  }
  function candidate(value) {
    if (suppressed.has(value.item)) return;
    const dedupe = value.item + '|' + value.position;
    if (Date.now() - (recorded.get(dedupe) ?? -Infinity) < 300000) return;
    if (CORE.has(value.item)) save(value);
    else if (OTHER.has(value.item) && !pending && !offered) pending = value;
  }
  function overlap(a, b) {
    const x = Math.max(a[0], b[0]), y = Math.max(a[1], b[1]);
    const area = Math.max(0, Math.min(a[0] + a[2], b[0] + b[2]) - x) * Math.max(0, Math.min(a[1] + a[3], b[1] + b[3]) - y);
    return area / (a[2] * a[3] + b[2] * b[3] - area);
  }
  function observeLocal(frame, objects) {
    const meta = frames.get(frame);
    if (!current(meta) || meta.local || !Array.isArray(objects)) return;
    meta.local = true;
    for (const object of objects) {
      const item = canonical(object.detectorId || object.id), score = object.detectorScore ?? object.score, box = object.bbox;
      if ((!CORE.has(item) && !OTHER.has(item)) || item !== canonical(object.id) || !POSITIONS.has(object.pos) ||
          !Number.isFinite(score) || score < 0.8 || score > 1 || !Array.isArray(box) || box.length !== 4 || !box.every(Number.isFinite) ||
          box[0] < 0 || box[1] < 0 || box[2] <= 0 || box[3] <= 0 || box[0] + box[2] > frame.width || box[1] + box[3] > frame.height ||
          !['coco', 'coco-ssd', 'yolo26n'].includes(object.src)) continue;
      const previous = sightings.get(item), matching = previous && previous.sequence !== meta.sequence && meta.at - previous.at <= 5000 &&
        previous.position === object.pos && overlap(previous.box, box) >= 0.4;
      const firstAt = matching ? previous.firstAt : meta.at, count = matching ? previous.count + 1 : 1;
      sightings.set(item, { at: meta.at, firstAt, count, sequence: meta.sequence, position: object.pos, box: [...box] });
      if (count >= 3 && meta.at - firstAt >= 400) candidate({ item, position: object.pos, score, meta, kind: 'local' });
    }
  }
  function prompt(frame) { return current(frames.get(frame)) ? SCHEMA : ''; }
  function observeCloud(frame, observations) {
    const meta = frames.get(frame);
    if (!current(meta, 45000) || meta.cloud || !remoteProcessingAllowed() || !Array.isArray(observations)) return;
    meta.cloud = true;
    for (const entry of observations.slice(0, 3)) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry) || entry.visible !== true || entry.clarity !== 'clear') continue;
      const item = canonical(entry.item);
      if ((!CORE.has(item) && !OTHER.has(item)) || !POSITIONS.has(entry.position)) continue;
      candidate({ item, position: entry.position, score: null, meta, kind: 'cloud' });
    }
  }
  function tick() {
    render();
    if (!enabled()) { reset(); return; }
    if (offered && state.pendingYes === offered && Date.now() > offered.until) { state.pendingYes = null; offered = null; }
    if (offered && state.pendingYes !== offered) offered = null;
    if (!pending || !current(pending.meta, 45000)) { pending = null; return; }
    if (Date.now() < quietUntil || Date.now() - lastOffer < 60000 || state.pendingYes || state.busy || state.listening ||
        asthaSpeaking() || (typeof AsthaExperience !== 'undefined' && (AsthaExperience.busy || AsthaExperience.guiding || AsthaExperience.mode === 'reading' || !AsthaExperience.allows('medium')))) return;
    const next = pending; pending = null; lastOffer = Date.now();
    const names = labels(next.item);
    askYesNo(`I may have seen a ${names[0]}. Would you like me to remember this camera observation?`, `আমি সম্ভবত ${names[1]} দেখেছি। ক্যামেরার এই পর্যবেক্ষণ মনে রাখব?`,
      () => { offered = null; save(next); },
      () => { offered = null; if (!current(next.meta, 45000)) return; suppressed.add(next.item); announce('Okay. I have not saved it.', 'ঠিক আছে। এটি সংরক্ষণ করিনি।', 'memory'); });
    offered = state.pendingYes;
  }
  function forget(item) { const id = canonical(item); reset(); suppressed.add(id); }
  function clear() {
    const current = contextKey();
    if (current) { try { localStorage.removeItem(current); } catch {} }
    reset(); recorded.clear(); suppressed.clear(); render();
  }
  function stop() { reset(); quietUntil = Date.now() + 10000; }
  function boot() {
    if (booted) return;
    booted = true; render();
    $('auto-memory-enabled')?.addEventListener('change', event => setEnabled(Boolean(event.target.checked)));
    document.addEventListener('visibilitychange', () => { if (document.hidden) reset(); });
    window.addEventListener('pagehide', reset);
  }
  return { capture, observeLocal, prompt, observeCloud, route, enabled, selected, setEnabled, tick, reset, stop, forget, clear, render, boot,
    exportPreference: () => ({ enabled: selected() }) };
})();
