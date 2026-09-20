// Server-side Gemini proxy. The key lives only in this process's environment, never sent to the
// client, so the phone app never needs to know or store it. Mirrors the prompt contract the
// frontend already expects (see web/cloud-client.js): {en, bn, ...task-specific fields}.
// 'gemini-flash-latest' auto-resolves to Google's current flash model, so this list keeps
const MODELS = ['gemini-2.0-flash', 'gemini-1.5-flash', 'gemini-flash-latest', 'gemini-3.5-flash', 'gemini-3-flash-preview'];
const SYSTEM = 'You are Astha, a warm, highly perceptive, and deeply detailed visual companion for a blind user in Bangladesh. Speak as "I". Be exceptionally vivid, concrete, and comprehensive: describe the room/environment layout, surfaces, lighting, all visible objects with their exact colours, textures, materials, brands, printed text, and precise spatial arrangement (left, ahead, right, foreground, background) with rough distances. Point out any hazards (stairs, drops, obstacles, wires, fire, water) first. Never invent anything you cannot actually see; if unsure, say you are not sure. Do not describe people as animals or objects; say "a person" when a human is visible. Return only the requested JSON. "bn" must be natural spoken Bangla with the exact same rich detail and meaning as "en".';

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

const MAIRA_ENDPOINT = process.env.MAIRA_API_URL || 'https://api.recommender.gigalogy.com/v1/maira/ask';
const DEFAULT_MAIRA_PROFILE = process.env.MAIRA_PROFILE_ID || '7edb5168-fafd-432c-80e9-de59acc9d0a2';

export function hasCloudAI() {
  const hasMaira = Boolean(process.env.PROJECT_KEY && (process.env.API_KEY || (process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY.startsWith('gAAAAA'))));
  const hasGemini = Boolean(process.env.GEMINI_API_KEY && !process.env.GEMINI_API_KEY.startsWith('gAAAAA'));
  return hasMaira || hasGemini;
}

export async function callMaira({ task, customPrompt, imageBase64, apiKey, projectKey, gptProfileId, userId = 'astha-user' }) {
  const pKey = projectKey || process.env.PROJECT_KEY;
  const aKey = apiKey || process.env.API_KEY || process.env.GEMINI_API_KEY;
  if (!pKey || !aKey) {
    const e = new Error('no_key');
    e.code = 'no_key';
    throw e;
  }
  const promptText = customPrompt || (typeof PROMPTS[task] === 'function' ? PROMPTS[task]() : PROMPTS[task]);
  if (!promptText) {
    const e = new Error('unknown_task');
    e.code = 'bad_request';
    throw e;
  }

  const images = [];
  if (imageBase64) {
    const dataUrl = imageBase64.startsWith('data:') ? imageBase64 : `data:image/jpeg;base64,${imageBase64}`;
    images.push({
      file_content: dataUrl,
      filename: 'frame.jpg'
    });
  }

  const query = `${SYSTEM}\n\nTask: ${promptText}`;
  const body = {
    user_id: userId,
    query,
    conversation_type: 'question',
    gpt_profile_id: gptProfileId || DEFAULT_MAIRA_PROFILE,
    images
  };

  let res;
  try {
    res = await fetch(MAIRA_ENDPOINT, {
      method: 'POST',
      headers: {
        'project-key': pKey,
        'api-key': aKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });
  } catch (e) {
    const err = new Error('network');
    err.code = 'network';
    throw err;
  }

  if (res.status === 401 || res.status === 403) {
    const err = new Error('bad_key');
    err.code = 'bad_key';
    throw err;
  }
  if (res.status === 429) {
    const err = new Error('rate_limit');
    err.code = 'rate_limit';
    throw err;
  }
  if (!res.ok) {
    const err = new Error('maira_' + res.status);
    err.code = 'upstream';
    throw err;
  }

  const data = await res.json();
  const text = data?.detail?.response || '';
  return parseJsonLoose(text);
}

export async function callGemini(options = {}) {
  const { task, customPrompt, imageBase64, apiKey, projectKey, maxTokens = 900, userId } = options;
  const key = apiKey || process.env.API_KEY || process.env.GEMINI_API_KEY;
  const pKey = projectKey || process.env.PROJECT_KEY;

  // If Gigalogy Maira credentials are present (project-key and api-key starting with gAAAAA... or API_KEY env),
  // dispatch directly to Maira AI engine.
  if (pKey && (process.env.API_KEY || (key && key.startsWith('gAAAAA')))) {
    return callMaira({ task, customPrompt, imageBase64, apiKey: key, projectKey: pKey, userId });
  }

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
  for (const model of MODELS) {
    let res;
    try {
      res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`, {
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

