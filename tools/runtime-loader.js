// Local vision is optional. Load its pinned runtime only when that feature is used,
// so a slow CDN cannot hold the app shell or an online answer behind model libraries.
const VISION_RUNTIMES = {
  ort: { url: 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.21.0/dist/ort.webgpu.min.js', ready: () => typeof ort !== 'undefined' },
  tf: { url: 'https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.20.0/dist/tf.min.js', ready: () => typeof tf !== 'undefined' },
  coco: { url: 'https://cdn.jsdelivr.net/npm/@tensorflow-models/coco-ssd@2.2.3/dist/coco-ssd.min.js', ready: () => typeof cocoSsd !== 'undefined', dependency: 'tf' },
  ocr: { url: 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js', ready: () => typeof Tesseract !== 'undefined' },
};
const visionRuntimeLoads = new Map();
function ensureVisionRuntime(name) {
  const runtime = VISION_RUNTIMES[name];
  if (!runtime) return Promise.reject(new Error('Unknown vision runtime: ' + name));
  if (runtime.ready()) return Promise.resolve();
  if (visionRuntimeLoads.has(name)) return visionRuntimeLoads.get(name);
  const loading = Promise.resolve().then(async () => {
    if (runtime.dependency) await ensureVisionRuntime(runtime.dependency);
    if (runtime.ready()) return;
    await new Promise((resolve, reject) => {
      const script = document.createElement('script');
      let settled = false;
      const finish = error => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        script.onload = script.onerror = null;
        if (error) { script.remove(); reject(error); } else resolve();
      };
      const timer = setTimeout(() => finish(new Error('Vision runtime timed out: ' + name)), 15000);
      script.src = runtime.url;
      script.async = true;
      script.onload = () => finish(runtime.ready() ? null : new Error('Vision runtime unavailable: ' + name));
      script.onerror = () => finish(new Error('Vision runtime failed to load: ' + name));
      try { document.head.appendChild(script); } catch (error) { finish(error); }
    });
  }).catch(error => {
    visionRuntimeLoads.delete(name);
    throw error;
  });
  visionRuntimeLoads.set(name, loading);
  return loading;
}
