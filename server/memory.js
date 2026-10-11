// Per-user memory: approved object events, room notes, and a short activity log.
// Every write here is something the user explicitly asked Astha to remember.
import { Router } from 'express';
import { nanoid } from 'nanoid';
import { run, all, saveRoom } from './db.js';
import { asyncRoute } from './async-route.js';

export const memoryRouter = Router();

const isBody = value => value && typeof value === 'object' && !Array.isArray(value);
const isText = (value, max, required = true) => typeof value === 'string' &&
  value.length <= max && (!required || value.trim().length > 0);

memoryRouter.get('/memories', asyncRoute(async (req, res) => {
  if (req.query.q !== undefined && !isText(req.query.q, 240, false)) return res.status(400).json({ error: 'invalid_query' });
  const q = (req.query.q || '').toLowerCase();
  const rows = await all('SELECT * FROM memories WHERE user_id = ? ORDER BY created_at DESC LIMIT 200', [req.user.id]);
  const filtered = q ? rows.filter(r => (r.item + ' ' + r.location).toLowerCase().includes(q)) : rows;
  res.json({ memories: filtered });
}));
memoryRouter.post('/memories', asyncRoute(async (req, res) => {
  const { item, location, source, score } = req.body || {};
  if (!item || !location) return res.status(400).json({ error: 'item_and_location_required' });
  if (!isBody(req.body) || !isText(item, 120) || !isText(location, 240) ||
      (source !== undefined && !isText(source, 120, false)) ||
      (score !== undefined && score !== null && (typeof score !== 'number' || !Number.isFinite(score)))) {
    return res.status(400).json({ error: 'invalid_memory_input' });
  }
  const id = nanoid();
  await run('INSERT INTO memories (id, user_id, item, location, source, score, created_at) VALUES (?,?,?,?,?,?,?)',
    [id, req.user.id, String(item).slice(0, 120), String(location).slice(0, 240), source || 'Your note', score ?? null, Date.now()]);
  res.json({ id });
}));
memoryRouter.delete('/memories/:id', asyncRoute(async (req, res) => {
  await run('DELETE FROM memories WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
  res.json({ ok: true });
}));
memoryRouter.delete('/memories', asyncRoute(async (req, res) => {
  await run('DELETE FROM memories WHERE user_id = ?', [req.user.id]);
  res.json({ ok: true });
}));

memoryRouter.get('/rooms', asyncRoute(async (req, res) => {
  res.json({ rooms: await all('SELECT * FROM rooms WHERE user_id = ? ORDER BY updated_at DESC LIMIT 100', [req.user.id]) });
}));
memoryRouter.post('/rooms', asyncRoute(async (req, res) => {
  const { name, notes } = req.body || {};
  if (!name || !notes) return res.status(400).json({ error: 'name_and_notes_required' });
  if (!isBody(req.body) || !isText(name, 80) || !isText(notes, 2000)) return res.status(400).json({ error: 'invalid_room_input' });
  const id = await saveRoom({ userId: req.user.id, name: String(name).slice(0, 80), notes: String(notes).slice(0, 2000) });
  res.json({ id });
}));
memoryRouter.delete('/rooms/:id', asyncRoute(async (req, res) => {
  await run('DELETE FROM rooms WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
  res.json({ ok: true });
}));

memoryRouter.delete('/rooms', asyncRoute(async (req, res) => {
  await run('DELETE FROM rooms WHERE user_id = ?', [req.user.id]);
  res.json({ ok: true });
}));

memoryRouter.get('/log', asyncRoute(async (req, res) => {
  res.json({ events: await all('SELECT * FROM events WHERE user_id = ? ORDER BY created_at DESC LIMIT 30', [req.user.id]) });
}));
memoryRouter.delete('/log', asyncRoute(async (req, res) => {
  await run('DELETE FROM events WHERE user_id = ?', [req.user.id]);
  res.json({ ok: true });
}));

memoryRouter.post('/log', asyncRoute(async (req, res) => {
  const { kind, text } = req.body || {};
  if (!text) return res.status(400).json({ error: 'text_required' });
  if (!isBody(req.body) || !isText(text, 300) || (kind !== undefined && !isText(kind, 64, false))) return res.status(400).json({ error: 'invalid_log_input' });
  await run('INSERT INTO events (id, user_id, kind, text, created_at) VALUES (?,?,?,?,?)', [nanoid(), req.user.id, kind || 'note', String(text).slice(0, 300), Date.now()]);
  res.json({ ok: true });
}));

memoryRouter.put('/settings', asyncRoute(async (req, res) => {
  const { voice_lang, mode, face_descriptor } = req.body || {};
  if (!isBody(req.body) || (voice_lang !== undefined && !['bn', 'en'].includes(voice_lang)) ||
      (mode !== undefined && !['auto', 'quiet'].includes(mode)) ||
      (face_descriptor !== undefined && face_descriptor !== null &&
       (!Array.isArray(face_descriptor) || face_descriptor.length !== 128 ||
        !face_descriptor.every(value => typeof value === 'number' && Number.isFinite(value))))) {
    return res.status(400).json({ error: 'invalid_settings' });
  }
  if (voice_lang !== undefined || mode !== undefined || face_descriptor !== undefined) {
    await run('UPDATE users SET voice_lang = COALESCE(?, voice_lang), mode = COALESCE(?, mode), face_descriptor = CASE WHEN ? = 1 THEN ? ELSE face_descriptor END WHERE id = ?',
      [voice_lang ?? null, mode ?? null, face_descriptor !== undefined ? 1 : 0,
        face_descriptor ? JSON.stringify(face_descriptor) : null, req.user.id]);
  }
  res.json({ ok: true });
}));
