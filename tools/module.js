/* =====================================================================
   0. VoiceEngine — Astha's real voice
      Speaks through our backend's neural TTS (a genuine Bangla female voice,
      "bn-BD-NabanitaNeural", not a robotic default) when the phone is online and
      signed in. Falls back to the browser's own speechSynthesis automatically
      when offline, unauthenticated, or the server is unreachable, so reading
      never goes silent. All existing pause/resume/stop call sites are
      redefined below to drive whichever engine is actually speaking.
   ===================================================================== */
// Prefixes every /api/... call with window.ASTHA_API_BASE (config.js), so the frontend
// can be hosted separately from the backend -- e.g. a GitHub Pages shell talking to a
// server on Render. Same-origin deployments leave ASTHA_API_BASE empty and this is a
// no-op.
function apiUrl(path) { return (window.ASTHA_API_BASE || '') + path; }

const VoiceEngine = {
  mode: null,       // 'audio' | 'synth' | null
  audioEl: null,
  get speaking() {
    if (this.mode === 'audio') return !!this.audioEl && !this.audioEl.paused && !this.audioEl.ended;
    if (this.mode === 'synth') return !!(window.speechSynthesis && window.speechSynthesis.speaking);
    return false;
  },
  stop() {
    if (this.audioEl) { try { this.audioEl.pause(); if (this.audioEl.src) URL.revokeObjectURL(this.audioEl.src); this.audioEl.src = ''; } catch (e) {} this.audioEl = null; }
    if (window.speechSynthesis) window.speechSynthesis.cancel();
    this.mode = null;
  },
  pause() {
    if (this.mode === 'audio' && this.audioEl) this.audioEl.pause();
    else if (this.mode === 'synth' && window.speechSynthesis) window.speechSynthesis.pause();
  },
  resume() {
    if (this.mode === 'audio' && this.audioEl) this.audioEl.play().catch(() => {});
    else if (this.mode === 'synth' && window.speechSynthesis) window.speechSynthesis.resume();
  },
  // Resolves true once the text has finished playing, false if it could not be spoken at all
  // (voice off, nothing to say, and no fallback voice on this device).
  async speak(text, lang) {
    this.stop();
    if (!state.audio || !text) return false;
    const voiceKey = lang === 'bn' ? 'bn-female' : 'en-female';
    try {
      const res = await fetch(apiUrl('/api/speak?text=' + encodeURIComponent(text) + '&voice=' + voiceKey), { credentials: 'include' });
      if (res.ok) {
        const blob = await res.blob();
        const audio = new Audio(URL.createObjectURL(blob));
        const rate = Number($('speech-rate') && $('speech-rate').value) || 1;
        audio.playbackRate = rate;
        this.mode = 'audio'; this.audioEl = audio;
        const ok = await new Promise(resolve => {
          audio.onended = () => resolve(true);
          audio.onerror = () => resolve(false);
          audio.play().catch(() => resolve(false));
        });
        if (this.audioEl === audio) { this.mode = null; this.audioEl = null; }
        if (ok) return true;
        // fall through to the browser voice if playback itself failed
      }
    } catch (e) { /* offline, signed out, or the server is down: use the local voice instead */ }
    if (!window.speechSynthesis) return false;
    const u = makeUtterance(sanitizeForSpeech(text), lang);
    if (!u) return false;
    this.mode = 'synth';
    const ok = await new Promise(resolve => {
      u.onend = () => resolve(true);
      u.onerror = () => resolve(false);
      window.speechSynthesis.speak(u);
    });
    if (this.mode === 'synth') this.mode = null;
    return ok;
  },
};
function asthaSpeaking() { return VoiceEngine.speaking; }

function speak(enText, bnText) {
  lastResponse = { en: enText, bn: bnText };
  if (!state.audio) return;
  stopReader();
  const useBn = voiceLang === 'bn' && !!bnText;
  const text = useBn ? bnText : enText;
  if (text) VoiceEngine.speak(text, useBn ? 'bn' : 'en');
}
function startReader(inputText) {
  const text = typeof inputText === 'string' ? inputText.trim() : $('reader-text').value.trim();
  if (!text) return announce('Add text to the reader first.', 'আগে রিডারে লেখা যোগ করুন।');
  if (!state.audio) return announce('Turn voice on to hear this read aloud.', 'শোনার জন্য কণ্ঠস্বর চালু করুন।');
  stopAllSpeech();
  reader.parts = splitReading(text); reader.index = 0; reader.active = true;
  readNextChunk(reader.generation);
}
function readNextChunk(generation) {
  if (!reader.active || generation !== reader.generation) return;
  if (reader.index >= reader.parts.length) {
    reader.active = false; $('reader-progress').textContent = 'Finished';
    const done = reader.onFinish; reader.onFinish = null; if (done) done();
    return;
  }
  const text = reader.parts[reader.index];
  const lang = /[\u0980-\u09ff]/.test(text) ? 'bn' : 'en';
  $('reader-progress').textContent = 'Part ' + (reader.index + 1) + ' of ' + reader.parts.length;
  VoiceEngine.speak(text, lang).then(ok => {
    if (generation !== reader.generation || !reader.active) return;
    if (!ok) { stopReader(); $('reader-progress').textContent = 'Speech failed. Try Read all again.'; return; }
    reader.index++;
    if (!reader.paused) readNextChunk(generation);
  });
}
function pauseReader() {
  if (!reader.active || reader.paused) return;
  reader.paused = true; VoiceEngine.pause(); $('reader-progress').textContent = 'Paused';
}
function resumeReader() {
  if (!reader.active || !reader.paused) return;
  reader.paused = false; VoiceEngine.resume();
  if (reader.active) $('reader-progress').textContent = 'Reading';
}
function stopReader() {
  reader.active = false; reader.paused = false; reader.generation++; reader.parts = []; reader.index = 0;
  VoiceEngine.stop();
}
function stopAllSpeech() {
  stopReader(); stopListening(); VoiceEngine.stop();
  $('reader-progress').textContent = 'Stopped';
}



/* =====================================================================
   14. Companion upgrades
       - CLIP prompt sets for purpose-built questions
       - Identity refinement: toy vs real, ID card vs person, phone brand
       - Clothing: garment, colours and pattern
       - Mirror compliments
       - Guided, continuous reading with spoken alignment help
       - Astha's heart: on-screen attention cursor with click feedback
       - Hands-free wake-word mode ("Astha, …")
   ===================================================================== */

// Classes the small detector confuses most often need a higher score before Astha speaks about them.
const STRICT_COCO = new Set(['traffic light', 'dog', 'cat', 'bird', 'horse', 'cow', 'sheep', 'bear', 'teddy bear', 'kite', 'frisbee', 'toilet', 'fire hydrant', 'parking meter', 'stop sign', 'airplane', 'boat', 'train', 'elephant', 'zebra', 'giraffe']);
function themeAccent() { return getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#2dd4bf'; }
function withArticle(noun, pl) { return pl ? noun : article(noun) + ' ' + noun; }

// ---- Suppression: a CLIP guess that a box already explains stays quiet ----
const SUPPRESS = {
  monitor: ['laptop', 'tv'], tablet: ['laptop', 'cell phone'], bag: ['backpack', 'handbag', 'suitcase'],
  'wine glass': ['cup', 'bottle'], plant: ['potted plant'], food: ['bowl', 'plate', 'pizza', 'cake', 'sandwich'],
  paper: ['book', 'notebook'], notebook: ['book', 'laptop'], shelf: ['book'], photo: ['id card'],
};
function suppressedBy(o, batch) {
  if (o.src !== 'clip') return false;
  const list = SUPPRESS[o.id]; if (!list) return false;
  return list.some(id => batch.some(x => x.id === id && x.src === 'coco') || (state.world.get(id) || {}).src === 'coco');
}

// ---- Labels that respect refinement (brand, relabel) ----
function brandMeta(id) { return REFINE.phone.defs.find(d => d.id === id) || null; }
function objLabel(o) { if (o && o.brand && brandMeta(o.brand)) return brandMeta(o.brand).en + ' phone'; return label(o.id); }
function objLabelBn(o) { if (o && o.brand && brandMeta(o.brand)) return brandMeta(o.brand).bn + ' ফোন'; return labelBn(o.id); }
function objLabelWithArticle(o) { if (o && o.brand && brandMeta(o.brand)) { const n = objLabel(o); return article(n) + ' ' + n; } return labelWithArticle(o.id); }

// ---- CLIP prompt sets ----------------------------------------------------
const promptSets = {};
async function getPromptSet(name, defs) {
  if (promptSets[name]) return promptSets[name];
  if (engine.clip.status !== 'ready') return null;
  const texts = [], ids = [];
  defs.forEach(d => d.prompts.forEach(p => { texts.push(p); ids.push(d.id); }));
  const embeds = [];
  for (let i = 0; i < texts.length; i += 32) {
    const inputs = engine.clip.tokenizer(texts.slice(i, i + 32), { padding: true, truncation: true });
    const out = await engine.clip.textModel(inputs);
    out.text_embeds.tolist().forEach(r => embeds.push(normalize(r)));
  }
  return (promptSets[name] = { ids, embeds, meta: Object.fromEntries(defs.map(d => [d.id, d])) });
}
function rankAgainst(emb, set) {
  const best = {};
  for (let i = 0; i < set.embeds.length; i++) {
    let d = 0; const row = set.embeds[i];
    for (let k = 0; k < emb.length; k++) d += row[k] * emb[k];
    const id = set.ids[i];
    if (best[id] == null || d > best[id]) best[id] = d;
  }
  const ids = Object.keys(best), logits = ids.map(id => best[id] * 100), max = Math.max(...logits);
  let sum = 0; const ex = logits.map(l => { const e = Math.exp(l - max); sum += e; return e; });
  return ids.map((id, i) => ({ id, p: ex[i] / sum, meta: set.meta[id] })).sort((a, b) => b.p - a.p);
}
function centerRect(frame, frac = 0.55) {
  const s = Math.round(Math.min(frame.width, frame.height) * frac);
  return { x: Math.round((frame.width - s) / 2), y: Math.round((frame.height - s) / 2), s };
}
function squareAround(frame, x, y, w, h, pad = 1.15) {
  let s = Math.min(Math.max(w, h) * pad, Math.min(frame.width, frame.height));
  const cx = x + w / 2, cy = y + h / 2;
  return { x: Math.round(Math.min(Math.max(cx - s / 2, 0), frame.width - s)), y: Math.round(Math.min(Math.max(cy - s / 2, 0), frame.height - s)), s: Math.round(s) };
}
function bodyRect(frame, bbox) { const [x, y, w, h] = bbox; return squareAround(frame, x, y + h * 0.25, w, h * 0.75, 1.05); }
async function clipEmbedBox(frame, bbox) { const [emb] = await clipEmbedCrops(frame, [squareAround(frame, ...bbox)]); return emb; }
function cropToCanvas(frame, rect) {
  const c = document.createElement('canvas'); c.width = rect.s; c.height = rect.s;
  c.getContext('2d').drawImage(frame, rect.x, rect.y, rect.s, rect.s, 0, 0, rect.s, rect.s);
  return c;
}

// ---- Identity refinement ------------------------------------------------
const REFINE = {
  vehicle: { applies: ['car', 'truck', 'bus', 'motorcycle', 'bicycle', 'airplane', 'train', 'boat'], defs: [
    { id: 'toy', prompts: ['a toy car', 'a small die-cast model car held in a hand', 'a plastic toy vehicle', 'a miniature model car on a table'] },
    { id: 'real', prompts: ['a real car parked on a street', 'a full-size vehicle on a road', 'a real car photographed outdoors'] },
    { id: 'picture', prompts: ['a photo of a car on a phone screen', 'a picture of a car in a magazine', 'a car on a television screen'] } ] },
  person: { applies: ['person'], defs: [
    { id: 'idcard', prompts: ['an ID card with a small photo', 'a plastic identity card held in a hand', 'a passport-size photo on a card', 'a national ID card'] },
    { id: 'picture', prompts: ['a printed photograph of a person', 'a photo of a person on a phone screen', 'a poster with a face', 'a person on a television screen'] },
    { id: 'doll', prompts: ['a doll', 'a toy action figure', 'a mannequin in a shop', 'a toy ball with a smiley face', 'a soft toy with eyes', 'a cartoon character toy'] },
    { id: 'real', prompts: ['a real person standing in a room', 'a real human face looking at the camera', 'a person walking'] },
    { id: 'mirror', prompts: ['a person taking a selfie in a mirror', 'a reflection of someone holding a phone in a mirror'] } ] },
  animal: { applies: ['dog', 'cat', 'bird', 'horse', 'cow', 'bear', 'elephant', 'teddy bear', 'sheep'], defs: [
    { id: 'toy', prompts: ['a stuffed toy animal', 'a plush toy', 'a plastic toy animal'] },
    { id: 'real', prompts: ['a real animal', 'a live animal outdoors'] },
    { id: 'human', prompts: ['a human being', 'a person sitting or standing', 'a human face', 'a woman', 'a man', 'a child'] },
    { id: 'picture', prompts: ['a picture of an animal on a screen or poster'] } ] },
  phone: { applies: ['cell phone'], defs: [
    { id: 'iphone', en: 'iPhone', bn: 'আইফোন', prompts: ['an Apple iPhone', 'the back of an iPhone with an Apple logo'] },
    { id: 'samsung', en: 'Samsung', bn: 'স্যামসাং', prompts: ['a Samsung Galaxy phone', 'the back of a Samsung phone'] },
    { id: 'xiaomi', en: 'Xiaomi or Redmi', bn: 'শাওমি বা রেডমি', prompts: ['a Xiaomi phone', 'a Redmi phone'] },
    { id: 'realme', en: 'Realme', bn: 'রিয়েলমি', prompts: ['a Realme phone'] },
    { id: 'oppo', en: 'Oppo', bn: 'অপো', prompts: ['an Oppo phone'] },
    { id: 'vivo', en: 'Vivo', bn: 'ভিভো', prompts: ['a Vivo phone'] },
    { id: 'oneplus', en: 'OnePlus', bn: 'ওয়ানপ্লাস', prompts: ['a OnePlus phone'] },
    { id: 'pixel', en: 'Google Pixel', bn: 'গুগল পিক্সেল', prompts: ['a Google Pixel phone'] },
    { id: 'nokia', en: 'Nokia', bn: 'নোকিয়া', prompts: ['a Nokia phone', 'an old Nokia feature phone with buttons'] },
    { id: 'huawei', en: 'Huawei', bn: 'হুয়াওয়ে', prompts: ['a Huawei phone'] },
    { id: 'tecno', en: 'Tecno or Infinix', bn: 'টেকনো বা ইনফিনিক্স', prompts: ['a Tecno phone', 'an Infinix phone'] },
    { id: 'walton', en: 'Walton', bn: 'ওয়ালটন', prompts: ['a Walton phone'] },
    { id: 'generic', prompts: ['a smartphone', 'a black rectangular smartphone'] } ] },
};
const BRAND_WORDS = { iphone: /iphone|apple/i, samsung: /samsung|galaxy/i, xiaomi: /xiaomi|redmi|poco|\bmi\b/i, realme: /realme/i, oppo: /oppo/i, vivo: /vivo/i, oneplus: /oneplus|one plus/i, pixel: /pixel/i, nokia: /nokia/i, huawei: /huawei|honor/i, tecno: /tecno|infinix|itel/i, walton: /walton/i };

// Returns { kind: 'real'|'toy'|'idcard'|'picture'|'doll'|'mirror'|'brand'|null, newId?, brand?, p }
async function refineDetection(frame, obj, ocrText) {
  const group = Object.keys(REFINE).find(k => REFINE[k].applies.includes(obj.id));
  if (!group || engine.clip.status !== 'ready' || !obj.bbox) return null;
  const set = await getPromptSet('refine_' + group, REFINE[group].defs);
  if (!set) return null;
  const emb = await clipEmbedBox(frame, obj.bbox);
  const ranked = rankAgainst(emb, set);
  const area = (obj.bbox[2] * obj.bbox[3]) / (frame.width * frame.height);
  const p = id => (ranked.find(r => r.id === id) || {}).p || 0;
  if (group === 'phone') {
    let brand = null;
    for (const b in BRAND_WORDS) if (ocrText && BRAND_WORDS[b].test(ocrText)) brand = b;
    const top = ranked[0];
    if (!brand && top && top.id !== 'generic' && top.p >= 0.35) brand = top.id;
    return brand ? { kind: 'brand', brand, p: top && top.id === brand ? top.p : 0.9 } : { kind: null, p: top ? top.p : 0 };
  }
  // Only relabel on strong evidence. The default answer is always "real".
  const toyP = p('toy'), realP = p('real'), picP = p('picture');
  const now = Date.now();
  if (group === 'vehicle' || group === 'animal') {
    if (obj.id === 'teddy bear') return { kind: 'toy', newId: 'toy animal', p: 0.9 };
    // The detector sometimes calls a person an animal; a human crop is always a person.
    if (group === 'animal' && p('human') >= 0.45 && p('human') > realP) return { kind: 'real', newId: 'person', p: p('human') };
    // Street context (road, several vehicles, a person walking) means a small box is just a distant vehicle.
    const street = [...state.world.values()].some(o => ['road', 'rickshaw', 'auto rickshaw', 'footpath', 'pole', 'traffic light'].includes(o.id))
      || state.lastCocoPreds.filter(o => REFINE.vehicle.applies.includes(o.id)).length >= 2;
    if (!street && (toyP >= 0.6 || (toyP >= 0.5 && area < 0.12 && toyP > realP * 2))) {
      const newId = group === 'vehicle' ? (obj.id === 'car' ? 'toy car' : 'toy vehicle') : 'toy animal';
      return { kind: 'toy', newId, p: toyP };
    }
    if (picP >= 0.75 && realP < 0.15 && area < 0.4) return { kind: 'picture', newId: 'photo', p: picP };
    return { kind: 'real', p: realP };
  }
  if (group === 'person') {
    // A person who moved across the frame in the last few seconds is real, whatever the crop looks like.
    if (now - (state.personMovingAt || 0) < 4000 && area > 0.08) return { kind: 'real', p: 1 };
    let idP = p('idcard'); if (ocrText && ocrText.replace(/\W/g, '').length >= 8) idP += 0.2;
    if (area < 0.3 && (idP >= 0.5 || (idP >= 0.4 && ocrText))) return { kind: 'idcard', newId: 'id card', p: Math.min(1, idP) };
    // A mirror is only claimed when a phone is visible in the reflection and the score is high.
    if (p('mirror') >= 0.6 && state.lastCocoPreds.some(o => o.id === 'cell phone')) return { kind: 'mirror', p: p('mirror') };
    if (picP >= 0.7 && area < 0.3 && realP < 0.15) return { kind: 'picture', newId: 'photo', p: picP };
    if (p('doll') >= 0.65 && realP < 0.15) return { kind: 'doll', newId: 'doll', p: p('doll') };
    return { kind: 'real', p: realP };
  }
  return null;
}
// Track whether the biggest person box is moving; motion is the cheapest proof of a live person.
function trackPersonMotion(objs, frame) {
  const person = objs.filter(o => o.id === 'person' || o.origId === 'person').sort((a, b) => (b.bbox[2] * b.bbox[3]) - (a.bbox[2] * a.bbox[3]))[0];
  const now = Date.now();
  if (!person) { state.personTrack = null; return; }
  const cx = (person.bbox[0] + person.bbox[2] / 2) / frame.width, cy = (person.bbox[1] + person.bbox[3] / 2) / frame.height, w = person.bbox[2] / frame.width;
  const prev = state.personTrack;
  if (prev && now - prev.t < 2500) {
    const moved = Math.hypot(cx - prev.cx, cy - prev.cy) > 0.06 || Math.abs(w - prev.w) > 0.06;
    if (moved) { state.personMovingAt = now; if (state.relabel.person) delete state.relabel.person; }
  }
  state.personTrack = { cx, cy, w, t: now };
}

// Applies refinement to the world map and remembers the relabel for a few seconds,
// so the live loop does not immediately flip an "ID card" back into a "person".
async function refineWorld(frame, cocoObjs, ocrText, max = 2) {
  const candidates = (cocoObjs || []).filter(o => Object.values(REFINE).some(g => g.applies.includes(o.id))).sort((a, b) => b.score - a.score).slice(0, max);
  const notes = [];
  for (const o of candidates) {
    let r = null;
    try { r = await refineDetection(frame, o, ocrText); } catch (e) { console.warn('refine', e); }
    if (!r) continue;
    const now = Date.now();
    const entry = state.world.get(o.id);
    if (r.newId && r.newId !== o.id) {
      state.relabel[o.id] = { newId: r.newId, kind: r.kind, until: now + 8000 };
      if (entry) state.world.delete(o.id);
      state.world.set(r.newId, Object.assign({}, entry || o, { id: r.newId, origId: o.id, note: r.kind, first: (entry && entry.first) || now, last: now }));
      o.origId = o.id; o.id = r.newId; o.note = r.kind;
    } else {
      if (r.brand) state.relabel[o.id] = { newId: o.id, kind: 'brand', brand: r.brand, until: now + 15000 };
      if (entry) { entry.note = r.kind; if (r.brand) entry.brand = r.brand; }
      o.note = r.kind; if (r.brand) o.brand = r.brand;
    }
    if (r.kind === 'mirror') state.mirrorSeenAt = now;
    notes.push({ obj: o, r });
  }
  if (notes.length) renderSeen();
  return notes;
}
function applyRelabel(o, now) {
  const rl = state.relabel && state.relabel[o.id];
  if (!rl || now > rl.until) return;
  if (rl.newId !== o.id) { o.origId = o.id; o.id = rl.newId; }
  o.note = rl.kind; if (rl.brand) o.brand = rl.brand;
}
const liveRefineCache = new Map();
const refineVotes = new Map();
// Live mode relabels only after two consecutive agreeing checks (hysteresis), so a single odd frame
// cannot turn a person into a picture or a passing car into a toy.
async function liveRefineAndMirror(frame) {
  if (state.busy || !state.liveLoop) return;
  const now = Date.now();
  const cand = state.lastCocoPreds.filter(o => Object.values(REFINE).some(g => g.applies.includes(o.id)) && now - (liveRefineCache.get(o.id) || 0) > 4000).sort((a, b) => b.score - a.score)[0];
  if (cand) {
    liveRefineCache.set(cand.id, now);
    let r = null;
    try { r = await refineDetection(frame, cand, ''); } catch (e) { console.warn('live refine', e); }
    if (r) {
      const v = refineVotes.get(cand.id);
      const agree = v && v.kind === r.kind && now - v.t < 12000;
      refineVotes.set(cand.id, { kind: r.kind, t: now });
      if (r.kind === 'mirror') state.mirrorSeenAt = now;
      else if (r.kind !== 'real' && agree) await refineWorld(frame, [cand], '', 1);
    }
  }
  if (now - (state.mirrorSeenAt || 0) < 3000 && now - (state.lastComplimentAt || 0) > 60000 && !state.busy && !reading.active) {
    state.busy = true; try { await mirrorCheck(frame, true); } finally { state.busy = false; }
  }
}

// ---- Voice choice ---------------------------------------------------------
// Prefer the natural-sounding (usually female) voices; remember the user's own pick per language.
function pickVoice(matches, language) {
  if (!matches.length) return null;
  let savedName = null; try { savedName = localStorage.getItem('astha.voice.' + language); } catch (e) {}
  const saved = savedName && matches.find(v => v.name === savedName);
  if (saved) return saved;
  const score = v => (/google|natural|neural|online/i.test(v.name) ? 4 : 0) + (/female|zira|aria|jenny|samantha|sonia|heera|tanvi|swara|ananya/i.test(v.name) ? 3 : 0)
    + (/en-us|bn-bd/i.test(v.lang) ? 1 : 0) - (/david|mark|guy|male/i.test(v.name) ? 2 : 0);
  return matches.slice().sort((a, b) => score(b) - score(a))[0];
}
function populateVoices() {
  const sel = $('voice-select'); if (!sel) return;
  refreshVoices();
  let language = voiceLang;
  let matches = voices.filter(v => v.lang.toLowerCase().startsWith(language));
  let note = '';
  if (!matches.length && language === 'bn') { language = 'en'; matches = voices.filter(v => v.lang.toLowerCase().startsWith('en')); note = ' (no Bangla voice installed; English voice used)'; }
  const chosen = pickVoice(matches, language);
  sel.innerHTML = matches.length ? matches.map(v => `<option value="${esc(v.name)}"${chosen && v.name === chosen.name ? ' selected' : ''}>${esc(v.name)}${v.localService ? '' : ' (online)'}${note}</option>`).join('') : '<option value="">No voice on this device</option>';
  sel.dataset.language = language;
}
function onVoiceChosen(name) {
  const language = ($('voice-select') && $('voice-select').dataset.language) || voiceLang;
  try { localStorage.setItem('astha.voice.' + language, name); } catch (e) {}
  playEarcon('click');
  speak('This is my voice.', 'এটি আমার কণ্ঠস্বর।');
}

// ---- Clothing -----------------------------------------------------------
const GARMENTS = [
  { id: 'shirt', en: 'shirt', bn: 'শার্ট', prompts: ['a collared button-up shirt', 'a formal shirt'] },
  { id: 'tshirt', en: 't-shirt', bn: 'টি-শার্ট', prompts: ['a round-neck t-shirt', 'a polo shirt'] },
  { id: 'dress', en: 'dress', bn: 'ড্রেস', prompts: ["a woman's dress", 'a long frock', 'a gown'] },
  { id: 'saree', en: 'saree', bn: 'শাড়ি', prompts: ['a saree', 'a sari with a border', 'a folded saree'] },
  { id: 'kameez', en: 'salwar kameez', bn: 'সালোয়ার কামিজ', prompts: ['a salwar kameez', 'a kurti', 'a three-piece dress'] },
  { id: 'panjabi', en: 'panjabi', bn: 'পাঞ্জাবি', prompts: ['a panjabi', 'a kurta for men'] },
  { id: 'lungi', en: 'lungi', bn: 'লুঙ্গি', prompts: ['a lungi', 'a checked sarong'] },
  { id: 'trousers', en: 'pair of trousers', bn: 'প্যান্ট', prompts: ['a pair of trousers', 'a pair of jeans', 'formal pants'] },
  { id: 'shorts', en: 'pair of shorts', bn: 'হাফপ্যান্ট', prompts: ['a pair of shorts'] },
  { id: 'jacket', en: 'jacket', bn: 'জ্যাকেট', prompts: ['a jacket', 'a hoodie', 'a blazer'] },
  { id: 'sweater', en: 'sweater', bn: 'সোয়েটার', prompts: ['a knitted sweater', 'a cardigan'] },
  { id: 'scarf', en: 'scarf', bn: 'ওড়না', prompts: ['a scarf', 'an orna dupatta', 'a shawl'] },
  { id: 'hijab', en: 'hijab', bn: 'হিজাব', prompts: ['a hijab head scarf'] },
  { id: 'skirt', en: 'skirt', bn: 'স্কার্ট', prompts: ['a skirt'] },
  { id: 'socks', en: 'pair of socks', bn: 'মোজা', prompts: ['a pair of socks'] },
  { id: 'towel', en: 'towel', bn: 'তোয়ালে', prompts: ['a towel', 'a gamcha'] },
  { id: 'none', prompts: ['an object that is not clothing', 'a room with furniture', 'a plain wall', 'a hand holding a gadget', 'a laptop on a desk'] },
];
const MATERIALS = [
  { id: 'cotton', en: 'cotton', bn: 'সুতি', prompts: ['cotton fabric', 'a soft cotton garment'] },
  { id: 'silk', en: 'silk', bn: 'সিল্ক', prompts: ['shiny silk fabric', 'a silk saree'] },
  { id: 'denim', en: 'denim', bn: 'ডেনিম', prompts: ['denim jeans fabric'] },
  { id: 'wool', en: 'wool', bn: 'উল', prompts: ['knitted wool fabric'] },
  { id: 'leather', en: 'leather', bn: 'চামড়া', prompts: ['leather material'] },
  { id: 'synthetic', en: 'synthetic', bn: 'সিনথেটিক', prompts: ['shiny polyester fabric', 'nylon sportswear fabric'] },
  { id: 'lace', en: 'lace', bn: 'লেস', prompts: ['lace fabric with holes', 'embroidered net fabric'] },
  { id: 'unknown', prompts: ['an object that is not fabric', 'a plain wall'] },
];
const PATTERNS = [
  { id: 'striped', prompts: ['striped fabric', 'a garment with horizontal stripes', 'a garment with vertical stripes'] },
  { id: 'checked', prompts: ['checked plaid fabric', 'a gingham check pattern', 'a tartan pattern'] },
  { id: 'floral', prompts: ['floral printed fabric', 'fabric with flower patterns'] },
  { id: 'dotted', prompts: ['polka dot fabric'] },
  { id: 'printed', prompts: ['fabric with a printed graphic or logo', 'a t-shirt with text printed on it'] },
  { id: 'plain', prompts: ['plain solid color fabric with no pattern', 'a plain garment'] },
];
function colorName(c) { return c.name.split(' / ')[0].toLowerCase(); }
function colorNameBn(c) { return c.bn.split(' বা ')[0]; }
async function analyzeClothing(frame, rect) {
  rect = rect || centerRect(frame, 0.6);
  const colors = extractDominantColor(cropToCanvas(frame, rect));
  let garment = null, pattern = null;
  if (engine.clip.status === 'ready') {
    const [emb] = await clipEmbedCrops(frame, [rect]);
    garment = rankAgainst(emb, await getPromptSet('garments', GARMENTS))[0];
    pattern = rankAgainst(emb, await getPromptSet('patterns', PATTERNS))[0];
    var material = rankAgainst(emb, await getPromptSet('materials', MATERIALS))[0];
  }
  return { colors, garment, pattern, material, rect };
}
// ctx: 'holding' | 'wearing' | 'person'
function clothingSentence(info, ctx) {
  const c1 = info.colors.top, c2 = info.colors.second;
  const g = info.garment, pt = info.pattern;
  const cEn = colorName(c1), cBn = colorNameBn(c1);
  const isGarment = !!g && g.id !== 'none' && g.p >= 0.18;
  if (!isGarment) return { isGarment: false, en: `I do not think this is clothing. It is mostly ${cEn}.`, bn: `এটি পোশাক বলে মনে হচ্ছে না। এর রঙ মূলত ${cBn}।` };
  const gm = g.meta;
  const hasC2 = !!c2 && c2.pct >= 12 && colorName(c2) !== cEn;
  // English: pattern goes after the noun. Bangla: adjective-like patterns go before the colour,
  // and a second colour is added as a clause after the verb.
  let patEn = '', patBnPre = '', patBnPost = '', plainEn = '';
  if (pt && pt.p >= 0.3) {
    if (pt.id === 'striped') { patEn = hasC2 ? ` with ${colorName(c2)} stripes` : ' with stripes'; patBnPre = 'ডোরাকাটা'; if (hasC2) patBnPost = `, তাতে ${colorNameBn(c2)} ডোরা আছে`; }
    else if (pt.id === 'checked') { patEn = hasC2 ? ` with a ${cEn} and ${colorName(c2)} check pattern` : ' with a check pattern'; patBnPre = 'চেক নকশার'; if (hasC2) patBnPost = `, তাতে ${colorNameBn(c2)} চেকও আছে`; }
    else if (pt.id === 'floral') { patEn = ' with a floral print'; patBnPre = 'ফুলের ছাপ দেওয়া'; }
    else if (pt.id === 'dotted') { patEn = ' with polka dots'; patBnPre = 'ফোঁটা ফোঁটা নকশার'; }
    else if (pt.id === 'printed') { patEn = ' with a printed design'; patBnPre = 'ছাপা নকশার'; }
    else if (pt.id === 'plain') { plainEn = 'plain '; patBnPre = 'একরঙা'; }
  }
  const lead = { holding: ['You are holding', 'আপনি', 'ধরে আছেন'], wearing: ['You are wearing', 'আপনি', 'পরে আছেন'], person: ['The person in front of you is wearing', 'সামনের মানুষটি', 'পরে আছেন'] }[ctx] || ['This is', 'এটি', ''];
  const mat = info.material && info.material.id !== 'unknown' && info.material.p >= 0.35 ? info.material.meta : null;
  const nounEn = `${plainEn}${cEn} ${mat ? mat.en + ' ' : ''}${gm.en}`;
  const en = `${lead[0]} ${withArticle(nounEn, gm.id === 'socks')}${patEn}.`;
  const bn = `${lead[1]} একটি ${patBnPre} ${cBn} ${mat ? mat.bn + ' ' : ''}${gm.bn} ${lead[2]}`.replace(/\s+/g, ' ').trim() + patBnPost + '।';
  return { isGarment: true, en, bn, garment: gm, color: c1 };
}

// ---- Mirror compliments -------------------------------------------------
const MIRROR_SET = [
  { id: 'mirror', prompts: ['a person taking a selfie in a mirror', 'a reflection of someone holding a phone in a bathroom mirror', 'a mirror selfie'] },
  { id: 'other', prompts: ['a room with furniture', 'an object on a table', 'a person photographed directly by someone else', 'a plain wall'] },
];
const COMPLIMENTS = [
  ['You look beautiful today!', 'আজ আপনাকে খুব সুন্দর লাগছে!'],
  ['You are looking great!', 'আপনাকে দারুণ লাগছে!'],
  ['Looking lovely, as always.', 'বরাবরের মতোই চমৎকার লাগছে।'],
  ['You look wonderful. Ready to go!', 'আপনাকে অসাধারণ লাগছে। বেরোনোর জন্য তৈরি!'],
];
async function mirrorCheck(frame, onlyIfMirror) {
  // With the cloud available, only Gemini may declare a mirror; on-device needs a phone in view and a high score.
  let isMirror = false;
  if (cloudReady()) {
    try { const r = await gemini(CLOUD_PROMPTS.mirror, frame, { maxTokens: 200 }); isMirror = r.mirror === true; if (isMirror) { await cloudCompliment(frame, r); return true; } } catch (e) { cloudFail(e); }
    if (onlyIfMirror) return false;
  } else {
    const phone = state.lastCocoPreds.some(o => o.id === 'cell phone');
    isMirror = phone && Date.now() - (state.mirrorSeenAt || 0) < 5000;
    if (!isMirror && phone && engine.clip.status === 'ready') {
      const [emb] = await clipEmbedCrops(frame, [centerRect(frame, 0.95)]);
      const r = rankAgainst(emb, await getPromptSet('mirror', MIRROR_SET));
      isMirror = r[0].id === 'mirror' && r[0].p >= 0.6;
    }
  }
  if (!isMirror && onlyIfMirror) return false;
  const person = [...state.world.values()].find(o => o.id === 'person' && o.bbox);
  const rect = person ? bodyRect(frame, person.bbox) : centerRect(frame, 0.6);
  const info = await analyzeClothing(frame, rect);
  const cl = clothingSentence(info, 'wearing');
  state.complimentIdx = ((state.complimentIdx || 0) + 1) % COMPLIMENTS.length;
  const c = COMPLIMENTS[state.complimentIdx];
  let en = isMirror ? `I can see you in the mirror. ${c[0]}` : c[0];
  let bn = isMirror ? `আয়নায় আপনাকে দেখতে পাচ্ছি। ${c[1]}` : c[1];
  if (cl.isGarment) { en += ` That ${colorName(info.colors.top)} ${cl.garment.en} really suits you.`; bn += ` ${colorNameBn(info.colors.top)} ${cl.garment.bn}টা আপনাকে দারুণ মানিয়েছে।`; }
  state.lastComplimentAt = Date.now();
  announce(en, bn, 'vision'); playEarcon('confirm');
  heartFlash({ x: 0.5, y: 0.45, mode: 'lock', label: '♥' }, 5000);
  logEvent('Mirror: complimented');
  return true;
}

// ---- Astha's heart --------------------------------------------------------
const heart = { period: 0, tickTimer: null, hideTimer: null };
function heartSet(o) {
  const el = $('heart'); if (!el) return;
  el.hidden = false;
  if (o.x != null) el.style.left = (Math.min(Math.max(o.x, 0.06), 0.94) * 100) + '%';
  if (o.y != null) el.style.top = (Math.min(Math.max(o.y, 0.1), 0.86) * 100) + '%';
  if (o.mode) el.className = 'heart ' + o.mode;
  const lab = $('heart-label'); lab.textContent = o.label || ''; lab.hidden = !o.label;
  clearTimeout(heart.hideTimer);
}
function heartFlash(o, ms = 4000) { heartSet(o); heart.hideTimer = setTimeout(() => { if (!reading.active) heartHide(); }, ms); }
function heartHide() { const el = $('heart'); if (el) el.hidden = true; heartTicks(0); }
function heartTicks(period) {
  if (heart.period === period) return;
  heart.period = period; clearTimeout(heart.tickTimer); heart.tickTimer = null;
  if (!period) return;
  const tick = () => { if (heart.period !== period) return; playEarcon('tick'); heart.tickTimer = setTimeout(tick, period); };
  tick();
}
function heartPointAt(o) {
  if (!o) return;
  const c = $('overlay');
  if (o.bbox && c.width) heartFlash({ x: (o.bbox[0] + o.bbox[2] / 2) / c.width, y: (o.bbox[1] + o.bbox[3] / 2) / c.height, mode: 'lock', label: objLabel(o) });
  else if (o.zone && c.width) heartFlash({ x: (o.zone.x + o.zone.s / 2) / c.width, y: (o.zone.y + o.zone.s / 2) / c.height, mode: 'lock', label: objLabel(o) });
  else heartFlash({ x: 0.5, y: 0.5, mode: 'lock', label: objLabel(o) });
}

// ---- Guided, continuous reading -----------------------------------------
const GUIDE = {
  start: ['Reading mode. Show me the page and I will tell you how to hold it.', 'পড়ার মোড। পৃষ্ঠাটি দেখান, আমি বলে দেব কীভাবে ধরবেন।'],
  show_page: ['I cannot see any text yet. Hold the page in front of the camera.', 'এখনো কোনো লেখা দেখছি না। পৃষ্ঠাটি ক্যামেরার সামনে ধরুন।'],
  move_left: ['A bit to the left.', 'একটু বাঁয়ে।'], move_right: ['A bit to the right.', 'একটু ডানে।'],
  move_up: ['A bit higher.', 'একটু উপরে।'], move_down: ['A bit lower.', 'একটু নিচে।'],
  closer: ['Bring it a little closer.', 'আরেকটু কাছে আনুন।'],
  hold: ['Good. Hold still, I am reading.', 'ভালো। স্থির রাখুন, পড়ছি।'],
  no_text: ['I do not find readable text here. Try more light, or move a little closer.', 'এখানে পড়ার মতো লেখা পাচ্ছি না। আরও আলো দিন বা একটু কাছে আনুন।'],
  same_page: ['I have already read this page. Turn the page or move down.', 'এই পৃষ্ঠা আগেই পড়েছি। পাতা উল্টান বা নিচে নামুন।'],
  page_done: ['That is all I can see here. Turn the page or move down and I will continue.', 'এখানে যা ছিল পড়া শেষ। পাতা উল্টান বা নিচে নামুন, আমি আবার পড়ব।'],
  new_page: ['New page. Let me line it up.', 'নতুন পৃষ্ঠা। ঠিক করে ধরুন।'],
  stopped: ['Reading stopped.', 'পড়া বন্ধ।'],
};
const reading = { active: false, phase: 'idle', timer: null, lastGuideKey: '', lastGuideAt: 0, goodStreak: 0, readLines: new Set(), lockedGray: null, prevGray: null, ocrBusy: false };

function readText() {
  // No camera yet? Start it and go straight into reading mode; the user never has to type or paste anything.
  if (!state.source) {
    state.pendingRead = true;
    announce('Starting the camera. Hold the page in front of the phone.', 'ক্যামেরা চালু করছি। পৃষ্ঠাটি ফোনের সামনে ধরুন।', 'ocr');
    toggleCamera();
    return;
  }
  if (state.source !== 'camera') return readStillOnce();
  if (reading.active) return stopReading();
  startReading();
}
async function startReading() {
  reading.active = true; reading.phase = 'align'; reading.goodStreak = 0; reading.readLines.clear();
  reading.lockedGray = null; reading.prevGray = null; reading.lastGuideKey = ''; reading.lastGuideAt = 0;
  stopLiveLoop(); setReadButton(true);
  heartSet({ x: 0.5, y: 0.5, mode: 'seek', label: 'Show me the page' });
  playEarcon('confirm');
  announce(GUIDE.start[0], GUIDE.start[1], 'ocr');
  logEvent('Reading mode started');
  try { await ensureOcr(); } catch (e) { announce(t('ocr_failed'), tBn('ocr_failed'), 'ocr'); return stopReading(true); }
  if (!reading.active) return;
  reading.timer = setTimeout(readingTick, 1500);
}
function stopReading(silent) {
  if (!reading.active) return;
  reading.active = false; reading.phase = 'idle'; clearTimeout(reading.timer); reading.timer = null;
  heartHide(); setReadButton(false); reader.onFinish = null; stopAllSpeech();
  if (!silent) announce(GUIDE.stopped[0], GUIDE.stopped[1], 'ocr');
  if (state.source === 'camera') startLiveLoop();
}
function setReadButton(on) {
  const b = $('read-btn'); if (!b) return;
  b.classList.toggle('on', on); b.setAttribute('aria-pressed', on);
  $('read-title').textContent = on ? 'Stop reading' : t('act_read');
}
function grayThumb(frame) {
  const W = 32, H = 24; const c = grayThumb.c || (grayThumb.c = document.createElement('canvas')); c.width = W; c.height = H;
  const ctx = c.getContext('2d', { willReadFrequently: true }); ctx.drawImage(frame, 0, 0, W, H);
  const d = ctx.getImageData(0, 0, W, H).data; const g = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) g[i] = (d[i * 4] + d[i * 4 + 1] + d[i * 4 + 2]) / 3;
  return g;
}
function grayDiff(a, b) { if (!a || !b) return 999; let s = 0; for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]); return s / a.length; }

// Cheap text-region finder: text is dense in vertical strokes (strong horizontal gradients).
function findTextRegion(frame) {
  const W = 128, H = 96, cols = 16, rows = 12;
  const c = findTextRegion.c || (findTextRegion.c = document.createElement('canvas')); c.width = W; c.height = H;
  const ctx = c.getContext('2d', { willReadFrequently: true }); ctx.drawImage(frame, 0, 0, W, H);
  const d = ctx.getImageData(0, 0, W, H).data; const g = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) g[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
  const cellW = W / cols, cellH = H / rows, n = cols * rows, counts = new Float32Array(n);
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
    const i = y * W + x, gx = Math.abs(g[i + 1] - g[i - 1]), gy = Math.abs(g[i + W] - g[i - W]);
    if (gx > 40 && gx > gy * 1.2) counts[Math.floor(y / cellH) * cols + Math.floor(x / cellW)]++;
  }
  let mean = 0; for (let i = 0; i < n; i++) { counts[i] /= cellW * cellH; mean += counts[i]; } mean /= n;
  let vr = 0; for (let i = 0; i < n; i++) vr += (counts[i] - mean) ** 2; const sd = Math.sqrt(vr / n);
  const thr = Math.max(0.05, mean + 0.5 * sd);
  const act = new Uint8Array(n); for (let i = 0; i < n; i++) act[i] = counts[i] >= thr ? 1 : 0;
  let kept = 0, minX = cols, maxX = -1, minY = rows, maxY = -1, density = 0;
  for (let r = 0; r < rows; r++) for (let q = 0; q < cols; q++) {
    const i = r * cols + q; if (!act[i]) continue;
    const nb = (q > 0 && act[i - 1] ? 1 : 0) + (q < cols - 1 && act[i + 1] ? 1 : 0) + (r > 0 && act[i - cols] ? 1 : 0) + (r < rows - 1 && act[i + cols] ? 1 : 0);
    if (nb >= 1) { kept++; density += counts[i]; if (q < minX) minX = q; if (q > maxX) maxX = q; if (r < minY) minY = r; if (r > maxY) maxY = r; }
  }
  if (kept < 4) return { found: false };
  return { found: true, cx: (minX + maxX + 1) / 2 / cols, cy: (minY + maxY + 1) / 2 / rows, w: (maxX - minX + 1) / cols, h: (maxY - minY + 1) / rows, cells: kept, density: density / kept };
}
function guidanceFor(r) {
  if (!r.found) return { ok: false, key: 'show_page', label: 'Show me the page' };
  if (r.cx < 0.36) return { ok: false, key: 'move_left', label: '← a bit left' };
  if (r.cx > 0.64) return { ok: false, key: 'move_right', label: 'a bit right →' };
  if (r.cy < 0.32) return { ok: false, key: 'move_up', label: '↑ a bit higher' };
  if (r.cy > 0.68) return { ok: false, key: 'move_down', label: '↓ a bit lower' };
  if (r.w < 0.35 || r.h < 0.25) return { ok: false, key: 'closer', label: 'Closer' };
  return { ok: true, key: 'hold', label: 'Hold still' };
}
function tickPeriod(r) {
  if (!r.found) return 1200;
  const err = Math.abs(r.cx - 0.5) + Math.abs(r.cy - 0.5) + (r.w < 0.35 ? 0.3 : 0);
  return Math.round(220 + Math.min(900, err * 2200));
}
function sayGuide(key, force) {
  const now = Date.now();
  if (!force) {
    if (window.speechSynthesis && window.speechSynthesis.speaking) return;
    if (key === reading.lastGuideKey && now - reading.lastGuideAt < 4000) return;
    if (now - reading.lastGuideAt < 1800) return;
  }
  reading.lastGuideKey = key; reading.lastGuideAt = now;
  const [en, bn] = GUIDE[key];
  setCaption('Reading mode', en, 'ocr', key === 'hold' ? null : 'busy', bn);
  speak(en, bn);
}
async function readingTick() {
  if (!reading.active) return;
  let next = 700;
  try {
    const frame = captureFrame(480);
    if (frame && !reading.ocrBusy) {
      const region = findTextRegion(frame);
      const gray = grayThumb(frame);
      if (reading.phase === 'align') {
        const g = guidanceFor(region);
        heartSet({ x: region.found ? region.cx : 0.5, y: region.found ? region.cy : 0.5, mode: g.ok ? 'lock' : (region.found ? 'seek' : 'bad'), label: g.label });
        heartTicks(g.ok ? 0 : tickPeriod(region));
        reading.goodStreak = g.ok ? reading.goodStreak + 1 : 0;
        if (g.ok && reading.goodStreak >= 2 && !(window.speechSynthesis && window.speechSynthesis.speaking)) {
          reading.phase = 'read'; reading.lockedGray = gray; heartTicks(0); playEarcon('confirm');
          sayGuide('hold', true);
          await ocrPage();
          next = 1200;
        } else if (!g.ok) sayGuide(g.key);
      } else {
        const dLocked = grayDiff(gray, reading.lockedGray), dPrev = grayDiff(gray, reading.prevGray);
        if (!reader.active && dLocked > 26 && dPrev < 10) {
          reading.phase = 'align'; reading.goodStreak = 0;
          heartSet({ mode: 'seek', label: 'New page' }); sayGuide('new_page', true);
        }
        next = 1000;
      }
      reading.prevGray = gray;
    }
  } catch (e) { console.warn('reading tick', e); }
  if (reading.active) reading.timer = setTimeout(readingTick, next);
}
function normLine(l) { return l.toLowerCase().replace(/[^\p{L}\p{N}]/gu, ''); }
async function ocrPage() {
  reading.ocrBusy = true;
  try {
    const worker = await ensureOcr();
    const frame = captureFrame(1024); // ~3 s per page on a laptop CPU with Bangla + English
    let lines = null, explain = null;
    if (cloudReady()) { try { const r = await cloudReadLines(frame); lines = r.lines; explain = r; } catch (e) { cloudFail(e); } }
    if (!lines) {
      const { data } = await worker.recognize(frame);
      lines = (data.lines || []).filter(l => l.confidence >= 55).map(l => cleanOcrLine(l.text))
        .filter(l => { const letters = l.replace(/[^\p{L}\p{N}]/gu, '').length; return letters >= 2 && letters / l.length >= 0.5; });
    }
    if (!reading.active) return;
    reading.explain = explain;
    if (!lines.length) { reading.phase = 'align'; reading.goodStreak = 0; heartSet({ mode: 'bad', label: 'No text found' }); sayGuide('no_text', true); return; }
    const fresh = lines.filter(l => !reading.readLines.has(normLine(l)));
    if (!fresh.length) { reading.phase = 'done'; heartSet({ mode: 'seek', label: 'Turn the page' }); sayGuide('same_page', true); return; }
    fresh.forEach(l => reading.readLines.add(normLine(l)));
    const text = fresh.join('\n');
    $('ocr-text').textContent = text; $('ocr-result').hidden = false;
    $('reader-text').value = [$('reader-text').value.trim(), text].filter(Boolean).join('\n\n');
    setCaption('Reading', text.slice(0, 300) + (text.length > 300 ? '…' : ''), 'ocr');
    heartSet({ mode: 'lock', label: 'Reading…' });
    logEvent(t('log_ocr', { n: text.length }));
    reader.onFinish = () => {
      if (!reading.active) return;
      reading.phase = 'done'; heartSet({ mode: 'seek', label: 'Turn the page' });
      const ex = reading.explain; reading.explain = null;
      if (ex && ex.explainEn) { setCaption('Reading mode', ex.explainEn + ' ' + GUIDE.page_done[0], 'ocr', null, ex.explainBn + ' ' + GUIDE.page_done[1]); speak(ex.explainEn + ' ' + GUIDE.page_done[0], ex.explainBn + ' ' + GUIDE.page_done[1]); }
      else sayGuide('page_done', true);
    };
    startReader(text);
  } catch (e) { console.warn('ocrPage', e); reading.phase = 'align'; }
  finally { reading.ocrBusy = false; }
}

// ---- Hands-free ("Astha, …") ---------------------------------------------
const hf = { on: false, rec: null, poll: null, lastCommandAt: 0, starting: false, lastSpeakingAt: 0 };
const WAKE_RE = /(^|[\s,.!?])(astha|asta|ashtha|aastha|astar|আস্থা|আসথা|আস্তা)(?=$|[\s,.!?])/i;
function toggleHandsFree() { hf.on ? stopHandsFree() : startHandsFree(); }
function startHandsFree() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return announce(t('voice_unavailable'), tBn('voice_unavailable'), 'voice');
  if (privacyMode) return announce('Hands-free listening is off in privacy mode.', 'গোপনীয়তা মোডে হ্যান্ডস-ফ্রি বন্ধ।', 'voice');
  hf.on = true; hf.lastCommandAt = Date.now();
  $('hf-btn').setAttribute('aria-pressed', 'true'); $('hf-label').textContent = 'Hands-free: on';
  playEarcon('confirm');
  announce('Hands-free mode is on. Say “Astha”, then what you need. For example: Astha, read this. Say “Astha, sleep” to stop.',
    'হ্যান্ডস-ফ্রি মোড চালু। বলুন “আস্থা”, তারপর কী চাই বলুন। যেমন: আস্থা, এটা পড়ো। বন্ধ করতে বলুন “আস্থা, ঘুমাও”।', 'voice');
  logEvent('Hands-free on');
  if (state.source !== 'camera' && !state.cameraPending) toggleCamera();
  hf.poll = setInterval(hfPoll, 300);
}
function stopHandsFree(silent) {
  hf.on = false; clearInterval(hf.poll); hf.poll = null;
  if (hf.rec) { try { hf.rec.abort(); } catch (e) {} hf.rec = null; }
  $('hf-btn').setAttribute('aria-pressed', 'false'); $('hf-label').textContent = 'Hands-free: off';
  if (!state.listening) { $('mic').classList.remove('listening'); $('mic-label').textContent = t('mic_idle'); }
  if (!silent) { announce('Hands-free mode is off. Tap the microphone when you need me.', 'হ্যান্ডস-ফ্রি মোড বন্ধ। দরকার হলে মাইক্রোফোন চাপুন।', 'voice'); logEvent('Hands-free off'); }
}
function hfPoll() {
  if (!hf.on) return;
  const now = Date.now();
  const speaking = !!(window.speechSynthesis && window.speechSynthesis.speaking);
  if (speaking) hf.lastSpeakingAt = now;
  // Do not listen to our own voice: pause recognition while Astha speaks, and during a one-tap query.
  if (speaking || state.listening) { if (hf.rec) { try { hf.rec.abort(); } catch (e) {} hf.rec = null; } return; }
  if (!hf.rec && !hf.starting && now - hf.lastSpeakingAt > 700) hfStart();
}
function hfStart() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  hf.starting = true;
  try {
    const rec = new SR();
    rec.lang = sttLang(); rec.continuous = true; rec.interimResults = false; rec.maxAlternatives = 1;
    rec.onresult = e => { for (let i = e.resultIndex; i < e.results.length; i++) if (e.results[i].isFinal) hfHandle(e.results[i][0].transcript); };
    rec.onerror = ev => {
      if (ev.error === 'not-allowed' || ev.error === 'service-not-allowed') { stopHandsFree(true); announce('Microphone access was denied, so hands-free mode is off.', 'মাইক্রোফোনের অনুমতি নেই, তাই হ্যান্ডস-ফ্রি বন্ধ।', 'voice'); }
    };
    rec.onend = () => { if (hf.rec === rec) hf.rec = null; };
    rec.start(); hf.rec = rec;
    $('mic').classList.add('listening'); $('mic-label').textContent = 'Hands-free · say “Astha…”';
  } catch (e) { console.warn('hands-free start', e); }
  finally { setTimeout(() => { hf.starting = false; }, 600); }
}
function hfHandle(text) {
  const q = (text || '').trim(); if (!q) return;
  const hasWake = WAKE_RE.test(q);
  const followUp = Date.now() - hf.lastCommandAt < 10000;
  if (!hasWake && !followUp) return;
  const cmd = hasWake ? q.replace(/^[\s\S]*?(astha|asta|ashtha|aastha|astar|আস্থা|আসথা|আস্তা)[,.!?\s]*/i, '') : q;
  hf.lastCommandAt = Date.now();
  playEarcon('click');
  if (/^(sleep|go to sleep|stop listening|hands.?free off|ঘুমাও|শোনা বন্ধ)/i.test(cmd.trim())) return stopHandsFree();
  if (!cmd.trim()) return announce('Yes? I am listening.', 'বলুন, শুনছি।', 'voice');
  handleQuery(cmd);
}

// ---- "How do I look?" ---------------------------------------------------
function howDoILook() {
  if (withCamera(howDoILook)) return;
  return withBusy(t('clothes_title'), async () => {
    if (!(await ensureVisionModels())) return;
    const frame = captureFrame(640); if (!frame) return;
    const cocoObjs = await runCoco(frame); state.lastCocoPreds = cocoObjs;
    state.world.clear(); ingest(cocoObjs, 1e9); drawOverlay(frame, cocoObjs, []);
    await refineWorld(frame, cocoObjs, '', 1);
    await mirrorCheck(frame, false);
  });
}

// ---- Speech text hygiene --------------------------------------------------
// OCR leaves stray symbols and the odd misread letter of the other script; spoken as-is they get spelled out.
function scriptRatioBn(text) { const bn = (text.match(/[ঀ-৿]/g) || []).length, lat = (text.match(/[A-Za-z]/g) || []).length; return bn + lat ? bn / (bn + lat) : 0; }
function cleanOcrLine(line) {
  let s = String(line || '').replace(/\s+/g, ' ').trim();
  const r = scriptRatioBn(s);
  if (r > 0 && r < 0.3) s = s.replace(/[ঀ-৿]+/g, ' ');       // mostly Latin: drop stray Bangla glyphs
  else if (r > 0.7) s = s.replace(/[A-Za-z]{1,2}(?=\s|$)/g, ' ');       // mostly Bangla: drop 1–2 letter Latin noise
  // \p{M} keeps Bangla vowel signs and conjunct marks, which are not letters in Unicode terms.
  s = s.replace(/[^\p{L}\p{M}\p{N}\s.,!?;:'"()\-%/।]/gu, ' ').replace(/\s+/g, ' ').trim();
  return s;
}
function sanitizeForSpeech(text) { return String(text || '').replace(/[^\p{L}\p{M}\p{N}\s.,!?;:'"()\-%/।]/gu, ' ').replace(/\s+/g, ' ').trim(); }
// Camera-first: if the user asks for something visual while the camera is off, start it and then do the thing.
function withCamera(fn) {
  if (state.source) return false;
  state.pendingAction = fn;
  announce('Starting the camera, one moment.', 'ক্যামেরা চালু করছি, এক মুহূর্ত।', 'system');
  toggleCamera();
  return true;
}
function hasBanglaVoice() { refreshVoices(); return voices.some(v => /^bn/i.test(v.lang)); }
// Which voice should read this chunk? null means "cannot be spoken on this device".
function speechLangFor(text) {
  const r = scriptRatioBn(text);
  if (r >= 0.5) { if (hasBanglaVoice()) return 'bn'; if (!reader.warnedNoBn) { reader.warnedNoBn = true; setCaption('Reading', 'This device has no Bangla voice, so Bangla text is shown here instead of spoken.', 'ocr'); } return null; }
  return 'en';
}
function sttLang() {
  const pref = $('stt-lang') ? $('stt-lang').value : 'auto';
  if (pref && pref !== 'auto') return pref;
  return voiceLang === 'bn' ? 'bn-BD' : 'en-US';
}

// ---- Understanding what was said ------------------------------------------
// Fuzzy intent matching over English, Bangla and Banglish words, so natural phrasing works.
const INTENTS = [
  // Keywords cover English, Bangla script, and romanised Bangla ("amar phone kothay").
  { id: 'read', run: () => readText(), kw: ['read', 'reading', 'book', 'page', 'letter', 'label', 'text', 'পড়', 'পড়ো', 'লেখা', 'বই', 'রিড', 'বুক', 'পেজ', 'পৃষ্ঠা', 'poro', 'pore', 'boi', 'lekha', 'porhe', 'shonao'] },
  { id: 'identify', run: () => identifyObject(), kw: ['what is this', "what's this", 'what am i holding', 'identify', 'which brand', 'what phone', 'which phone', 'এটা কী', 'এটি কী', 'কী এটা', 'এটা কি', 'হোয়াট ইজ দিস', 'আইডেন্টিফাই', 'কোন ফোন', 'eta ki', 'eita ki', 'ki eta', 'kon phone'] },
  { id: 'describe', run: () => describeScene(), kw: ['describe', 'what do you see', 'what can you see', 'what is in front', "what's in front", 'whats in front', 'what is around', 'whats around', 'surroundings', 'look around', 'scene', 'tell me what', 'what is there', 'চারপাশ', 'সামনে কী', 'কী দেখছ', 'কী দেখছো', 'কী আছে', 'দেখো', 'ডেসক্রাইব', 'বর্ণনা', 'samne ki', 'ki dekhcho', 'ki dekhso', 'charpash', 'ki ache', 'dekho'] },
  { id: 'find', run: q => findItems(q), kw: ['where is my', 'where are my', 'where did i', 'find my', 'locate my', 'আমার.*কোথায়', 'খুঁজ', 'কই', 'ফাইন্ড', 'kothay', 'kothai', 'koi', 'khuje', 'khuj'] },
  { id: 'clothes', run: () => inspectClothesAndColor(), kw: ['wearing', 'clothes', 'cloth', 'dress', 'shirt', 'colour', 'color', 'পরেছি', 'পোশাক', 'জামা', 'কাপড়', 'রঙ', 'রং', 'ক্লথ', 'কালার', 'porechi', 'poreci', 'jama', 'kapor', 'poshak', 'rong', 'rang'] },
  { id: 'mirror', run: () => howDoILook(), kw: ['how do i look', 'how am i looking', 'mirror', 'looking good', 'কেমন লাগছে', 'আয়না', 'kemon lagche', 'kemon lagse', 'ayna'] },
  { id: 'safety', run: () => safetyCheck(), kw: ['obstacle', 'is it safe', 'danger', 'path clear', 'stairs', 'বাধা', 'বিপদ', 'নিরাপদ', 'সিঁড়ি', 'badha', 'bipod', 'nirapod', 'siri'] },
  { id: 'screen', run: () => eyeWhatsOnScreen(), kw: ['on my screen', 'my screen', 'which app', 'which tab', 'which window', 'where am i', 'স্ক্রিন', 'কোন অ্যাপ', 'কোন ট্যাব', 'কোথায় আছি'] },
  { id: 'error', run: () => eyeReadError(), kw: ['error', 'terminal output', 'went wrong', 'এরর', 'ভুলটা', 'ভুল কী'] },
  { id: 'stop', run: () => { if (reading.active) stopReading(); else stopAllSpeech(); }, kw: ['stop', 'be quiet', 'silence', 'enough', 'থামো', 'চুপ', 'বন্ধ করো', 'স্টপ', 'thamo', 'chup', 'bondho koro'] },
  { id: 'repeat', run: () => repeatResponse(), kw: ['repeat', 'say that again', 'once more', 'আবার বলো', 'রিপিট', 'abar bolo'] },
  { id: 'help', run: () => showCommandHelp(), kw: ['help', 'what can you do', 'commands', 'সাহায্য', 'কী করতে পারো', 'হেল্প'] },
];
function classifyIntent(q) {
  const s = ' ' + (q || '').toLowerCase().replace(/[?!.,।]/g, ' ').replace(/\s+/g, ' ') + ' ';
  let best = null, bestScore = 0;
  for (const it of INTENTS) {
    let score = 0;
    for (const kw of it.kw) {
      const ascii = /^[\x00-\x7f]+$/.test(kw);
      const hit = ascii ? new RegExp('(^|\\s)' + kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + 's?(\\s|$)').test(s) : new RegExp(kw).test(s);
      if (hit) score += Math.max(2, kw.split(' ').length * 2 + Math.min(kw.length, 12) / 6);
    }
    if (score > bestScore) { bestScore = score; best = it; }
  }
  return bestScore > 0 ? best : null;
}
function smartFallback(query, q) {
  const it = classifyIntent(q);
  if (it) { logEvent('Understood: ' + it.id); return it.run(query); }
  if (state.source === 'camera' && !reading.active) {
    announce(`I heard “${query}”. Let me tell you what I see.`, `শুনলাম “${query}”। যা দেখছি বলছি।`, 'voice');
    return describeScene();
  }
  announce(`I heard “${query}”, but I am not sure what you want. You can say: describe, read this, what is this, where is my phone, what am I wearing, or what is on my screen.`,
    `শুনলাম “${query}”, কিন্তু কী চান বুঝিনি। বলতে পারেন: চারপাশ বলো, এটা পড়ো, এটা কী, আমার ফোন কোথায়, আমি কী পরেছি, বা স্ক্রিনে কী আছে।`, 'voice');
}

// ---- One-tap listening that actually waits --------------------------------
let listenTimer = null;
function toggleListening() {
  if (state.listening) { stopListening(); return; }
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { setCaption(t('agent_voice'), t('voice_unavailable'), 'voice'); speak(t('voice_unavailable'), tBn('voice_unavailable')); return; }
  if (privacyMode || privacyTransition) return announce('Voice recognition is off in privacy mode. Type your request.', 'গোপনীয়তা মোডে অনলাইন কণ্ঠ শনাক্তকরণ বন্ধ। অনুরোধ লিখুন।');
  if (reader.active) pauseReader(); else VoiceEngine.stop();
  state.listening = true;
  $('mic').setAttribute('aria-label', 'Stop listening'); $('mic').setAttribute('aria-pressed', 'true'); $('mic').classList.add('listening');
  $('mic-label').textContent = t('mic_listening');
  setCaption(t('agent_voice'), 'Listening… take your time.', 'voice', 'busy', 'শুনছি… ধীরে বলুন।');
  playEarcon('confirm');
  let finalText = '', gotSpeech = false;
  const finish = () => {
    clearTimeout(listenTimer);
    const text = finalText.trim();
    stopListening();
    if (text) handleQuery(text);
    else { setCaption(t('agent_voice'), 'I did not hear anything. Tap the microphone and speak after the chime.', 'voice', null, 'কিছু শুনতে পাইনি। মাইক্রোফোন চেপে শব্দের পরে বলুন।'); speak('I did not hear anything. Tap the microphone and speak after the chime.', 'কিছু শুনতে পাইনি। মাইক্রোফোন চেপে শব্দের পরে বলুন।'); }
  };
  try {
    recognizer = new SR();
    recognizer.lang = sttLang(); recognizer.continuous = true; recognizer.interimResults = true; recognizer.maxAlternatives = 1;
    recognizer.onresult = e => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const tr = e.results[i][0].transcript;
        if (e.results[i].isFinal) finalText += ' ' + tr; else interim += tr;
      }
      gotSpeech = true;
      setCaption(t('agent_voice'), 'Heard: ' + (finalText + ' ' + interim).trim(), 'voice', 'busy');
      clearTimeout(listenTimer);
      // Wait a moment after the last words in case the sentence continues.
      listenTimer = setTimeout(finish, finalText.trim() ? 900 : 2500);
    };
    recognizer.onerror = ev => { if (ev.error === 'no-speech') return; console.warn('speech', ev.error); if (ev.error === 'not-allowed') { stopListening(); announce('Microphone access was denied.', 'মাইক্রোফোনের অনুমতি নেই।', 'voice'); } };
    recognizer.onend = () => { if (state.listening) { if (finalText.trim()) finish(); else if (!gotSpeech && Date.now() - listenStart < 7500) { try { recognizer.start(); } catch (e) {} } else finish(); } };
    const listenStart = Date.now();
    recognizer.start();
    listenTimer = setTimeout(finish, 8000);
  } catch (e) { console.warn(e); stopListening(); }
}

function companionBoot() {
  state.relabel = {};
  populateVoices();
  window.speechSynthesis?.addEventListener('voiceschanged', populateVoices);
  window.addEventListener('pagehide', () => { if (hf.on) stopHandsFree(true); });
}

/* =====================================================================
   17. Server-backed memory (replaces the old browser-encrypted vault)
       Every save already went through the same privacy-mode guard clauses
       as before; only the storage target changed, from a client-side
       encrypted blob to this account's row on Astha's own server.
   ===================================================================== */
async function apiGet(path) {
  const r = await fetch(apiUrl(path), { credentials: 'include' });
  if (!r.ok) { const e = new Error('http_' + r.status); e.status = r.status; throw e; }
  return r.json();
}
async function apiSend(method, path, body) {
  const r = await fetch(apiUrl(path), { method, credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  if (!r.ok) { const e = new Error('http_' + r.status); e.status = r.status; throw e; }
  return r.json();
}
async function refreshMemory() {
  try {
    const d = await apiGet('/api/memories');
    state.memory = d.memories.map(m => ({ uid: m.id, id: m.obj_id || undefined, item: m.item, location: m.location, source: m.source, score: m.score, time: new Date(m.created_at).toISOString() }));
  } catch (e) { console.warn('memory fetch failed', e); }
  renderMemory();
}
async function refreshRooms() {
  try {
    const d = await apiGet('/api/rooms');
    state.spatialHome = d.rooms.map(r => ({ id: r.id, name: r.name, notes: r.notes, updated: new Date(r.updated_at).toISOString() }));
  } catch (e) { console.warn('rooms fetch failed', e); }
  renderSpatialLayout();
}

async function saveManualMemory() {
  if (privacyTransition) return;
  if (privacyMode) return announce('Memory is off in privacy mode.', 'গোপনীয়তা মোডে মেমরি বন্ধ।');
  const item = $('memory-item').value.trim(), location = $('memory-location').value.trim();
  if (!item || !location) return;
  $('memory-item').value = ''; $('memory-location').value = '';
  try { await apiSend('POST', '/api/memories', { item, location, source: 'Your note' }); }
  catch (e) { return announce('I could not save that. Check your connection.', 'সংরক্ষণ করা যায়নি। সংযোগ দেখুন।'); }
  await refreshMemory();
  announce('Remembered ' + item + ': ' + location + '.', item + ' এর স্থান মনে রাখা হয়েছে: ' + location + '।', 'memory');
}
async function remember(id, pos) {
  if (privacyTransition) return;
  if (privacyMode) return announce('Memory is off in privacy mode.', 'গোপনীয়তা মোডে মেমরি বন্ধ।');
  if (!state.source || state.source === 'scene') return announce('Demo scenes are not saved as personal memories.', 'ডেমো দৃশ্য ব্যক্তিগত স্মৃতিতে সংরক্ষিত হয় না।');
  const observation = state.world.get(id);
  if (!observation) return;
  const position = 'In the ' + (pos === 'ahead' ? 'centre' : pos) + ' of the image; physical location unconfirmed';
  const itemLabel = objLabel(observation);
  try { await apiSend('POST', '/api/memories', { item: itemLabel, location: position, source: state.source === 'camera' ? 'Camera observation' : 'Uploaded photo', score: observation.score }); }
  catch (e) { return announce('I could not save that. Check your connection.', 'সংরক্ষণ করা যায়নি। সংযোগ দেখুন।'); }
  await refreshMemory();
  announce('Saved a possible ' + itemLabel + ' from this image. Add a room or surface in a new note for useful location recall.', 'ছবি থেকে সম্ভাব্য ' + objLabelBn(observation) + ' সংরক্ষিত। নির্দিষ্ট স্থানের জন্য আলাদা নোট যোগ করুন।', 'memory');
}
async function deleteMemory(uid) {
  if (privacyTransition) return;
  try { await apiSend('DELETE', '/api/memories/' + encodeURIComponent(uid)); } catch (e) {}
  await refreshMemory();
  $('memory-search').focus();
}
async function clearMemory() {
  if (!confirm('Delete all saved object memories and room notes from your Astha account?')) return;
  try { await Promise.all([apiSend('DELETE', '/api/memories'), apiSend('DELETE', '/api/rooms'), apiSend('DELETE', '/api/log')]); }
  catch (e) { return announce('Could not clear your account data. Check your connection and try again.', 'অ্যাকাউন্টের তথ্য মুছা যায়নি। সংযোগ দেখে আবার চেষ্টা করুন।'); }
  await refreshMemory(); await refreshRooms(); state.log = []; renderLog();
  announce('All personal memories and room notes deleted.', 'সব ব্যক্তিগত স্মৃতি ও ঘরের নোট মুছে ফেলা হয়েছে।', 'memory');
}
async function saveCalibratedRoom() {
  if (privacyTransition) return;
  if (privacyMode) return;
  const name = $('room-name').value.trim(), notes = $('room-notes').value.trim(); if (!name || !notes) return;
  closeHomeCalibration();
  try { await apiSend('POST', '/api/rooms', { name, notes }); }
  catch (e) { return announce('I could not save that room. Check your connection.', 'ঘরের নোট সংরক্ষণ করা যায়নি। সংযোগ দেখুন।'); }
  await refreshRooms();
  announce('Saved your confirmed notes for ' + name + '.', name + ' এর নিশ্চিত নোট সংরক্ষিত।', 'memory');
}
async function deleteCalibratedRoom(id) {
  if (privacyTransition) return;
  try { await apiSend('DELETE', '/api/rooms/' + encodeURIComponent(id)); } catch (e) {}
  await refreshRooms();
}
function clearPrivateSession() {
  stopAllSpeech(); lastResponse = null;
  state.memory = []; state.spatialHome = []; state.log = [];
  renderMemory(); renderSpatialLayout(); renderLog();
  ['memory-item', 'memory-location', 'memory-search', 'room-name', 'room-notes', 'command-input'].forEach(id => { const el = $(id); if (el) el.value = ''; });
  clearReader();
  $('caption-text').textContent = 'Personal session cleared from view.';
  $('caption-voice-sub').textContent = ''; $('caption-voice-sub').hidden = true;
}
async function togglePrivateMode() {
  if (privacyTransition) return;
  const entering = !privacyMode;
  privacyTransition = true; $('private-btn').disabled = true;
  try {
    stopAllSpeech();
    privacyMode = entering;
    if (privacyMode) clearPrivateSession();
    $('private-btn').setAttribute('aria-pressed', privacyMode);
    $('private-btn').textContent = 'Privacy mode: ' + (privacyMode ? 'on' : 'off');
    $('privacy-status').textContent = privacyMode
      ? 'New memories, room notes and activity are not saved while this is on. Existing account data is untouched.'
      : 'Session memory is on and saved to your account.';
    if (!privacyMode) { await refreshMemory(); await refreshRooms(); }
    announce(privacyMode ? 'Privacy mode is on. Nothing new will be saved until you turn it off.' : 'Privacy mode is off.',
      privacyMode ? 'গোপনীয়তা মোড চালু। বন্ধ না করা পর্যন্ত নতুন কিছু সংরক্ষণ হবে না।' : 'গোপনীয়তা মোড বন্ধ।');
  } finally { privacyTransition = false; $('private-btn').disabled = false; }
}
async function signOut() {
  try { await apiSend('POST', '/api/auth/logout', {}); } catch (e) {}
  location.reload();
}
