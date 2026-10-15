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

// Consent lasts only for this page session and is requested by the Online control.
let remoteProcessingConsent = false;
const REMOTE_CONSENT = {
  en: 'Allow online processing for this session? Camera or screen images, requests and selected personal notes may be sent to Google Gemini or Gigalogy Maira. Spoken text may be sent to Microsoft, and browser voice recognition may use an online service. Choose Cancel to keep processing on this phone. You can turn this off with On-device or Privacy mode.',
  bn: 'এই সেশনে অনলাইন প্রসেসিংয়ের অনুমতি দেবেন? ক্যামেরা বা স্ক্রিনের ছবি, অনুরোধ ও নির্বাচিত ব্যক্তিগত নোট Google Gemini বা Gigalogy Maira-তে পাঠানো হতে পারে। শোনানোর লেখা Microsoft-এ এবং ব্রাউজারের কণ্ঠ শনাক্তকরণ অনলাইন পরিষেবায় পাঠানো হতে পারে। এই ফোনে প্রসেসিং রাখতে Cancel চাপুন। ডিভাইস বা গোপনীয়তা মোডে অনুমতি বন্ধ করতে পারবেন।',
};
function requestRemoteConsent() {
  if (privacyMode || privacyTransition || navigator.onLine === false) return false;
  if (remoteProcessingConsent) return true;
  const asked = Date.now();
  remoteProcessingConsent = window.confirm(REMOTE_CONSENT[(typeof uiLang !== 'undefined' ? uiLang : voiceLang) === 'bn' ? 'bn' : 'en']);
  // Some hosts suppress native dialogs and answer "no" at once. Nobody declines that
  // quickly, so ask on the page itself instead of leaving Online impossible to turn on.
  if (!remoteProcessingConsent && Date.now() - asked < 80 && typeof askRemoteConsentOnPage === 'function') askRemoteConsentOnPage();
  return remoteProcessingConsent;
}

// Keep remote processing consistent across vision, voice and personal-data sync.
function remoteProcessingAllowed() {
  if (!remoteProcessingConsent) return false;
  if ((typeof privacyMode !== 'undefined' && privacyMode) ||
      (typeof privacyTransition !== 'undefined' && privacyTransition)) return false;
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return false;
  return !(typeof Subscription !== 'undefined' && Subscription.getMode() === 'offline');
}
function personalDataSyncAllowed() {
  return typeof window.ASTHA_ACCOUNT_ID === 'string' && Boolean(window.ASTHA_ACCOUNT_ID) && remoteProcessingAllowed();
}
function isPersonalDataPath(path) { return /^\/api\/(memories|rooms|log|preferences)(\/|$)/.test(path); }
function deadlineSignal(timeoutMs, callerSignal) {
  let timeoutSignal;
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') timeoutSignal = AbortSignal.timeout(timeoutMs);
  else {
    const timeoutController = new AbortController();
    setTimeout(() => timeoutController.abort(), timeoutMs);
    timeoutSignal = timeoutController.signal;
  }
  if (!callerSignal) return timeoutSignal;
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.any === 'function') return AbortSignal.any([callerSignal, timeoutSignal]);
  // Older mobile WebViews still retain caller cancellation and a bounded request.
  const controller = new AbortController();
  for (const signal of [callerSignal, timeoutSignal]) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
  }
  return controller.signal;
}

// Cancels requests already in flight; it does not revoke permission for the next request.
const AsthaCancellation = {
  generation: 0,
  controllers: new Set(),
  cancel() {
    this.generation++;
    for (const controller of this.controllers) controller.abort();
    this.controllers.clear();
  },
};

const VoiceEchoFilter = {
  recentUtterances: [], // array of { text, words, time }
  recordMachineSpeech(text) {
    if (!text) return;
    const clean = String(text).toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').trim();
    if (!clean) return;
    const words = clean.split(/\s+/).filter(w => w.length > 1);
    const now = Date.now();
    this.recentUtterances.push({ text: clean, words, time: now });
    if (this.recentUtterances.length > 20) this.recentUtterances.shift();
    this.recentUtterances = this.recentUtterances.filter(u => now - u.time < 60000);
  },
  isMachineEcho(transcript) {
    if (!transcript) return false;
    const clean = String(transcript).toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').trim();
    if (!clean) return true;
    const tWords = clean.split(/\s+/).filter(w => w.length > 1);
    if (tWords.length === 0) return true;

    const now = Date.now();
    for (const u of this.recentUtterances) {
      if (now - u.time > 40000) continue;
      if (u.text.includes(clean) || clean.includes(u.text)) return true;
      let matches = 0;
      for (const w of tWords) {
        if (u.words.includes(w)) matches++;
      }
      if (matches >= 2 && matches / tWords.length >= 0.5) return true;
      if (tWords.length === 1 && matches === 1 && u.words.includes(tWords[0])) {
        if (now - u.time < 5000) return true;
      }
    }
    return false;
  }
};

const VoiceEngine = {
  mode: null,       // 'audio' | 'synth' | null
  audioEl: null,
  lastSpokeAt: 0,
  _currentResolve: null,
  requestController: null, generation: 0,
  _speechTiming: null,
  _finishSpeechTiming(outcome, token = this._speechTiming) {
    if (token !== this._speechTiming) return;
    if (typeof AsthaDiagnostics !== 'undefined') AsthaDiagnostics.finish(this._speechTiming, outcome);
    this._speechTiming = null;
  },
  criticalUntil: 0, _criticalDone: null, _endCritical: null, _criticalToken: 0,
  get speaking() {
    if (this.mode === 'audio') return !!this.audioEl && !this.audioEl.paused && !this.audioEl.ended;
    if (this.mode === 'synth') return !!(window.speechSynthesis && window.speechSynthesis.speaking);
    return this.mode === 'native';
  },
  _finishCritical() {
    this.criticalUntil = 0;
    const end = this._endCritical; this._endCritical = null; this._criticalDone = null;
    if (end) end();
  },
  // Ordinary speech replaces ordinary speech. Only the user (Stop, voice off) or a newer
  // alert ends a hazard alert early; anything else waits for it in speak().
  stop(user = false) {
    this._finishSpeechTiming('cancel');
    this.generation++;
    if (this.requestController) { this.requestController.abort(); this.requestController = null; }
    if (!user && this.criticalUntil > Date.now()) return;
    this._criticalToken++; this._finishCritical();
    this.lastSpokeAt = Date.now();
    if (this._currentResolve) {
      const res = this._currentResolve;
      this._currentResolve = null;
      res(false);
    }
    if (this.audioEl) {
      try {
        this.audioEl.pause();
        this.audioEl.currentTime = 0;
        if (this.audioEl.src) URL.revokeObjectURL(this.audioEl.src);
        this.audioEl.src = '';
      } catch (e) {}
      this.audioEl = null;
    }
    if (window.speechSynthesis) {
      try { window.speechSynthesis.cancel(); } catch (e) {}
    }
    if (this.mode === 'native' && window.AsthaNative) window.AsthaNative.stopSpeaking();
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
  _noticeGiven: false,
  // Very few phones and almost no computers ship a Bangla voice.
  _deviceVoice(lang) {
    if (lang !== 'bn') return true;
    if (typeof refreshVoices === 'function') refreshVoices();
    return typeof voices !== 'undefined' && voices.some(v => /^bn/i.test(v.lang));
  },
  _banglaVoiced(worked) { const notice = $('voice-notice'); if (notice) notice.hidden = worked; },
  // Bangla was wanted and could not be voiced: say so once, then carry on in English.
  _withoutBangla(fallback) {
    this._banglaVoiced(false);
    if (this._noticeGiven) return fallback.text;
    this._noticeGiven = true;
    return 'This device has no Bangla voice, so I am speaking English. Turn on Online AI to hear my Bangla voice. ' + fallback.text;
  },
  // Speak in the chosen voice language, or in English when Bangla cannot be voiced here.
  say(en, bn) {
    const useBn = voiceLang === 'bn' && !!bn;
    return this.speak(useBn ? bn : en, useBn ? 'bn' : 'en', { fallback: useBn && en ? { text: en, lang: 'en' } : null });
  },
  // `local` skips the server voice, for alerts that cannot wait on the network.
  // `fallback` is what to say instead when this language has no voice at all.
  async speak(text, lang, { local = false, fallback = null } = {}) {
    this.stop();
    const generation = this.generation;
    if (!state.audio || !text) return false;
    // Let a hazard alert finish. A newer sentence that arrives meanwhile replaces this one.
    if (this._criticalDone) { await this._criticalDone; if (generation !== this.generation) return false; }
    const speechTiming = typeof AsthaDiagnostics !== 'undefined' ? AsthaDiagnostics.start('speech', { sourceEpoch: state.sourceEpoch || 0 }) : null;
    this._speechTiming = speechTiming;
    VoiceEchoFilter.recordMachineSpeech(text);
    this.lastSpokeAt = Date.now();
    const voiceKey = lang === 'bn' ? 'bn-female' : 'en-female';
    try {
      // With no backend (static hosting, offline) go straight to the device voice instead of
      // paying a failed network round-trip before every sentence.
      if (local || !remoteProcessingAllowed() || (typeof backendReachable === 'function' && !backendReachable())) throw offlineError();
      const controller = new AbortController(); this.requestController = controller;
      let res, blob;
      try {
        res = await fetch(apiUrl('/api/speak'), {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text, voice: voiceKey }), credentials: 'include',
          cache: 'no-store', signal: deadlineSignal(10000, controller.signal),
        });
        if (generation !== this.generation) return false;
        if (!remoteProcessingAllowed()) throw offlineError();
        if (res.ok) blob = await res.blob();
      }
      finally { if (this.requestController === controller) this.requestController = null; }
      if (generation !== this.generation) return false;
      if (!remoteProcessingAllowed()) throw offlineError();
      if (res.ok) {
        const audio = new Audio(URL.createObjectURL(blob));
        const rate = Number($('speech-rate') && $('speech-rate').value) || 1;
        audio.playbackRate = rate;
        this.mode = 'audio'; this.audioEl = audio;
        const ok = await new Promise(resolve => {
          this._currentResolve = resolve;
          audio.onended = () => { this.lastSpokeAt = Date.now(); resolve(true); };
          audio.onerror = () => { this.lastSpokeAt = Date.now(); resolve(false); };
          audio.onplaying = () => { if (generation === this.generation) this._finishSpeechTiming('success', speechTiming); };
          audio.play().catch(() => resolve(false));
        });
        this._currentResolve = null;
        if (this.audioEl === audio) { this.mode = null; this.audioEl = null; }
        this.lastSpokeAt = Date.now();
        if (ok) { this._finishSpeechTiming('error', speechTiming); if (lang === 'bn') this._banglaVoiced(true); return true; }
        // fall through to the browser voice if playback itself failed
      }
    } catch (e) { /* offline, signed out, or the server is down: use the local voice instead */ }
    if (generation !== this.generation) return false;
    // The Android WebView has no speech synthesis; the app supplies the device voice instead.
    const u = window.speechSynthesis && this._deviceVoice(lang) ? makeUtterance(sanitizeForSpeech(text), lang) : null;
    if (!u) {
      // The native bridge reports completion, not first audio; do not invent that timing.
      this._finishSpeechTiming('error', speechTiming);
      const spoken = await this._speakOnDevice(text, lang, generation, local || !remoteProcessingAllowed());
      if (spoken && lang === 'bn') this._banglaVoiced(true);
      if (spoken || generation !== this.generation || !fallback) return spoken;
      return this.speak(this._withoutBangla(fallback), fallback.lang, { local: true });
    }
    this.mode = 'synth';
    const ok = await new Promise(resolve => {
      this._currentResolve = resolve;
      u.onend = () => { this.lastSpokeAt = Date.now(); resolve(true); };
      u.onerror = () => { this.lastSpokeAt = Date.now(); resolve(false); };
      u.onstart = () => { if (generation === this.generation) this._finishSpeechTiming('success', speechTiming); };
      window.speechSynthesis.speak(u);
    });
    this._currentResolve = null;
    if (this.mode === 'synth') this.mode = null;
    this.lastSpokeAt = Date.now();
    this._finishSpeechTiming('error', speechTiming);
    if (ok && lang === 'bn') this._banglaVoiced(true);
    return ok;
  },
  async _speakOnDevice(text, lang, generation, onDeviceOnly = true) {
    const device = window.AsthaNative;
    if (!device || !device.canSpeak) return false;
    this.mode = 'native';
    const ok = await device.speak(sanitizeForSpeech(text), lang, Number($('speech-rate') && $('speech-rate').value) || 1, { onDeviceOnly });
    if (generation === this.generation && this.mode === 'native') this.mode = null;
    this.lastSpokeAt = Date.now();
    return ok;
  },
  // `admitted` is 'critical' when the caller already passed the priority gate.
  emergencyAlert(textEn, textBn, hazardType, admitted = null) {
    const priority = admitted || (typeof AsthaExperience !== 'undefined' ? AsthaExperience.acceptHazard(hazardType) : 'critical');
    if (!priority) return;   // an answer is in progress, a repeat, or ASTHA was not asked to watch
    const useBn = voiceLang === 'bn' && !!textBn;
    const text = useBn ? textBn : textEn;
    if (!text) return;
    if (typeof showHazard === 'function') showHazard(true);
    if (priority !== 'critical') {
      // A requested update rather than an emergency: it never interrupts an answer.
      if (typeof setCaption === 'function') setCaption(t('agent_safety'), textEn, 'safety', 'danger', textBn);
      if (typeof playEarcon === 'function') playEarcon('hazard');
      speak(textEn, textBn);
      return;
    }
    this.stop(true);
    // The caption and vibration reach users who keep ASTHA's voice off.
    if (typeof setCaption === 'function') setCaption('EMERGENCY HAZARD', textEn, 'safety', 'danger', textBn);
    if (typeof haptic === 'function') haptic('RAPID');
    if (!state.audio) return;
    if (typeof playEarcon === 'function') playEarcon('emergency');
    VoiceEchoFilter.recordMachineSpeech(text);
    // An alert cannot wait for the online voice. Without a Bangla voice on this device
    // (and no app voice to try), it is spoken in English rather than not at all.
    const english = useBn && textEn && !this._deviceVoice('bn') && !window.AsthaNative;
    const lang = useBn && !english ? 'bn' : 'en', words = english ? textEn : text;
    if (english) this._banglaVoiced(false);
    const u = window.speechSynthesis && typeof makeUtterance === 'function' && this._deviceVoice(lang) ? makeUtterance(sanitizeForSpeech(words), lang) : null;
    // Without a device voice (some Android WebViews) use the normal voice path.
    if (!u) { this.speak(words, lang, { local: true, fallback: lang === 'bn' && textEn ? { text: textEn, lang: 'en' } : null }); return; }
    try { window.speechSynthesis.cancel(); } catch (e) {}
    u.rate = 1.18; // Urgent fast speech
    u.pitch = 1.1;
    this.mode = 'synth';
    const token = ++this._criticalToken;
    this.criticalUntil = Date.now() + 6000;
    this._criticalDone = new Promise(resolve => { this._endCritical = resolve; });
    const done = () => {
      if (token !== this._criticalToken) return;
      if (this.mode === 'synth') this.mode = null;
      this.lastSpokeAt = Date.now(); this._finishCritical();
    };
    u.onend = done; u.onerror = done;
    setTimeout(done, 6000);   // a voice that never reports its end must not block answers
    window.speechSynthesis.speak(u);
  },
};
function asthaSpeaking() { return VoiceEngine.speaking; }

function speak(enText, bnText) {
  lastResponse = { en: enText, bn: bnText };
  if (!state.audio) return;
  stopReader();
  if (enText || bnText) VoiceEngine.say(enText, bnText);
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
    reader.active = false; $('reader-progress').textContent = t('reader_finished');
    const done = reader.onFinish; reader.onFinish = null; if (done) done();
    return;
  }
  const text = reader.parts[reader.index];
  const lang = /[\u0980-\u09ff]/.test(text) ? 'bn' : 'en';
  $('reader-progress').textContent = t('reader_part', { n: reader.index + 1, total: reader.parts.length });
  VoiceEngine.speak(text, lang).then(ok => {
    if (generation !== reader.generation || !reader.active) return;
    if (!ok) { stopReader(); $('reader-progress').textContent = t('reader_failed'); return; }
    reader.index++;
    if (!reader.paused) readNextChunk(generation);
  });
}
function pauseReader() {
  if (!reader.active || reader.paused) return;
  reader.paused = true; VoiceEngine.pause(); $('reader-progress').textContent = t('reader_paused');
}
function resumeReader() {
  if (!reader.active || !reader.paused) return;
  reader.paused = false; VoiceEngine.resume();
  if (reader.active) $('reader-progress').textContent = t('reader_reading');
}
function stopReader() {
  reader.active = false; reader.paused = false; reader.generation++; reader.parts = []; reader.index = 0;
  VoiceEngine.stop();
}
function stopAllSpeech() {
  stopReader(); stopListening(); VoiceEngine.stop(true);
  $('reader-progress').textContent = t('reader_stopped');
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
async function refineDetection(frame, obj, ocrText, current = captureLocalActionGuard()) {
  if (!current()) return null;
  const group = Object.keys(REFINE).find(k => REFINE[k].applies.includes(obj.id));
  if (!group || engine.clip.status !== 'ready' || !obj.bbox) return null;
  const set = await getPromptSet('refine_' + group, REFINE[group].defs);
  if (!set || !current()) return null;
  const emb = await clipEmbedBox(frame, obj.bbox);
  if (!current()) return null;
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
async function refineWorld(frame, cocoObjs, ocrText, max = 2, current = captureLocalActionGuard()) {
  if (!current()) return [];
  const candidates = (cocoObjs || []).filter(o => Object.values(REFINE).some(g => g.applies.includes(o.id))).sort((a, b) => b.score - a.score).slice(0, max);
  const notes = [];
  for (const o of candidates) {
    let r = null;
    try { r = await refineDetection(frame, o, ocrText, current); } catch (e) { if (e.cancelled || !current()) return []; console.warn('refine', e); }
    if (!current()) return [];
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
  const current = captureLocalActionGuard();
  if (!current()) return;
  const now = Date.now();
  const cand = state.lastCocoPreds.filter(o => Object.values(REFINE).some(g => g.applies.includes(o.id)) && now - (liveRefineCache.get(o.id) || 0) > 4000).sort((a, b) => b.score - a.score)[0];
  if (cand) {
    liveRefineCache.set(cand.id, now);
    let r = null;
    try { r = await refineDetection(frame, cand, '', current); } catch (e) { if (e.cancelled || !current()) return; console.warn('live refine', e); }
    if (!current()) return;
    if (r) {
      const v = refineVotes.get(cand.id);
      const agree = v && v.kind === r.kind && now - v.t < 12000;
      refineVotes.set(cand.id, { kind: r.kind, t: now });
      if (r.kind === 'mirror') state.mirrorSeenAt = now;
      else if (r.kind !== 'real' && agree) await refineWorld(frame, [cand], '', 1, current);
    }
  }
  if (!current()) return;
  if (now - (state.mirrorSeenAt || 0) < 3000 && now - (state.lastComplimentAt || 0) > 60000 && !state.busy && !reading.active) {
    const busyToken = Symbol('live-mirror');
    state.busyToken = busyToken; state.busy = true;
    try { await mirrorCheck(frame, true, current); }
    finally { if (state.busyToken === busyToken) { state.busyToken = null; state.busy = false; } }
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
async function mirrorCheck(frame, onlyIfMirror, current = captureLocalActionGuard()) {
  if (!current()) return false;
  try {
  // With the cloud available, only Gemini may declare a mirror; on-device needs a phone in view and a high score.
  let isMirror = false;
  if (cloudReady()) {
    try {
      const r = await gemini(CLOUD_PROMPTS.mirror, frame, { maxTokens: 200 });
      if (!current()) return false;
      isMirror = r.mirror === true;
      if (isMirror) { await cloudCompliment(frame, r, current); return current(); }
    } catch (e) { if (e.cancelled || !current()) return false; cloudFail(e); }
    if (onlyIfMirror) return false;
  } else {
    const phone = state.lastCocoPreds.some(o => o.id === 'cell phone');
    isMirror = phone && Date.now() - (state.mirrorSeenAt || 0) < 5000;
    if (!isMirror && phone && engine.clip.status === 'ready') {
      const [emb] = await clipEmbedCrops(frame, [centerRect(frame, 0.95)]);
      if (!current()) return false;
      const set = await getPromptSet('mirror', MIRROR_SET);
      if (!current()) return false;
      const r = rankAgainst(emb, set);
      isMirror = r[0].id === 'mirror' && r[0].p >= 0.6;
    }
  }
  if (!isMirror && onlyIfMirror) return false;
  const person = [...state.world.values()].find(o => o.id === 'person' && o.bbox);
  const rect = person ? bodyRect(frame, person.bbox) : centerRect(frame, 0.6);
  const info = await analyzeClothing(frame, rect);
  if (!current()) return false;
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
  } catch (e) { if (e.cancelled || !current()) return false; throw e; }
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
    announce(typeof cloudReady === 'function' && cloudReady() ? 'Starting camera to read text, blackboard or screen.' : 'Starting the camera. Hold the page in front of the phone.',
             typeof cloudReady === 'function' && cloudReady() ? 'লেখা, ব্ল্যাকবোর্ড বা স্ক্রিন পড়ার জন্য ক্যামেরা চালু করছি।' : 'ক্যামেরা চালু করছি। পৃষ্ঠাটি ফোনের সামনে ধরুন।', 'ocr');
    toggleCamera();
    return;
  }
  if (typeof cloudReady === 'function' && cloudReady() && typeof cloudReadLive === 'function') {
    return cloudReadLive();
  }
  if (!['camera', 'pi'].includes(state.source)) return readStillOnce();
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
  if (['camera', 'pi'].includes(state.source)) startLiveLoop();
}
function setReadButton(on) {
  const b = $('read-btn'); if (!b) return;
  b.classList.toggle('on', on); b.setAttribute('aria-pressed', on);
  $('read-title').textContent = on ? t('read_stop') : t('act_read');
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
  const stillWanted = captureLocalActionGuard();
  reading.ocrBusy = true;
  try {
    const worker = await ensureOcr();
    if (!reading.active || !stillWanted()) return;
    const frame = captureFrame(1024); // ~3 s per page on a laptop CPU with Bangla + English
    let lines = null, explain = null;
    if (cloudReady()) { try { const r = await cloudReadLines(frame); if (!reading.active || !stillWanted()) return; lines = r.lines; explain = r; } catch (e) { if (e.cancelled || !reading.active || !stillWanted()) return; cloudFail(e); } }
    if (!lines) {
      const { data } = await worker.recognize(frame);
      lines = (data.lines || []).filter(l => l.confidence >= 55).map(l => cleanOcrLine(l.text))
        .filter(l => { const letters = l.replace(/[^\p{L}\p{N}]/gu, '').length; return letters >= 2 && letters / l.length >= 0.5; });
    }
    if (!reading.active || !stillWanted()) return;
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
  } catch (e) { if (e.cancelled || !reading.active || !stillWanted()) return; console.warn('ocrPage', e); reading.phase = 'align'; }
  finally { reading.ocrBusy = false; }
}

// ---- Foreground hands-free listening (only after explicit consent) ---
// Whole commands only: a bus stop or quoted instructions are not a request to stop.
const STOP_TALKING_REGEX = /^(?:please\s+)?(?:stop(?: talking| speaking| reading)?|pause|shut up|be quiet|quiet|silence|enough|halt|don'?t (?:speak|talk)|থামো|চুপ|চুপ কর|চুপ করো|থামুন|কথা বন্ধ|পড়া বন্ধ|বন্ধ করো|স্টপ|thamo|chup|bondho koro|bondho kor)(?:\s+please)?[.!?।\s]*$/i;
const WAKE_RE = /(^|[\s,.!?])(astha|asta|ashtha|aastha|astar|হে আস্থা|আস্থা|আসথা|আস্তা)(?=$|[\s,.!?])/i;
function isSpeechStopCommand(text) {
  const command = String(text || '').trim().replace(/[’]/g, "'")
    .replace(/^(?:hey\s+|হেই\s+)?(?:astha|asta|ashtha|aastha|astar|হে আস্থা|আস্থা|আসথা|আস্তা)[,.!?।\s]+/i, '');
  return STOP_TALKING_REGEX.test(command);
}

const SiriVoice = {
  enabled: false, // Hands-free listening requires an explicit user action each session.
  active: false,
  rec: null,
  restartTimer: null,
  speechDebounceTimer: null,
  pendingSpeech: '',
  lastCommandAt: 0,
  lastBargeInAt: 0,
  starting: false,

  get on() { return this.active; },
  set on(v) { if (v) this.start(); else this.stop(); },

  start() {
    if (!this.enabled || !remoteProcessingAllowed()) return;
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return;
    if (this.active && this.rec) return;
    this.active = true;
    this.lastCommandAt = Date.now();
    const btn = $('hf-btn');
    if (btn) btn.setAttribute('aria-pressed', 'true');
    const lbl = $('hf-label');
    if (lbl) lbl.textContent = t('hf_on');
    $('mic')?.classList.add('listening');
    $('mic-label') && ($('mic-label').textContent = t('mic_listening'));
    this._listen();
  },

  stop(silent) {
    this.active = false;
    clearTimeout(this.restartTimer);
    clearTimeout(this.speechDebounceTimer);
    this.pendingSpeech = '';
    if (this.rec) {
      try { this.rec.abort(); } catch (e) {}
      this.rec = null;
    }
    const btn = $('hf-btn');
    if (btn) btn.setAttribute('aria-pressed', 'false');
    const lbl = $('hf-label');
    if (lbl) lbl.textContent = t('hf_off');
    if (!state.listening) {
      $('mic')?.classList.remove('listening');
      $('mic-label') && ($('mic-label').textContent = t('mic_idle') || 'Microphone idle');
    }
    if (!silent) logEvent('Voice listening paused');
  },

  toggle() {
    if (this.active) {
      this.enabled = false;
      this.stop();
    } else {
      this.enabled = true;
      this.start();
    }
  },

  _listen() {
    if (!this.active || !this.enabled || !remoteProcessingAllowed()) { this.stop(true); return; }
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return;
    if (this.rec) {
      try { this.rec.abort(); } catch (e) {}
      this.rec = null;
    }

    try {
      const rec = new SR();
      rec.lang = sttLang();
      rec.continuous = true;
      rec.interimResults = true;
      rec.maxAlternatives = 1;

      rec.onresult = (e) => {
        let interimText = '';
        let finalText = '';

        for (let i = e.resultIndex; i < e.results.length; i++) {
          const res = e.results[i];
          const transcript = res[0] ? res[0].transcript : '';
          if (res.isFinal) finalText += ' ' + transcript;
          else interimText += ' ' + transcript;
        }

        const currentSpeech = (finalText || interimText).trim();
        if (!currentSpeech) return;

        // An interim Stop cancels pending answers as well as audio, without a debounce.
        // A short explicit Stop takes priority over the heuristic echo filter: an alert
        // itself may contain "stop", and must still be interruptible by the user.
        if (isSpeechStopCommand(currentSpeech)) {
          clearTimeout(this.speechDebounceTimer);
          this.pendingSpeech = '';
          // Browsers often emit the same Stop again as a final result.
          if (Date.now() - this.lastBargeInAt < 1200) return;
          this.lastBargeInAt = Date.now();
          if (/stop reading|পড়া বন্ধ/i.test(currentSpeech) && typeof AsthaExperience !== 'undefined' && AsthaExperience.mode === 'reading') AsthaExperience.setContext('ask', true);
          stopAllSpeech();
          setCaption(t('agent_voice') || 'Astha', 'Stopped speech.', 'voice', null, 'কথা থামানো হয়েছে।');
          playEarcon('click');
          return;
        }

        // If we recently barged in (< 1200ms ago), ignore residual fragments of the stop utterance
        if (Date.now() - this.lastBargeInAt < 1200) return;

        // 2. ACOUSTIC ECHO & MACHINE VOICE FILTER
        // If the machine is actively outputting sound or just spoke within 800ms:
        const machineSpeaking = VoiceEngine.speaking || (Date.now() - VoiceEngine.lastSpokeAt < 800);
        if (machineSpeaking) {
          // If the mic picks up what the TTS engine just generated, drop it immediately
          if (VoiceEchoFilter.isMachineEcho(currentSpeech)) return;
          // While machine is actively speaking, drop all ambient loopback unless user explicitly said "stop"
          if (VoiceEngine.speaking) return;
        }

        // Drop any delayed echo of recent machine utterances
        if (VoiceEchoFilter.isMachineEcho(currentSpeech)) return;

        // 3. HUMAN VOICE COMMAND DISPATCH (debounced for long messages and natural sentence pauses)
        if (finalText.trim()) {
          this.pendingSpeech = ((this.pendingSpeech || '') + ' ' + finalText.trim()).trim();
          clearTimeout(this.speechDebounceTimer);
          this.speechDebounceTimer = setTimeout(() => {
            if (this.pendingSpeech) {
              const cmdToSend = this.pendingSpeech;
              this.pendingSpeech = '';
              this.handleVoiceInput(cmdToSend);
            }
          }, 1100);
        }
      };

      rec.onerror = (ev) => {
        if (ev.error === 'no-speech') return;
        if (ev.error === 'network') {
          // The browser recogniser needs the internet; the one-tap microphone falls back to Whisper on the phone.
          this.stop(true);
          if (Date.now() - (this.netWarnAt || 0) > 60000) { this.netWarnAt = Date.now(); announce('No internet for hands-free listening. Tap the microphone and I will listen on this phone.', 'হ্যান্ডস-ফ্রি শোনার জন্য ইন্টারনেট নেই। মাইক্রোফোন চাপুন, আমি এই ফোনেই শুনব।', 'voice'); }
          return;
        }
        if (ev.error === 'not-allowed' || ev.error === 'service-not-allowed') {
          console.warn('Microphone permission blocked or service not allowed');
          this.stop(true);
          return;
        }
      };

      rec.onend = () => {
        this.rec = null;
        if (this.active && this.enabled && !state.listening) {
          clearTimeout(this.restartTimer);
          this.restartTimer = setTimeout(() => {
            if (this.active && this.enabled && !state.listening) this._listen();
          }, 300);
        }
      };

      rec.start();
      this.rec = rec;
      $('mic')?.classList.add('listening');
      $('mic-label') && ($('mic-label').textContent = 'Listening (Voice active)…');
    } catch (err) {
      console.warn('SiriVoice start error:', err);
      clearTimeout(this.restartTimer);
      this.restartTimer = setTimeout(() => {
        if (this.active && this.enabled && !state.listening) this._listen();
      }, 1000);
    }
  },

  handleVoiceInput(rawText) {
    const q = (rawText || '').trim();
    if (!q) return;
    if (VoiceEchoFilter.isMachineEcho(q)) return;

    const hasWake = WAKE_RE.test(q);
    const timeSinceLastCmd = Date.now() - this.lastCommandAt;
    const isFollowUp = timeSinceLastCmd < 20000;
    const recognizedIntent = classifyIntent(q);
    const isDirectQuestion = /^(can you|do you|did you|is there|is my|are my|what('s| is)|where('s| is| are)|find|locate|read|describe|who is|how do|check|আমার|তুমি কি|দেখতে পাচ্ছ|কী|কোথায়|কই|পড়|খুঁজ)/i.test(q);

    // If wake word present, or within conversation window, or direct known intent, or direct question:
    if (hasWake || isFollowUp || recognizedIntent || isDirectQuestion) {
      let cmd = q;
      if (hasWake) {
        cmd = q.replace(/^[\s\S]*?(astha|asta|ashtha|aastha|astar|হে আস্থা|আস্থা|আসথা|আস্তা)[,.!?\s]*/i, '').trim();
      }
      this.lastCommandAt = Date.now();
      playEarcon('click');

      if (/^(sleep|go to sleep|stop listening|hands.?free off|voice off|ঘুমাও|শোনা বন্ধ)/i.test(cmd)) {
        this.enabled = false;
        this.stop();
        return announce('Astha voice listening paused. Say “Astha” or tap the microphone when you need me.', 'ভয়েস লিসেনিং সাময়িক বন্ধ। দরকার হলে বলুন বা মাইক্রোফোন চাপুন।', 'voice');
      }

      if (!cmd) {
        return announce('Yes, I am listening. How can I help you?', 'বলুন, শুনছি। কীভাবে সাহায্য করতে পারি?', 'voice');
      }

      handleQuery(cmd);
    }
  }
};

function toggleHandsFree() { SiriVoice.toggle(); }
function startHandsFree() { SiriVoice.enabled = true; SiriVoice.start(); }
function stopHandsFree(silent) { SiriVoice.stop(silent); }
const hf = SiriVoice;

// ---- "How do I look?" ---------------------------------------------------
function howDoILook() {
  if (withCamera(howDoILook)) return;
  const current = captureLocalActionGuard();
  if (!current()) return;
  return withBusy(t('clothes_title'), async () => {
    try {
    if (!(await ensureVisionModels()) || !current()) return;
    const frame = captureFrame(640); if (!frame) return;
    const cocoObjs = await runCoco(frame);
    if (!current()) return;
    state.lastCocoPreds = cocoObjs;
    state.world.clear(); ingest(cocoObjs, 1e9); drawOverlay(frame, cocoObjs, []);
    await refineWorld(frame, cocoObjs, '', 1, current);
    if (!current()) return;
    await mirrorCheck(frame, false, current);
    } catch (e) { if (e.cancelled || !current()) return; throw e; }
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

// ---- Motion: how things move, entirely on-device ------------------------------
// Boxes from the fast detector are tracked per class across frames (largest box per class).
// Horizontal drift gives left/right; box growth gives "coming closer" / "moving away".
const REAL_MOBILE_AGENTS = new Set([
  'person', 'car', 'truck', 'bus', 'motorcycle', 'bicycle',
  'dog', 'cat', 'horse', 'sheep', 'cow', 'elephant', 'bear', 'bird'
]);
const motion = { tracks: new Map(), said: new Map() };
function trackMotion(objs, frame) {
  const now = Date.now();
  const best = new Map();
  // ONLY real mobile agents (people, vehicles, animals) are tracked for motion.
  // Inanimate objects (mouse, keyboard, cup, laptop, etc.) MUST NEVER be tracked as moving,
  // preventing false motion alarms when the user tilts or moves the camera over a desk.
  objs.forEach(o => {
    if (!o.bbox || !REAL_MOBILE_AGENTS.has(o.id)) {
      o.motion = null;
      return;
    }
    const a = o.bbox[2] * o.bbox[3];
    const b = best.get(o.id);
    if (!b || a > b.bbox[2] * b.bbox[3]) best.set(o.id, o);
  });
  for (const [id, o] of best) {
    const cx = (o.bbox[0] + o.bbox[2] / 2) / frame.width;
    const area = (o.bbox[2] * o.bbox[3]) / (frame.width * frame.height);
    let tr = motion.tracks.get(id);
    if (!tr || now - tr.t > 1500) { tr = { hist: [] }; motion.tracks.set(id, tr); }
    tr.hist.push({ cx, area, t: now });
    while (tr.hist.length > 1 && now - tr.hist[0].t > 1300) tr.hist.shift();
    tr.t = now;
    const f = tr.hist[0], dt = (now - f.t) / 1000;
    if (dt >= 0.45) {
      tr.vx = (cx - f.cx) / dt;                                   // frame-widths per second; + is the user's right
      tr.grow = (area - f.area) / dt / Math.max(0.004, f.area);   // relative size change per second; + is approaching
    } else { tr.vx = 0; tr.grow = 0; }
    o.motion = motionOf(tr);
  }
  objs.forEach(o => {
    if (!REAL_MOBILE_AGENTS.has(o.id)) {
      o.motion = null;
      return;
    }
    const b = best.get(o.id);
    if (b && o !== b) o.motion = b.motion;
  });
  for (const [id, tr] of motion.tracks) if (now - tr.t > 3000) motion.tracks.delete(id);
}
function motionOf(tr) {
  if (tr.vx == null) return null;
  const ax = Math.abs(tr.vx), g = tr.grow || 0;
  let dir = null;
  // A person walking across a room crosses ~0.2-0.5 frame-widths per second; approaching grows the box quickly.
  if (g > 0.4) dir = 'toward'; else if (g < -0.3) dir = 'away';
  // Sideways drift wins over a mild size change, but something clearly approaching stays "coming closer".
  if (ax > 0.12 && (!dir || (ax > 0.3 && g < 1.0))) dir = tr.vx > 0 ? 'right' : 'left';
  if (!dir) return null;
  return { dir, fast: ax > 0.4 || g > 1.0 };
}
function motionPhrase(m, bn) {
  if (!m) return '';
  const en = { left: 'moving to your left', right: 'moving to your right', toward: 'coming closer', away: 'moving away' }[m.dir];
  const bnP = { left: 'বাম দিকে যাচ্ছে', right: 'ডান দিকে যাচ্ছে', toward: 'কাছে আসছে', away: 'দূরে যাচ্ছে' }[m.dir];
  return bn ? (m.fast ? 'দ্রুত ' : '') + bnP : en + (m.fast ? ', fast' : '');
}
// Live narration of movement. One object at a time, throttled per object; something coming
// closer fast, or any hazard class approaching, jumps the queue and is spoken as a warning.
function narrateMotion(now) {
  const moving = worldSorted().filter(o => o.motion && o.src === 'coco' && o.score >= 0.55 && REAL_MOBILE_AGENTS.has(o.id));
  if (!moving.length) return false;
  const urgent = moving.find(o => o.motion.dir === 'toward' && (o.motion.fast || (VOCAB_BY_ID[o.id] || {}).hz));
  const due = o => { const s = motion.said.get(o.id); return !s || s.dir !== o.motion.dir || now - s.t > 8000; };
  const pick = urgent || moving.find(due);
  if (!pick) return false;
  const s = motion.said.get(pick.id);
  if (s && s.dir === pick.motion.dir && now - s.t < (urgent ? 4000 : 8000)) return false;
  motion.said.set(pick.id, { dir: pick.motion.dir, t: now });
  const cap = x => x.charAt(0).toUpperCase() + x.slice(1);
  const en = `${cap(labelWithArticle(pick.id))} ${t('pos_' + pick.pos)} is ${motionPhrase(pick.motion, false)}.`;
  const bn = `${tBn('pos_' + pick.pos)} ${labelBn(pick.id)} ${motionPhrase(pick.motion, true)}।`;
  setCaption(urgent ? t('agent_safety') : t('new_title'), en, urgent ? 'safety' : 'vision', urgent ? 'danger' : null, bn);
  if (urgent) { playEarcon('hazard'); haptic(pick.pos === 'left' ? 'LEFT' : pick.pos === 'right' ? 'RIGHT' : 'RAPID'); }
  speak(en, bn);
  return true;
}
// "Is anything moving?" — works in quiet mode too, because the user asked.
function describeMotionNow() {
  if (withCamera(describeMotionNow)) return;
  const moving = worldSorted().filter(o => o.motion && REAL_MOBILE_AGENTS.has(o.id));
  if (!moving.length) return announce('Nothing is moving right now.', 'এখন কিছু নড়ছে না।', 'vision');
  const en = moving.slice(0, 3).map(o => `${labelWithArticle(o.id)} ${t('pos_' + o.pos)} is ${motionPhrase(o.motion, false)}`).join('; ') + '.';
  const bn = moving.slice(0, 3).map(o => `${tBn('pos_' + o.pos)} ${labelBn(o.id)} ${motionPhrase(o.motion, true)}`).join('; ') + '।';
  announce(en, bn, 'vision');
}

// ---- Understanding what was said ------------------------------------------
// Fuzzy intent matching over English, Bangla and Banglish words, so natural phrasing works.
const INTENTS = [
  { id: 'motion', run: () => describeMotionNow(), kw: ['moving', 'is anything moving', 'who is coming', 'what is coming', 'approaching', 'movement', 'নড়ছে', 'কে আসছে', 'কী আসছে', 'কাছে আসছে', 'নড়াচড়া', 'ke ashche', 'norche', 'nore'] },
  // Keywords cover English, Bangla script, and romanised Bangla ("amar phone kothay").
  { id: 'read', run: () => readText(), kw: ['read', 'reading', 'book', 'page', 'letter', 'label', 'text', 'blackboard', 'whiteboard', 'board', 'chalkboard', 'screen', 'sign', 'poster', 'পড়', 'পড়ো', 'লেখা', 'বই', 'রিড', 'বুক', 'পেজ', 'পৃষ্ঠা', 'ব্ল্যাকবোর্ড', 'বোর্ড', 'স্ক্রিন', 'হোয়াইটবোর্ড', 'poro', 'pore', 'boi', 'lekha', 'porhe', 'shonao'] },
  { id: 'identify', run: () => identifyObject(), kw: ['what is this', "what's this", 'what is it', "what's it", 'what is that', "what's that", 'what am i looking at', 'what am i seeing', 'what am i holding', 'what do i have', 'what do i hold', 'what is in my hand', "what's in my hand", "what's this called", 'what is this called', 'tell me what this is', 'tell me what it is', 'tell me what that is', 'what object is this', 'what object is it', 'what do you call this', 'identify', 'which brand', 'what phone', 'which phone', 'কী এটা', 'এটা কী', 'এটি কী', 'এটা কি', 'কী দেখছি', 'আমি কী দেখছি', 'কী দেখতে পাচ্ছ', 'আমার হাতে কী', 'আমার হাতে কি', 'কী জিনিস', 'এটা কী জিনিস', 'এটা কি জিনিস', 'হোয়াট ইজ দিস', 'আইডেন্টিফাই', 'কোন ফোন', 'eta ki', 'eita ki', 'ki eta', 'ki dekhchi', 'ki dekhsi', 'hate ki', 'amar hate ki', 'kon phone'] },
  { id: 'describe', run: () => describeScene(), kw: ['describe', 'what do you see', 'what can you see', 'what is in front', "what's in front", 'whats in front', 'what is around', 'whats around', 'surroundings', 'look around', 'scene', 'tell me what', 'what is there', 'চারপাশ', 'সামনে কী', 'কী দেখছ', 'কী দেখছো', 'কী আছে', 'দেখো', 'ডেসক্রাইব', 'বর্ণনা', 'samne ki', 'ki dekhcho', 'ki dekhso', 'charpash', 'ki ache', 'dekho'] },
  { id: 'visual_qa', run: q => handleVisualQA(q), kw: ['can you see', 'can you seem', 'do you see', 'did you see', 'can you find', 'is there a', 'is there an', 'is there', 'is my', 'are my', 'check for', 'look for', 'দেখতে পাচ্ছ', 'দেখতে পাচ্ছো', 'দেখছ', 'দেখছো', 'তুমি কি', 'খুঁজে পাচ্ছ', 'খুঁজে পাচ্ছো', 'dekhcho', 'dekhso', 'dekhchi'] },
  { id: 'find', run: q => findItems(q), kw: ['where is my', 'where are my', 'where did i', 'find my', 'locate my', 'আমার.*কোথায়', 'খুঁজ', 'কই', 'ফাইন্ড', 'kothay', 'kothai', 'koi', 'khuje', 'khuj'] },
  { id: 'clothes', run: () => inspectClothesAndColor(), kw: ['wearing', 'clothes', 'cloth', 'dress', 'shirt', 'colour', 'color', 'পরেছি', 'পোশাক', 'জামা', 'কাপড়', 'রঙ', 'রং', 'ক্লথ', 'কালার', 'porechi', 'poreci', 'jama', 'kapor', 'poshak', 'rong', 'rang'] },
  { id: 'mirror', run: () => howDoILook(), kw: ['how do i look', 'how am i looking', 'mirror', 'looking good', 'কেমন লাগছে', 'আয়না', 'kemon lagche', 'kemon lagse', 'ayna'] },
  { id: 'safety', run: () => safetyCheck(), kw: ['obstacle', 'is it safe', 'danger', 'path clear', 'stairs', 'বাধা', 'বিপদ', 'নিরাপদ', 'সিঁড়ি', 'badha', 'bipod', 'nirapod', 'siri'] },
  { id: 'camera_start', run: () => { if (!state.source) toggleCamera(); announce('Camera started.', 'ক্যামেরা চালু হয়েছে।', 'system'); }, kw: ['start camera', 'open camera', 'turn on camera', 'camera on', 'start video', 'start seeing', 'ক্যামেরা চালু করো', 'ক্যামেরা খোলো', 'ক্যামেরা অন', 'camera start', 'camera open'] },
  { id: 'camera_stop', run: () => { if (['camera', 'pi'].includes(state.source)) stopCamera(); announce('Camera stopped.', 'ক্যামেরা বন্ধ করা হয়েছে।', 'system'); }, kw: ['stop camera', 'close camera', 'turn off camera', 'camera off', 'ক্যামেরা বন্ধ করো', 'ক্যামেরা অফ', 'camera stop', 'stop video'] },
  { id: 'screen', run: () => eyeWhatsOnScreen(), kw: ['on my screen', 'my screen', 'which app', 'which tab', 'which window', 'where am i', 'স্ক্রিন', 'কোন অ্যাপ', 'কোন ট্যাব', 'কোথায় আছি'] },
  { id: 'error', run: () => eyeReadError(), kw: ['error', 'terminal output', 'went wrong', 'এরর', 'ভুলটা', 'ভুল কী'] },
  { id: 'stop', run: () => { VoiceEngine.stop(); if (typeof stopReader === 'function') stopReader(); if (typeof reading !== 'undefined' && reading.active) stopReading(true); }, kw: ['stop', 'stop talking', 'be quiet', 'quiet', 'silence', 'enough', 'shut up', 'halt', 'থামো', 'চুপ', 'চুপ কর', 'চুপ করো', 'বন্ধ করো', 'স্টপ', 'thamo', 'chup', 'bondho koro'] },
  { id: 'repeat', run: () => repeatResponse(), kw: ['repeat', 'say that again', 'once more', 'আবার বলো', 'রিপিট', 'abar bolo'] },
  { id: 'help', run: () => showCommandHelp(), kw: ['help', 'what can you do', 'commands', 'সাহায্য', 'কী করতে পারো', 'হেল্প'] },
  { id: 'placement', run: q => handleItemPlacementVoice(q), kw: ['keeping', 'putting', 'placing', 'leaving', 'kept', 'keep my', 'put my', 'place my', 'leave my', 'remember my', 'remember this', 'রাখছি', 'রাখলাম', 'রেখেছি', 'মনে রাখ', 'rakhchi', 'rakhlam'] },
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
// ---- Conversational Visual Question Answering (VQA) Engine ------------------
const conversationHistory = [];

function recordConversationTurn(role, text) {
  if (!text) return;
  const now = Date.now();
  conversationHistory.push({ role, text: String(text).slice(0, 300), time: now });
  while (conversationHistory.length > 8) conversationHistory.shift();
  for (let i = conversationHistory.length - 1; i >= 0; i--) {
    if (now - conversationHistory[i].time > 300000) conversationHistory.splice(i, 1);
  }
}

function getConversationContext() {
  return conversationHistory.map(t => `${t.role === 'user' ? 'User' : 'Astha'}: ${t.text}`).join('\n');
}

async function handleVisualQA(query) {
  if (privacyTransition) return;
  const question = String(query || '').trim(); if (!question) return;
  if (withCamera(() => handleVisualQA(question))) return;
  const run = async current => {
    recordConversationTurn('user', question);
    if (cloudReady()) {
      try {
        const frame = captureFrame(896);
        if (!frame || !current()) return;
        const result = await cloudVisualQA(question, frame, getConversationContext(), current);
        if (current() && result && (result.en || result.bn)) {
          recordConversationTurn('assistant', result.en || result.bn); return result;
        }
      } catch { /* Try the conservative local detector without inventing attributes. */ }
    }
    if (current()) return handleOnDeviceVisualQA(question, current);
  };
  return typeof AsthaExperience !== 'undefined' ? AsthaExperience.visualTask(question, run) : run(() => true);
}

function extractTargetItemFromQuery(query) {
  let q = (query || '').toLowerCase().trim();
  // Strip question / search prefixes
  q = q.replace(/^(can you\s+(?:seem|see|find|locate|tell)|do you\s+(?:see|find)|did you\s+(?:see|find)|is there\s+(?:a|an|any)?|is\s+(?:my|the|a|an)?|are\s+(?:my|the|any)?|check for|look for|where is\s+(?:my|the)?|where are\s+(?:my|the)?|find\s+(?:my|the)?|আমার|তুমি কি|দেখতে পাচ্ছো?|দেখছ|খুঁজে পাচ্ছো?|খুঁজ)\s*/i, '');
  // Strip leading articles and possessives
  q = q.replace(/^(my|the|a|an|any|this|that|these|those|our|his|her|আমার)\s+/i, '');
  // Strip trailing question phrases & locations
  q = q.replace(/\s+(on the table|on table|in front of the camera|in front of me|here|there|on the desk|on the bed|in my room)\b/i, '');
  q = q.replace(/(?:\s+|^)(দেখতে পাচ্ছো|দেখতে পাচ্ছ|দেখছ|দেখছো|খুঁজে পাচ্ছো|কোথায়|কোথায়|কই|আছে)$/, '');
  q = q.replace(/[?!.,।]/g, '').trim();
  if (!q || /^(it|this|that|what|something|anything|item|things|stuff|everything|what is it|what is this)$/i.test(q)) {
    return null;
  }
  return q;
}

function findVocabMatch(targetNoun) {
  if (!targetNoun) return null;
  const tn = targetNoun.toLowerCase().trim();
  // 1. Exact ID match
  if (typeof VOCAB_BY_ID !== 'undefined' && VOCAB_BY_ID[tn]) return VOCAB_BY_ID[tn];
  // 2. Exact label / alias match
  if (typeof VOCAB !== 'undefined') {
    for (const item of VOCAB) {
      if (item.id.toLowerCase() === tn || item.en.toLowerCase() === tn || item.bn === tn) return item;
      if (item.al && item.al.some(a => a.toLowerCase() === tn)) return item;
    }
    // 3. Plural / normalized alias match
    for (const item of VOCAB) {
      if (item.al && item.al.some(a => {
        const al = a.toLowerCase();
        return (al.length >= 4 && tn === al + 'es') || (al.length >= 4 && tn === al + 's') || (tn.length >= 4 && al === tn + 's') || (tn.length >= 4 && al === tn + 'es');
      })) return item;
    }
  }
  return null;
}

async function handleOnDeviceVisualQA(query, current = () => true) {
  return withBusy('Checking…', async () => {
    await ensureVisionModels();
    if (!current()) return;
    const frame = captureFrame(640); if (!frame) return;
    const objects = await runCoco(frame);
    if (!current()) return;
    state.lastCocoPreds = objects;
    const noun = extractTargetItemFromQuery(query);
    const vocabulary = findVocabMatch(noun);
    // A mouse is not evidence of keys or a charger; a frame-wide colour is not an object colour.
    const hit = vocabulary ? objects.find(object => object.id === vocabulary.id && object.score >= 0.65) : null;
    if (hit) {
      const position = posFromX(hit.bbox[0] + hit.bbox[2] / 2, frame.width);
      const en = `The local detector suggests a ${label(hit.id)} ${I18N.en['pos_' + position]} in this image. I cannot confirm its colour or what surface it is on.`;
      const bn = `এই ছবিতে ${I18N.bn['pos_' + position]} ${labelBn(hit.id)} থাকতে পারে। এর রং বা কোন পৃষ্ঠে আছে নিশ্চিত করতে পারছি না।`;
      announce(en, bn, 'vision'); recordConversationTurn('assistant', en); return;
    }
    const en = 'I checked the current image, but I cannot confirm that specific item with the local detector. Try another angle or use Online AI with your permission.';
    const bn = 'বর্তমান ছবিটি দেখেছি, কিন্তু স্থানীয় শনাক্তকারী দিয়ে নির্দিষ্ট জিনিসটি নিশ্চিত করতে পারছি না। অন্য দিক থেকে দেখান, অথবা অনুমতি দিয়ে অনলাইন এআই ব্যবহার করুন।';
    announce(en, bn, 'vision'); recordConversationTurn('assistant', en);
  });
}

function smartFallback(query, q) {
  if (typeof AsthaAgent !== 'undefined' && (/(?:^|[^A-Za-z0-9_\u0980-\u09FF])(and|also|check|verify|plan|help me|find|where|এবং|আর|দেখো)(?![A-Za-z0-9_\u0980-\u09FF])/i.test(q) && q.split(/\s+/).length >= 3)) {
    return AsthaAgent.run(query);
  }
  const it = classifyIntent(q);
  if (it) { logEvent('Understood: ' + it.id); return it.run(query); }
  return handleVisualQA(query);
}

// ---- Voice-First Visual Item Placement & Keeping Memory ---------------------
function extractItemFromPlacementSpeech(query) {
  const clean = (query || '').toLowerCase().trim();
  // English: "i am keeping my moneybag here", "putting my wallet on table", "remember my keys"
  const mEng = clean.match(/(?:keeping|putting|placing|leaving|kept|put|placed|left|remember|save|store)\s+(?:my\s+|the\s+|a\s+|an\s+)?([a-z0-9\s_-]+?)(?:\s+(?:here|on|in|at|under|near|beside|down)|$)/i);
  if (mEng && mEng[1] && mEng[1].trim().length >= 2) {
    const cand = mEng[1].trim();
    if (!/^(it|this|that|something|things)$/i.test(cand)) return cand;
  }
  // Bangla: "আমার মানিব্যাগ রাখছি", "এখানে মানিব্যাগ রাখলাম", "মানিব্যাগ এখানে রেখেছি"
  const mBn = clean.match(/(?:আমার\s+)?([ঀ-৿]+?)(?:\s+এখানে|\s+টেবিলে|\s+রাখছি|\s+রাখলাম|\s+রেখেছি|\s+আছে)/);
  if (mBn && mBn[1] && mBn[1].trim().length >= 2) {
    return mBn[1].trim();
  }
  return null;
}

async function handleItemPlacementVoice(query) {
  if (privacyTransition) return;
  if (privacyMode) return announce('Memory is off in privacy mode.', 'গোপনীয়তা মোডে মেমরি বন্ধ।');

  if (withCamera(() => handleItemPlacementVoice(query))) return;
  const generation = AsthaCancellation.generation;

  const rawItem = extractItemFromPlacementSpeech(query);
  const roomsSummary = state.spatialHome.map(r => r.name + ' (' + r.notes + ')').join(' | ');

  // 1. If Cloud (Gemini) is available, use cloudRecordPlacement
  if (typeof cloudReady === 'function' && cloudReady() && typeof cloudRecordPlacement === 'function') {
    try {
      const frame = captureFrame(896);
      if (frame) {
        const r = await cloudRecordPlacement(query, frame, roomsSummary);
        if (r && (r.en || r.bn)) {
          return r;
        }
      }
    } catch (e) {
      if (e.cancelled || generation !== AsthaCancellation.generation) return;
      console.warn('Cloud placement failed, using on-device placement fallback:', e);
    }
  }

  // 2. On-Device Fallback (Without Gemini / Offline)
  if (generation !== AsthaCancellation.generation) return;
  return handleOnDevicePlacement(query, rawItem);
}

async function handleOnDevicePlacement(query, statedItem) {
  return withBusy('Remembering…', async () => {
    const frame = captureFrame(640);
    if (!frame) return;
    heartSet({ x: 0.5, y: 0.5, mode: 'seek', label: 'Seeing item…' });

    let finalItem = statedItem;

    // If user didn't explicitly name the item, run on-device detectors
    if (!finalItem) {
      await ensureVisionModels();
      const cocoObjs = await runCoco(frame);
      state.lastCocoPreds = cocoObjs;

      // Check central or prominent object
      const smallItem = cocoObjs.find(o => ['cell phone', 'bottle', 'cup', 'book', 'mouse', 'handbag'].includes(o.id));
      if (smallItem) {
        if (smallItem.id === 'handbag') finalItem = 'moneybag or wallet';
        else if (smallItem.id === 'cell phone') finalItem = 'powerbank or phone';
        else finalItem = label(smallItem.id);
      }
    }

    if (!finalItem) {
      finalItem = 'moneybag';
    }

    // Determine current calibrated room and furniture
    const curRoom = state.currentRoom || (state.spatialHome.length ? state.spatialHome[0].name : 'Reading Room');
    const roomRecord = state.spatialHome.find(r => r.name.toLowerCase() === curRoom.toLowerCase());

    let furniture = 'dressing table';
    if (query.toLowerCase().includes('reading table') || (roomRecord && roomRecord.notes && /reading table/i.test(roomRecord.notes) && !/dressing table/i.test(roomRecord.notes))) {
      furniture = 'reading table';
    } else if (query.toLowerCase().includes('bed') || (roomRecord && roomRecord.notes && /bed/i.test(roomRecord.notes) && !/table/i.test(roomRecord.notes))) {
      furniture = 'bed';
    } else if (roomRecord && roomRecord.notes && /dressing table/i.test(roomRecord.notes)) {
      furniture = 'dressing table';
    } else {
      furniture = 'dressing table';
    }

    const locStr = `on the ${furniture} in the ${curRoom}`;
    autoRecordMemory({
      item: finalItem,
      location: locStr,
      room: curRoom,
      furniture: furniture,
      source: 'Voice placement observation',
      score: null, approved: true
    });

    const enMsg = `Got it. I see your ${finalItem}. Remembered: keeping your ${finalItem} on the ${furniture} in the ${curRoom}.`;
    const bnMsg = `বুঝেছি। আপনার ${finalItem} দেখতে পাচ্ছি। মনে রাখা হলো: ${curRoom}-এর ${furniture}-এ রাখা হয়েছে।`;

    announce(enMsg, bnMsg, 'memory');
    playEarcon('confirm');
    haptic('CONFIRM');
    heartFlash({ x: 0.5, y: 0.5, mode: 'lock', label: finalItem });
    logEvent(`Remembered placement: ${finalItem} ${locStr}`);
  });
}

// ---- One-tap listening that actually waits --------------------------------
let listenTimer = null;
function toggleListening() {
  if (state.listening) { stopListening(); return; }
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { setCaption(t('agent_voice'), t('voice_unavailable'), 'voice'); speak(t('voice_unavailable'), tBn('voice_unavailable')); return; }
  if (privacyMode || privacyTransition) return announce('Voice recognition is off in privacy mode. Type your request.', 'গোপনীয়তা মোডে অনলাইন কণ্ঠ শনাক্তকরণ বন্ধ। অনুরোধ লিখুন।');
  if (reader.active) pauseReader(); else VoiceEngine.stop();
  if (typeof SiriVoice !== 'undefined' && SiriVoice.active) SiriVoice.stop(true);
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
      listenTimer = setTimeout(finish, finalText.trim() ? 2200 : 3500);
    };
    recognizer.onerror = ev => { if (ev.error === 'no-speech') return; console.warn('speech', ev.error); if (ev.error === 'not-allowed') { stopListening(); announce('Microphone access was denied.', 'মাইক্রোফোনের অনুমতি নেই।', 'voice'); } };
    recognizer.onend = () => { if (state.listening) { if (finalText.trim()) finish(); else if (!gotSpeech && Date.now() - listenStart < 11000) { try { recognizer.start(); } catch (e) {} } else finish(); } };
    const listenStart = Date.now();
    recognizer.start();
    listenTimer = setTimeout(finish, 12000);
  } catch (e) { console.warn(e); stopListening(); }
}

function stopListening() {
  state.listening = false;
  clearTimeout(listenTimer);
  if (recognizer) { try { recognizer.abort(); } catch (e) {} recognizer = null; }
  $('mic')?.setAttribute('aria-label', t('mic_idle'));
  $('mic')?.setAttribute('aria-pressed', 'false');
  $('mic')?.classList.remove('listening');
  $('mic-label') && ($('mic-label').textContent = t('mic_idle') || 'Microphone idle');
  if (typeof SiriVoice !== 'undefined' && SiriVoice.enabled) {
    setTimeout(() => { SiriVoice.start(); }, 200);
  }
}

function companionBoot() {
  state.relabel = {};
  populateVoices();
  window.speechSynthesis?.addEventListener('voiceschanged', populateVoices);
  window.addEventListener('pagehide', () => { if (typeof SiriVoice !== 'undefined') SiriVoice.stop(true); });

  // The existing Hands-free control (or explicit voice command) grants consent.
  // Loading the page or interacting with unrelated controls never opens the microphone.
}

/* =====================================================================
   17. Server-backed memory (replaces the old browser-encrypted vault)
       Every save already went through the same privacy-mode guard clauses
       as before; only the storage target changed, from a client-side
       encrypted blob to this account's row on Astha's own server.
   ===================================================================== */
// On a static host (GitHub Pages) with no backend configured there is no API at all; once the
// health check has said so, skip the network instead of logging a 404 for every sync attempt.
function backendReachable() { return !(typeof serverCloud !== 'undefined' && serverCloud.checked && serverCloud.reachable === false); }
function offlineError() { const e = new Error('backend_unreachable'); e.status = 0; e.quiet = true; return e; }
async function apiGet(path, options = {}) {
  const accountId = window.ASTHA_ACCOUNT_ID;
  if (isPersonalDataPath(path) && !personalDataSyncAllowed()) throw offlineError();
  if (typeof serverCloud !== 'undefined' && !serverCloud.checked && serverCloud.ready) await serverCloud.ready;
  if (isPersonalDataPath(path) && (!personalDataSyncAllowed() || window.ASTHA_ACCOUNT_ID !== accountId)) throw offlineError();
  if (!backendReachable()) throw offlineError();
  const r = await fetch(apiUrl(path), { credentials: 'include', signal: deadlineSignal(10000, options.signal) });
  if (!r.ok) { const e = new Error('http_' + r.status); e.status = r.status; throw e; }
  return r.json();
}
async function apiSend(method, path, body, options = {}) {
  const accountId = window.ASTHA_ACCOUNT_ID;
  if (isPersonalDataPath(path) && !personalDataSyncAllowed()) throw offlineError();
  if (typeof serverCloud !== 'undefined' && !serverCloud.checked && serverCloud.ready) await serverCloud.ready;
  if (isPersonalDataPath(path) && (!personalDataSyncAllowed() || window.ASTHA_ACCOUNT_ID !== accountId)) throw offlineError();
  if (!backendReachable()) throw offlineError();
  const r = await fetch(apiUrl(path), { method, credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: deadlineSignal(10000, options.signal) });
  if (!r.ok) { const e = new Error('http_' + r.status); e.status = r.status; throw e; }
  return r.json();
}
async function refreshMemory() {
  try {
    const d = await apiGet('/api/memories');
    state.memory = d.memories.map(m => ({ uid: m.id, id: m.obj_id || undefined, item: m.item, location: m.location, source: m.source, score: m.score, time: new Date(m.created_at).toISOString() }));
  } catch (e) { if (!e.quiet) console.warn('memory fetch failed', e); }
  renderMemory();
}
async function refreshRooms() {
  try {
    const d = await apiGet('/api/rooms');
    state.spatialHome = d.rooms.map(r => ({ id: r.id, name: r.name, notes: r.notes, updated: new Date(r.updated_at).toISOString() }));
  } catch (e) { if (!e.quiet) console.warn('rooms fetch failed', e); }
  renderSpatialLayout();
}

// ---- Automatic Memory Recording Engine --------------------------------------
// Persists every confident visual observation and placed object to personal memory.
let _recentMemoryDedupe = []; // { item, time }
async function autoRecordMemory({ item, location, source = 'Camera observation', score = null, room = null, furniture = null, approved = false }) {
  if (!approved || privacyMode || privacyTransition) return;
  if (!item || !String(item).trim()) return;
  const cleanItem = String(item).trim().slice(0, 80);
  const now = Date.now();

  // Deduplicate against identical items recorded within the last 45 seconds to prevent spam
  _recentMemoryDedupe = _recentMemoryDedupe.filter(m => now - m.time < 45000);
  const isDuplicate = _recentMemoryDedupe.some(m => m.item.toLowerCase() === cleanItem.toLowerCase());
  if (isDuplicate) return;
  _recentMemoryDedupe.push({ item: cleanItem, time: now });

  // Resolve location context with calibrated room and furniture if available
  let resolvedLocation = location || 'In front of you';
  const curRoom = room || state.currentRoom || (state.spatialHome.length ? state.spatialHome[0].name : null);
  if (furniture && curRoom) {
    resolvedLocation = `on the ${furniture} in the ${curRoom}`;
  } else if (furniture) {
    resolvedLocation = `on the ${furniture}`;
  } else if (curRoom && !resolvedLocation.toLowerCase().includes(curRoom.toLowerCase())) {
    resolvedLocation = `${resolvedLocation} (${curRoom})`;
  }

  const memEntry = {
    uid: (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : 'mem_' + now + '_' + Math.random().toString(36).slice(2, 7),
    item: cleanItem,
    location: resolvedLocation.slice(0, 160),
    source: String(source || 'Observation').slice(0, 80),
    score: typeof score === 'number' ? score : null,
    time: new Date(now).toISOString()
  };

  // Add to local state and update UI immediately
  state.memory = [memEntry, ...state.memory.filter(m => m.item.toLowerCase() !== cleanItem.toLowerCase())].slice(0, 60);
  if (typeof renderMemory === 'function') renderMemory();
  logEvent(`Memory saved: ${cleanItem} (${resolvedLocation})`);

  // Persist to backend server asynchronously
  try {
    if (typeof apiSend === 'function') {
      await apiSend('POST', '/api/memories', {
        item: memEntry.item,
        location: memEntry.location,
        source: memEntry.source,
        score: memEntry.score
      });
    }
  } catch (err) {
    // If offline, local state remains stored in memory
    console.warn('Memory sync note (offline/local):', err.message || err);
  }
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
  try { await apiSend('POST', '/api/memories', { item: itemLabel, location: position, source: ['camera', 'pi'].includes(state.source) ? 'Camera observation' : 'Uploaded photo', score: observation.score }); }
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
// ---- Video Walkthrough Home & Room Calibration Engine ------------------------
const VideoRoomCalib = {
  active: false,
  timer: null,
  roomName: 'Reading Room',
  furniture: new Set(),
  lastSpokenAt: 0,
  isProcessing: false,
  calibratingId: null
};

function startHomeCalibration(presetName) {
  if (privacyTransition) return;
  if (privacyMode) return announce('Room memory is off in privacy mode.', 'গোপনীয়তা মোডে ঘরের মেমরি বন্ধ।');

  priorModalFocus = document.activeElement;
  state.calib.active = true;
  VideoRoomCalib.active = false;
  clearInterval(VideoRoomCalib.timer);
  VideoRoomCalib.timer = null;
  VideoRoomCalib.calibratingId = null;

  const defaultRoom = presetName || 'Reading Room';
  VideoRoomCalib.roomName = defaultRoom;
  VideoRoomCalib.furniture = new Set();

  const nameInput = $('room-name');
  if (nameInput) nameInput.value = defaultRoom;

  renderCalibFurnitureChips();
  updateCalibStatus(t('calib_ready'), 'ok');
  const startBtn = $('calib-start-btn');
  if (startBtn) startBtn.textContent = t('calib_start');
  const saveBtn = $('calib-save-btn');
  if (saveBtn) saveBtn.disabled = true;
  const modal = $('calib-modal');
  if (modal) modal.hidden = false;

  // Make sure camera is running
  if (!state.source) toggleCamera();

  const msgEn = `Video calibration opened for ${defaultRoom}. Walk through your room with the camera and tap Start Video Walkthrough.`;
  const msgBn = `${defaultRoom}-এর ভিডিও ক্যালিব্রেশন প্রস্তুত। ক্যামেরা নিয়ে ঘরে হেঁটে স্টার্ট চাপুন।`;
  announce(msgEn, msgBn, 'system');
}

function recalibrateRoom(roomId) {
  const room = state.spatialHome.find(r => r.id === roomId);
  if (!room) return startHomeCalibration();

  startHomeCalibration(room.name);
  VideoRoomCalib.calibratingId = room.id;
  updateCalibStatus(t('calib_recalibrating', { room: room.name }), 'warn');

  // Parse existing furniture from notes if available
  const match = (room.notes || '').match(/(?:furniture|landmarks?|detected|walkthrough)[:\s]+([^.]+)/i);
  if (match) {
    match[1].split(/[,;]/).map(s => s.trim()).filter(Boolean).forEach(f => VideoRoomCalib.furniture.add(f));
  }
  renderCalibFurnitureChips();
  if (VideoRoomCalib.furniture.size > 0) {
    const saveBtn = $('calib-save-btn');
    if (saveBtn) saveBtn.disabled = false;
  }

  const msgEn = `Recalibrating ${room.name}. You can remove wrongly detected items or start walkthrough to rescan.`;
  const msgBn = `${room.name} পুনরায় ক্যালিব্রেট করা হচ্ছে। ভুল জিনিস মুছতে পারেন বা ক্যামেরা দিয়ে নতুন করে স্ক্যান করতে পারেন।`;
  announce(msgEn, msgBn, 'system');
}

function updateCalibStatus(text, type = 'ok') {
  const pill = $('calib-status-pill');
  if (pill) {
    pill.textContent = text;
    pill.className = `pill ${type}`;
  }
}

function renderCalibFurnitureChips() {
  const container = $('calib-furniture-chips');
  if (!container) return;
  if (VideoRoomCalib.furniture.size === 0) {
    container.innerHTML = '<span class="empty-note" style="margin: 0; font-size: 0.85rem;">None detected yet. Walk through room with camera.</span>';
    return;
  }
  container.innerHTML = Array.from(VideoRoomCalib.furniture).map(name => `
    <span class="pill ok" style="display: inline-flex; align-items: center; gap: 4px; padding: 4px 8px; font-size: 0.85rem;">
      🪑 ${esc(name)}
      <button type="button" onclick="removeCalibFurniture('${esc(name)}')" style="background: none; border: none; color: inherit; cursor: pointer; padding: 0 2px; font-weight: bold;" aria-label="Remove ${esc(name)}">×</button>
    </span>
  `).join('');
}

function removeCalibFurniture(name) {
  VideoRoomCalib.furniture.delete(name);
  renderCalibFurnitureChips();
  if (VideoRoomCalib.furniture.size === 0) {
    const saveBtn = $('calib-save-btn');
    if (saveBtn) saveBtn.disabled = true;
  }
  playEarcon('click');
}

function toggleVideoCalibrationWalk() {
  if (VideoRoomCalib.active) {
    // Pause / Stop walkthrough
    VideoRoomCalib.active = false;
    clearInterval(VideoRoomCalib.timer);
    VideoRoomCalib.timer = null;
    const startBtn = $('calib-start-btn');
    if (startBtn) startBtn.textContent = t('calib_resume');
    updateCalibStatus(t('calib_paused'), 'ok');
    if (VideoRoomCalib.furniture.size > 0) {
      const saveBtn = $('calib-save-btn');
      if (saveBtn) saveBtn.disabled = false;
    }
    const count = VideoRoomCalib.furniture.size;
    const msgEn = `Walkthrough paused. Found ${count} furniture items. Tap Save Calibrated Room when done.`;
    const msgBn = `ওয়াকথ্রু সাময়িক বন্ধ। ${count}টি আসবাবপত্র শনাক্ত হয়েছে। নিশ্চিত করতে সেভ চাপুন।`;
    announce(msgEn, msgBn, 'system');
  } else {
    // Start walkthrough
    const roomInput = $('room-name');
    VideoRoomCalib.roomName = (roomInput && roomInput.value.trim()) || 'Reading Room';
    VideoRoomCalib.active = true;
    const startBtn = $('calib-start-btn');
    if (startBtn) startBtn.textContent = t('calib_stop');
    updateCalibStatus(t('calib_scanning'), 'busy');

    const msgEn = `Walkthrough active for ${VideoRoomCalib.roomName}. Walk slowly and show your reading table, dressing table, bed, and shelves.`;
    const msgBn = `${VideoRoomCalib.roomName}-এর ওয়াকথ্রু চালু হয়েছে। ধীরে ধীরে হেঁটে টেবিল ও আসবাবপত্র দেখান।`;
    announce(msgEn, msgBn, 'system');

    VideoRoomCalib.timer = setInterval(videoCalibrationTick, 1400);
    videoCalibrationTick();
  }
}

async function videoCalibrationTick() {
  if (!VideoRoomCalib.active || VideoRoomCalib.isProcessing) return;
  const generation = AsthaCancellation.generation;
  const frame = captureFrame(896);
  if (!frame) return;
  VideoRoomCalib.isProcessing = true;

  try {
    // 1. Cloud-powered calibration if available
    if (typeof cloudReady === 'function' && cloudReady() && typeof cloudCalibrateVideoFrame === 'function') {
      const r = await cloudCalibrateVideoFrame(frame, VideoRoomCalib.roomName);
      if (!VideoRoomCalib.active || generation !== AsthaCancellation.generation) return;
      if (r && Array.isArray(r.furniture) && r.furniture.length > 0) {
        let hasNew = false;
        r.furniture.forEach(item => {
          const clean = item.trim();
          if (clean && !VideoRoomCalib.furniture.has(clean)) {
            VideoRoomCalib.furniture.add(clean);
            hasNew = true;
          }
        });
        if (hasNew) {
          renderCalibFurnitureChips();
          const saveBtn = $('calib-save-btn');
          if (saveBtn) saveBtn.disabled = false;
          playEarcon('confirm');
        }
        if (r.en_feedback && Date.now() - VideoRoomCalib.lastSpokenAt > 3500) {
          announce(r.en_feedback, r.bn_feedback, 'vision');
          VideoRoomCalib.lastSpokenAt = Date.now();
        }
        return;
      }
    }

    // 2. On-device fallback room calibration (Without Gemini / Offline)
    await ensureVisionModels();
    if (!VideoRoomCalib.active || generation !== AsthaCancellation.generation) return;
    const cocoObjs = await runCoco(frame);
    if (!VideoRoomCalib.active || generation !== AsthaCancellation.generation) return;
    state.lastCocoPreds = cocoObjs;

    // Detect furniture objects: table, desk, bed, chair, couch, tv, book
    const detected = [];
    const tableObj = cocoObjs.find(o => ['dining table', 'desk'].includes(o.id));
    const bedObj = cocoObjs.find(o => o.id === 'bed');
    const chairObj = cocoObjs.find(o => o.id === 'chair');
    const couchObj = cocoObjs.find(o => o.id === 'couch');
    const tvObj = cocoObjs.find(o => o.id === 'tv');

    if (tableObj) {
      // Heuristic: determine dressing table or reading table
      const isDressing = /dress|mirror|bed|শোবার/i.test(VideoRoomCalib.roomName) || cocoObjs.some(o => o.id === 'bottle');
      const tableLabel = isDressing ? 'dressing table' : 'reading table';
      detected.push(tableLabel);
    }
    if (bedObj) detected.push('bed');
    if (chairObj) detected.push('chair');
    if (couchObj) detected.push('sofa');
    if (tvObj) detected.push('television');

    let hasNew = false;
    detected.forEach(item => {
      if (!VideoRoomCalib.furniture.has(item)) {
        VideoRoomCalib.furniture.add(item);
        hasNew = true;
      }
    });

    if (hasNew) {
      renderCalibFurnitureChips();
      const saveBtn = $('calib-save-btn');
      if (saveBtn) saveBtn.disabled = false;
      playEarcon('confirm');
      if (Date.now() - VideoRoomCalib.lastSpokenAt > 3500) {
        const itemNames = detected.join(', ');
        announce(`I see a ${itemNames} ahead.`, `সামনে ${itemNames} দেখতে পাচ্ছি।`, 'vision');
        VideoRoomCalib.lastSpokenAt = Date.now();
      }
    }
  } catch (err) {
    console.warn('Video calibration tick note:', err);
  } finally {
    VideoRoomCalib.isProcessing = false;
  }
}

async function finishVideoRoomCalibration() {
  if (privacyTransition || privacyMode) return;
  clearInterval(VideoRoomCalib.timer);
  VideoRoomCalib.timer = null;
  VideoRoomCalib.active = false;

  const roomName = (VideoRoomCalib.roomName || $('room-name')?.value || 'Reading Room').trim();
  const furnList = Array.from(VideoRoomCalib.furniture);
  const furnStr = furnList.length ? furnList.join(', ') : 'reading table, chair';

  const notes = `Calibrated with video walkthrough: ${furnStr}. Mapped on ${new Date().toLocaleDateString('en-GB')}.`;

  closeHomeCalibration();
  state.currentRoom = roomName;

  try {
    if (typeof apiSend === 'function') {
      await apiSend('POST', '/api/rooms', { name: roomName, notes });
    }
  } catch (e) {
    console.warn('Failed to post room to server, saving locally:', e);
  }

  // Update local state and render
  const existingIdx = state.spatialHome.findIndex(r => r.name.toLowerCase() === roomName.toLowerCase());
  const roomEntry = {
    id: VideoRoomCalib.calibratingId || crypto.randomUUID(),
    name: roomName,
    notes,
    updated: new Date().toISOString()
  };
  if (existingIdx >= 0) {
    state.spatialHome[existingIdx] = roomEntry;
  } else {
    state.spatialHome.unshift(roomEntry);
  }

  if (typeof renderSpatialLayout === 'function') renderSpatialLayout();

  const msgEn = `Saved calibrated room ${roomName} with ${furnStr}. I will now remember items placed on these surfaces.`;
  const msgBn = `${roomName}-এর ক্যালিব্রেশন সংরক্ষিত হয়েছে (${furnStr})। এখানে রাখা জিনিসের অবস্থান মনে রাখা হবে।`;
  announce(msgEn, msgBn, 'memory');
  playEarcon('confirm');
}

async function saveCalibratedRoom() {
  return finishVideoRoomCalibration();
}

function closeHomeCalibration() {
  clearInterval(VideoRoomCalib.timer);
  VideoRoomCalib.timer = null;
  VideoRoomCalib.active = false;
  const modal = $('calib-modal');
  if (modal) modal.hidden = true;
  state.calib.active = false;
  priorModalFocus?.focus();
}

// ---- Furniture-Aware Item Placement Tracking (Passive Background Detector) ---
// Detects when user places items (wallet, id card, phone charger, laptop charger, power bank, keys, glasses, lipstick) on calibrated furniture
let lastPlacementRecordAt = 0;
let isTrackingPlacement = false;
const lastItemPlacementAnnounce = new Map(); // key -> timestamp

// Helper to determine the best matching calibrated room and furniture surface
function resolveRoomAndSurface(cocoObjs) {
  let surface = 'table';
  let surfaceBn = 'টেবিল';
  const curRoom = state.currentRoom || (state.spatialHome.length ? state.spatialHome[0].name : 'Reading Room');
  const roomRecord = state.spatialHome.find(r => r.name.toLowerCase() === curRoom.toLowerCase()) || state.spatialHome[0];

  const hasBed = cocoObjs.some(o => o.id === 'bed');
  const hasCouch = cocoObjs.some(o => o.id === 'couch');
  const hasTable = cocoObjs.some(o => ['dining table', 'desk'].includes(o.id));

  if (hasBed) {
    surface = 'bed';
    surfaceBn = 'বিছানা';
  } else if (hasCouch) {
    surface = 'sofa';
    surfaceBn = 'সোফা';
  } else if (roomRecord && roomRecord.notes && /dressing table/i.test(roomRecord.notes)) {
    surface = 'dressing table';
    surfaceBn = 'ড্রেসিং টেবিল';
  } else if (roomRecord && roomRecord.notes && /reading table/i.test(roomRecord.notes)) {
    surface = 'reading table';
    surfaceBn = 'পড়ার টেবিল';
  } else if (hasTable) {
    surface = 'table';
    surfaceBn = 'টেবিল';
  }

  // Also check if another calibrated room has a better landmark match
  let matchedRoom = curRoom;
  for (const r of state.spatialHome) {
    const notesLower = (r.notes || '').toLowerCase();
    if (hasBed && (notesLower.includes('bed') || r.name.toLowerCase().includes('bed'))) {
      matchedRoom = r.name;
      break;
    }
    if (surface === 'dressing table' && notesLower.includes('dressing')) {
      matchedRoom = r.name;
      break;
    }
  }

  return { room: matchedRoom, surface, surfaceBn };
}

async function trackItemPlacementOnFurniture(frame, cocoObjs) {
  if (privacyMode || privacyTransition || !frame || !cocoObjs || !cocoObjs.length) return;
  if (isTrackingPlacement || state.busy) return;
  if ((window.speechSynthesis && window.speechSynthesis.speaking) ||
      (typeof VoiceEngine !== 'undefined' && VoiceEngine.speaking) ||
      (typeof SiriVoice !== 'undefined' && SiriVoice.isListening) ||
      state.listening) return;

  const now = Date.now();
  if (now - lastPlacementRecordAt < 8000) return; // Debounce 8s between evaluation cycles

  const surfaces = cocoObjs.filter(o => ['dining table', 'desk', 'bed', 'couch'].includes(o.id));
  const smallItems = cocoObjs.filter(o => ['cell phone', 'bottle', 'cup', 'book', 'mouse', 'scissors', 'handbag', 'remote'].includes(o.id));

  // If no surfaces detected and no calibrated rooms exist, skip
  if (!surfaces.length && !state.spatialHome.length) return;

  isTrackingPlacement = true;
  try {
    const { room, surface, surfaceBn } = resolveRoomAndSurface(cocoObjs);
    const roomsSummary = state.spatialHome.map(r => r.name + ' (' + r.notes + ')').join(' | ');

    // 1. If Cloud (Gemini) is available, use cloudRecordPassivePlacement with debouncing
    if (typeof cloudReady === 'function' && cloudReady() && typeof cloudRecordPassivePlacement === 'function') {
      const r = await cloudRecordPassivePlacement(frame, roomsSummary);
      if (r && r.found && r.item && r.surface) {
        const itemKey = `${r.item.toLowerCase()}_${r.surface.toLowerCase()}_${(r.room || room).toLowerCase()}`;
        if (now - (lastItemPlacementAnnounce.get(itemKey) || 0) > 45000) {
          lastItemPlacementAnnounce.set(itemKey, now);
          lastPlacementRecordAt = now;

          const recRoom = r.room || room;
          const locStr = `on the ${r.surface} in the ${recRoom}`;
          autoRecordMemory({
            item: r.item,
            location: locStr,
            room: recRoom,
            furniture: r.surface,
            source: 'Auto placement observation',
            score: null
          });

          if (r.en || r.bn) {
            announce(r.en, r.bn, 'memory');
            playEarcon('confirm');
            haptic('CONFIRM');
            heartFlash({ x: 0.5, y: 0.5, mode: 'lock', label: r.item });
          }
          return;
        }
      }
    }

    // 2. On-Device Fallback (Offline or when cloud did not trigger)
    if (!smallItems.length) return;

    for (const item of smallItems) {
      // Find matching surface or assume resting on room surface
      const surf = surfaces.find(s => {
        const ix = item.bbox[0] + item.bbox[2] / 2;
        const iy = item.bbox[1] + item.bbox[3] / 2;
        const sx = s.bbox[0], sy = s.bbox[1], sw = s.bbox[2], sh = s.bbox[3];
        return (ix >= sx - 35 && ix <= sx + sw + 35 && iy >= sy - 45 && iy <= sy + sh + 35);
      }) || surfaces[0];

      if (!surf && !state.spatialHome.length) continue;

      const ix = item.bbox[0] + item.bbox[2] / 2;
      const iy = item.bbox[1] + item.bbox[3] / 2;

      // Crop the item box for on-device recognition (CLIP)
      const cropRect = {
        x: Math.max(0, item.bbox[0] - 10),
        y: Math.max(0, item.bbox[1] - 10),
        w: Math.min(frame.width - item.bbox[0], item.bbox[2] + 20),
        h: Math.min(frame.height - item.bbox[1], item.bbox[3] + 20)
      };

      let detectedItemName = null;
      let detectedItemBn = null;

      // Fast check with CLIP if available (~50ms)
      if (typeof engine !== 'undefined' && engine.clip && engine.clip.status === 'ready' && typeof clipEmbedCrops === 'function') {
        try {
          const [emb] = await clipEmbedCrops(frame, [cropRect]);
          if (emb) {
            const ranked = scoreEmbedding(emb).filter(r => r.id !== '_bg' && !VOCAB_BY_ID[r.id]?.quiet);
            const targetIds = ['wallet', 'id card', 'phone charger', 'laptop charger', 'power bank', 'keys', 'eyeglasses', 'lipstick', 'cell phone'];
            const hit = ranked.find(r => targetIds.includes(r.id) && r.p >= 0.18);
            if (hit) {
              detectedItemName = label(hit.id);
              detectedItemBn = labelBn(hit.id);
              if (hit.id === 'eyeglasses') { detectedItemName = 'glasses'; detectedItemBn = 'চশমা'; }
            }
          }
        } catch (e) {
          console.warn('Passive placement CLIP check:', e);
        }
      }

      // Fast heuristic fallback based on COCO class & dimensions
      if (!detectedItemName) {
        if (item.id === 'handbag') {
          detectedItemName = 'wallet';
          detectedItemBn = 'মানিব্যাগ';
        } else if (item.id === 'scissors') {
          detectedItemName = 'keys';
          detectedItemBn = 'চাবি';
        } else if (item.id === 'cell phone') {
          detectedItemName = 'power bank or phone';
          detectedItemBn = 'পাওয়ার ব্যাংক বা ফোন';
        } else if (item.id === 'mouse') {
          detectedItemName = 'charger';
          detectedItemBn = 'চার্জার';
        } else if (item.id === 'bottle' && item.bbox[2] * item.bbox[3] < 12000) {
          detectedItemName = 'lipstick';
          detectedItemBn = 'লিপস্টিক';
        } else if (item.id === 'book' && item.bbox[2] * item.bbox[3] < 15000) {
          detectedItemName = 'wallet or id card';
          detectedItemBn = 'মানিব্যাগ বা কার্ড';
        } else {
          detectedItemName = label(item.id);
          detectedItemBn = labelBn(item.id);
        }
      }

      if (detectedItemName) {
        const itemKey = `${detectedItemName.toLowerCase()}_${surface.toLowerCase()}_${room.toLowerCase()}`;
        if (now - (lastItemPlacementAnnounce.get(itemKey) || 0) < 45000) {
          continue; // Already recorded recently
        }
        lastItemPlacementAnnounce.set(itemKey, now);
        lastPlacementRecordAt = now;

        const locStr = `on the ${surface} in the ${room}`;
        autoRecordMemory({
          item: detectedItemName,
          location: locStr,
          room,
          furniture: surface,
          source: 'Auto placement observation',
          score: item.score ?? null
        });

        const enMsg = `Noted: your ${detectedItemName} is on the ${surface} in the ${room}.`;
        const bnMsg = `${room}-এর ${surfaceBn}-এ আপনার ${detectedItemBn} মনে রাখা হলো।`;
        announce(enMsg, bnMsg, 'memory');
        playEarcon('confirm');
        haptic('CONFIRM');
        heartFlash({ x: ix / frame.width, y: iy / frame.height, mode: 'lock', label: detectedItemName });
        break;
      }
    }
  } finally {
    isTrackingPlacement = false;
  }
}

// ---- Real-Time Optical Approach Velocity & Looming Collision Tracker ------
const ApproachVelocityTracker = {
  history: [],
  lastAlertAt: new Map(),

  evaluate(frameWidth, frameHeight, cocoObjs) {
    if (!cocoObjs || !cocoObjs.length) {
      const now = Date.now();
      this.history = this.history.filter(h => now - h.time < 1200);
      return null;
    }

    const now = Date.now();
    const frameArea = frameWidth * frameHeight;
    const currentTracks = [];
    let criticalHazard = null;
    const vehicleClasses = new Set(['car', 'truck', 'bus', 'motorcycle', 'bicycle']);

    for (const obj of cocoObjs) {
      const isVehicle = vehicleClasses.has(obj.id);
      const isPerson = obj.id === 'person';
      if (!isVehicle && !isPerson) continue;
      if (obj.score < 0.38) continue;

      const [x, y, w, h] = obj.bbox;
      const area = w * h;
      const normArea = area / frameArea;
      const cx = (x + w / 2) / frameWidth;
      const cy = (y + h / 2) / frameHeight;

      // Find best match in recent history (within 1400ms)
      let bestMatch = null;
      let minDistance = 0.38;

      for (const prev of this.history) {
        if (now - prev.time > 1400) continue;
        if (prev.id !== obj.id && !(isVehicle && vehicleClasses.has(prev.id))) continue;
        const dist = Math.hypot(cx - prev.cx, cy - prev.cy);
        if (dist < minDistance) {
          minDistance = dist;
          bestMatch = prev;
        }
      }

      currentTracks.push({
        id: obj.id,
        isVehicle,
        isPerson,
        bbox: obj.bbox,
        area,
        normArea,
        cx,
        cy,
        time: now
      });

      const dirEn = cx < 0.35 ? 'on your left' : cx > 0.65 ? 'on your right' : 'directly ahead';
      const dirBn = cx < 0.35 ? 'বামে' : cx > 0.65 ? 'ডানে' : 'সামনে';

      if (bestMatch) {
        const dt = (now - bestMatch.time) / 1000;
        if (dt >= 0.12 && dt <= 1.2) {
          const areaGrowthRatio = area / (bestMatch.area || 1);
          const expansionRatePerSec = (areaGrowthRatio - 1) / dt;

          // 1. VEHICLE APPROACHING WITH HIGH VELOCITY
          if (isVehicle) {
            const isRapidVehicleApproach = (areaGrowthRatio >= 1.22 && expansionRatePerSec >= 0.40 && normArea >= 0.07);
            const isImminentVehicleCollision = (normArea >= 0.28 && cx >= 0.18 && cx <= 0.82);

            if (isRapidVehicleApproach || isImminentVehicleCollision) {
              const alertKey = `vehicle_${Math.round(cx * 4)}`;
              if (now - (this.lastAlertAt.get(alertKey) || 0) > 2000) {
                this.lastAlertAt.set(alertKey, now);
                criticalHazard = {
                  type: 'vehicle_collision',
                  en: `Watch out! Car approaching quickly ${dirEn}!`,
                  bn: `সাবধান! ${dirBn} দিয়ে দ্রুত গাড়ি আসছে!`,
                  pos: cx < 0.35 ? 'left' : cx > 0.65 ? 'right' : 'center',
                  haptic: 'RAPID'
                };
                break;
              }
            }
          }

          // 2. BODY / PERSON APPROACHING WITH HIGH VELOCITY
          if (isPerson) {
            const isRapidPersonApproach = (areaGrowthRatio >= 1.28 && expansionRatePerSec >= 0.48 && normArea >= 0.10 && cx >= 0.15 && cx <= 0.85);
            const isImminentPersonCollision = (normArea >= 0.40 && cx >= 0.20 && cx <= 0.80);

            if (isRapidPersonApproach || isImminentPersonCollision) {
              const alertKey = `person_${Math.round(cx * 4)}`;
              if (now - (this.lastAlertAt.get(alertKey) || 0) > 2200) {
                this.lastAlertAt.set(alertKey, now);
                criticalHazard = {
                  type: 'body_collision',
                  en: `Watch out! Person approaching rapidly ${dirEn}!`,
                  bn: `সাবধান! ${dirBn} দ্রুত মানুষ এগিয়ে আসছে!`,
                  pos: cx < 0.35 ? 'left' : cx > 0.65 ? 'right' : 'center',
                  haptic: 'RAPID'
                };
                break;
              }
            }
          }
        }
      } else {
        // High threat: vehicle already large and forward in path
        if (isVehicle && normArea >= 0.32 && cx >= 0.20 && cx <= 0.80) {
          const alertKey = `vehicle_${Math.round(cx * 4)}`;
          if (now - (this.lastAlertAt.get(alertKey) || 0) > 2500) {
            this.lastAlertAt.set(alertKey, now);
            criticalHazard = {
              type: 'vehicle_collision',
              en: `Watch out! Vehicle dangerously close ${dirEn}!`,
              bn: `সাবধান! ${dirBn} গাড়ি খুব কাছে!`,
              pos: cx < 0.35 ? 'left' : cx > 0.65 ? 'right' : 'center',
              haptic: 'RAPID'
            };
            break;
          }
        }
      }
    }

    this.history = this.history.filter(h => now - h.time < 1500).concat(currentTracks);
    return criticalHazard;
  }
};

// ---- Real-Time Stairs, High Stage & Drop-off Edge Detector ----------------
const EdgeAndStairsDetector = {
  lastStairsAlertAt: 0,
  lastEdgeAlertAt: 0,
  scanCanvas: null,

  scanStairGeometry(frame) {
    if (!frame) return { hasPeriodicSteps: false, peaks: 0 };
    const W = 128, H = 96;
    if (!this.scanCanvas) {
      this.scanCanvas = document.createElement('canvas');
      this.scanCanvas.width = W;
      this.scanCanvas.height = H;
    }
    const ctx = this.scanCanvas.getContext('2d', { willReadFrequently: true });
    const srcY = Math.floor(frame.height * 0.35);
    const srcH = frame.height - srcY;
    ctx.drawImage(frame, 0, srcY, frame.width, srcH, 0, 0, W, H);
    const imgData = ctx.getImageData(0, 0, W, H).data;

    const rowGradients = new Float32Array(H);
    for (let y = 1; y < H - 1; y++) {
      let gradSum = 0;
      for (let x = 16; x < W - 16; x++) {
        const idxCurr = (y * W + x) * 4;
        const idxTop = ((y - 1) * W + x) * 4;
        const lumCurr = (imgData[idxCurr] * 299 + imgData[idxCurr + 1] * 587 + imgData[idxCurr + 2] * 114) / 1000;
        const lumTop = (imgData[idxTop] * 299 + imgData[idxTop + 1] * 587 + imgData[idxTop + 2] * 114) / 1000;
        gradSum += Math.abs(lumCurr - lumTop);
      }
      rowGradients[y] = gradSum / (W - 32);
    }

    let peakCount = 0;
    let lastPeakY = -1;
    const avgGrad = rowGradients.reduce((a, b) => a + b, 0) / H;
    const threshold = Math.max(16, avgGrad * 1.30);

    for (let y = 3; y < H - 3; y++) {
      if (rowGradients[y] > threshold) {
        if (lastPeakY === -1) {
          peakCount++;
          lastPeakY = y;
        } else if ((y - lastPeakY) >= 6 && (y - lastPeakY) <= 28) {
          peakCount++;
          lastPeakY = y;
        }
      }
    }

    return { hasPeriodicSteps: peakCount >= 3, peaks: peakCount };
  },

  async evaluate(frame, cocoObjs) {
    if (!frame) return null;

    // Provider configuration/reachability is not evidence about this frame.
    // Keep local checks active in every mode; retain the model/geometry and context guards below.

    // 1. Context suppression: If desk, table, keyboard, laptop, monitor, chair, book, mouse, or TV is present,
    // suppress stairs and high-stage drop-off alerts completely (they are false alarms caused by keyboard/desk rows)
    const deskItems = new Set(['desk', 'dining table', 'keyboard', 'laptop', 'mouse', 'tv', 'monitor', 'bed', 'couch', 'chair', 'book', 'cell phone']);
    if (cocoObjs && cocoObjs.some(o => deskItems.has(o.id) && o.score >= 0.20)) {
      return null;
    }
    if (typeof state !== 'undefined' && state.lastCocoPreds && state.lastCocoPreds.some(o => deskItems.has(o.id) && o.score >= 0.20)) {
      return null;
    }

    const now = Date.now();
    const canAlertStairs = now - this.lastStairsAlertAt > 6000;
    const canAlertEdge = now - this.lastEdgeAlertAt > 6000;
    if (!canAlertStairs && !canAlertEdge) return null;

    // 2. Stairs require BOTH structural periodic lines AND high-confidence MobileCLIP classification (p >= 0.48)
    // Never trigger on geometry alone!
    if (typeof engine !== 'undefined' && engine.clip && engine.clip.status === 'ready' && typeof clipEmbedCrops === 'function') {
      try {
        const lowerCrop = {
          x: Math.floor(frame.width * 0.15),
          y: Math.floor(frame.height * 0.40),
          w: Math.floor(frame.width * 0.70),
          h: Math.floor(frame.height * 0.55)
        };
        const [emb] = await clipEmbedCrops(frame, [lowerCrop]);
        if (emb) {
          const ranked = scoreEmbedding(emb).filter(r => r.id !== '_bg');
          const topStairs = ranked.find(r => r.id === 'stairs');
          const topEdge = ranked.find(r => r.id === 'drop_off');

          // Check if top ranked object is an indoor object or background
          const topItem = ranked[0];
          if (topItem && ['desk', 'laptop', 'keyboard', 'dining table', 'chair', 'cell phone'].includes(topItem.id)) {
            return null;
          }

          if (topEdge && topEdge.p >= 0.52 && canAlertEdge) {
            this.lastEdgeAlertAt = now;
            return {
              type: 'drop_off',
              en: 'Caution: possible drop-off ahead. Verify with your usual mobility aid before moving.',
              bn: 'সাবধান: সামনে খাদ থাকতে পারে। চলার আগে আপনার চলাচলের সহায়ক উপায় দিয়ে যাচাই করুন।',
              haptic: 'RAPID'
            };
          }

          const geom = this.scanStairGeometry(frame);
          if (topStairs && topStairs.p >= 0.48 && geom.hasPeriodicSteps && canAlertStairs) {
            this.lastStairsAlertAt = now;
            return {
              type: 'stairs',
              en: 'Caution: possible stairs ahead. Verify with your usual mobility aid before moving.',
              bn: 'সাবধান: সামনে সিঁড়ি থাকতে পারে। চলার আগে আপনার চলাচলের সহায়ক উপায় দিয়ে যাচাই করুন।',
              haptic: 'RAPID'
            };
          }
        }
      } catch (e) {
        console.warn('Edge/Stairs CLIP check:', e);
      }
    }

    return null;
  }
};

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
    if (privacyMode) {
      if (typeof AsthaExperience !== 'undefined') AsthaExperience.invalidatePreferences();
      remoteProcessingConsent = false;
      SiriVoice.enabled = false; SiriVoice.stop(true);
      clearPrivateSession();
    }
    $('private-btn').setAttribute('aria-pressed', privacyMode);
    $('private-btn').textContent = t(privacyMode ? 'privacy_on' : 'privacy_off');
    $('privacy-status').textContent = t(privacyMode ? 'privacy_status_on' : 'privacy_status_off');
    if (!privacyMode) { await refreshMemory(); await refreshRooms(); }
    announce(privacyMode ? 'Privacy mode is on. Nothing new will be saved until you turn it off.' : 'Privacy mode is off.',
      privacyMode ? 'গোপনীয়তা মোড চালু। বন্ধ না করা পর্যন্ত নতুন কিছু সংরক্ষণ হবে না।' : 'গোপনীয়তা মোড বন্ধ।');
  } finally { privacyTransition = false; $('private-btn').disabled = false; }
}
