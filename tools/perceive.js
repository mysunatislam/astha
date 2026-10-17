
/* =====================================================================
   18. Offline perception: depth, metric distance, scene graph, rules
       Everything here runs on the phone. No model in this file talks to
       a server. The goal is understanding, not a list of labels:
         - how far each thing is (size priors + monocular depth)
         - what is on what, who is on a screen, what is a toy
         - what kind of room this is
         - a spoken summary a blind person can act on
   ===================================================================== */

// ---- Typical real-world size of each class (metres): long side L, short side S ----
// Used with the camera focal length to turn a box height into a distance. Coarse on
// purpose: Astha speaks in bands ("about two metres"), never false precision.
const SIZE_PRIOR = {
  person: [1.65, 0.5], bicycle: [1.7, 1.0], car: [4.2, 1.5], motorcycle: [2.0, 1.1], bus: [11, 3.0], truck: [7, 3.0], train: [20, 3.8], boat: [5, 1.5], airplane: [35, 10],
  'traffic light': [1.0, 0.35], 'fire hydrant': [0.75, 0.3], 'stop sign': [0.75, 0.75], 'parking meter': [1.4, 0.25], bench: [1.6, 0.9],
  bird: [0.25, 0.2], cat: [0.5, 0.3], dog: [0.8, 0.55], horse: [2.2, 1.6], sheep: [1.3, 0.9], cow: [2.2, 1.4], elephant: [5, 3], bear: [2, 1.5], zebra: [2.2, 1.4], giraffe: [4.5, 2],
  backpack: [0.45, 0.3], umbrella: [1.0, 0.9], handbag: [0.35, 0.3], tie: [0.5, 0.09], suitcase: [0.65, 0.45],
  'sports ball': [0.22, 0.22], 'baseball bat': [0.85, 0.07], skateboard: [0.8, 0.12], 'tennis racket': [0.68, 0.28], kite: [1, 1], frisbee: [0.27, 0.27],
  bottle: [0.25, 0.07], 'wine glass': [0.18, 0.08], cup: [0.1, 0.09], fork: [0.19, 0.03], knife: [0.25, 0.03], spoon: [0.18, 0.04], bowl: [0.18, 0.08],
  banana: [0.18, 0.04], apple: [0.08, 0.08], sandwich: [0.14, 0.06], orange: [0.08, 0.08], broccoli: [0.12, 0.12], carrot: [0.18, 0.03], 'hot dog': [0.16, 0.05], pizza: [0.3, 0.03], donut: [0.1, 0.04], cake: [0.25, 0.1],
  chair: [0.9, 0.5], couch: [1.9, 0.85], 'potted plant': [0.5, 0.35], bed: [1.9, 0.6], table: [1.3, 0.75], toilet: [0.75, 0.4], tv: [1.0, 0.6], laptop: [0.33, 0.23], mouse: [0.1, 0.06], remote: [0.17, 0.05], keyboard: [0.44, 0.14], 'cell phone': [0.15, 0.07],
  microwave: [0.5, 0.3], oven: [0.9, 0.6], toaster: [0.3, 0.2], sink: [0.55, 0.2], refrigerator: [1.7, 0.75], book: [0.24, 0.16], clock: [0.3, 0.3], vase: [0.3, 0.15], scissors: [0.2, 0.08], 'teddy bear': [0.35, 0.25], 'hair drier': [0.25, 0.2], toothbrush: [0.18, 0.02],
  door: [2.05, 0.9], 'id card': [0.085, 0.054], wallet: [0.11, 0.09], keys: [0.08, 0.04], eyeglasses: [0.14, 0.04], 'laptop charger': [0.15, 0.07], 'phone charger': [0.06, 0.04], 'power bank': [0.14, 0.07], watch: [0.045, 0.04], 'medicine strip': [0.1, 0.05], banknote: [0.15, 0.07], pen: [0.14, 0.012], notebook: [0.25, 0.18], paper: [0.3, 0.21], 'toy car': [0.09, 0.04],
};
const SCREEN_IDS = new Set(['tv', 'laptop', 'cell phone', 'monitor', 'tablet']);
const SURFACE_IDS = new Set(['table', 'bed', 'couch', 'chair', 'bench']);
const VEHICLE_IDS = new Set(['car', 'truck', 'bus', 'motorcycle', 'bicycle', 'train', 'boat', 'airplane']);
const ANIMAL_IDS = new Set(['bird', 'cat', 'dog', 'horse', 'sheep', 'cow', 'elephant', 'bear', 'zebra', 'giraffe']);
const OUTDOOR_ONLY = new Set(['traffic light', 'stop sign', 'fire hydrant', 'parking meter', 'airplane', 'boat', 'train', 'bus', 'truck']);
const INDOOR_EVIDENCE = new Set(['bed', 'couch', 'laptop', 'keyboard', 'tv', 'mouse', 'refrigerator', 'microwave', 'oven', 'toilet', 'sink', 'book', 'remote', 'toaster', 'hair drier', 'toothbrush']);
const OBSTACLE_IDS = new Set(['chair', 'table', 'couch', 'bed', 'person', 'potted plant', 'suitcase', 'bicycle', 'motorcycle', 'car', 'refrigerator', 'oven', 'bench', 'dog', 'toilet', 'backpack', 'door']);

// Focal length in pixels for the long axis of the frame, assuming ~65 degrees along it
// (a typical phone main camera). Real phones vary by +-25%; the bands absorb that.
function focalPx(frame) { return 0.78 * Math.max(frame.width, frame.height); }

// Distance from apparent size. Returns { m, lower } where lower=true means the box is cut
// by the frame edge so the true distance is at most m.
function distanceFromSize(o, frame) {
  const prior = SIZE_PRIOR[o.id] || SIZE_PRIOR[o.origId]; if (!prior || !o.bbox) return null;
  const [x, y, w, h] = o.bbox; if (w < 4 || h < 4) return null;
  const f = focalPx(frame), edge = 3;
  const cutH = y <= edge || y + h >= frame.height - edge;      // vertical extent truncated
  const cutW = x <= edge || x + w >= frame.width - edge;       // horizontal extent truncated
  const boxLong = Math.max(w, h), boxShort = Math.min(w, h);
  const longIsH = h >= w;
  const dLong = f * prior[0] / boxLong, dShort = f * prior[1] / boxShort;
  const longCut = longIsH ? cutH : cutW, shortCut = longIsH ? cutW : cutH;
  if (longCut && shortCut) return { m: Math.min(dLong, dShort), lower: true };
  if (longCut) return { m: dShort, lower: false, weak: true };
  if (shortCut) return { m: dLong, lower: false, weak: true };
  // Geometric mean of the two estimates, which is orientation-agnostic for handheld things.
  return { m: Math.sqrt(dLong * dShort), lower: false };
}

// ---- Monocular depth (Depth Anything V2 small, quantised, ~27 MB) ----
// Output is relative: which parts of the picture are nearer than others. That alone answers
// "what is closest", ranks obstacles, and exposes toys and pictures (small-looking things that
// are actually right in front of the lens). Metric numbers come from the size priors above.
engine.depth = engine.depth || { status: 'idle' };
engine.ear = engine.ear || { status: 'idle' };
const DepthEngine = {
  id: 'onnx-community/depth-anything-v2-small', pipe: null, loading: null, lastMs: 0,
  get status() { return (engine.depth && engine.depth.status) || 'idle'; }, last: null, busy: false, lastAt: 0, size: 196, failures: 0,
  wanted() {
    try { if (localStorage.getItem('astha.depth') === '0') return false; } catch (e) {}
    if (navigator.connection && navigator.connection.saveData) return false;
    if (navigator.deviceMemory && navigator.deviceMemory < 2) return false;
    return true;
  },
  async load() {
    if (this.status === 'ready') return true;
    if (this.loading) return this.loading;
    setEngineState('depth', 'loading');
    this.loading = (async () => {
      try {
        const TF = engine.clip.lib || await import('https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1/dist/transformers.min.js');
        TF.env.allowLocalModels = false;
        engine.clip.lib = engine.clip.lib || TF;
        const files = {};
        const progress = p => {
          if (p.status === 'progress' && p.file) files[p.file] = (p.loaded || 0) / (p.total || 1);
          const vals = Object.values(files); if (vals.length) setProgress('depth', vals.reduce((a, b) => a + b, 0) / Math.max(vals.length, 2));
        };
        this.pipe = await TF.pipeline('depth-estimation', this.id, { dtype: 'q8', progress_callback: progress });
        this.RawImage = TF.RawImage;
        setProgress('depth', 1); setEngineState('depth', 'ready');
        logEvent('Depth model ready (on-device)');
        return true;
      } catch (e) { console.warn('depth load failed', e); setEngineState('depth', 'error'); setProgress('depth', null); this.loading = null; return false; }
    })();
    return this.loading;
  },
  // Runs the model on a small copy of the frame and stores a nearness map (0 = farthest, 1 = nearest).
  async run(frame, current = captureLocalActionGuard()) {
    if (!current()) return null;
    // A caller asking for this picture must never receive the previous picture's map.
    // Live perception may explicitly consult fresh(); a one-shot measurement cannot.
    if (this.status !== 'ready' || this.busy || !frame) return null;
    this.busy = true; const t0 = Date.now();
    try {
      const s = this.size / Math.max(frame.width, frame.height);
      const w = Math.max(14, Math.round(frame.width * s / 14) * 14), h = Math.max(14, Math.round(frame.height * s / 14) * 14);
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      const cx = c.getContext('2d', { willReadFrequently: true }); cx.drawImage(frame, 0, 0, w, h);
      const d = cx.getImageData(0, 0, w, h);
      const img = new this.RawImage(new Uint8ClampedArray(d.data), w, h, 4);
      const out = await this.pipe(img);
      if (!current()) return null;
      const tensor = out.predicted_depth;
      const dims = tensor.dims, H = dims[dims.length - 2], W = dims[dims.length - 1];
      const raw = tensor.data;
      // Percentile normalisation so one bright wall cannot flatten the whole map.
      const sample = []; const step = Math.max(1, Math.floor(raw.length / 4000));
      for (let i = 0; i < raw.length; i += step) sample.push(raw[i]);
      sample.sort((a, b) => a - b);
      const lo = sample[Math.floor(sample.length * 0.03)], hi = sample[Math.floor(sample.length * 0.97)];
      const span = (hi - lo) || 1;
      const near = new Float32Array(raw.length);
      for (let i = 0; i < raw.length; i++) near[i] = Math.min(1, Math.max(0, (raw[i] - lo) / span));
      this.last = { near, w: W, h: H, at: Date.now(), fw: frame.width, fh: frame.height };
      this.lastCurrent = current;
      this.lastAt = this.last.at; this.failures = 0; this.lastMs = this.lastAt - t0;
      return this.last;
    } catch (e) {
      if (!current() || e.cancelled) return null;
      this.failures++; console.warn('depth run', e);
      if (this.failures >= 3) { setEngineState('depth', 'error'); }
      return null;
    } finally { this.busy = false; }
  },
  fresh(maxAgeMs = 3000) { return this.last && (!this.lastCurrent || this.lastCurrent()) && Date.now() - this.last.at <= maxAgeMs ? this.last : null; },
  // Slow phones get a slower cadence, so depth never starves the detector or the recogniser.
  due(baseMs) { return Date.now() - this.lastAt > Math.max(baseMs, this.lastMs * 2.5); },
  // Median nearness inside the inner half of a box (frame coordinates), or null.
  nearnessInBox(map, bbox, fw, fh) {
    if (!map || !bbox) return null;
    const sx = map.w / fw, sy = map.h / fh;
    const [x, y, w, h] = bbox;
    const x0 = Math.max(0, Math.floor((x + w * 0.25) * sx)), x1 = Math.min(map.w - 1, Math.ceil((x + w * 0.75) * sx));
    const y0 = Math.max(0, Math.floor((y + h * 0.25) * sy)), y1 = Math.min(map.h - 1, Math.ceil((y + h * 0.75) * sy));
    if (x1 < x0 || y1 < y0) return null;
    const vals = [];
    const stepX = Math.max(1, Math.floor((x1 - x0 + 1) / 12)), stepY = Math.max(1, Math.floor((y1 - y0 + 1) / 12));
    for (let yy = y0; yy <= y1; yy += stepY) for (let xx = x0; xx <= x1; xx += stepX) vals.push(map.near[yy * map.w + xx]);
    if (!vals.length) return null;
    vals.sort((a, b) => a - b);
    return vals[Math.floor(vals.length / 2)];
  },
  // Nearness of a region given as fractions of the frame (for CLIP tiles and the walking path).
  nearnessInRegion(map, fx, fy, fw, fh) {
    if (!map) return null;
    return this.nearnessInBox(map, [fx * map.fw, fy * map.fh, fw * map.fw, fh * map.fh], map.fw, map.fh);
  },
};

// ---- Per-object geometry: distance band, proximity, nearness ----
function annotateGeometry(o, frame, depth) {
  o.flags = {}; o.rel = [];
  // distMeasured is always written: the world model merges detections, and a stale "measured"
  // flag must never label a later image estimate.
  o.distM = null; o.distLower = false; o.near01 = null; o.distMeasured = false;
  if (!o.bbox) return;
  const est = distanceFromSize(o, frame);
  if (est) { o.distM = Math.round(est.m * 10) / 10; o.distLower = !!est.lower; o.distWeak = !!est.weak; }
  if (depth) o.near01 = DepthEngine.nearnessInBox(depth, o.bbox, frame.width, frame.height);
  // Proximity band from distance when we have it (the box-area rule stays as the fallback).
  if (o.distM != null && !o.distWeak) o.prox = o.distM <= 1.0 ? 'very_close' : o.distM <= 2.5 ? 'near' : 'far';
  else if (o.near01 != null && o.prox == null) o.prox = o.near01 >= 0.8 ? 'very_close' : o.near01 >= 0.5 ? 'near' : 'far';
}

// ---- Measured distance from the ultrasonic sensor beside the paired Pi camera ----
// The HC-SR04 reports the nearest surface in a beam about 15 degrees wide. Mounted beside the
// Pi camera and facing the same way (the mount must keep this), that beam is the centre of
// the camera's 62 x 49 degree view: roughly the middle fifth across and the middle third down.
const ULTRASONIC_BEAM = { x0: 0.39, x1: 0.61, y0: 0.35, y1: 0.65 };
function inBeam(o, frame) {
  if (!o.bbox) return false;
  const [x, y, w, h] = o.bbox;
  return x / frame.width < ULTRASONIC_BEAM.x1 && (x + w) / frame.width > ULTRASONIC_BEAM.x0 &&
    y / frame.height < ULTRASONIC_BEAM.y1 && (y + h) / frame.height > ULTRASONIC_BEAM.y0;
}
// Gives the measurement to the object it most likely came from. An object whose own size
// estimate disagrees badly cannot take it: the echo then came from something else, such as a
// nearer thing the detector does not know or the floor. Returns what is straight ahead.
function applyMeasuredDistance(objs, frame, reading) {
  if (!reading || !reading.measured || !Number.isFinite(reading.metres)) return null;
  const m = reading.metres;
  let best = null;
  for (const o of objs) {
    if (!inBeam(o, frame) || (o.flags && (o.flags.onScreen || o.flags.picture))) continue;
    let gap;
    if (o.distM == null || o.distWeak) {
      // No usable estimate: only the object right in the middle of the beam can take it.
      const [x, y, w, h] = o.bbox;
      if (!(x <= frame.width / 2 && x + w >= frame.width / 2 && y <= frame.height / 2 && y + h >= frame.height / 2)) continue;
      gap = 1;
    } else if (o.distLower) {
      if (m > o.distM * 1.2) continue;   // the box is cut by the frame edge: it is at most distM away
      gap = 0.5;
    } else {
      const ratio = m / o.distM;
      if (ratio < 0.5 || ratio > 2) continue;
      gap = Math.abs(Math.log(ratio));
    }
    if (!best || gap < best.gap) best = { o, gap };
  }
  if (best) {
    const o = best.o;
    o.distM = Math.round(m * 100) / 100; o.distMeasured = true; o.distLower = false; o.distWeak = false;
    o.distMeasuredAt = reading.at; o.distMeasuredEpoch = state.sourceEpoch || 0;
    o.prox = m <= 1.0 ? 'very_close' : m <= 2.5 ? 'near' : 'far';
  }
  return { metres: m, object: best ? best.o : null };
}

// ---- Scene graph: what is on what, who is on a screen, what kind of room ----
function boxOverlapFrac(a, b) { // fraction of a's area inside b
  const ix = Math.max(0, Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0]));
  const iy = Math.max(0, Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]));
  return (ix * iy) / Math.max(1, a[2] * a[3]);
}
function inferRoom(ids, objs) {
  const has = id => ids.has(id);
  // Street cues only count when they look real-sized: a tiny "car" beside a laptop and a sofa is a
  // toy or a picture, and must not turn the living room into a road.
  const frameArea = objs && objs.length && objs[0]._frameArea || 1;
  const indoorCount = [...ids].filter(id => INDOOR_EVIDENCE.has(id)).length;
  const bigStreet = !objs || objs.some(o => o.bbox && (VEHICLE_IDS.has(o.id) || OUTDOOR_ONLY.has(o.id)) && (o.bbox[2] * o.bbox[3]) / frameArea >= 0.1);
  const streetOk = bigStreet || indoorCount < 2;
  const score = {
    bedroom: (has('bed') ? 3 : 0) + (has('pillow') ? 1 : 0) + (has('blanket') ? 1 : 0),
    living: (has('couch') ? 3 : 0) + (has('tv') ? 2 : 0) + (has('remote') ? 1 : 0),
    kitchen: (has('sink') ? 2 : 0) + (has('oven') ? 2 : 0) + (has('microwave') ? 2 : 0) + (has('refrigerator') ? 3 : 0) + (has('toaster') ? 1 : 0),
    bathroom: (has('toilet') ? 4 : 0) + (has('toothbrush') ? 2 : 0) + (has('soap') ? 1 : 0) + (has('towel') ? 1 : 0),
    desk: (has('laptop') ? 2 : 0) + (has('keyboard') ? 2 : 0) + (has('mouse') ? 2 : 0) + (has('monitor') ? 2 : 0),
    dining: (has('table') ? 1 : 0) + ((has('cup') || has('bowl') || has('plate') || has('fork') || has('spoon')) && has('table') ? 2 : 0),
    street: streetOk ? (has('car') ? 2 : 0) + (has('bus') ? 3 : 0) + (has('truck') ? 3 : 0) + (has('traffic light') ? 3 : 0) + (has('motorcycle') ? 2 : 0) + (has('bicycle') ? 1 : 0) + (has('stop sign') ? 3 : 0) + (has('fire hydrant') ? 3 : 0) : 0,
  };
  let best = null, bestS = 1; // need at least a score of 2 to say anything
  for (const k in score) if (score[k] > bestS) { bestS = score[k]; best = k; }
  return best;
}
function buildSceneGraph(objs, frame) {
  const ids = new Set(objs.map(o => o.id));
  // CLIP-only hits that are still fresh in the world map count as evidence too (door, stairs, wall...).
  for (const w of state.world.values()) if (w.src === 'clip' && Date.now() - w.last < 4000) ids.add(w.id);
  objs.forEach(o => { o._frameArea = frame.width * frame.height; });
  const room = inferRoom(ids, objs);
  const indoorCount = [...ids].filter(id => INDOOR_EVIDENCE.has(id)).length;
  const indoor = room ? room !== 'street' : indoorCount > 0 && (indoorCount >= 2 || ![...ids].some(id => VEHICLE_IDS.has(id) || OUTDOOR_ONLY.has(id)));
  const boxes = objs.filter(o => o.bbox);
  for (const a of boxes) {
    for (const b of boxes) {
      if (a === b) continue;
      const frac = boxOverlapFrac(a.bbox, b.bbox);
      // A living thing or vehicle drawn inside a screen is a video, not a visitor.
      if (SCREEN_IDS.has(b.id) && (a.id === 'person' || ANIMAL_IDS.has(a.id) || VEHICLE_IDS.has(a.id)) && frac >= 0.8 && a.bbox[2] * a.bbox[3] < b.bbox[2] * b.bbox[3] * 0.9) {
        a.rel.push({ type: 'onScreen', id: b.id }); a.flags.onScreen = true; continue;
      }
      if (SURFACE_IDS.has(b.id) && !SURFACE_IDS.has(a.id) && a.id !== 'person') {
        const aArea = a.bbox[2] * a.bbox[3], bArea = b.bbox[2] * b.bbox[3];
        const bottom = a.bbox[1] + a.bbox[3];
        const horiz = Math.max(0, Math.min(a.bbox[0] + a.bbox[2], b.bbox[0] + b.bbox[2]) - Math.max(a.bbox[0], b.bbox[0])) / Math.max(1, a.bbox[2]);
        if (aArea < bArea * 0.5 && horiz >= 0.6 && bottom >= b.bbox[1] - b.bbox[3] * 0.15 && bottom <= b.bbox[1] + b.bbox[3] * 0.7) {
          if (!a.rel.some(r => r.type === 'on')) a.rel.push({ type: 'on', id: b.id });
        }
      }
      // A person overlapping a chair or sofa with a squat outline is probably seated.
      if (a.id === 'person' && (b.id === 'chair' || b.id === 'couch' || b.id === 'bed') && frac >= 0.3 && a.bbox[3] / Math.max(1, a.bbox[2]) < 1.7) {
        if (!a.rel.some(r => r.type === 'sittingOn')) a.rel.push({ type: 'sittingOn', id: b.id });
      }
    }
  }
  return { room, indoor, ids, at: Date.now() };
}

// ---- Rules: the decisions that used to need a cloud model ----
function applyRules(objs, graph, frame) {
  const frameArea = frame.width * frame.height;
  for (const o of objs) {
    if (!o.bbox) continue;
    const area = (o.bbox[2] * o.bbox[3]) / frameArea;
    const depthNear = o.near01 != null && o.near01 >= 0.72;
    const looksFar = o.distM != null && !o.distLower && o.distM >= 5;
    // 1. Miniature: the size says "far away", the depth says "right in front of the lens".
    if ((VEHICLE_IDS.has(o.id) || ANIMAL_IDS.has(o.id)) && looksFar && depthNear) o.flags.toy = true;
    if (o.id === 'person' && looksFar && depthNear && area < 0.06) o.flags.picture = true;
    // 2. No depth yet: a small vehicle in a room full of furniture is far more often a toy or a picture.
    if (!o.flags.toy && VEHICLE_IDS.has(o.id) && graph.indoor && area < 0.08 && o.near01 == null) o.flags.maybeToy = true;
    // 3. Street furniture indoors (traffic light, stop sign, hydrant) is a mis-read of something else.
    if (OUTDOOR_ONLY.has(o.id) && graph.indoor && area < 0.15) o.flags.doubtful = true;
    // 4. A tiny "person" very close to the lens with an ID card recognised nearby is the card's photo.
    if (o.id === 'person' && area < 0.04 && depthNear && (state.world.get('id card') || (state.relabel && state.relabel.person && state.relabel.person.newId === 'id card'))) o.flags.picture = true;
    // 5. Sharp things within arm's reach are worth a word.
    if ((o.id === 'knife' || o.id === 'scissors') && ((o.distM != null && o.distM <= 1.2) || depthNear)) o.flags.sharpNear = true;
    // A toy or a picture is never a hazard and never "approaching".
    if (o.flags.toy || o.flags.picture || o.flags.onScreen || o.flags.doubtful) { o.hazardMuted = true; if (o.motion) o.motion = null; }
  }
}

// Called from the live loop for every detector frame and from the one-shot describers.
function perceptionHook(objs, frame, opts = {}) {
  if (!frame || !objs) return;
  const depth = Object.hasOwn(opts, 'depthMap') ? opts.depthMap : DepthEngine.fresh(opts.depthMaxAge || Math.max(3500, DepthEngine.lastMs * 3));
  for (const o of objs) annotateGeometry(o, frame, depth);
  const graph = buildSceneGraph(objs, frame);
  applyRules(objs, graph, frame);
  // Only pictures from the paired Pi camera share the sensor's point of view.
  const reading = Object.hasOwn(opts, 'sensorReading') ? opts.sensorReading : state.source === 'pi' && typeof AsthaSensors !== 'undefined' ? AsthaSensors.measured('front') : null;
  const ahead = applyMeasuredDistance(objs, frame, reading);
  state.scene = Object.assign(graph, { frameW: frame.width, frameH: frame.height, hasDepth: !!depth, ahead, at: Date.now() });
  if (opts.noDepthKick) return;
  // Keep the depth map warm while the camera runs; load it lazily once the recogniser is in.
  const now = Date.now();
  if (state.source === 'camera' && DepthEngine.status === 'ready' && !DepthEngine.busy && DepthEngine.due(typeof Seeker !== 'undefined' && Seeker.active ? 1500 : 2200) && !state.busy) DepthEngine.run(frame);
  else if (DepthEngine.status === 'idle' && DepthEngine.wanted() && (engine.clip.status === 'ready' || engine.clip.status === 'error') && !(typeof OfflinePack !== 'undefined' && OfflinePack.running)) DepthEngine.load().catch(() => {});
}

// ---- Words for distance ----
const NUM_EN = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen'];
const NUM_BN = ['শূন্য', 'এক', 'দুই', 'তিন', 'চার', 'পাঁচ', 'ছয়', 'সাত', 'আট', 'নয়', 'দশ', 'এগারো', 'বারো', 'তেরো', 'চৌদ্দ', 'পনেরো'];
function numWord(n, bn) { const arr = bn ? NUM_BN : NUM_EN; return n < arr.length ? arr[n] : (bn ? String(n).replace(/\d/g, d => '০১২৩৪৫৬৭৮৯'[d]) : String(n)); }
// A distance the sensor measured is said as a number and called measured; everything from
// the picture stays "about", so the two can never be confused.
function measuredPhrase(m, bn) {
  const digits = value => String(value).replace(/\d/g, d => '০১২৩৪৫৬৭৮৯'[d]);
  if (m < 1) { const cm = Math.round(m * 100); return bn ? `সেন্সরে মাপা ${digits(cm)} সেন্টিমিটার দূরে` : `measured at ${cm} centimetres`; }
  const v = (Math.round(m * 10) / 10).toFixed(1);
  return bn ? `সেন্সরে মাপা ${digits(v)} মিটার দূরে` : `measured at ${v} metres`;
}
function currentMeasuredDistance(o) {
  const reading = state.source === 'pi' && typeof AsthaSensors !== 'undefined' ? AsthaSensors.measured('front') : null;
  return Boolean(reading && o.distMeasuredAt === reading.at && o.distMeasuredEpoch === (state.sourceEpoch || 0) && o.distM === Math.round(reading.metres * 100) / 100);
}
function invalidateMeasuredDistances() {
  const objects = new Set([...(state.world?.values() || []), ...(state.lastCocoPreds || []), state.scene?.ahead?.object]);
  for (const o of objects) if (o?.distMeasured) {
    o.distM = null; o.distMeasured = false; o.distMeasuredAt = null; o.near01 = null; o.prox = null;
  }
  if (state.scene) state.scene.ahead = null;
  state.spatial = null;
}
// Returns '' when nothing sensible can be said.
function distPhrase(o, bn) {
  if (!o) return '';
  if (o.distMeasured) return o.distM != null && currentMeasuredDistance(o) ? measuredPhrase(o.distM, bn) : '';
  if (o.distM != null && !o.distWeak) {
    const m = o.distM;
    if (o.distLower || m < 0.75) return bn ? 'হাতের নাগালে' : 'within arm\'s reach';
    if (m < 1.5) return bn ? 'প্রায় এক মিটার দূরে' : 'about one metre away';
    if (m < 2.5) return bn ? 'প্রায় দুই মিটার দূরে' : 'about two metres away';
    if (m < 3.5) return bn ? 'প্রায় তিন মিটার দূরে' : 'about three metres away';
    const n = Math.round(m);
    if (n <= 15) return bn ? `প্রায় ${numWord(n, true)} মিটার দূরে` : `about ${numWord(n, false)} metres away`;
    return bn ? 'অনেক দূরে' : 'far away';
  }
  if (o.near01 != null) {
    if (o.near01 >= 0.8) return bn ? 'খুব কাছে' : 'very close';
    if (o.near01 >= 0.5) return bn ? 'কাছাকাছি' : 'nearby';
    return bn ? 'কিছুটা দূরে' : 'further away';
  }
  if (o.prox) return bn ? tBn('prox_' + o.prox) : t('prox_' + o.prox);
  return '';
}
function distMetresText(o, bn) { // short form for guidance: "about 40 centimetres", "about one metre"
  if (!o || o.distM == null || o.distMeasured) return distPhrase(o, bn);
  const m = o.distM;
  if (m < 1) { const cm = Math.max(10, Math.round(m * 10) * 10); return bn ? `প্রায় ${String(cm).replace(/\d/g, d => '০১২৩৪৫৬৭৮৯'[d])} সেন্টিমিটার` : `about ${cm} centimetres`; }
  return distPhrase(o, bn);
}

// ---- Labels that carry the rule decisions ----
function objLabel(o) {
  if (o && o.brand && typeof brandMeta === 'function' && brandMeta(o.brand)) return brandMeta(o.brand).en + ' phone';
  const base = label(o.id); const f = (o && o.flags) || {};
  if (f.toy) return 'toy ' + base;
  if (f.maybeToy) return 'small ' + base + ', possibly a toy';
  if (f.picture) return 'picture of ' + withArticle(base, !!(VOCAB_BY_ID[o.id] || {}).pl);
  if (f.onScreen) return base + ' on a screen';
  return base;
}
function objLabelBn(o) {
  if (o && o.brand && typeof brandMeta === 'function' && brandMeta(o.brand)) return brandMeta(o.brand).bn + ' ফোন';
  const base = labelBn(o.id); const f = (o && o.flags) || {};
  if (f.toy) return 'খেলনা ' + base;
  if (f.maybeToy) return 'ছোট ' + base + ', সম্ভবত খেলনা';
  if (f.picture) return base + '-এর ছবি';
  if (f.onScreen) return 'স্ক্রিনে ' + base;
  return base;
}
function objLabelWithArticle(o) {
  const n = objLabel(o);
  if ((VOCAB_BY_ID[o.id] || {}).pl && n === label(o.id)) return n;
  return article(n) + ' ' + n;
}

// ---- Hazard decision, now aware of toys, screens and distance ----
function isHazard(o) {
  // A detected person, including a nearby one, is an observation rather than a hazard class.
  if (o.id === 'person') return false;
  const f = o.flags || {};
  if (f.onScreen || f.toy || f.picture || f.doubtful || o.hazardMuted) return false;
  if (o.id === 'stairs' || o.id === 'drop_off') {
    if (state.lastCocoPreds && state.lastCocoPreds.some(p => ['table', 'keyboard', 'laptop', 'mouse', 'tv', 'monitor'].includes(p.id))) return false;
    return o.score >= 0.55;
  }
  const vb = VOCAB_BY_ID[o.id]; if (!vb || !vb.hz) return false;
  if (o.id === 'knife' || o.id === 'scissors') return !!f.sharpNear || o.prox === 'very_close';
  if (vb.hz === 'always') {
    if (f.maybeToy) return false;
    if (o.distM != null && !o.distLower && o.distM > 12 && !(o.motion && o.motion.dir === 'toward')) return false; // a bus far down the road
    return true;
  }
  return o.prox === 'very_close' || (o.src === 'clip' && o.score >= 0.40 && o.pos === 'ahead');
}

// ---- Spoken scene summary (deterministic; this is what replaces the cloud paragraph) ----
const ROOM_WORDS = { // completes "You seem to be …" / "আপনি সম্ভবত … আছেন"
  bedroom: ['in a bedroom', 'শোবার ঘরে'], living: ['in a living room', 'বসার ঘরে'], kitchen: ['in a kitchen', 'রান্নাঘরে'], bathroom: ['in a bathroom', 'বাথরুমে'],
  desk: ['at a desk with a computer', 'কম্পিউটারসহ একটি কাজের টেবিলের সামনে'], dining: ['at a dining table', 'খাবার টেবিলের কাছে'], street: ['outdoors, near a road', 'বাইরে, রাস্তার কাছে'],
};
function relPhrase(o, bn) {
  const r = (o.rel || [])[0]; if (!r) return '';
  const nb = labelBn(r.id), ne = label(r.id);
  if (r.type === 'on') return bn ? `${nb}-এর ওপর` : `on the ${ne}`;
  if (r.type === 'sittingOn') return bn ? `সম্ভবত ${nb}-এ বসা` : `seems to be sitting on the ${ne}`;
  if (r.type === 'onScreen') return bn ? `${nb}-এর স্ক্রিনে, ঘরে নয়` : `on the ${ne} screen, not in the room`;
  return '';
}
function objectSentence(o, bn) {
  const f = o.flags || {};
  if (bn) {
    let s = tBn('pos_' + o.pos) + ' ';
    const rel = relPhrase(o, true); if (rel && !f.onScreen) s += rel + ' ';
    s += (o.id === 'person' && !f.picture ? 'একজন ' : 'একটি ') + objLabelBn(o);
    if (f.onScreen) s += ', ' + relPhrase(o, true);
    const d = distPhrase(o, true); if (d) s += ', ' + d;
    if (o.motion && typeof motionPhrase === 'function') s += ', ' + motionPhrase(o.motion, true);
    return s;
  }
  let s = objLabelWithArticle(o) + ' ' + t('pos_' + o.pos);
  const rel = relPhrase(o, false); if (rel) s += ', ' + rel;
  const d = distPhrase(o, false); if (d) s += ', ' + d;
  if (o.motion && typeof motionPhrase === 'function') s += ', ' + motionPhrase(o.motion, false);
  return s;
}
function sceneSummary(opts = {}) {
  const detailed = !!opts.detailed;
  const all = worldSorted().filter(o => !(o.flags && o.flags.doubtful));
  const graph = state.scene || {};
  const en = [], bn = [];
  if (!all.length) return { en: t('nothing_seen'), bn: tBn('nothing_seen') };
  if (graph.room && ROOM_WORDS[graph.room]) { en.push(`You seem to be ${ROOM_WORDS[graph.room][0]}.`); bn.push(`আপনি সম্ভবত ${ROOM_WORDS[graph.room][1]} আছেন।`); }
  // Hazards and approaching things first.
  const hz = all.filter(o => isHazard(o) || (o.motion && o.motion.dir === 'toward' && VEHICLE_IDS.has(o.id)));
  hz.slice(0, 2).forEach(o => {
    const d = distPhrase(o, false), dB = distPhrase(o, true);
    const mv = o.motion && o.motion.dir === 'toward' ? ', ' + motionPhrase(o.motion, false) : '';
    const mvB = o.motion && o.motion.dir === 'toward' ? ', ' + motionPhrase(o.motion, true) : '';
    en.push(`Careful: ${objLabelWithArticle(o)} ${t('pos_' + o.pos)}${d ? ', ' + d : ''}${mv}.`);
    bn.push(`সাবধান: ${tBn('pos_' + o.pos)} একটি ${objLabelBn(o)}${dB ? ', ' + dB : ''}${mvB}।`);
  });
  const rest = all.filter(o => !hz.includes(o));
  // People, then the nearest things; short style keeps it to three items.
  const people = rest.filter(o => o.id === 'person' && !(o.flags && (o.flags.picture || o.flags.onScreen)));
  const things = rest.filter(o => !people.includes(o));
  const byNear = arr => arr.slice().sort((a, b) => ((a.distM ?? 99) - (b.distM ?? 99)) || ((b.near01 ?? 0) - (a.near01 ?? 0)) || (b.score - a.score));
  if (people.length) {
    if (people.length === 1) { en.push(`There is ${objectSentence(people[0], false)}.`); bn.push(`${objectSentence(people[0], true)}।`); }
    else {
      const p = byNear(people)[0];
      en.push(`There are ${numWord(people.length, false)} people; the nearest is ${t('pos_' + p.pos)}${distPhrase(p, false) ? ', ' + distPhrase(p, false) : ''}.`);
      bn.push(`${numWord(people.length, true)} জন মানুষ আছেন; সবচেয়ে কাছেরজন ${tBn('pos_' + p.pos)}${distPhrase(p, true) ? ', ' + distPhrase(p, true) : ''}।`);
    }
  }
  const limit = detailed ? 6 : 3;
  const picked = byNear(things).slice(0, limit);
  if (picked.length) {
    en.push((people.length ? 'I also see ' : 'I see ') + joinList(picked.map(o => objectSentence(o, false)), false) + '.');
    bn.push(joinList(picked.map(o => objectSentence(o, true)), true) + '।');
  }
  const more = things.length - picked.length;
  if (more > 0 && !detailed) { en.push(`And ${numWord(more, false)} more ${more === 1 ? 'thing' : 'things'}; say "describe in detail" to hear everything.`); bn.push(`আরও ${numWord(more, true)}টি জিনিস আছে; সব শুনতে বলুন "বিস্তারিত বলো"।`); }
  return { en: en.join(' '), bn: bn.join(' ') };
}

// ---- "Describe" now goes through the summary above ----
function describeScene(skipCloud, forceDetailed) {
  if (withCamera(describeScene)) return;
  if (typeof cloudReady === 'function' && cloudReady() && !skipCloud) return cloudDescribe();
  const current = captureLocalActionGuard();
  if (!current()) return;
  return withBusy(t('analyzing_title'), async () => {
    try {
    if (!(await ensureVisionModels()) || !current()) return;
    const frame = captureFrame(640); if (!frame) return;
    const readingAtCapture = state.source === 'pi' && typeof AsthaSensors !== 'undefined' ? AsthaSensors.measured('front') : null;
    const [cocoObjs, clip] = await Promise.all([runCoco(frame), runClipZones(frame)]);
    if (!current()) return;
    let depthMap = null;
    if (DepthEngine.status === 'ready') { try { depthMap = await DepthEngine.run(frame, current); } catch (e) {} }
    else if (DepthEngine.status === 'idle' && DepthEngine.wanted()) DepthEngine.load().catch(() => {});
    if (!current()) return;
    if (typeof trackMotion === 'function' && state.source === 'camera') trackMotion(cocoObjs, frame);
    const reading = state.source === 'pi' && typeof AsthaSensors !== 'undefined' ? AsthaSensors.measured('front') : null;
    // An echo taken after inference is not a measurement of an object in the old picture.
    const matchingReading = reading && readingAtCapture && reading.at === readingAtCapture.at ? reading : null;
    perceptionHook(cocoObjs, frame, { noDepthKick: true, depthMap, sensorReading: matchingReading });
    state.lastCocoPreds = cocoObjs; state.lastClipHits = clip.hits.map(h => Object.assign(h, { at: Date.now() }));
    state.world.clear(); ingest(cocoObjs.concat(clip.hits), state.source === 'camera' ? 3500 : 1e9); drawOverlay(frame, cocoObjs, clip.hits);
    const objs = worldSorted();
    const now = Date.now(); objs.forEach(o => state.announced.set(o.id, now));
    if (!objs.length) { setCaption(t('describe_title'), t('nothing_seen'), 'vision', null, tBn('nothing_seen')); speak(t('nothing_seen'), tBn('nothing_seen')); return; }
    const s = sceneSummary({ detailed: forceDetailed || ($('description-style') && $('description-style').value !== 'short') });
    setCaption(t('describe_title'), s.en, 'vision', null, s.bn);
    playEarcon('confirm'); speak(s.en, s.bn); haptic('CONFIRM');
    if (typeof heartPointAt === 'function') heartPointAt(objs[0]);
    logEvent(t('log_describe', { n: objs.length }));
    } catch (e) { if (e.cancelled || !current()) return; throw e; }
  });
}

// "How far is the chair?" / "চেয়ার কত দূরে?"
function answerHowFar(query) {
  if (withCamera(() => answerHowFar(query))) return;
  const noun = (typeof extractTargetItemFromQuery === 'function' ? extractTargetItemFromQuery(query.replace(/how far( away)? (is|are)( the| my| a| an)?/i, '').replace(/কত ?দূরে/g, '')) : null) || '';
  const vm = noun ? findVocabMatch(noun) : null;
  const objs = worldSorted();
  let o = vm ? objs.find(x => x.id === vm.id || x.origId === vm.id) : null;
  // "How far is it?" with the Pi's distance sensor: what is straight ahead, measured.
  const ahead = !vm && state.source === 'pi' && typeof AsthaSensors !== 'undefined' ? AsthaSensors.measured('front') : null;
  if (ahead) {
    // The newest scene says what the echo came from; the number is the reading of this moment.
    const scene = state.scene || {};
    const hit = scene.ahead && scene.ahead.object && Date.now() - (scene.at || 0) <= 2000 && currentMeasuredDistance(scene.ahead.object) ? scene.ahead.object : null;
    if (hit) return announce(`The ${objLabel(hit)} straight ahead is ${measuredPhrase(ahead.metres, false)}.`, `সোজা সামনের ${objLabelBn(hit)} ${measuredPhrase(ahead.metres, true)}।`, 'vision');
    return announce(`Something straight ahead is ${measuredPhrase(ahead.metres, false)}.`, `সোজা সামনে কিছু একটা আছে, ${measuredPhrase(ahead.metres, true)}।`, 'vision');
  }
  if (!o && !vm) o = objs.filter(x => x.distM != null || x.near01 != null).sort((a, b) => (a.distM ?? 99) - (b.distM ?? 99))[0];
  if (!o) return announce(vm ? `I do not see ${withArticle(vm.en, !!vm.pl)} right now.` : 'I cannot judge a distance yet. Point the camera at the thing.', vm ? `এখন ${vm.bn} দেখতে পাচ্ছি না।` : 'এখনো দূরত্ব বুঝতে পারছি না। জিনিসটির দিকে ক্যামেরা ধরুন।', 'vision');
  const d = distPhrase(o, false), dB = distPhrase(o, true);
  if (!d) return announce(`I see ${objLabelWithArticle(o)} ${t('pos_' + o.pos)}, but I cannot judge how far.`, `${tBn('pos_' + o.pos)} ${objLabelBn(o)} দেখছি, কিন্তু কত দূরে বুঝতে পারছি না।`, 'vision');
  announce(`The ${objLabel(o)} is ${t('pos_' + o.pos)}, ${d}.`, `${objLabelBn(o)} ${tBn('pos_' + o.pos)}, ${dB}।`, 'vision');
  if (typeof heartPointAt === 'function') heartPointAt(o);
}

// "Which room is this?" / "এটা কোন ঘর?"
function answerWhichRoom() {
  if (withCamera(answerWhichRoom)) return;
  const g = state.scene || {};
  if (g.room && ROOM_WORDS[g.room]) return announce(`You seem to be ${ROOM_WORDS[g.room][0]}.`, `এটা দেখে ${ROOM_WORDS[g.room][1]} মনে হচ্ছে।`, 'vision');
  const seen = worldSorted().slice(0, 3).map(o => label(o.id));
  if (seen.length) return announce(`I am not sure which room. I can see ${joinList(seen, false)}.`, `কোন ঘর নিশ্চিত নই। দেখতে পাচ্ছি ${joinList(worldSorted().slice(0, 3).map(o => labelBn(o.id)), true)}।`, 'vision');
  announce('I cannot tell yet. Turn slowly so I can see the furniture.', 'এখনো বুঝতে পারছি না। ধীরে ঘুরুন যাতে আসবাব দেখতে পাই।', 'vision');
}

// Obstacles in the walking lane (lower centre of the frame), nearest first.
function pathObstacles(excludeId) {
  const fw = (state.scene && state.scene.frameW) || 640, fh = (state.scene && state.scene.frameH) || 480;
  return (state.lastCocoPreds || []).filter(o => o.bbox && o.id !== excludeId && OBSTACLE_IDS.has(o.id) && !(o.flags && (o.flags.onScreen || o.flags.toy || o.flags.picture)))
    .filter(o => !o.distMeasured || currentMeasuredDistance(o))
    .map(o => { const cx = (o.bbox[0] + o.bbox[2] / 2) / fw, bottom = (o.bbox[1] + o.bbox[3]) / fh; return Object.assign({ cx, bottom }, o); })
    .filter(o => o.cx > 0.25 && o.cx < 0.75 && o.bottom > 0.55 && ((o.distM != null && o.distM <= 2.0) || (o.near01 != null && o.near01 >= 0.6) || o.prox === 'very_close'))
    .sort((a, b) => ((a.distM ?? 9) - (b.distM ?? 9)) || ((b.near01 ?? 0) - (a.near01 ?? 0)));
}
