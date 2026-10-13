// Per-account accessibility preferences from the personal setup assessment.
//
// They live in one reserved knowledge_docs row per account, so the reviewed six-table
// Supabase schema is unchanged and no migration is needed. The row follows the account:
// it is included in the export, removed by account deletion, and never used as a note.
import { Router } from 'express';
import { nanoid } from 'nanoid';
import { all, run } from './db.js';
import { asyncRoute } from './async-route.js';
import { isBody, jsonWithin } from './validate.js';

export const PREFERENCES_CATEGORY = 'astha_preferences';
const TITLE = 'Accessibility preferences';

// Every stored value is one of these. Unknown keys and values are rejected, not stored.
const CHOICES = Object.freeze({
  vision: ['none', 'light', 'low', 'unspecified'],
  language: ['bn', 'en'],
  feedback: ['detailed', 'brief', 'text'],
  textSize: ['normal', 'large', 'xlarge'],
  theme: ['mulberry-apricot', 'navy-cyan', 'monochrome', 'clinical-yellow'],
  speechRate: ['0.8', '1', '1.2', '1.5'],
});
const SETS = Object.freeze({
  devices: ['phone_camera', 'smart_glasses', 'clip_camera', 'braille_controller'],
  modes: ['ask', 'road', 'classroom'],
});
const FLAGS = Object.freeze(['haptics']);

// Returns a clean copy, or null when anything is outside the contract.
export function validatePreferences(input) {
  if (!isBody(input) || !jsonWithin(input, 2048)) return null;
  const clean = {};
  for (const [key, value] of Object.entries(input)) {
    if (Object.hasOwn(CHOICES, key)) {
      if (!CHOICES[key].includes(value)) return null;
      clean[key] = value;
    } else if (Object.hasOwn(SETS, key)) {
      if (!Array.isArray(value) || value.length > SETS[key].length ||
          !value.every(item => SETS[key].includes(item)) || new Set(value).size !== value.length) return null;
      clean[key] = SETS[key].filter(item => value.includes(item));
    } else if (FLAGS.includes(key)) {
      if (typeof value !== 'boolean') return null;
      clean[key] = value;
    } else return null;
  }
  return clean;
}

async function stored(userId) {
  const rows = await all('SELECT id, content, updated_at FROM knowledge_docs WHERE user_id = ? AND category = ? ORDER BY updated_at DESC, id DESC LIMIT 5',
    [userId, PREFERENCES_CATEGORY]);
  return rows;
}

export async function readPreferences(userId) {
  const [row] = await stored(userId);
  if (!row) return null;
  let parsed;
  try { parsed = JSON.parse(row.content); } catch { return null; }
  const preferences = validatePreferences(parsed);
  return preferences ? { preferences, updated_at: row.updated_at } : null;
}

export const preferencesRouter = Router();

preferencesRouter.get('/preferences', asyncRoute(async (req, res) => {
  const saved = await readPreferences(req.user.id);
  res.json(saved || { preferences: null, updated_at: null });
}));

preferencesRouter.put('/preferences', asyncRoute(async (req, res) => {
  const preferences = isBody(req.body) ? validatePreferences(req.body.preferences) : null;
  if (!preferences) return res.status(400).json({ error: 'invalid_preferences' });
  const content = JSON.stringify(preferences);
  const now = Date.now();
  const [current, ...duplicates] = await stored(req.user.id);
  if (current) {
    await run('UPDATE knowledge_docs SET content = ?, updated_at = ? WHERE id = ? AND user_id = ?', [content, now, current.id, req.user.id]);
    // Two devices saving at once can each insert; keep only the row just written.
    for (const extra of duplicates) await run('DELETE FROM knowledge_docs WHERE id = ? AND user_id = ?', [extra.id, req.user.id]);
  } else {
    await run('INSERT INTO knowledge_docs (id, user_id, category, title, content, tags_json, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)',
      [nanoid(), req.user.id, PREFERENCES_CATEGORY, TITLE, content, '[]', now, now]);
  }
  res.json({ ok: true, preferences, updated_at: now });
}));

preferencesRouter.delete('/preferences', asyncRoute(async (req, res) => {
  await run('DELETE FROM knowledge_docs WHERE user_id = ? AND category = ?', [req.user.id, PREFERENCES_CATEGORY]);
  res.json({ ok: true });
}));
