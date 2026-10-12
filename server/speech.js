import { Router } from 'express';

const VOICES = new Set(['bn-female', 'bn-male', 'en-female', 'en-male']);

// Inject synthesis so the HTTP boundary can be verified without contacting a voice provider.
export function createSpeechRouter(synthesize) {
  const router = Router();
  router.route('/speak')
    .all((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); })
    .post(async (req, res) => {
      if (!req.is('application/json')) return res.status(415).json({ error: 'json_required' });
      const body = req.body;
      if (!body || typeof body !== 'object' || Array.isArray(body) ||
          typeof body.text !== 'string' || body.text.length > 900 ||
          (body.voice !== undefined && !VOICES.has(body.voice))) {
        return res.status(400).json({ error: 'invalid_speech_input' });
      }
      if (!body.text.trim()) return res.status(400).json({ error: 'text_required' });
      const voice = body.voice ?? 'bn-female';
      const controller = new AbortController();
      const abort = () => controller.abort();
      const onClose = () => { if (!res.writableEnded) abort(); };
      req.once('aborted', abort);
      res.once('close', onClose);
      if (req.aborted) abort();
      try {
        const audio = await synthesize(body.text, voice, { signal: controller.signal });
        if (controller.signal.aborted || res.destroyed) return;
        res.type('audio/mpeg').send(audio);
      } catch {
        if (controller.signal.aborted || res.destroyed) return;
        console.error('tts unavailable');
        res.status(502).json({ error: 'tts_unavailable' });
      } finally {
        req.removeListener('aborted', abort);
        res.removeListener('close', onClose);
      }
    })
    // Old clients treat a failed GET as a cue to use the existing local voice fallback.
    // Never synthesize query text: it can already be retained in URL and access logs.
    .all((req, res) => res.set('Allow', 'POST').status(405).json({ error: 'speech_post_required' }));
  return router;
}
