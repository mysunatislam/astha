// An optional view of the existing local detector/overlay. No model, stream, provider,
// persistence or timing collection starts merely because this view is opened.
const AsthaVisionDetails = (() => {
  const LIVE_MAX_AGE = 3500, MAX_ROWS = 20;
  const frames = new WeakMap();
  let revision = 0, sequence = 0, latest = null, active = null, newest = 0;
  let reason = '', visible = false, booted = false, timer = null, signature = '', description = null;
  const clock = () => performance.now();
  const live = source => source === 'camera' || source === 'pi';
  const element = id => $(id);
  function clearBoxes() {
    const canvas = element('overlay');
    canvas?.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
  }
  function current(meta) {
    return Boolean(meta && meta.revision === revision && meta.current() && state.source &&
      (!live(meta.source) || clock() - meta.at <= LIVE_MAX_AGE) &&
      (meta.source !== 'pi' || typeof AsthaPiCamera === 'undefined' || AsthaPiCamera.frame()));
  }
  function expire() {
    if (latest && !current(latest.meta)) { latest = null; reason = 'stale'; clearBoxes(); }
    if (active && !current(active)) { active = null; reason = 'stale'; clearBoxes(); }
  }
  function capture(frame) {
    if (!frame || typeof frame !== 'object') return;
    frames.set(frame, { sequence: ++sequence, revision, source: state.source, at: clock(), capturedAt: Date.now(), current: captureLocalActionGuard(), detected: false });
  }
  function begin(frame) {
    const meta = frames.get(frame);
    if (!current(meta) || meta.sequence < newest) return;
    meta.detected = false; meta.skipped = false;
    newest = meta.sequence; active = meta; reason = ''; render();
  }
  function skipped(frame) {
    const meta = frames.get(frame);
    if (!current(meta) || meta.sequence < newest) return;
    // The object detector did not run. A fresh, independently computed CLIP zone
    // may still be drawn, but this must never turn into a completed detection.
    meta.detected = false; meta.skipped = true;
    newest = meta.sequence; if (active === meta) active = null;
    render();
  }
  function complete(frame) {
    const meta = frames.get(frame);
    if (meta) meta.detected = true;
    if (active === meta) active = null;
    render();
  }
  function failed(frame) {
    const meta = frames.get(frame);
    if (!current(meta) || meta.sequence < newest) return;
    newest = meta.sequence; active = null; latest = null; reason = 'failed'; clearBoxes(); render();
  }
  function canDraw(frame, objects = []) {
    const meta = frames.get(frame);
    return current(meta) && (meta.detected || meta.skipped && objects.length === 0) &&
      meta.sequence >= newest && (!latest || meta.sequence >= latest.meta.sequence);
  }
  function publish(frame, objects, zones) {
    if (!canDraw(frame, objects)) return false;
    const meta = frames.get(frame), seen = new Set(), rows = [];
    for (const object of objects || []) {
      const id = object.detectorId || object.id, score = object.detectorScore ?? object.score;
      if (!object.bbox || !object.bbox.every(Number.isFinite) || !Number.isFinite(score) || score < 0 || score > 1) continue;
      seen.add(object.id);
      rows.push({ id, score, pos: object.pos, kind: 'box', model: object.src });
      if (rows.length >= MAX_ROWS) break;
    }
    for (const zone of zones || []) {
      if (rows.length >= MAX_ROWS) break;
      if (seen.has(zone.id) || !zone.zone || !Number.isFinite(zone.score) || zone.score < 0 || zone.score > 1 ||
          Number.isFinite(zone.at) && Date.now() - zone.at > 4000) continue;
      rows.push({ id: zone.id, score: zone.score, pos: zone.pos, kind: 'zone', model: 'clip' });
    }
    latest = { meta, rows, boxes: rows.filter(row => row.kind === 'box').length };
    active = null; reason = ''; signature = ''; newest = Math.max(newest, meta.sequence);
    const viewport = element('viewport');
    viewport?.style.setProperty('--vision-aspect', frame.width + ' / ' + frame.height);
    render(); return true;
  }
  function clear() {
    revision++; latest = null; active = null; description = null; reason = ''; signature = '';
    clearBoxes(); render();
  }
  // Keep only an explicitly produced description in memory, separate from status captions.
  // Cloud latency does not turn it into a live observation: display its capture time.
  function describeResult(frame, words, provider) {
    const meta = frames.get(frame);
    if (!meta || meta.revision !== revision || !meta.current() || description && meta.sequence < description.meta.sequence || !words ||
        typeof words.en !== 'string' || typeof words.bn !== 'string') return false;
    description = { meta, en: words.en.slice(0, 8000), bn: words.bn.slice(0, 8000), online: provider === 'online' };
    renderDescription(); return true;
  }
  function renderDescription() {
    if (description && (description.meta.revision !== revision || !description.meta.current())) description = null;
    const node = element('vision-description-text'), info = element('vision-description-meta');
    const button = element('vision-describe');
    if (button) button.disabled = !state.source || Boolean(state.busy) || document.hidden;
    const bn = typeof uiLang !== 'undefined' && uiLang === 'bn';
    const text = description ? (bn ? description.bn || description.en : description.en || description.bn) : t('vision_description_empty');
    if (node && node.textContent !== text) node.textContent = text;
    const metadata = description ? t('vision_description_meta', {
      source: t(description.meta.source === 'pi' ? 'vision_description_pi' : description.meta.source === 'camera' ? 'vision_description_camera' : 'vision_description_image'),
      time: new Date(description.meta.capturedAt).toLocaleTimeString(bn ? 'bn-BD' : 'en-GB'),
      provider: t(description.online ? 'vision_description_online' : 'vision_description_local'),
    }) : '';
    if (info && info.textContent !== metadata) info.textContent = metadata;
  }
  function sourceChanged() { clear(); }
  function modelChanged() {
    if (engine.coco.status !== 'ready') { latest = null; active = null; clearBoxes(); }
    render();
  }
  function modelKey() {
    if (engine.coco.status === 'loading') return 'vision_model_loading';
    if (engine.coco.status === 'error') return 'vision_model_error';
    if (engine.coco.status !== 'ready' || !engine.coco.model) return 'vision_model_idle';
    return engine.coco.type === 'yolo26n' ? 'vision_model_yolo' : engine.coco.type === 'coco-ssd' ? 'vision_model_coco' : 'vision_model_ready';
  }
  function statusKey() {
    if (state.cameraPending) return 'vision_camera_request';
    if (!state.source) return 'vision_off';
    if (document.hidden) return 'vision_background';
    if (latest?.meta.skipped && latest.rows.length) return 'vision_clip_only';
    if (engine.coco.status === 'loading') return 'vision_loading';
    if (engine.coco.status === 'error' || reason === 'failed') return 'vision_failed';
    if (active) return 'vision_checking';
    if (latest) return !latest.meta.detected ? 'vision_waiting' : latest.boxes ? (live(latest.meta.source) ? 'vision_live_results' : 'vision_image_results') : 'vision_no_boxes';
    return reason === 'stale' ? 'vision_stale' : 'vision_waiting';
  }
  function render(force = false) {
    expire();
    renderDescription();
    const key = statusKey(), model = modelKey();
    const next = [uiLang, key, model, latest?.meta.sequence, state.source, Boolean(state.busy), Boolean(state.cameraPending)].join('|');
    if (next === signature && !force) return;
    signature = next;
    const put = (id, value) => { const node = element(id); if (node) node.textContent = value; };
    put('vision-state', t(key)); put('vision-model', t(model));
    if (element('vision-state')) element('vision-state').dataset.state = key;
    if (element('vision-results')) {
      element('vision-results').dataset.frame = latest ? String(latest.meta.sequence) : '';
      element('vision-results').dataset.source = latest ? latest.meta.source : '';
    }
    const camera = element('vision-camera');
    if (camera) { camera.textContent = t(state.cameraPending ? 'vision_camera_cancel' : state.source === 'camera' ? 'vision_camera_stop' : 'vision_camera_start'); camera.setAttribute('aria-pressed', String(state.source === 'camera')); }
    if (element('vision-check')) element('vision-check').disabled = !state.source || Boolean(state.busy) || document.hidden;
    const rows = element('vision-result-rows');
    if (rows?.replaceChildren) {
      const children = (latest?.rows || []).map(row => {
        const node = document.createElement('tr');
        node.dataset.resultKind = row.kind; node.dataset.model = row.model || engine.coco.type || '';
        const score = row.kind === 'box' ? t('vision_model_percent', { score: Math.round(row.score * 100) }) : row.score.toFixed(2);
        for (const value of [label(row.id), t(row.kind === 'box' ? 'vision_kind_box' : 'vision_kind_zone'), score,
          t(['left', 'ahead', 'right', 'center'].includes(row.pos) ? 'pos_' + (row.pos === 'center' ? 'ahead' : row.pos) : 'vision_position_unknown')]) {
          const cell = document.createElement('td'); cell.textContent = value; node.append(cell);
        }
        return node;
      });
      rows.replaceChildren(...children);
    }
    put('vision-result-count', latest ? t('vision_count', { boxes: latest.boxes, zones: latest.rows.length - latest.boxes }) : t('vision_not_checked'));
  }
  function schedule() {
    clearTimeout(timer); timer = null;
    if (!visible || document.hidden) return;
    timer = setTimeout(() => { timer = null; render(); schedule(); }, 250);
  }
  function setVisible(on) { visible = on === true; render(); schedule(); }
  // An explicit button uses the established detector and overlay once. It never invokes a
  // cloud model, OCR, CLIP downloads or an additional camera stream.
  function check() {
    if (!state.source || document.hidden) { render(); return; }
    const wanted = captureLocalActionGuard();
    return withBusy(t('analyzing_title'), async () => {
      try {
        if (!wanted()) return;
        const ready = await ensureVisionModels();
        if (!wanted() || !ready) return;
        const frame = captureFrame(640); if (!frame) { reason = 'stale'; render(); return; }
        const objects = await runCoco(frame);
        if (!wanted()) return;
        drawOverlay(frame, objects, []);
      } catch (error) { if (error.cancelled || !wanted()) return; reason = 'failed'; render(); }
    });
  }
  function boot() {
    if (booted) return;
    booted = true;
    element('vision-check')?.addEventListener('click', check);
    element('vision-describe')?.addEventListener('click', () => describeScene(undefined, true));
    element('vision-camera')?.addEventListener('click', () => toggleCamera());
    document.addEventListener('visibilitychange', () => { if (document.hidden) clear(); render(); schedule(); });
    render();
  }
  return { capture, begin, skipped, complete, failed, canDraw, publish, describeResult, sourceChanged, modelChanged, clear, render, setVisible, check, boot };
})();
