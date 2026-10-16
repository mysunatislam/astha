/* =====================================================================
   Spatial layout: a rough map of how far things are to the left,
   straight ahead and to the right, from one picture.
   The depth model only knows which parts of a picture are nearer. Its
   output behaves like k / distance + c, so two known distances in the
   same picture fix both numbers: the Pi's ultrasonic reading (measured)
   and the size-based distances of recognised objects (estimates). With
   fewer than two, or with known distances that disagree, ASTHA says
   only which side is nearer. Nothing here calls a way clear or safe.
   ===================================================================== */
const AsthaSpatial = (() => {
  const SECTORS = [
    { key: 'left', x0: 0, x1: 0.35, en: 'To your left', bn: 'বাঁয়ে' },
    { key: 'ahead', x0: 0.35, x1: 0.65, en: 'Straight ahead', bn: 'সোজা সামনে' },
    { key: 'right', x0: 0.65, x1: 1, en: 'To your right', bn: 'ডানে' },
  ];
  // Around eye level for a camera worn facing forward. The floor enters this band only when
  // the camera points down; without a tilt sensor that cannot be checked.
  const BAND = { y0: 0.3, y1: 0.7 };
  const RANGE_M = 4;          // beyond this nothing is reported as a distance
  const MEASURED_WEIGHT = 4;  // a measurement counts for four estimates
  const MAX_LOG_ERROR = 0.4;  // known distances off by more than about 50 % mean the fit is wrong

  // Weighted least squares for near = k * (1 / metres) + c.
  function fitScale(anchors) {
    const usable = (anchors || []).filter(a => Number.isFinite(a.near) && a.near > 0.02 && a.near < 0.98 &&
      Number.isFinite(a.metres) && a.metres >= 0.1 && a.metres <= 15 && a.weight > 0);
    if (usable.length < 2) return null;
    const inverse = usable.map(a => 1 / a.metres);
    if (Math.max(...inverse) / Math.min(...inverse) < 1.3) return null;   // all at one distance: no scale
    let sw = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
    usable.forEach((a, i) => { const w = a.weight, x = inverse[i]; sw += w; sx += w * x; sy += w * a.near; sxx += w * x * x; sxy += w * x * a.near; });
    const det = sw * sxx - sx * sx;
    if (Math.abs(det) < 1e-9) return null;
    const k = (sw * sxy - sx * sy) / det, c = (sy - k * sx) / sw;
    if (!(k > 0)) return null;                                              // nearer must look nearer
    const fit = { k, c, anchors: usable.length, measured: usable.some(a => a.measured) };
    const errors = usable.map(a => Math.abs(Math.log(metresAt(fit, a.near) / a.metres)));
    if (errors.some(e => !Number.isFinite(e)) || Math.sqrt(errors.reduce((s, e) => s + e * e, 0) / errors.length) > MAX_LOG_ERROR) return null;
    return fit;
  }
  function metresAt(fit, near) {
    const d = near - fit.c;
    return d > 0 ? fit.k / d : Infinity;
  }
  // The nearest part of a region, ignoring the nearest tenth as noise.
  function regionNearness(map, x0, x1, y0, y1) {
    if (!map || !map.near) return null;
    const c0 = Math.floor(x0 * map.w), c1 = Math.min(map.w, Math.ceil(x1 * map.w));
    const r0 = Math.floor(y0 * map.h), r1 = Math.min(map.h, Math.ceil(y1 * map.h));
    const values = [];
    for (let r = r0; r < r1; r++) for (let c = c0; c < c1; c++) values.push(map.near[r * map.w + c]);
    if (!values.length) return null;
    values.sort((a, b) => a - b);
    return values[Math.min(values.length - 1, Math.floor(values.length * 0.9))];
  }
  function anchorsFrom(objs, frame, map, reading) {
    const anchors = [];
    let measuredUsed = false;
    for (const o of objs || []) {
      if (o.distMeasured && typeof currentMeasuredDistance === 'function' && !currentMeasuredDistance(o)) continue;
      if (!o.bbox || o.distM == null || o.distWeak || o.distLower || (o.flags && (o.flags.onScreen || o.flags.picture || o.flags.toy))) continue;
      const near = DepthEngine.nearnessInBox(map, o.bbox, frame.width, frame.height);
      if (near == null) continue;
      anchors.push({ near, metres: o.distM, weight: o.distMeasured ? MEASURED_WEIGHT : 1, measured: !!o.distMeasured });
      measuredUsed = measuredUsed || !!o.distMeasured;
    }
    // A reading no recognised object took still says how far the middle of the picture is.
    if (reading && reading.measured && !measuredUsed) {
      const near = DepthEngine.nearnessInRegion(map, 0.45, 0.43, 0.1, 0.14);
      if (near != null) anchors.push({ near, metres: reading.metres, weight: MEASURED_WEIGHT, measured: true });
    }
    return anchors;
  }
  // objs: the detections of this picture after perceptionHook; map: DepthEngine output for it.
  function layout(objs, frame, map, reading) {
    if (!map || !frame) return null;
    const fit = fitScale(anchorsFrom(objs, frame, map, reading));
    const sectors = SECTORS.map(s => {
      const near = regionNearness(map, s.x0, s.x1, BAND.y0, BAND.y1);
      let metres = fit && near != null ? metresAt(fit, near) : null, measured = false;
      if (s.key === 'ahead' && reading && reading.measured) { metres = reading.metres; measured = true; }
      // Name the nearest recognised thing in this direction, if any.
      const named = (objs || []).filter(o => o.bbox && !(o.flags && (o.flags.onScreen || o.flags.picture)))
        .filter(o => { const cx = (o.bbox[0] + o.bbox[2] / 2) / frame.width; return cx >= s.x0 && cx < s.x1; })
        .sort((a, b) => (a.distM ?? 99) - (b.distM ?? 99))[0] || null;
      return { key: s.key, near, metres, measured, object: named };
    });
    return { sectors, scaled: !!fit, anchors: fit ? fit.anchors : 0, at: Date.now() };
  }

  const digits = value => String(value).replace(/\d/g, d => '০১২৩৪৫৬৭৮৯'[d]);
  function estimatePhrase(m, bn) {
    if (Math.round(m * 10) < 10) { const cm = Math.max(30, Math.round(m * 10) * 10); return bn ? `প্রায় ${digits(cm)} সেন্টিমিটার` : `about ${cm} centimetres`; }
    const v = Math.round(m * 2) / 2;   // half-metre steps: no false precision
    return bn ? `প্রায় ${digits(v)} মিটার` : `about ${v} ${v === 1 ? 'metre' : 'metres'}`;
  }
  // What ASTHA says. Directions are relative to where the camera points.
  function sentences(result) {
    const en = [], bn = [];
    if (!result) return null;
    if (!result.scaled) {
      const known = result.sectors.filter(s => s.near != null);
      const ahead = result.sectors.find(s => s.key === 'ahead');
      if (ahead.measured) { en.push(`Straight ahead: ${measuredPhrase(ahead.metres, false)}.`); bn.push(`সোজা সামনে: ${measuredPhrase(ahead.metres, true)}।`); }
      if (known.length >= 2) {
        const nearest = known.slice().sort((a, b) => b.near - a.near)[0];
        const name = SECTORS.find(s => s.key === nearest.key);
        en.push(`From the picture alone, the nearest things are ${name.en.toLowerCase()}; I cannot judge the other distances in metres.`);
        bn.push(`শুধু ছবি দেখে, সবচেয়ে কাছের জিনিস ${name.bn}; অন্য দূরত্ব মিটারে বলতে পারছি না।`);
      }
      if (!en.length) return null;
    } else {
      for (const s of result.sectors) {
        const name = SECTORS.find(x => x.key === s.key);
        const thing = s.object && (!Number.isFinite(s.metres) || s.metres <= RANGE_M) ? s.object : null;
        const what = thing ? `, ${objLabelWithArticle(thing)}` : '', whatBn = thing ? `, ${objLabelBn(thing)}` : '';
        if (s.measured) { en.push(`${name.en}: ${measuredPhrase(s.metres, false)}${what}.`); bn.push(`${name.bn}: ${measuredPhrase(s.metres, true)}${whatBn}।`); }
        else if (Number.isFinite(s.metres) && s.metres <= RANGE_M) { en.push(`${name.en}: something ${estimatePhrase(s.metres, false)} away${what}.`); bn.push(`${name.bn}: ${estimatePhrase(s.metres, true)} দূরে কিছু আছে${whatBn}।`); }
        else { en.push(`${name.en}: nothing seen within ${RANGE_M} metres.`); bn.push(`${name.bn}: ${digits(RANGE_M)} মিটারের মধ্যে কিছু দেখছি না।`); }
      }
      en.push('Distances are estimates from the picture' + (result.sectors.some(s => s.measured) ? ', except the measured one.' : '.'));
      bn.push('দূরত্বগুলো ছবি দেখে আন্দাজ' + (result.sectors.some(s => s.measured) ? ', শুধু মাপা দূরত্বটি ছাড়া।' : '।'));
    }
    en.push('Use your cane to confirm.'); bn.push('লাঠি দিয়ে নিশ্চিত হয়ে নিন।');
    return { en: en.join(' '), bn: bn.join(' ') };
  }
  return { fitScale, metresAt, regionNearness, anchorsFrom, layout, sentences, SECTORS, BAND, RANGE_M };
})();

// "What is on each side?" / "কোন দিকে কত দূরে কী আছে?"
function answerSpatial() {
  if (withCamera(answerSpatial)) return;
  const stillWanted = captureLocalActionGuard();
  return withBusy(t('analyzing_title'), async () => {
    try {
      if (!stillWanted()) return;
      const ready = await ensureVisionModels();
      if (!stillWanted() || !ready) return;
      if (DepthEngine.status !== 'ready') {
        if (DepthEngine.status === 'idle' && DepthEngine.wanted()) DepthEngine.load().catch(() => {});
        return announce('I need the depth model for this. It is loading; ask again in a moment.', 'এর জন্য গভীরতার মডেল লাগবে। লোড হচ্ছে; একটু পরে আবার জিজ্ঞাসা করুন।', 'vision');
      }
      const frame = captureFrame(640); if (!frame) return;
      const objs = await runCoco(frame);
      if (!stillWanted()) return;
      let map = null;
      try { map = await DepthEngine.run(frame); } catch (e) { if (e.cancelled || !stillWanted()) return; }
      if (!stillWanted()) return;
      if (!map) return announce('I could not judge depth in this picture.', 'এই ছবিতে গভীরতা বুঝতে পারলাম না।', 'vision');
      perceptionHook(objs, frame, { noDepthKick: true, depthMaxAge: 60000 });
      const reading = state.source === 'pi' && typeof AsthaSensors !== 'undefined' ? AsthaSensors.measured('front') : null;
      const result = AsthaSpatial.layout(objs, frame, map, reading);
      state.spatial = result;
      const words = AsthaSpatial.sentences(result);
      if (!words) return announce('I cannot judge distances in this picture. Turn slowly so I can see more.', 'এই ছবিতে দূরত্ব বুঝতে পারছি না। ধীরে ঘুরুন যাতে আরও দেখতে পাই।', 'vision');
      setCaption(t('describe_title'), words.en, 'vision', null, words.bn);
      speak(words.en, words.bn);
    } catch (e) { if (e.cancelled || !stillWanted()) return; throw e; }
  });
}
