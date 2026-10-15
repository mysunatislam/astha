import { fetchCloud } from './security.js';

// Server-side cloud proxy. Keys live only in this process's environment, never sent to the
// client, so the phone app never needs to know or store it. Mirrors the prompt contract the
// frontend already expects (see web/cloud-client.js): {en, bn, ...task-specific fields}.
// Google's documented stable replacement for retired Gemini 2.0 Flash; reviewed 2026-10-09.
// https://ai.google.dev/gemini-api/docs/deprecations/
export const DEFAULT_GEMINI_MODELS = Object.freeze(['gemini-3.6-flash']);
export function getGeminiModels(value = process.env.GEMINI_MODELS) {
  if (value === undefined || value === '') return [...DEFAULT_GEMINI_MODELS];
  const models = typeof value === 'string' ? value.split(',').map(model => model.trim()) : value;
  if (!Array.isArray(models) || models.length < 1 || models.length > 3 ||
      models.some(model => typeof model !== 'string' || !/^gemini-[a-z0-9][a-z0-9._-]{0,79}$/.test(model))) {
    const error = new Error('GEMINI_MODELS must contain 1 to 3 exact Gemini model IDs.');
    error.code = 'bad_request';
    throw error;
  }
  // Preview/latest IDs are never defaults; operators can choose them explicitly after evaluation.
  return [...new Set(models)];
}
const MODELS = getGeminiModels();
const SYSTEM = 'You are Astha, an AI vision companion for a blind user in Bangladesh. Your user-facing name is Astha; provider, deployment, project and retrieved-document names do not change your identity. When asked to introduce yourself, say exactly "Hello, I am Astha, your AI vision companion." in English, or "হ্যালো, আমি আস্থা, আপনার এআই দৃষ্টি সহায়ক।" in Bangla. Do not add an introduction to ordinary visual answers unless asked. Speak as "I". Be exceptionally vivid, concrete, and comprehensive: describe the room/environment layout, surfaces, lighting, all visible objects with their exact colours, textures, materials, brands, printed text, and precise spatial arrangement (left, ahead, right, foreground, background) with rough distances. Point out any hazards (stairs, drops, obstacles, wires, fire, water) first. Never invent anything you cannot actually see; if unsure, say you are not sure. Do not describe people as animals or objects; say "a person" when a human is visible. Return only the requested JSON. "bn" must be natural spoken Bangla with the exact same rich detail and meaning as "en".';

export const PROMPTS = {
  describe: 'Provide a rich, highly detailed, and vivid visual description of everything the camera sees for the blind user. Start with hazards if any (stairs, drops, vehicles, wires on the floor, water, fire). Then describe the main environment and layout. Detail all major objects and people with their exact position (left, ahead, right, foreground, background), distance (very close, near, far), colors, materials, and any readable text or signs. Return JSON: {"en": string, "bn": string, "hazard": boolean, "mirror": boolean, "objects": [short English nouns]}. "mirror" is true ONLY if this is clearly the user\'s own reflection in a mirror with the phone visible.',
  identify: 'The user is holding one object near the camera. Say what it is: type, colour, material, brand or model if a logo or printed text shows, and any text on it. If it is a toy, a picture, a screen, or an ID card, say so clearly. Return JSON: {"en": string, "bn": string, "name": short English noun}.',
  clothes: 'Describe the garment in view: type (shirt, saree, salwar kameez, panjabi, dress, t-shirt, lungi...), colours, pattern, and fabric if visible (cotton, silk, denim, wool, synthetic, lace). Say whether a person is wearing it or it is being held. Return JSON: {"en": string, "bn": string, "garment": string, "colour": string}.',
  read: 'Transcribe ALL readable text exactly as printed, in its original script (Bangla or English), keeping line breaks, into "text". If it is a medicine, a sign, a label, a letter or a page, give a one-sentence explanation in "en" and "bn". If there is no readable text, set "text" to "". Return JSON: {"text": string, "en": string, "bn": string}.',
  screen: 'This is a screenshot of the user\'s computer. Return JSON: {"app": name of the foreground app or website, "content": exact transcription of the main editor, document, chat or page text (skip menus, toolbars and sidebars; keep code indentation and line breaks), "dialog": {"present": boolean, "button": text of the safest dismiss button or "", "location": one of "top-left","top","top-right","left","center","right","bottom-left","bottom","bottom-right"}, "error": {"present": boolean, "line": exact error text or "", "fix": one short sentence or ""}, "en": one-sentence spoken summary of where the user is and what is on screen, "bn": the same in Bangla}.',
  mirror: 'Is this image the user\'s own reflection in a mirror (a person holding up a phone toward a mirror)? Return JSON: {"mirror": boolean, "en": one sentence describing what the person is wearing if mirror is true else "", "bn": same in Bangla}.',
  verify: names => `The on-device detector thinks it sees: ${names}. Look at the frame: say in one short sentence what is really there that matters to a blind person (hazards first, then people and objects with position). If the detector was wrong, do not repeat its mistake. If nothing notable, set "none" true. Return JSON: {"en": string, "bn": string, "none": boolean, "mirror": boolean}.`,
};

function parseJsonLoose(text) {
  try { return JSON.parse(text); } catch (e) {}
  const m = (text || '').match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch (e) {} }
  // Gemini occasionally gets cut off by the token limit before the closing brace, which
  // breaks JSON.parse entirely. The "en"/"bn" fields are written first in every prompt's
  // schema, so they usually survive a truncation intact -- pull them out directly rather
  // than falling back to speaking the raw, broken JSON text at the user.
  const field = name => { const fm = (text || '').match(new RegExp('"' + name + '"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"')); return fm ? fm[1].replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\') : null; };
  const en = field('en'), bn = field('bn');
  if (en) return { en, bn: bn || '' };
  return { en: (text || '').trim(), bn: '' };
}

const MAIRA_ENDPOINT = 'https://api.recommender.gigalogy.com/v1/maira/ask';
const MAX_MAIRA_RESPONSE_BYTES = 256 * 1024;
const MAX_MAIRA_TEXT = 128 * 1024;

function cloudError(code) { const error = new Error(code); error.code = code; return error; }
function configuredValue(...values) { return values.find(value => value !== undefined && value !== null && value !== ''); }
function boundedConfig(value, max) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) {
    throw cloudError('bad_request');
  }
  return value.trim();
}
function isLegacyMairaKey(value) { return typeof value === 'string' && value.startsWith('gAAAAA'); }
function mairaConfig(options = {}, env = process.env) {
  const apiKey = boundedConfig(configuredValue(options.apiKey, env.MAIRA_API_KEY, env.API_KEY,
    isLegacyMairaKey(env.GEMINI_API_KEY) ? env.GEMINI_API_KEY : undefined), 8192);
  const projectKey = boundedConfig(configuredValue(options.projectKey, env.MAIRA_PROJECT_KEY, env.PROJECT_KEY), 8192);
  const profileId = boundedConfig(configuredValue(options.gptProfileId, env.MAIRA_PROFILE_ID), 128);
  let endpoint;
  try {
    const url = new URL(configuredValue(env.MAIRA_API_URL, MAIRA_ENDPOINT));
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error();
    endpoint = url.href;
  } catch { throw cloudError('bad_request'); }
  return { apiKey, projectKey, profileId, endpoint };
}
function geminiKey(options = {}, env = process.env) {
  // API_KEY was also used for Gemini in older installations with no Maira project.
  const key = boundedConfig(configuredValue(options.apiKey, env.GEMINI_API_KEY,
    !env.PROJECT_KEY && !env.MAIRA_PROJECT_KEY ? env.API_KEY : undefined), 8192);
  return isLegacyMairaKey(key) ? undefined : key;
}

// Provider selection is explicit in production; auto preserves existing configured installs.
// Selecting Maira never falls through to Gemini on incomplete config or a provider error.
export function getCloudProvider(env = process.env, options = {}) {
  const selector = configuredValue(options.provider, env.CLOUD_AI_PROVIDER, 'auto');
  if (!['auto', 'maira', 'gemini'].includes(selector)) throw cloudError('bad_request');
  if (selector !== 'auto') return selector;
  if (configuredValue(env.MAIRA_API_KEY, env.MAIRA_PROJECT_KEY) ||
      (configuredValue(options.projectKey, env.PROJECT_KEY) && configuredValue(options.apiKey, env.API_KEY)) ||
      isLegacyMairaKey(configuredValue(options.apiKey, env.GEMINI_API_KEY))) return 'maira';
  return geminiKey(options, env) ? 'gemini' : 'none';
}
export function getCloudStatus(env = process.env) {
  let provider = 'none';
  try {
    provider = getCloudProvider(env);
    const config = provider === 'maira' ? mairaConfig({}, env) : null;
    const configured = provider === 'maira' ? Boolean(config.apiKey && config.projectKey) :
      provider === 'gemini' ? Boolean(geminiKey({}, env)) : false;
    return { provider, configured };
  } catch { return { provider, configured: false }; }
}
// Configuration presence only: credentials/profile access and live inference are not verified here.
export function hasCloudAI(env = process.env) { return getCloudStatus(env).configured; }

function mairaImage(imageBase64) {
  if (imageBase64 === undefined || imageBase64 === null || imageBase64 === '') return [];
  if (typeof imageBase64 !== 'string' || imageBase64.length > 8 * 1024 * 1024 + 64) throw cloudError('bad_request');
  let data = imageBase64, type = 'jpeg';
  if (data.startsWith('data:')) {
    const match = /^data:image\/(jpeg|jpg|png|webp|gif|bmp);base64,([\s\S]+)$/.exec(data);
    if (!match) throw cloudError('bad_request');
    [, type, data] = match;
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data) || data.length % 4 === 1 || data.length > 8 * 1024 * 1024) {
    throw cloudError('bad_request');
  }
  const bytes = Buffer.from(data, 'base64').byteLength;
  if (!bytes || bytes > 6 * 1024 * 1024) throw cloudError('bad_request');
  type = type === 'jpg' ? 'jpeg' : type;
  // The official live MairaAskRequestSchema supports JSON images with data-URL file_content.
  // https://api.recommender.gigalogy.com/v1/recommender.json
  return [{ file_content: `data:image/${type};base64,${data}`, filename: `frame.${type === 'jpeg' ? 'jpg' : type}` }];
}

async function readMairaResponse(response) {
  if (Number(response.headers.get('content-length')) > MAX_MAIRA_RESPONSE_BYTES) {
    void response.body?.cancel().catch(() => {});
    throw cloudError('bad_response');
  }
  const reader = response.body?.getReader();
  if (!reader) throw cloudError('bad_response');
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_MAIRA_RESPONSE_BYTES) throw cloudError('bad_response');
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    void reader.cancel().catch(() => {});
    throw error?.code === 'bad_response' ? error : cloudError('network');
  } finally { reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks, size).toString('utf8')); }
  catch { throw cloudError('bad_response'); }
}

function parseMairaResponse(text) {
  if (typeof text !== 'string' || !text.trim() || text.length > MAX_MAIRA_TEXT) throw cloudError('bad_response');
  let trimmed = text.trim();
  let isFenced = false;
  if (trimmed.startsWith('```')) {
    const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
    if (!fenced) throw cloudError('bad_response');
    trimmed = fenced[1].trim();
    isFenced = true;
  }
  let result;
  try { result = JSON.parse(trimmed); }
  catch {
    if (isFenced) throw cloudError('bad_response');
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (match) { try { result = JSON.parse(match[0]); } catch { throw cloudError('bad_response'); } }
    else if (/^[\[\{]|^```|"(?:en|bn)"\s*:/.test(trimmed)) throw cloudError('bad_response');
    else return { en: trimmed, bn: '' };
  }
  if (!result || typeof result !== 'object' || Array.isArray(result) || !Object.keys(result).length ||
      ['en', 'bn'].some(field => result[field] !== undefined && typeof result[field] !== 'string')) {
    throw cloudError('bad_response');
  }
  return result;
}

export async function callMaira(options = {}) {
  const { task, customPrompt, imageBase64, userId } = options;
  const { apiKey, projectKey, profileId, endpoint } = mairaConfig(options);
  if (!apiKey || !projectKey) throw cloudError('no_key');
  // Authenticated callers supply their own opaque account ID, never a shared default identity.
  if (typeof userId !== 'string' || !userId.trim() || userId.length > 128 ||
      ['astha-user', 'astha-browser-user'].includes(userId.trim()) || /[\u0000-\u001f\u007f]/.test(userId)) {
    throw cloudError('bad_request');
  }
  if (customPrompt === undefined && (typeof task !== 'string' || !Object.hasOwn(PROMPTS, task))) {
    throw cloudError('bad_request');
  }
  const promptText = customPrompt !== undefined ? customPrompt :
    Object.hasOwn(PROMPTS, task) ? (typeof PROMPTS[task] === 'function' ? PROMPTS[task]() : PROMPTS[task]) : undefined;
  if (typeof promptText !== 'string' || !promptText.trim() || promptText.length > 32000) throw cloudError('bad_request');
  const body = {
    user_id: userId,
    query: `${SYSTEM}\n\nTask: ${promptText}`,
    conversation_type: 'question',
    ...(profileId ? { gpt_profile_id: profileId } : {}),
    images: mairaImage(imageBase64),
  };
  let response;
  try {
    response = await fetchCloud(endpoint, {
      method: 'POST', redirect: 'error', cache: 'no-store',
      headers: { 'project-key': projectKey, 'api-key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch { throw cloudError('network'); }
  if (response.status !== 200) void response.body?.cancel().catch(() => {});
  if (response.status === 401 || response.status === 403) throw cloudError('bad_key');
  if (response.status === 429) throw cloudError('rate_limit');
  if (!response.ok) throw cloudError('upstream');
  // Accepted/background work is not a completed spoken answer.
  if (response.status !== 200) throw cloudError('bad_response');
  const data = await readMairaResponse(response);
  return parseMairaResponse(data?.detail?.response);
}

export async function callGemini(options = {}) {
  const { task, customPrompt, imageBase64, maxTokens = 900, models } = options;
  if (getCloudProvider(process.env, options) === 'maira') return callMaira(options);
  const key = geminiKey(options);

  if (!key) { const e = new Error('no_key'); e.code = 'no_key'; throw e; }
  const promptText = customPrompt || (typeof PROMPTS[task] === 'function' ? PROMPTS[task]() : PROMPTS[task]);
  if (!promptText) { const e = new Error('unknown_task'); e.code = 'bad_request'; throw e; }
  const parts = [{ text: promptText }];
  if (imageBase64) parts.push({ inline_data: { mime_type: 'image/jpeg', data: imageBase64 } });
  const body = {
    system_instruction: { parts: [{ text: SYSTEM }] },
    contents: [{ role: 'user', parts }],
    generationConfig: { temperature: 0.2, response_mime_type: 'application/json', max_output_tokens: maxTokens },
  };
  let lastErr = null;
  for (const model of models === undefined ? MODELS : getGeminiModels(models)) {
    let res;
    try {
      res = await fetchCloud(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
    } catch (e) { const err = new Error('network'); err.code = 'network'; throw err; }
    if (res.status === 404) { lastErr = new Error('model_not_found'); continue; }
    if (res.status === 400 || res.status === 403) { const err = new Error('bad_key'); err.code = 'bad_key'; throw err; }
    if (res.status === 429) { const err = new Error('rate_limit'); err.code = 'rate_limit'; throw err; }
    if (!res.ok) { const err = new Error('gemini_' + res.status); err.code = 'upstream'; throw err; }
    const data = await res.json();
    const text = ((((data.candidates || [])[0] || {}).content || {}).parts || []).map(p => p.text || '').join('');
    return parseJsonLoose(text);
  }
  throw lastErr || new Error('gemini_unavailable');
}

export const callCloudAI = callGemini;
