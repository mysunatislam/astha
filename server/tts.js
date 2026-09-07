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
const cache = new Map(); // small in-memory cache; identical lines (guidance phrases) are spoken a lot
const MAX_CACHE = 200;

export async function synthesize(text, voiceKey) {
  const voice = VOICES[voiceKey] || VOICES['bn-female'];
  const key = voice + '|' + text;
  if (cache.has(key)) return cache.get(key);
  const tts = new MsEdgeTTS();
  await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
  const { audioStream } = tts.toStream(text);
  const chunks = [];
  for await (const chunk of audioStream) chunks.push(chunk);
  const buffer = Buffer.concat(chunks);
  if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value);
  cache.set(key, buffer);
  return buffer;
}
export function listVoices() { return VOICES; }
