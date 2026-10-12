// Account data rights: an owner-scoped export of everything the server holds, and an
// irreversible deletion that also ends every session issued for that account.
import { Router } from 'express';
import { all, run } from './db.js';
import { verifyPasscode } from './auth.js';
import { normalizePasscode } from './security.js';
import { asyncRoute } from './async-route.js';
import { isBody } from './validate.js';

export const DELETE_CONFIRMATION = 'delete_my_account';
const EXPORT_ROW_LIMIT = 5000;
const EXPORT_TABLES = Object.freeze({
  memories: 'SELECT id, item, location, source, score, created_at FROM memories WHERE user_id = ? ORDER BY created_at DESC LIMIT ' + EXPORT_ROW_LIMIT,
  rooms: 'SELECT id, name, notes, updated_at FROM rooms WHERE user_id = ? ORDER BY updated_at DESC LIMIT ' + EXPORT_ROW_LIMIT,
  events: 'SELECT id, kind, text, created_at FROM events WHERE user_id = ? ORDER BY created_at DESC LIMIT ' + EXPORT_ROW_LIMIT,
  agent_tasks: 'SELECT id, goal, plan_json, status, step_history_json, result_json, created_at, updated_at FROM agent_tasks WHERE user_id = ? ORDER BY updated_at DESC LIMIT ' + EXPORT_ROW_LIMIT,
  knowledge_docs: 'SELECT id, category, title, content, tags_json, created_at, updated_at FROM knowledge_docs WHERE user_id = ? ORDER BY updated_at DESC LIMIT ' + EXPORT_ROW_LIMIT,
});

// Stored JSON strings are returned as values; a damaged legacy string is exported unchanged.
function parseStored(value) {
  if (typeof value !== 'string') return null;
  try { return JSON.parse(value); } catch { return value; }
}

export function createAccountRouter(cookieOptions) {
  const router = Router();

  router.get('/account/export', asyncRoute(async (req, res) => {
    const { id, name, phone, voice_lang, mode, face_descriptor, created_at } = req.user;
    const data = {
      format: 'astha-export-v1',
      exported_at: Date.now(),
      // The PIN hash and salt are credentials, not personal records, and are never exported.
      account: { id, name, phone, voice_lang, mode, created_at, face_descriptor: parseStored(face_descriptor) },
      truncated: [],
    };
    for (const [table, sql] of Object.entries(EXPORT_TABLES)) {
      const rows = await all(sql, [id]);
      if (rows.length >= EXPORT_ROW_LIMIT) data.truncated.push(table);
      data[table] = rows;
    }
    data.agent_tasks = data.agent_tasks.map(({ plan_json, step_history_json, result_json, ...task }) => ({
      ...task, plan: parseStored(plan_json), step_history: parseStored(step_history_json), result: parseStored(result_json),
    }));
    data.knowledge_docs = data.knowledge_docs.map(({ tags_json, ...doc }) => ({ ...doc, tags: parseStored(tags_json) }));
    res.set('Content-Disposition', 'attachment; filename="astha-export.json"');
    res.json(data);
  }));

  // POST rather than DELETE: intermediaries may drop a DELETE request body.
  router.post('/account/delete', asyncRoute(async (req, res) => {
    const body = req.body;
    if (!isBody(body) || body.confirm !== DELETE_CONFIRMATION) return res.status(400).json({ error: 'confirmation_required' });
    // A registered account re-enters its PIN, so an unlocked borrowed phone cannot erase it.
    // Guest accounts have no PIN their owner knows; the explicit confirmation is their only gate.
    if (req.user.phone !== null) {
      const supplied = body.passcode;
      if (typeof supplied !== 'string' || supplied.length < 4 || supplied.length > 128) {
        return res.status(400).json({ error: 'passcode_required' });
      }
      const passcode = normalizePasscode(supplied) || supplied;
      const matches = verifyPasscode(passcode, req.user.passcode_hash, req.user.passcode_salt) ||
        (supplied !== passcode && verifyPasscode(supplied, req.user.passcode_hash, req.user.passcode_salt));
      // 403, not 401: the session is still valid and the phone must not treat this as signed out.
      if (!matches) return res.status(403).json({ error: 'invalid_credentials' });
    }
    // One statement: every owned table cascades from users in both storage providers, and
    // tokens for a removed account stop resolving to a user on their next request.
    await run('DELETE FROM users WHERE id = ?', [req.user.id]);
    const options = { ...cookieOptions }; delete options.maxAge;
    res.clearCookie('astha_session', options);
    res.json({ ok: true });
  }));

  return router;
}
