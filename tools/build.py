"""Build web/index.html from tools/base.html plus the companion modules (vocab, i18n, module, eye, cloud, account, styles).
Run: python tools/build.py
Every replacement asserts that its anchor occurs exactly once, so a silent mis-patch is impossible."""
import hashlib, json, pathlib, re, sys

HERE = pathlib.Path(__file__).parent
SRC = HERE / "base.html"
DST = HERE.parent / "web" / "index.html"
BOOTSTRAP = ("config.js", "native-api.js", "native-device.js", "pi-camera.js", "paired-camera-store.js", "backend.js")
bootstrap_urls = {name: name + "?v=" + hashlib.sha256((DST.parent / name).read_bytes()).hexdigest()[:16] for name in BOOTSTRAP}

html = SRC.read_text(encoding="utf-8")
vocab = (HERE / "vocab.js").read_text(encoding="utf-8")
css = (HERE / "styles.css").read_text(encoding="utf-8")
module = (HERE / "module.js").read_text(encoding="utf-8")
runtime_js = (HERE / "runtime-loader.js").read_text(encoding="utf-8")
agent_js = (HERE / "agent.js").read_text(encoding="utf-8")
perceive_js = (HERE / "perceive.js").read_text(encoding="utf-8")
spatial_js = (HERE / "spatial.js").read_text(encoding="utf-8")
offline_js = (HERE / "offline.js").read_text(encoding="utf-8")
observation_memory_js = (HERE / "observation-memory.js").read_text(encoding="utf-8")
offline_js += "\n" + observation_memory_js.rstrip("\n")
account_js = (HERE / "account.js").read_text(encoding="utf-8")
i18n_js = (HERE / "i18n.js").read_text(encoding="utf-8")
i18n = json.loads((HERE / "i18n.json").read_text(encoding="utf-8"))

def rep(old, new, count=1):
    global html
    n = html.count(old)
    assert n == count, f"anchor found {n}x (expected {count}): {old[:90]!r}"
    html = html.replace(old, new)

def rep_between(start, end, new):
    """Replace the text from `start` (inclusive) up to `end` (exclusive)."""
    global html
    assert html.count(start) == 1, f"start anchor {html.count(start)}x: {start[:80]!r}"
    i = html.index(start)
    j = html.index(end, i)
    html = html[:i] + new + html[j:]

# Optional local inference libraries must not block the app shell or online requests.
rep("async function ensureVisionModels() {", runtime_js.rstrip("\n") + "\n\nasync function ensureVisionModels() {")

# ---- Lavender is the default; high-contrast choices remain available. ----
rep('<html lang="en" data-theme="clinical-yellow"', '<html lang="en" data-theme="lavender"')
rep("""        <option value="clinical-yellow">🟡 Yellow on black</option>
        <option value="monochrome">⚪ Monochrome (Inverted White/Black)</option>
        <option value="navy-cyan">🌊 Navy and cyan</option>""",
    """        <option value="lavender" data-i18n="theme_calm">Lavender</option>
        <option value="navy-cyan">🌊 Navy and cyan</option>
        <option value="monochrome">⚪ Monochrome (white on black)</option>
        <option value="clinical-yellow">🟡 Yellow on black (photophobia)</option>""")

# ---- CSS ----
rep("</style>\n</head>", css + "</style>\n</head>")

# ---- HTML: heart cursor, hands-free chip, read button ids ----
rep('<div class="hazard" id="hazard" hidden><span id="hazard-text" data-i18n="hazard_banner">Warning! Obstacle ahead</span></div>\n',
    '<div class="hazard" id="hazard" hidden><span id="hazard-text" data-i18n="hazard_banner">Warning! Obstacle ahead</span></div>\n'
    '        <div class="heart idle" id="heart" hidden aria-hidden="true">\n'
    '          <svg viewBox="0 0 24 24"><path d="M12 21s-7.5-4.6-9.6-9.1C.9 8.5 2.6 5 6.1 5c2 0 3.3 1.1 3.9 2.1C10.6 6.1 11.9 5 13.9 5c3.5 0 5.2 3.5 3.7 6.9C19.5 16.4 12 21 12 21z"/></svg>\n'
    '          <span class="heart-label" id="heart-label" hidden></span>\n'
    '        </div>\n')
rep('        <span class="mic-hint" data-i18n="mic_hint">Ask in Bangla or English: “What is in front of me?”, “Read this”, “Where is my charger?”</span>\n      </div>',
    '        <span class="mic-hint" data-i18n="mic_hint">Ask in Bangla or English: “What is in front of me?”, “Read this”, “Where is my charger?”</span>\n'
    '        <button class="chip-btn" id="hf-btn" onclick="toggleHandsFree()" aria-pressed="false" title="Keep listening for “LUNEYRA, …”">🎧 <span id="hf-label">Hands-free: off</span></button>\n      </div>')
rep('<button class="action" onclick="readText()">', '<button class="action" id="read-btn" onclick="readText()" aria-pressed="false">')
rep('<div class="title" data-i18n="act_read">Read text</div>', '<div class="title" id="read-title" data-i18n="act_read">Read to me</div>')

# ---- I18N strings ----
rep("act_read: 'Read text', act_read_desc: 'Labels, medicine, notes, signs',",
    "act_read: 'Read to me', act_read_desc: 'Hold up a page; I guide your hands, then read it aloud',")
rep("act_read: 'লেখা পড়ুন', act_read_desc: 'লেবেল, ওষুধ, নোট, সাইনবোর্ড',",
    "act_read: 'আমাকে পড়ে শোনাও', act_read_desc: 'পৃষ্ঠা ধরুন; আমি ধরতে সাহায্য করব, তারপর পড়ে শোনাব',")
rep("mic_hint: 'Tap, then ask in your selected voice language. You can also type in Bangla or English.',",
    "mic_hint: 'Tap once to ask, or turn on Hands-free and just say “LUNEYRA, read this”. You can also type below.',")
rep('<p class="help">Tap the microphone before saying “Hey LUNEYRA”. Browser speech recognition may use an online service. There is no background wake-word listener.</p>',
    '<p class="help">Hands-free mode keeps the microphone open in this tab and waits for “LUNEYRA, …”. Browser speech recognition may use an online service.</p>')

# ---- vocabulary: restore the full list ----
rep_between("// COCO classes + everyday objects with Bangla mapping and hazard labels\n",
            "\nconst VOCAB_BY_ID", vocab.rstrip("\n"))

# ---- proximity back on; earcon tick; overlay colours ----
rep("function proxFromArea(r) { return null; }",
    "function proxFromArea(r) { return r > 0.35 ? 'very_close' : r > 0.12 ? 'near' : 'far'; }")
rep("  if (type === 'click') {\n    // Gentle tap feedback: 550Hz short tick",
    "  if (type === 'tick') {\n    // Alignment click for the heart cursor: very short, quiet\n    osc.type = 'square';\n    osc.frequency.setValueAtTime(1400, now);\n    gain.gain.setValueAtTime(0.05, now);\n    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.03);\n    osc.start(now); osc.stop(now + 0.03);\n  } else if (type === 'click') {\n    // Gentle tap feedback: 550Hz short tick")
rep("const col = hz ? '#ff3b30' : '#ffd700'; // Clinical yellow / danger red", "const col = hz ? '#ff3b30' : themeAccent();")
rep("esc(label(o.id))", "esc(objLabel(o))", count=2)

# ---- ingest: relabel, mirror special-case, suppression ----
rep("    if (o.src === 'clip' && (VOCAB_BY_ID[o.id].quiet)) return;\n    const prev = state.world.get(o.id);",
    "    if (o.src === 'coco') applyRelabel(o, now);\n"
    "    if (o.src === 'clip') {\n"
    "      const vb0 = VOCAB_BY_ID[o.id];\n"
    "      if (vb0.special === 'mirror') { state.mirrorSeenAt = now; return; }\n"
    "      if (vb0.quiet || suppressedBy(o, objs)) return;\n"
    "    }\n"
    "    const prev = state.world.get(o.id);")

# ---- live loop: keep centre ranking, refine and mirror ----
rep("        const { hits } = await runClipZones(frame);\n        if (!loop.active || state.liveLoop !== loop) return;\n        const at = Date.now();\n        state.lastClipHits = hits.map(h => Object.assign(h, { at }));\n        ingest(hits);\n        afterLiveUpdate();",
    "        const { hits, center } = await runClipZones(frame);\n        if (!loop.active || state.liveLoop !== loop) return;\n        const at = Date.now();\n        state.lastClipHits = hits.map(h => Object.assign(h, { at }));\n        state.lastCenter = center;\n        ingest(hits);\n        afterLiveUpdate();\n        await liveRefineAndMirror(frame);")
rep("    setCaption(t('new_title'), msgEn, 'vision', null, msgBn);\n    speak(msgEn, msgBn);\n  }\n}\nfunction showHazard",
    "    setCaption(t('new_title'), msgEn, 'vision', null, msgBn);\n    speak(msgEn, msgBn);\n    heartPointAt(fresh[0]);\n  }\n}\nfunction showHazard")
old_busy = "finally { state.busy=false; $('companion-main').setAttribute('aria-busy','false'); if(state.source==='camera')startLiveLoop(); }"
if old_busy in html:
    rep(old_busy, "finally { state.busy=false; $('companion-main').setAttribute('aria-busy','false'); if(state.source==='camera' && !reading.active)startLiveLoop(); }")

# ---- describe: refinement, mirror, brand-aware labels, heart ----
rep("    const objs = worldSorted();\n    const now = Date.now(); objs.forEach(o => state.announced.set(o.id, now));\n    if (!objs.length) { setCaption(t('describe_title'), t('nothing_seen'), 'vision', null, tBn('nothing_seen'));",
    "    const rframe = captureFrame(640);\n    if (rframe) { await refineWorld(rframe, state.lastCocoPreds, ''); if (await mirrorCheck(rframe, true)) return; }\n"
    "    const objs = worldSorted();\n    const now = Date.now(); objs.forEach(o => state.announced.set(o.id, now));\n    if (!objs.length) { setCaption(t('describe_title'), t('nothing_seen'), 'vision', null, tBn('nothing_seen'));")
# Each named object carries how it is moving, e.g. "a person, coming closer" (see trackMotion in module.js).
rep("const namesEn = g.map(o => labelWithArticle(o.id));", "const namesEn = g.map(o => objLabelWithArticle(o) + (o.motion && typeof motionPhrase === 'function' ? ', ' + motionPhrase(o.motion, false) : ''));")
rep("const namesBn = g.map(o => labelBn(o.id));", "const namesBn = g.map(o => objLabelBn(o) + (o.motion && typeof motionPhrase === 'function' ? ' (' + motionPhrase(o.motion, true) + ')' : ''));")
rep("`${label(closest.id)} ${t('prox_' + closest.prox)}`", "`${objLabel(closest)} ${t('prox_' + closest.prox)}`")
rep("`${labelBn(closest.id)} ${tBn('prox_' + closest.prox)}`", "`${objLabelBn(closest)} ${tBn('prox_' + closest.prox)}`")
rep("    setCaption(t('describe_title'), msgEn, 'vision', null, msgBn);\n    playEarcon('confirm');",
    "    setCaption(t('describe_title'), msgEn, 'vision', null, msgBn);\n    heartPointAt(objs[0]);\n    playEarcon('confirm');")

# ---- clothes: full rewrite ----
NEW_CLOTHES = r"""function inspectClothesAndColor(skipCloud) {
  if (withCamera(inspectClothesAndColor)) return;
  if (cloudReady() && !skipCloud) return cloudClothes();
  const current = captureLocalActionGuard();
  return withBusy(t('clothes_title'), async () => {
    if (!current()) return;
    await ensureVisionModels();
    if (!current()) return;
    const frame = captureFrame(640); if (!frame) return;
    const cocoObjs = await runCoco(frame);
    if (!current()) return;
    const person = cocoObjs.filter(o => o.id === 'person').sort((a, b) => (b.bbox[2] * b.bbox[3]) - (a.bbox[2] * a.bbox[3]))[0];
    const big = !!person && (person.bbox[2] * person.bbox[3]) / (frame.width * frame.height) > 0.2;
    const rect = big ? bodyRect(frame, person.bbox) : centerRect(frame, 0.6);
    const info = await analyzeClothing(frame, rect);
    if (!current()) return;
    const mirror = Date.now() - (state.mirrorSeenAt || 0) < 5000;
    const s = clothingSentence(info, big ? (mirror ? 'wearing' : 'person') : 'holding');
    drawOverlay(frame, cocoObjs, []);
    announce(s.en, s.bn, 'vision'); playEarcon('confirm'); haptic('CONFIRM');
    heartFlash({ x: (rect.x + rect.s / 2) / frame.width, y: (rect.y + rect.s / 2) / frame.height, mode: 'lock', label: s.isGarment ? s.garment.en : colorName(info.colors.top) });
    logEvent(t('log_clothes', { c: colorName(info.colors.top), g: s.isGarment ? s.garment.en : 'not clothing' }));
  });
}
"""
rep_between("function inspectClothesAndColor() {", "\n/* =====================================================================\n   11. Multimodal OCR-First", NEW_CLOTHES)

# ---- identify: full rewrite ----
NEW_IDENTIFY = r"""function identifyObject(skipCloud) {
  if (withCamera(identifyObject)) return;
  if (cloudReady() && !skipCloud) return cloudIdentify();
  const current = captureLocalActionGuard();
  return withBusy(t('identify_title'), async () => {
    if (!current() || !(await ensureVisionModels()) || !current()) return;
    const frame = captureFrame(640); if (!frame) return;
    heartSet({ x: 0.5, y: 0.5, mode: 'seek', label: 'Looking…' });

    // 1. Quick OCR on the centre: brands, ID cards and labels carry text.
    let ocrText = '';
    try {
      const worker = await ensureOcr();
      if (!current()) return;
      const res = await worker.recognize(cropToCanvas(frame, centerRect(frame, 0.7)));
      if (!current()) return;
      // Keep only confident lines that look like words; drop the noise OCR produces on textures.
      ocrText = (res.data.lines || []).filter(l => l.confidence >= 60).map(l => l.text.replace(/\s+/g, ' ').trim())
        .filter(l => { const letters = l.replace(/[^\p{L}\p{N}]/gu, '').length; return letters >= 3 && letters / l.length >= 0.6; })
        .join(' ').trim();
      if (ocrText.replace(/[^\p{L}\p{N}]/gu, '').length < 4) ocrText = '';
    } catch (e) { if (!current()) return; console.warn('identify OCR', e); }

    // 2. Boxes, then refine the central one (toy vs real, ID card vs person, phone brand).
    const cocoObjs = await runCoco(frame);
    if (!current()) return;
    state.lastCocoPreds = cocoObjs;
    const cx = frame.width / 2, cy = frame.height / 2;
    const central = cocoObjs.filter(o => o.bbox[0] < cx && o.bbox[0] + o.bbox[2] > cx && o.bbox[1] < cy && o.bbox[1] + o.bbox[3] > cy).sort((a, b) => b.score - a.score)[0];
    let refined = null;
    if (central && central.score >= 0.5) { try { refined = await refineDetection(frame, central, ocrText, current); } catch (e) { if (!current()) return; console.warn('refine', e); } }
    if (!current()) return;
    if (central && refined && refined.newId) { state.relabel[central.id] = { newId: refined.newId, kind: refined.kind, until: Date.now() + 8000 }; central.origId = central.id; central.id = refined.newId; central.note = refined.kind; }
    if (central && refined && refined.brand) { central.brand = refined.brand; state.relabel[central.id] = { newId: central.id, kind: 'brand', brand: refined.brand, until: Date.now() + 15000 }; }
    drawOverlay(frame, cocoObjs, []);

    // 3. Open-vocabulary ranking of the centre crop.
    let ranked = [];
    if (engine.clip.status === 'ready') {
      const [emb] = await clipEmbedCrops(frame, [centerRect(frame, 0.55)]);
      if (!current()) return;
      ranked = scoreEmbedding(emb).filter(r => r.id !== '_bg' && !VOCAB_BY_ID[r.id].quiet && !VOCAB_BY_ID[r.id].special);
    }
    const finish = (en, bn, labelText) => {
      if (!current()) return;
      announce(en, bn, 'vision'); playEarcon('confirm'); haptic('CONFIRM');
      heartFlash({ x: 0.5, y: 0.5, mode: 'lock', label: labelText });
      logEvent(t('log_identify', { a: labelText }));
      if (typeof autoRecordMemory === 'function' && labelText) {
        autoRecordMemory({ item: labelText, location: 'In front of camera', source: 'Identified object', score: null });
      }
    };
    const ocrTail = ocrText.length >= 3 ? [` The text on it says: “${ocrText.slice(0, 80)}”.`, ` এর গায়ে লেখা: “${ocrText.slice(0, 80)}”।`] : ['', ''];

    // 4. Special cases first.
    if (refined && refined.kind === 'mirror') { await mirrorCheck(frame, false, current); return; }
    if (refined && refined.kind === 'brand') {
      const b = brandMeta(refined.brand);
      const byText = BRAND_WORDS[refined.brand].test(ocrText);
      return finish(`This is ${article(b.en)} ${b.en} phone.` + (byText ? ' I read the brand name on it.' : ' I am judging by its look, so the brand may be wrong.') + ocrTail[0],
        `এটি একটি ${b.bn} ফোন।` + (byText ? ' ব্র্যান্ডের নামটি এর গায়ে লেখা আছে।' : ' দেখে অনুমান করছি, ব্র্যান্ড ভুল হতে পারে।') + ocrTail[1], b.en + ' phone');
    }
    if (central && central.id === 'cell phone') {
      return finish('This is a smartphone. I cannot tell the brand from here; show me the back where the logo is, or the name on the screen.' + ocrTail[0],
        'এটি একটি স্মার্টফোন। ব্র্যান্ড বুঝতে পারছি না; লোগোসহ পেছনের দিকটা দেখান বা স্ক্রিনের নাম দেখান।' + ocrTail[1], 'phone');
    }
    if (refined && refined.kind === 'toy') {
      const base = central.origId || 'car';
      return finish(`This is a toy ${label(base)}, not a real one. It is small enough to hold in your hand.` + ocrTail[0],
        `এটি খেলনা ${labelBn(base)}, আসল নয়। এটি হাতে ধরার মতো ছোট।` + ocrTail[1], 'toy ' + label(base));
    }
    if (refined && refined.kind === 'idcard') {
      return finish('This is an ID card with a photo on it, not a person.' + (ocrText ? ` It says: “${ocrText.slice(0, 100)}”.` : ' Hold it flat and closer if you want me to read it.'),
        'এটি ছবিসহ একটি আইডি কার্ড, কোনো মানুষ নয়।' + (ocrText ? ` এতে লেখা: “${ocrText.slice(0, 100)}”।` : ' পড়াতে চাইলে সমতল করে কাছে ধরুন।'), 'ID card');
    }
    if (refined && refined.kind === 'picture') {
      const base = central.origId || 'person';
      return finish(`This is a picture of ${withArticle(label(base), !!VOCAB_BY_ID[base].pl)}, not the real thing.` + ocrTail[0], `এটি ${labelBn(base)}-এর ছবি, আসল নয়।` + ocrTail[1], 'picture');
    }
    if (refined && refined.kind === 'doll') return finish('This is a doll or figure, not a real person.', 'এটি একটি পুতুল, আসল মানুষ নয়।', 'doll');

    // 5. Clothing gets its own describer (garment, colour, pattern).
    const top = ranked[0];
    if (top && VOCAB_BY_ID[top.id].garment && top.p >= 0.25) {
      const info = await analyzeClothing(frame);
      if (!current()) return;
      const s = clothingSentence(info, 'holding');
      return finish(s.en + ocrTail[0], s.bn + ocrTail[1], s.isGarment ? s.garment.en : label(top.id));
    }

    // 6. Everything else: best guess with colour, honest about confidence.
    if (central && central.score >= 0.6) { ranked = ranked.filter(r => r.id !== central.id); ranked.unshift({ id: central.id, p: central.score }); }
    if (!ranked.length) { heartHide(); return announce(t('nothing_seen'), tBn('nothing_seen'), 'vision'); }
    const [a, b] = ranked;
    const va = VOCAB_BY_ID[a.id];
    const colors = extractDominantColor(cropToCanvas(frame, centerRect(frame, 0.6)));
    const useColor = colors.top.pct >= 45 && !/Grey|White|Black/.test(colors.top.name) && !['person', 'photo', 'id card'].includes(a.id);
    const nounEn = (useColor ? colorName(colors.top) + ' ' : '') + label(a.id);
    const nounBn = (useColor ? colorNameBn(colors.top) + ' ' : '') + labelBn(a.id);
    let en = a.p >= CLIP_SURE ? `This looks like ${withArticle(nounEn, !!va.pl)}.` : `I am not sure. It might be ${withArticle(nounEn, !!va.pl)}.`;
    let bn = a.p >= CLIP_SURE ? `এটি সম্ভবত ${nounBn}।` : `আমি নিশ্চিত নই। এটি ${nounBn} হতে পারে।`;
    if (b && a.p < 0.6) { en += ` It could also be ${labelWithArticle(b.id)}.`; bn += ` এটি ${labelBn(b.id)}-ও হতে পারে।`; }
    finish(en + ocrTail[0], bn + ocrTail[1], label(a.id));
  });
}
"""
rep_between("function identifyObject() {", "\n/* =====================================================================\n   12. Guided Home Layout Calibration Wizard & Spatial Memory", NEW_IDENTIFY)

# ---- readText → one-shot for still images; guided mode lives in the module ----
rep("function readText() {\n  if (!state.source) { setCaption(t('ready_title'), t('need_source'), 'ocr', null, tBn('need_source')); speak(t('need_source'), tBn('need_source')); return; }\n  const stillWanted = captureLocalActionGuard();\n  return withBusy(t('reading_title'), async () => {",
    "function readStillOnce() {\n  const stillWanted = captureLocalActionGuard();\n  return withBusy(t('reading_title'), async () => {")

# ---- reader finish hook ----
rep("    reader.active = false; $('reader-progress').textContent = 'Finished'; return;",
    "    reader.active = false; $('reader-progress').textContent = 'Finished';\n    const done = reader.onFinish; reader.onFinish = null; if (done) done();\n    return;")

# ---- camera stop ends reading mode ----
rep("function stopCamera() {\n  cameraRequest++; state.cameraPending=false; stopLiveLoop();",
    "function stopCamera() {\n  cameraRequest++; state.cameraPending=false; stopLiveLoop();\n  if (typeof reading !== 'undefined' && reading.active) stopReading(true);")

# ---- voice commands ----
rep("  if (/privacy|গোপনীয়তা/.test(q)) return togglePrivateMode();\n",
    "  if (/privacy|গোপনীয়তা/.test(q)) return togglePrivateMode();\n"
    "  if (/hands.?free|always listen|keep listening|হ্যান্ডস ?ফ্রি|সবসময় শোনো/.test(q)) return toggleHandsFree();\n"
    "  if (/stop reading|reading stop|পড়া বন্ধ|পড়া থামাও/.test(q)) return reading.active ? stopReading() : stopAllSpeech();\n"
    "  if (/how do i look|how am i looking|mirror|looking good|looking beautiful|আমাকে কেমন লাগছে|কেমন লাগছে|আয়না/.test(q)) return howDoILook();\n"
    "  if (/what am i wearing|what colou?r|which colou?r|wearing|আমি কী পরেছি|কী রঙ|কোন রঙ|রঙ কী/.test(q)) return inspectClothesAndColor();\n"
    "  if (/which phone|what phone|phone model|which brand|what brand|কোন ফোন|কোন ব্র্যান্ড|মডেল/.test(q)) return identifyObject();\n"
    "  if (/is (this|it) (a )?(toy|real)|toy or real|খেলনা|আসল/.test(q)) return identifyObject();\n")
rep("  if (/read all|read book|read document|বই পড়|পুরো.*পড়/.test(q)) return startReader();",
    "  if (/read all|read book|read document|read (the|this|my) (book|page|paper|letter)|বই পড়|পুরো.*পড়|বইটা পড়/.test(q)) return state.source === 'camera' ? readText() : startReader();")

# ---- accuracy: keep garments/toys/pictures out of the live zone scan, track person motion ----
rep("    const ranked = scoreEmbedding(emb).filter(r => r.id !== '_bg' && !VOCAB_BY_ID[r.id].quiet);\n    if (rects[i].pos === 'center')",
    "    const ranked = scoreEmbedding(emb).filter(r => r.id !== '_bg' && !VOCAB_BY_ID[r.id].quiet && !VOCAB_BY_ID[r.id].zoneQuiet);\n    if (rects[i].pos === 'center')")
rep("      state.lastCocoPreds = objs;\n      ingest(objs.concat(",
    "      state.lastCocoPreds = objs;\n"
    "      if (typeof trackMotion === 'function') trackMotion(objs, frame); // left/right/closer/away per object, on-device\n"
    "      if (typeof perceptionHook === 'function') perceptionHook(objs, frame); // distance, scene graph, toy/screen rules, depth\n"
    "      // ---- AUTOMATIC REAL-TIME ACTIVE SAFETY GUARDIAN (ZERO COMMAND NEEDED) ----\n"
    "      let handledEmergency = false;\n"
    "      if (typeof ApproachVelocityTracker !== 'undefined') {\n"
    "        const velHazard = ApproachVelocityTracker.evaluate(frame.width, frame.height, objs);\n"
    "        if (velHazard) {\n"
    "          handledEmergency = true;\n"
    "          if (typeof VoiceEngine !== 'undefined' && typeof VoiceEngine.emergencyAlert === 'function') {\n"
    "            VoiceEngine.emergencyAlert(velHazard.en, velHazard.bn, velHazard.type);\n"
    "          } else {\n"
    "            announce(velHazard.en, velHazard.bn, 'safety');\n"
    "            playEarcon('emergency');\n"
    "            haptic('RAPID');\n"
    "          }\n"
    "          logEvent('EMERGENCY HAZARD: ' + velHazard.en);\n"
    "        }\n"
    "      }\n"
    "      if (!handledEmergency && typeof EdgeAndStairsDetector !== 'undefined') {\n"
    "        EdgeAndStairsDetector.evaluate(frame, objs).then(edgeHazard => {\n"
    "          if (!loop.active || state.liveLoop !== loop) return;\n"
    "          if (edgeHazard) {\n"
    "            if (typeof VoiceEngine !== 'undefined' && typeof VoiceEngine.emergencyAlert === 'function') {\n"
    "              VoiceEngine.emergencyAlert(edgeHazard.en, edgeHazard.bn, edgeHazard.type);\n"
    "            } else {\n"
    "              announce(edgeHazard.en, edgeHazard.bn, 'safety');\n"
    "              playEarcon('emergency');\n"
    "              haptic('RAPID');\n"
    "            }\n"
    "            logEvent('EMERGENCY HAZARD: ' + edgeHazard.en);\n"
    "          }\n"
    "        }).catch(() => {});\n"
    "      }\n"
    "      trackPersonMotion(objs, frame);\n"
    "      ingest(objs.concat(")
rep("if (rframe) { await refineWorld(rframe, state.lastCocoPreds, ''); if (await mirrorCheck(rframe, true)) return; }",
    "if (rframe) { await refineWorld(rframe, state.lastCocoPreds, ''); if (state.lastCocoPreds.some(o => o.id === 'person') && await mirrorCheck(rframe, true)) return; }")

# ---- instant narration & proactive safety shield: on by default ----
rep("  narrate: false,\n  shield: false,", "  narrate: true,\n  shield: true,")
rep("state.narrate=localStorage.getItem('astha.narrate')==='1';", "state.narrate=localStorage.getItem('astha.narrate')!=='0'; state.shield=localStorage.getItem('astha.shield')!=='0';")
rep("auto_narrate: 'Announce new objects automatically (off by default for screen readers)'", "auto_narrate: 'Announce objects out loud the moment they appear'")
rep("const fresh = worldSorted().filter(o => (state.announced.get(o.id) || 0) < now - 12000 && now - o.first < 2500 && o.score >= (o.src === 'coco' ? 0.55 : 0.28));\n  if (fresh.length && now - (state.lastNarration || 0) > 3000) {",
    "// Movement first: \"a person on your left is coming closer\" matters more than a new static object.\n"
    "  if (typeof narrateMotion === 'function' && narrateMotion(now)) { state.lastNarration = now; return; }\n"
    "  const fresh = worldSorted().filter(o => (state.announced.get(o.id) || 0) < now - 10000 && o.score >= (o.src === 'coco' ? 0.55 : 0.28));\n  if (fresh.length && now - (state.lastNarration || 0) > 1500) {")

# ---- voice: prefer the natural (female) voice, let the user pick ----
rep("const selected = localOnly ? matches.find(v => v.localService) : matches[0];", "const selected = localOnly ? matches.find(v => v.localService) : pickVoice(matches, language);")
rep('<label class="field" for="ocr-language">Reading language<select class="select-dropdown" id="ocr-language" onchange="savePreferences()"><option value="ben+eng">বাংলা + English</option><option value="eng">English</option></select></label>',
    '<label class="field" for="ocr-language">Reading language<select class="select-dropdown" id="ocr-language" onchange="savePreferences()"><option value="ben+eng">বাংলা + English</option><option value="eng">English</option></select></label>\n'
    '      <label class="field" for="voice-select">LUNEYRA\'s voice<select class="select-dropdown" id="voice-select" onchange="onVoiceChosen(this.value)"></select></label>')
rep("  voiceLang = next === 'en' ? 'en' : 'bn';\n  updateVoiceSupport();", "  voiceLang = next === 'en' ? 'en' : 'bn';\n  updateVoiceSupport();\n  if (typeof populateVoices === 'function') populateVoices();")

# If Bangla is selected but the device has no Bangla voice, speak the English text with the preferred English voice.
rep("  const useBn = voiceLang === 'bn' && !!bnText;\n  const text = useBn ? bnText : enText;",
    "  const useBn = voiceLang === 'bn' && !!bnText && voices.some(v => /^bn/i.test(v.lang));\n  const text = useBn ? bnText : enText;")

# ---- reading never depends on pasted text ----
# Camera start: if a read was requested, begin reading as soon as the camera is live (OCR only), load vision models in the background.
rep("    state.cameraPending=false; state.sceneKey=null; showSource('camera');\n    announce('Camera on. Loading recognition models.', 'ক্যামেরা চালু। শনাক্তকরণ মডেল লোড হচ্ছে।');",
    "    state.cameraPending=false; state.sceneKey=null; showSource('camera');\n    if (state.pendingRead) { state.pendingRead=false; startReading(); ensureVisionModels(); return; }\n"
    "    if (state.pendingAction) {\n"
    "      const act=state.pendingAction; state.pendingAction=null;\n"
    "      const actionCurrent=captureLocalActionGuard();\n"
    "      if (cloudReady()) { act(); ensureVisionModels().then(() => { if (state.source==='camera') startLiveLoop(); }); return; }\n"
    "      announce('Camera on. Loading the vision models, then I will look.', 'ক্যামেরা চালু। মডেল লোড হচ্ছে, তারপর দেখছি।');\n"
    "      if (!await ensureVisionModels() || !actionCurrent() || token!==cameraRequest || state.source!=='camera') return;\n"
    "      startLiveLoop(); act(); return;\n"
    "    }\n"
    "    announce('Camera on. Loading recognition models.', 'ক্যামেরা চালু। শনাক্তকরণ মডেল লোড হচ্ছে।');")
# Visual questions start the camera themselves instead of asking for a source.
rep("function describeScene() {\n  if (!state.source) { setCaption(t('ready_title'), t('need_source'), 'vision', null, tBn('need_source')); speak(t('need_source'), tBn('need_source')); return; }",
    "function describeScene() {\n  if (withCamera(describeScene)) return;")
rep("function safetyCheck(silentIfClear) {\n  if (!state.source) { setCaption(t('agent_safety'), t('need_source'), 'safety', null, tBn('need_source')); speak(t('need_source'), tBn('need_source')); return; }",
    "function safetyCheck(silentIfClear) {\n  if (!state.source) { if (silentIfClear) return; return withCamera(safetyCheck); }\n  if (typeof cloudReady === 'function' && cloudReady() && typeof cloudSafetyCheck === 'function') return cloudSafetyCheck(silentIfClear);")
rep("    stopCamera(); announce('Camera could not start. Check permission and use HTTPS or localhost, or upload a photo.',",
    "    state.pendingRead=false; state.pendingAction=null; stopCamera(); announce('Camera could not start. Check permission and use HTTPS or localhost, or upload a photo.',")
# Voice: every "read …" request goes to the camera reader.
rep("return state.source === 'camera' ? readText() : startReader();", "return readText();")
# Reader card: an empty transcript means "read with the camera", never "paste text".
rep("  if (!text) return announce('Add text to the reader first.', 'আগে রিডারে লেখা যোগ করুন।');", "  if (!text) return readText();")
rep('<div class="card-head"><h2>Book & document reader</h2>', '<div class="card-head"><h2>Reading transcript</h2>')
rep('<p class="help">Read a page with the camera and add it here, or paste text. All paragraphs are read aloud; add pages in order for longer documents.</p>',
    '<p class="help">Everything LUNEYRA reads from the camera is collected here. Say “LUNEYRA, read this” or tap “Read to me” to read a book or letter. Pasting text is optional.</p>')
rep('<label class="field" for="reader-text">Text to read<textarea id="reader-text" placeholder="Paste Bangla or English text…" oninput="readerTextChanged()"></textarea></label>',
    '<label class="field" for="reader-text">Transcript<textarea id="reader-text" placeholder="Pages LUNEYRA has read will appear here." oninput="readerTextChanged()"></textarea></label>')
rep('<button class="btn accent" onclick="startReader()">Read all</button>', '<button class="btn accent" onclick="startReader()">Read the transcript again</button>')

# ---- LUNEYRA's eye on your screen (replaces the earlier "Clicky" panel) ----
eye_js = (HERE / "eye.js").read_text(encoding="utf-8")
EYE_HTML = r"""    <div class="card" id="eye-card">
      <div class="card-head">
        <h2>♥ LUNEYRA on your screen</h2>
        <span class="pill" id="eye-pill">Not watching</span>
      </div>
      <p class="help">Share your screen and LUNEYRA tells you what is on it: a message, a slide, a document, a web page, a design or code. Ask her to read it, explain it, or help you with it. Say “LUNEYRA, watch my screen”.</p>
      <div class="eye-view">
        <div class="empty" id="eye-empty"><div>Screen not shared yet.</div></div>
        <video id="eye-video" autoplay muted playsinline hidden></video>
        <div class="heart idle" id="eye-heart" hidden aria-hidden="true">
          <svg viewBox="0 0 24 24"><path d="M12 21s-7.5-4.6-9.6-9.1C.9 8.5 2.6 5 6.1 5c2 0 3.3 1.1 3.9 2.1C10.6 6.1 11.9 5 13.9 5c3.5 0 5.2 3.5 3.7 6.9C19.5 16.4 12 21 12 21z"/></svg>
          <span class="heart-label" id="eye-heart-label" hidden></span>
        </div>
      </div>
      <div class="utility-row"><button class="btn accent" id="eye-start" onclick="toggleEye()">Let LUNEYRA see my screen</button><button class="btn" onclick="eyeWhatsOnScreen()">What is on my screen?</button><button class="btn" onclick="eyeExplain()">Explain what is on my screen</button></div>
      <label class="field" for="eye-paste">Or paste any text from your screen<textarea id="eye-paste" placeholder="Paste text here, then say “LUNEYRA, explain this”."></textarea></label>
      <div class="toggle-row"><span>Keyboard guidance: name each control as I Tab to it</span><button class="switch" id="focus-switch" role="switch" aria-checked="false" onclick="toggleFocusNarration()" aria-label="Keyboard guidance"></button></div>
      <p class="help">LUNEYRA can read and explain a shared screen. On an Android phone she can also read other apps and answer your messages; see Devices.</p>
    </div>
  </section>
"""
rep('<div class="utility-row"><button class="btn accent" onclick="startReader()">Read the transcript again</button><button class="btn" onclick="pauseReader()">Pause</button><button class="btn" onclick="resumeReader()">Resume</button><button class="btn" onclick="stopAllSpeech()">Stop</button><button class="btn" onclick="clearReader()">Clear text</button></div>\n    </div>\n  </section>\n',
    '<div class="utility-row"><button class="btn accent" onclick="startReader()">Read the transcript again</button><button class="btn" onclick="pauseReader()">Pause</button><button class="btn" onclick="resumeReader()">Resume</button><button class="btn" onclick="stopAllSpeech()">Stop</button><button class="btn" onclick="clearReader()">Clear text</button></div>\n    </div>\n' + EYE_HTML)
rep("</style>\n</head>", """  .eye-view { position: relative; aspect-ratio: 16 / 9; background: var(--bg); border: 2px solid var(--border); border-radius: 12px; overflow: hidden; margin: .5rem 0; }
  .eye-view video { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; background: #000; }
  .eye-view .empty { position: absolute; inset: 0; display: grid; place-items: center; color: var(--muted); font-weight: 600; }
</style>
</head>""")
# Voice routes for the screen eye (before the generic rules)
rep("  if (/hands.?free|always listen|keep listening|হ্যান্ডস ?ফ্রি|সবসময় শোনো/.test(q)) return toggleHandsFree();\n",
    "  if (/hands.?free|always listen|keep listening|হ্যান্ডস ?ফ্রি|সবসময় শোনো/.test(q)) return toggleHandsFree();\n"
    "  if (/watch my screen|see my screen|share (my )?screen|look at my screen|স্ক্রিন দেখো|স্ক্রিন শেয়ার/.test(q)) return eyeStart();\n"
    "  if (/stop watching|stop (the )?screen|স্ক্রিন দেখা বন্ধ/.test(q)) return eyeStop();\n"
    "  if (/(^|\\s)(open|launch|start|go to|switch to)\\s|খোলো|খুলো|চালু করো|যাও/.test(q) && appFromText(q)) return eyeOpen(q);\n"
    "  if (/explain (this|that|it|what|the (slide|page|screen|document|design|chart|message|picture|form))|what does (this|that|it) (mean|say)|help me (understand|with (this|the))|summari[sz]e (this|that|it|the)|এটা বুঝিয়ে|বুঝিয়ে বলো|ব্যাখ্যা করো|সারাংশ/.test(q) && (eye.active || ($('eye-paste') && $('eye-paste').value.trim()))) return eyeExplain(query);\n"
    "  if (/i want to (code|write code|program|work)|let'?s code|help me code|time to code|কোড করব|কোড লিখব|কাজ করব/.test(q)) return eyeSetTask(q);\n"
    "  if (/close (it|this|that|the pop.?up|the dialog|the window)|cancel (it|this|that)|dismiss|পপ.?আপ বন্ধ|বাতিল করো/.test(q)) return eyeCloseDialog();\n"
    "  if (/where('s| is) (the )?[a-z ]+ (button|icon|link|option)|find the [a-z ]+ (button|icon|link)|বোতাম কোথায়/.test(q)) return eyeFind(q);\n"
    "  if (/read (the |this |that )?(error|terminal|output)|what went wrong|explain the error|ভুলটা পড়|এরর/.test(q)) return eyeReadError();\n"
    "  if (/what('s| is) on (the |my )?screen|which (app|tab|window)|where am i|wrong (tab|window)|কোন উইন্ডো|কোন অ্যাপ|কোথায় আছি|স্ক্রিনে কী/.test(q)) return eyeWhatsOnScreen();\n"
    "  if (/keyboard guidance|focus narration|কীবোর্ড গাইড/.test(q)) return toggleFocusNarration();\n")
# Anything unrecognised goes to the fuzzy intent matcher, then to a scene description, never to a refusal.
rep("  return announce('I did not recognise that request. Try Describe surroundings, Read this, or Find my glasses.', 'অনুরোধ বুঝতে পারিনি। বলুন চারপাশ বলো, এটা পড়ো অথবা আমার চশমা কোথায়।');",
    "  return smartFallback(query, q);")
# The old one-tap recogniser stopped at the first pause; the module defines the replacement.
rep_between("function toggleListening() {\n  if (state.listening) { stopListening(); return; }\n  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;\n  if (!SR) { setCaption(t('agent_voice'), t('voice_unavailable'), 'voice'); speak(t('voice_unavailable'), tBn('voice_unavailable')); return; }\n  if (reader.active) pauseReader();",
            "function stopListening() {", "")
rep("function stopListening() {\n  state.listening = false;", "function stopListening() {\n  state.listening = false; clearTimeout(listenTimer);")
# Speak by the dominant script and only with a voice that exists; strip symbols that get spelled out.
rep("  const u = makeUtterance(text, /[\\u0980-\\u09ff]/.test(text) ? 'bn' : 'en');\n  if (!u) { stopReader(); $('reader-progress').textContent = 'No local voice available'; return; }",
    "  const langFor = speechLangFor(text);\n  if (!langFor) { reader.index++; return readNextChunk(generation); }\n  const u = makeUtterance(sanitizeForSpeech(text), langFor);\n  if (!u) { stopReader(); $('reader-progress').textContent = t('reader_no_voice'); return; }")
rep("    const lines = (data.lines || []).filter(l => l.confidence >= 55).map(l => l.text.replace(/\\s+/g, ' ').trim())\n      .filter(l => { const letters = l.replace(/[^\\p{L}\\p{N}]/gu, '').length; return letters >= 2 && letters / l.length >= 0.5; });\n    const text = lines.join('\\n');\n    if (!text) { $('ocr-result').hidden = true;",
    "    const lines = (data.lines || []).filter(l => l.confidence >= 55).map(l => cleanOcrLine(l.text))\n      .filter(l => { const letters = l.replace(/[^\\p{L}\\p{N}]/gu, '').length; return letters >= 2 && letters / l.length >= 0.5; });\n    const text = lines.join('\\n');\n    if (!text) { $('ocr-result').hidden = true;")
# Listening language preference + OCR language follows the voice language by default.
rep("      <label class=\"field\" for=\"voice-select\">LUNEYRA's voice<select class=\"select-dropdown\" id=\"voice-select\" onchange=\"onVoiceChosen(this.value)\"></select></label>",
    "      <label class=\"field\" for=\"voice-select\">LUNEYRA's voice<select class=\"select-dropdown\" id=\"voice-select\" onchange=\"onVoiceChosen(this.value)\"></select></label>\n"
    "      <label class=\"field\" for=\"stt-lang\">I speak<select class=\"select-dropdown\" id=\"stt-lang\" onchange=\"try{localStorage.setItem('astha.stt',this.value)}catch(e){}\"><option value=\"auto\">Same as the voice language</option><option value=\"en-US\">English</option><option value=\"bn-BD\">বাংলা (Banglish works too)</option></select></label>")
rep("    if(['ben+eng','eng'].includes(p.ocr))$('ocr-language').value=p.ocr;",
    "    if(['ben+eng','eng'].includes(p.ocr))$('ocr-language').value=p.ocr; else if(voiceLang==='en')$('ocr-language').value='eng';\n    const stt=localStorage.getItem('astha.stt'); if(stt && $('stt-lang'))$('stt-lang').value=stt;")
rep("const q = query.toLowerCase().replace(/^(?:hey\\s+)?(?:luneyra|astha)[,.!\\s]*/i, '')", "const q = query.toLowerCase().replace(/^(?:hey\\s+)?(?:luneyra|luneira|astha|asta|ashtha)[,.!\\s]*/i, '')")

# ---- Round 1 memory: approved object events with time and confidence ----
rep("    const partsEn = fresh.slice(0, 3).map(o => `${labelWithArticle(o.id)} ${t('pos_' + o.pos)}`);\n    const partsBn = fresh.slice(0, 3).map(o => `${tBn('pos_' + o.pos)} ${labelBn(o.id)}`);\n    const msgEn = t('new_object', { list: joinList(partsEn, false) });\n    const msgBn = tBn('new_object', { list: joinList(partsBn, true) });",
    "    const dEn = o => (typeof distPhrase === 'function' && distPhrase(o, false)) ? ', ' + distPhrase(o, false) : '';\n    const dBn = o => (typeof distPhrase === 'function' && distPhrase(o, true)) ? ', ' + distPhrase(o, true) : '';\n    const partsEn = fresh.slice(0, 3).map(o => `${objLabelWithArticle(o)} ${t('pos_' + o.pos)}${dEn(o)}`);\n    const partsBn = fresh.slice(0, 3).map(o => `${tBn('pos_' + o.pos)} ${objLabelBn(o)}${dBn(o)}`);\n    let msgEn = t('new_object', { list: joinList(partsEn, false) });\n    let msgBn = tBn('new_object', { list: joinList(partsBn, true) });\n"
    "    // Approved object events: offer to remember a confident personal item, never save silently.\n"
    "    const keep = fresh.find(o => (VOCAB_BY_ID[o.id] || {}).personal && o.score >= 0.7 && now - (state.lastRememberOffer || 0) > 45000);\n"
    "    if (keep && !privacyMode) { state.lastRememberOffer = now; state.rememberCandidate = keep.id; msgEn += ` Say “remember this” to save where your ${objLabel(keep)} is.`; msgBn += ` আপনার ${objLabelBn(keep)} কোথায় আছে মনে রাখতে বলুন “এটা মনে রাখো”।`; }")



# ---- Cloud reasoning, modes, owner ID, secure-connection banner ----
cloud_js = (HERE / "cloud.js").read_text(encoding="utf-8")
rep('<p class="prototype-note">Browser prototype · Camera recognition and reading are experimental. Use your usual mobility aid; LUNEYRA cannot confirm a safe path.</p>',
    '<p class="prototype-note"><strong>LUNEYRA AI Companion</strong> <span id="safety-note">· Experimental visual assistance. Use your usual mobility aid; LUNEYRA cannot confirm a safe path. লুনেইরা নিরাপদ পথ নিশ্চিত করতে পারে না।</span></p>\n'
    '      <p class="prototype-note" id="secure-banner" hidden style="border-color:var(--danger)"><strong>This page is open on an insecure address.</strong> <span id="secure-body">The browser will ask for the microphone and camera every time and may block them. Open the app on localhost or over HTTPS. On Android, use Chrome\'s port forwarding (chrome://inspect on the computer) so the phone sees localhost, or a Cloudflare tunnel.</span></p>')
rep('        <button class="chip-btn" id="hf-btn" onclick="toggleHandsFree()" aria-pressed="false" title="Keep listening for “LUNEYRA, …”">🎧 <span id="hf-label">Hands-free: off</span></button>\n      </div>',
    '        <button class="chip-btn" id="hf-btn" onclick="toggleHandsFree()" aria-pressed="false" title="Keep listening for “LUNEYRA, …”">🎧 <span id="hf-label">Hands-free: off</span></button>\n'
    '        <div class="segmented" role="group" aria-label="AI Engine Mode" title="Choose online processing or on-device models">\n'
    '          <button id="btn-mode-gemini" onclick="Subscription.setMode(\'gemini\')" aria-pressed="false">✨ Online AI</button>\n'
    '          <button id="btn-mode-offline" onclick="Subscription.setMode(\'offline\')" aria-pressed="false">📱 Offline</button>\n'
    '        </div>\n'
    '        <div class="segmented" role="group" aria-label="Speaking mode" title="Auto: speaks up in busy places. Quiet: speaks only when asked.">\n'
    '          <button id="mode-auto" onclick="setMode(\'auto\')" aria-pressed="true">Auto · busy area</button>\n'
    '          <button id="mode-quiet" onclick="setMode(\'quiet\')" aria-pressed="false">Quiet · ask me</button>\n'
    '        </div>\n      </div>')
rep('        <h2 data-i18n="engine_title">On-device AI engine</h2>\n        <button class="btn small accent" id="load-models-btn" onclick="loadAllModels()" data-i18n="engine_load">Load models</button>',
    '        <h2 data-i18n="engine_title">On-device AI engine</h2>\n        <span class="pill" id="cloud-pill">Checking cloud…</span>\n        <button class="btn small accent" id="load-models-btn" onclick="loadAllModels()" data-i18n="engine_load">Load models</button>')
rep('    <!-- AI Model Diagnostics -->',
    '    <div class="card" id="owner-card">\n'
    '      <div class="card-head"><h2>Owner ID</h2></div>\n'
    '      <p class="help">Face and voice matching are experimental convenience controls, not secure authentication. Templates are saved locally for this profile. Camera and microphone access require your browser permission.</p>\n'
    '      <div class="utility-row"><button class="btn accent" onclick="enrollOwnerFace()">Remember my face</button><button class="btn" onclick="enrollOwnerVoice()">Remember my voice (experimental)</button><button class="btn" onclick="ownerItsMe()">It\'s me</button><button class="btn" id="owner-lock-btn" aria-pressed="false" onclick="toggleOwnerLock()">Owner lock: off</button></div>\n'
    '      <p class="help" id="owner-status" role="status"></p>\n'
    '    </div>\n\n    <!-- AI Model Diagnostics -->')
# Cloud-first actions with on-device fallback
rep("function describeScene() {\n  if (withCamera(describeScene)) return;", "function describeScene(skipCloud) {\n  if (withCamera(describeScene)) return;\n  if (cloudReady() && !skipCloud) return cloudDescribe();")
# Auto mode: the cloud checks the frame before LUNEYRA speaks about new on-device detections; stricter thresholds otherwise.
rep("const fresh = worldSorted().filter(o => (state.announced.get(o.id) || 0) < now - 10000 && o.score >= (o.src === 'coco' ? 0.55 : 0.28));",
    "const fresh = worldSorted().filter(o => (state.announced.get(o.id) || 0) < now - 10000 && o.score >= (o.src === 'coco' ? (STRICT_COCO.has(o.id) ? 0.75 : 0.65) : 0.3) && !(o.flags && (o.flags.doubtful || o.flags.onScreen)));")
rep("    setCaption(t('new_title'), msgEn, 'vision', null, msgBn);\n    speak(msgEn, msgBn);\n    heartPointAt(fresh[0]);",
    "    if (cloudReady()) { cloudVerifyAndSpeak(fresh, msgEn, msgBn); return; }\n    setCaption(t('new_title'), msgEn, 'vision', null, msgBn);\n    speak(msgEn, msgBn);\n    heartPointAt(fresh[0]);")
# Still-image reading through the cloud when available
rep("    const frame = captureFrame(1280);\n    setCaption(t('reading_title'), t('ocr_working'), 'ocr', 'busy', tBn('ocr_working'));\n    speak(t('ocr_working'), tBn('ocr_working'));\n    let data;\n    try { ({ data } = await worker.recognize(frame)); } catch (e) { if (!stillWanted() || e.cancelled) return; throw e; }\n    if (!stillWanted()) return;\n    const lines = (data.lines || []).filter(l => l.confidence >= 55).map(l => cleanOcrLine(l.text))\n      .filter(l => { const letters = l.replace(/[^\\p{L}\\p{N}]/gu, '').length; return letters >= 2 && letters / l.length >= 0.5; });\n    const text = lines.join('\\n');",
    "    const frame = captureFrame(1280);\n    setCaption(t('reading_title'), t('ocr_working'), 'ocr', 'busy', tBn('ocr_working'));\n    speak(t('ocr_working'), tBn('ocr_working'));\n    let lines = null, explain = null;\n    if (cloudReady()) { try { const r = await cloudReadLines(frame); if (!stillWanted()) return; lines = r.lines; explain = r; } catch (e) { if (e.cancelled || !stillWanted()) return; cloudFail(e); } }\n    if (!stillWanted()) return;\n    if (!lines) {\n      let data;\n      try { ({ data } = await worker.recognize(frame)); } catch (e) { if (!stillWanted() || e.cancelled) return; throw e; }\n      if (!stillWanted()) return;\n      lines = (data.lines || []).filter(l => l.confidence >= 55).map(l => cleanOcrLine(l.text))\n        .filter(l => { const letters = l.replace(/[^\\p{L}\\p{N}]/gu, '').length; return letters >= 2 && letters / l.length >= 0.5; });\n    }\n    if (!stillWanted()) return;\n    const text = lines.join('\\n');\n    if (explain && explain.explainEn) reader.onFinish = () => speak(explain.explainEn, explain.explainBn);")
# Voice: yes/no follow-ups, owner lock, modes, screen reading, owner commands
rep("  if (!privacyMode) logEvent('Request: ' + query);\n",
    "  if (!privacyMode) logEvent('Request: ' + query);\n"
    "  if (answerYesNo(q)) return;\n"
    "  if (!ownerGate(query)) return;\n"
    "  if (/online mode|online ai|gemini mode|gemini ai|use gemini|20 day pass|অনলাইন মোড|জেমিনি মোড/.test(q)) return Subscription.setMode('gemini');\n"
    "  if (/offline mode|on.?device mode|use offline|go offline|অফলাইন মোড|ডিভাইস মোড/.test(q)) return Subscription.setMode('offline');\n"
    "  if (/auto mode|busy (area|place|road)|speak (up )?automatically|announce automatically|অটো মোড|নিজে থেকে বলো|ব্যস্ত জায়গা/.test(q)) return setMode('auto');\n"
    "  if (/quiet mode|silent mode|only when i ask|speak only when|stop announcing|শান্ত মোড|চুপচাপ মোড|জিজ্ঞাসা করলে বলো/.test(q)) return setMode('quiet');\n"
    "  if (/read (what i wrote|what i typed|my code|the code|the screen|the document|this page on (the )?screen|what is written|what's written)|read aloud what|স্ক্রিনের লেখা পড়|কোড পড়|যা লিখেছি পড়/.test(q)) return eyeReadScreen();\n"
    "  if (/remember my face|learn my face|enrol+ my face|আমার মুখ মনে রাখো|মুখ শেখো/.test(q)) return enrollOwnerFace();\n"
    "  if (/remember my voice|learn my voice|enrol+ my voice|আমার কণ্ঠ মনে রাখো|গলা শেখো/.test(q)) return enrollOwnerVoice();\n"
    "  if (/^(it'?s me|this is me|unlock)\\b|আমি লুনেইরা|আনলক করো|এটা আমি/.test(q)) return ownerItsMe();\n"
    "  if (/owner lock|মালিক লক/.test(q)) return toggleOwnerLock();\n"
    "  if (/(delete|close|remove) my account|অ্যাকাউন্ট (মুছ|ডিলিট)|একাউন্ট (মুছ|ডিলিট)/.test(q)) return openDeleteAccount(true);\n"
    "  if (/(download|export) my (data|information)|আমার (তথ্য|ডেটা) (ডাউনলোড|রপ্তানি)/.test(q)) return exportMyData();\n"
    "  if (/(forget|delete|remove) my (face|voice)|(মুখ|কণ্ঠ|গলা) (ভুলে যাও|মুছ)/.test(q)) return forgetOwnerBiometrics();\n"
    "  if (/create (an |my )?account|^(log|sign) ?in[.!]?$|(log|sign) ?in to my account|অ্যাকাউন্ট তৈরি|লগ ?ইন কর/.test(q)) return openAuthGate();\n"
    "  if (/^(log|sign) ?out[.!]?$|(log|sign) ?out of my account|সাইন ?আউট কর|লগ ?আউট কর/.test(q)) return signOut();\n")
# Keep the owner verified quietly while the camera runs
rep("      drawOverlay(frame, objs, state.lastClipHits);\n      afterLiveUpdate();\n    }\n  } catch (e) { console.warn('coco tick', e); }",
    "      drawOverlay(frame, objs, state.lastClipHits);\n      afterLiveUpdate();\n      ownerAutoCheck();\n    }\n  } catch (e) { console.warn('coco tick', e); }")



# ---- remove the browser-encrypted vault UI; server storage + account passcode replace it ----
rep('      <details><summary>Encrypted storage on this browser</summary>\n'
    '        <p class="help">Use a passphrase to save memories between visits. It is never stored. Keep it safe: a forgotten passphrase cannot be recovered.</p>\n'
    '        <label class="field" for="vault-password">Passphrase (at least 10 characters)<input id="vault-password" type="password" minlength="10" maxlength="200" autocomplete="off"></label>\n'
    '        <div class="utility-row"><button class="btn" onclick="unlockVault()">Unlock / create</button><button class="btn" onclick="lockVault()">Lock & clear session</button></div>\n'
    '        <p id="vault-status" class="help" role="status">Encrypted storage is locked.</p>\n'
    '      </details>\n',
    '')

# ---- account row: who is signed in, with a sign-out button ----
rep('Memory is kept for this session unless you unlock encrypted storage.',
    'Notes are saved on this browser and synced to your account when permitted and connected. Browser notes are not encrypted.')
rep('      <div class="card-head"><h2>Your preferences</h2></div>',
    '      <div class="card-head"><h2>Your preferences</h2></div>\n'
    '      <p class="help" id="account-row" role="status"></p>\n'
    '      <div class="utility-row"><button class="btn small" id="account-open-btn" onclick="openAuthGate()" hidden>Create account or log in</button>'
    '<button class="btn small" id="sign-out-btn" onclick="signOut()" hidden>Sign out</button></div>\n'
    '      <p class="help" id="data-help">You can download everything LUNEYRA has saved about you, remove your face and voice templates, or delete your account.</p>\n'
    '      <div class="utility-row"><button class="btn small" onclick="exportMyData()">Download my data</button>'
    '<button class="btn small" onclick="forgetOwnerBiometrics()">Forget my face and voice</button>'
    '<button class="btn small danger" id="delete-account-btn" onclick="openDeleteAccount()" aria-expanded="false" aria-controls="delete-account-panel">Delete my account</button></div>\n'
    '      <div id="delete-account-panel" role="group" aria-labelledby="delete-account-warning" hidden>\n'
    '        <p class="help" id="delete-account-warning">This permanently deletes your LUNEYRA account, every saved memory, room note, activity record and personal note, and the copies on this phone. It cannot be undone.</p>\n'
    '        <p class="help" id="delete-account-note" hidden></p>\n'
    '        <label class="field" id="delete-account-pin-field" for="delete-account-pin">Enter your passcode to confirm<input id="delete-account-pin" type="password" inputmode="numeric" autocomplete="current-password" maxlength="128"></label>\n'
    '        <div class="utility-row"><button class="btn danger" id="delete-account-confirm" onclick="confirmDeleteAccount()">Delete permanently</button><button class="btn" onclick="closeDeleteAccount()">Cancel</button></div>\n'
    '      </div>\n'
    '      <p class="help" id="data-status" role="status"></p>\n')

# ---- PWA head tags ----
rep('<title>LUNEYRA — AI Vision Companion</title>',
    '<title>LUNEYRA — AI Vision Companion</title>\n'
    '<meta name="theme-color" content="#64409a">\n'
    '<link rel="manifest" href="manifest.webmanifest">\n'
    '<link rel="apple-touch-icon" href="icons/icon-192.png">\n'
    '<meta name="apple-mobile-web-app-capable" content="yes">\n'
    '<meta name="mobile-web-app-capable" content="yes">')

# ---- the sign-in / create-account gate shown before the app boots ----
AUTH_GATE = ('<div id="auth-gate" role="dialog" aria-modal="true" aria-labelledby="auth-title">\n'
    '  <div class="auth-card">\n'
    '    <h1 id="auth-title">LUNEYRA — লুনেইরা</h1>\n'
    '    <p class="auth-sub">Your voice-first visual companion. Create an account once; LUNEYRA remembers your things and rooms after that.</p>\n'
    '    <div class="segmented" role="group" aria-label="Account action" style="margin-bottom:14px">\n'
    '      <button id="auth-tab-signup" onclick="setAuthTab(\'signup\')" aria-pressed="true">Create account</button>\n'
    '      <button id="auth-tab-login" onclick="setAuthTab(\'login\')" aria-pressed="false">Log in</button>\n'
    '    </div>\n'
    '    <form id="auth-form" onsubmit="event.preventDefault(); submitAuth();">\n'
    '      <label class="field" id="auth-name-field" for="auth-name">Your name<input id="auth-name" autocomplete="name" maxlength="80" required></label>\n'
    '      <label class="field" for="auth-phone">Phone number<input id="auth-phone" type="tel" inputmode="numeric" autocomplete="tel" maxlength="20" required placeholder="01XXXXXXXXX"></label>\n'
    '      <label class="field" for="auth-passcode">Passcode (4 to 8 digits)<input id="auth-passcode" type="password" inputmode="numeric" autocomplete="new-password" minlength="4" maxlength="8" required></label>\n'
    '      <button class="btn accent" type="submit" id="auth-submit" style="width:100%">Create my account</button>\n'
    '    </form>\n'
    '    <p class="help" id="auth-status" role="status"></p>\n'
    '    <p class="help">Your name and phone are used only to sign you back in. Everything LUNEYRA remembers stays tied to your account.</p>\n'
    '    <button class="btn" type="button" id="auth-close" onclick="closeAuthGate()">Continue without an account</button>\n'
    '  </div>\n'
    '</div>\n')
rep('<a class="skip-link" href="#companion-main">Skip to companion</a>\n',
    '<a class="skip-link" href="#companion-main">Skip to companion</a>\n' + AUTH_GATE)

# ---- client scripts: config (deployment overrides) + backend (auth gate wiring) ----
rep('</script>\n</body>\n</html>',
    '</script>\n' + ''.join(f'<script src="{bootstrap_urls[name]}"></script>\n' for name in BOOTSTRAP) + '</body>\n</html>')


# ---- Offline companion: no narration while a search is guiding; route the new voice abilities ----
rep("  if (state.listening || reader.active || asthaSpeaking()) return;\n  // Movement first",
    "  if (state.listening || reader.active || asthaSpeaking() || state.seeking) return;\n  // Movement first")
rep("  if (/computer|code|programming|teach|summar|explain|navigate|guide me|কম্পিউটার|কোড|ব্যাখ্যা|সারাংশ|পথ দেখাও/.test(q))\n"
    "    return announce('That feature needs a future integration. I can describe an image, read text, and recall your saved object or room notes.', 'এই সুবিধা এখনও যুক্ত হয়নি। ছবি বর্ণনা, লেখা পড়া ও সংরক্ষিত নোট মনে করতে পারি।');\n",
    "  if (typeof offlineRoute === 'function' && offlineRoute(query, q)) return;\n"
    "  if (/\\b(programming|teach me|explain (this|that) code)\\b|প্রোগ্রামিং|শেখাও/.test(q) && !/screen|স্ক্রিন/.test(q))\n"
    "    return announce('I can read what is on your screen, describe your surroundings, read text, find your things and guide you to them.', 'আমি আপনার স্ক্রিনের লেখা পড়তে, চারপাশ বর্ণনা করতে, লেখা পড়তে, জিনিস খুঁজতে ও সেখানে নিয়ে যেতে পারি।');\n")

# ---- module + boot ----
assert "</script" not in json.dumps(i18n["strings"], ensure_ascii=False).lower()
i18n_data = "const I18N_EXTRA = " + json.dumps(i18n["strings"], ensure_ascii=False, separators=(",", ":")) + ";\n"
rep("  renderSeen(); renderMemory(); renderLog();\n}\n", "  applyStaticI18n();\n  renderSeen(); renderMemory(); renderLog();\n}\n")
experience_js = (HERE / "experience.js").read_text(encoding="utf-8")
pi_ui_js = (HERE / "pi-camera-ui.js").read_text(encoding="utf-8")
camera_kit_js = (HERE / "camera-kit.js").read_text(encoding="utf-8")
braille_js = (HERE / "braille.js").read_text(encoding="utf-8")
screen_js = (HERE / "screen-access.js").read_text(encoding="utf-8")
messages_js = (HERE / "messages.js").read_text(encoding="utf-8")
sensors_js = (HERE / "sensors.js").read_text(encoding="utf-8")
diagnostics_js = (HERE / "diagnostics.js").read_text(encoding="utf-8")
diagnostics_ui_js = (HERE / "diagnostics-ui.js").read_text(encoding="utf-8")
ai_status_js = (HERE / "ai-status.js").read_text(encoding="utf-8")
vision_details_js = (HERE / "vision-details.js").read_text(encoding="utf-8")
rep("\n(function boot() {", i18n_data + i18n_js.rstrip("\n") + "\n" + diagnostics_js.rstrip("\n") + "\n" + diagnostics_ui_js.rstrip("\n") + "\n" + ai_status_js.rstrip("\n") + "\n" + vision_details_js.rstrip("\n") + "\n" + module.rstrip("\n") + "\n" + eye_js.rstrip("\n") + "\n" + cloud_js.rstrip("\n") + "\n" + agent_js.rstrip("\n") + "\n" + perceive_js.rstrip("\n") + "\n" + spatial_js.rstrip("\n") + "\n" + offline_js.rstrip("\n") + "\n" + account_js.rstrip("\n") + "\n" + experience_js.rstrip("\n") + "\n" + pi_ui_js.rstrip("\n") + "\n" + camera_kit_js.rstrip("\n") + "\n" + braille_js.rstrip("\n") + "\n" + sensors_js.rstrip("\n") + "\n" + screen_js.rstrip("\n") + "\n" + messages_js.rstrip("\n") + "\n\n(function boot() {")
rep("  renderSpatialLayout();\n  enhancementBoot();\n})();", "  renderSpatialLayout();\n  enhancementBoot();\n  companionBoot();\n  eyeBoot();\n  cloudBoot();\n})();")

# ---- boot(): expose it instead of self-invoking, so backend.js can run it after sign-in ----
rep('(function boot() {', 'window.__asthaBoot = function boot() {')
rep('  companionBoot();\n  eyeBoot();\n  cloudBoot();\n})();',
    '  companionBoot();\n  eyeBoot();\n  cloudBoot();\n  offlineBoot();\n  AsthaExperience.boot();\n  AsthaPiCamera.boot();\n  AsthaCameraKit.boot();\n  AsthaBraille.boot();\n  AsthaScreenAccess.boot();\n  AsthaMessages.boot();\n  AsthaDiagnosticsUI.boot();\n  AsthaAiStatus.boot();\n  AsthaVisionDetails.boot();\n  refreshMemory();\n  refreshRooms();\n'
    '};')
# Page navigation, the personal setup assessment and the connected-devices page.
assessment_html = (HERE / "assessment.html").read_text(encoding="utf-8").replace('<div id="pi-connection-slot"></div>', '<div id="pi-connection-slot">' + (HERE / "pi-camera-controls.html").read_text(encoding="utf-8") + '</div>')
rep('<main', assessment_html + '\n<main')
rep('function handleQuery(query) {\n  if (privacyTransition) return;',
    'function handleQuery(query) {\n  if (privacyTransition) return;\n  if (AsthaExperience.route(query)) return;')
# ---- translation hooks: tag each listed element, verifying it still shows its English string ----
def add_i18n_hooks():
    global html
    strings = i18n["strings"]
    for anchor, hooks in i18n["hooks"]:
        # Only page markup is tagged; the same tag text may also occur inside script templates.
        markup_end = html.index("<script", html.index("<body"))
        n = html.count(anchor, 0, markup_end)
        assert n == 1, f"i18n anchor found {n}x (expected 1): {anchor[:90]!r}"
        start = html.index(anchor)
        close = html.index(">", start)
        tag = html[start:close]
        added = ""
        for mode, key in hooks.items():
            english = strings[key][0] if key in strings else None
            if mode in ("text", "lead"):
                end = html.index("<", close + 1)
                assert english is None or html[close + 1:end].strip() == english.strip(), f"i18n text drifted for {key!r}: {html[close + 1:close + 61]!r}"
                if mode == "text":
                    assert html.startswith("</", end), f"data-i18n replaces all content; {key!r} is not a leaf element"
                added += f' data-i18n="{key}"' if mode == "text" else f' data-i18n-lead="{key}"'
            else:
                assert mode in ("aria-label", "title", "placeholder", "alt"), f"unknown i18n hook {mode!r}"
                assert english is None or f'{mode}="{english}"' in tag, f"i18n attribute drifted for {key!r}: {tag[:90]!r}"
                added += f' data-i18n-{mode}="{key}"'
        html = html[:close] + added + html[close:]
add_i18n_hooks()
DST.write_text(html, encoding="utf-8", newline="\n")
print("wrote", DST, len(html.encode("utf-8")), "bytes")

# ---- service worker: a new cache name per build, so stale shells are dropped on activate ----
sw_path = DST.parent / "sw.js"
sw = sw_path.read_text(encoding="utf-8")
shell_assets = ("manifest.webmanifest", "icons/icon-192.png", "icons/icon-512.png", "brand/luneyra-purple-winged-v1.png", "brand/astha-mulberry-apricot-v1.png", "brand/astha-mulberry-apricot-dark-v1.png")
shell_urls = ["./", "./index.html"] + ["./" + bootstrap_urls[name] for name in BOOTSTRAP] + ["./" + name for name in shell_assets]
sw, replacements = re.subn(r"^const SHELL = .*;$", "const SHELL = " + json.dumps(shell_urls) + ";", sw, count=1, flags=re.MULTILINE)
assert replacements == 1, 'Service-worker shell URL anchor is missing.'
shell_hash = hashlib.sha256(html.encode("utf-8"))
# Bootstrap/config-only changes must invalidate cache-first resources, too. Normalize the
# stamp itself to avoid a circular hash and keep successive builds byte-for-byte identical.
shell_hash.update(re.sub(r"const CACHE = 'astha-shell-[^']*';", "const CACHE = 'astha-shell-STAMP';", sw).encode("utf-8"))
for asset in BOOTSTRAP + shell_assets:
    shell_hash.update(asset.encode("utf-8"))
    shell_hash.update((DST.parent / asset).read_bytes())
stamp = shell_hash.hexdigest()[:10]
sw_new = re.sub(r"const CACHE = 'astha-shell-[^']*';", f"const CACHE = 'astha-shell-{stamp}';", sw, count=1)
sw_path.write_text(sw_new, encoding="utf-8", newline="\n")
if sw_new != sw:
    print("stamped", sw_path, "cache astha-shell-" + stamp)
