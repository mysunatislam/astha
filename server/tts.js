// Server-side speech: Microsoft Edge's neural voices (free, no key) give a real female Bangla
// voice ("bn-BD-NabanitaNeural") which almost no phone or desktop ships locally. The client still
// falls back to the browser's own SpeechSynthesis if this endpoint is unreachable (offline use).
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';

const VOICES = {
  'bn-female': 'bn-BD-NabanitaNeural',
  'bn-male': 'bn-BD-PradeepNeural',
  'en-female': 'en-US-AvaNeural',
  'en-male': 'en-US-GuyNeural',
};
const MAX_AUDIO_BYTES = 2 * 1024 * 1024;
const escapeXml = text => text.replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
})[char]);

// Generated speech may contain private notes: retain no shared text/audio cache.
export async function synthesize(text, voiceKey, { signal, timeoutMs = 10000 } = {}) {
  if (typeof text !== 'string' || !text.trim() || text.length > 900) {
    throw new Error('Invalid speech text');
  }
  signal?.throwIfAborted();
  const voice = VOICES[voiceKey] || VOICES['bn-female'];
  const tts = new MsEdgeTTS();
  let audioStream, metadataStream, interrupted, rejectStopped;
  const close = () => {
    audioStream?.destroy();
    metadataStream?.destroy();
    try { tts.close(); } catch { /* preserve the original failure */ }
  };
  const stopped = new Promise((_, reject) => { rejectStopped = reject; });
  const stop = reason => {
    if (interrupted) return;
    interrupted = reason;
    close();
    rejectStopped(reason);
  };
  const onAbort = () => stop(signal.reason || new Error('Speech cancelled'));
  const timer = setTimeout(() => stop(new Error('Speech deadline exceeded')), timeoutMs);
  signal?.addEventListener('abort', onAbort, { once: true });
  const assertActive = () => {
    if (interrupted) { close(); throw interrupted; }
  };
  try {
    return await Promise.race([stopped, (async () => {
      await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
      assertActive(); // a late provider connection must never start a cancelled request
      ({ audioStream, metadataStream } = tts.toStream(escapeXml(text)));
      const chunks = [];
      let size = 0;
      for await (const chunk of audioStream) {
        assertActive();
        size += chunk.length;
        if (size > MAX_AUDIO_BYTES) throw new Error('Speech audio too large');
        chunks.push(chunk);
      }
      assertActive();
      if (!size) throw new Error('Speech audio empty');
      return Buffer.concat(chunks);
    })()]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    close();
  }
}
export function listVoices() { return VOICES; }
