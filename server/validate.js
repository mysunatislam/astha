// Shared bounds for authenticated API bodies. Checks run before storage, hashing or provider
// work, so oversized or mistyped input never reaches a prompt, a row or a synchronous hash.
export const isBody = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
export const isText = (value, max, required = true) => typeof value === 'string' &&
  value.length <= max && (!required || value.trim().length > 0);

// Nested client or provider JSON is bounded by its serialized size rather than walked twice.
export function jsonWithin(value, maxBytes) {
  try {
    const serialized = JSON.stringify(value);
    return typeof serialized === 'string' && Buffer.byteLength(serialized, 'utf8') <= maxBytes;
  } catch {
    return false;
  }
}

// Optional camera/screen frame as base64 or an image data URL. Provider adapters still verify
// the encoding; this only keeps non-strings and oversized payloads out of every caller.
export const MAX_FRAME_CHARS = 8 * 1024 * 1024 + 64;
export function isFrame(value) {
  return value === undefined || value === null || (typeof value === 'string' && value.length <= MAX_FRAME_CHARS);
}

// Untrusted display text: a bounded string, or the fallback when the field is absent or mistyped.
export function clipText(value, max, fallback = '') {
  return typeof value === 'string' ? value.slice(0, max) : fallback;
}
