// Rolling per-account retention. Each account keeps only its newest rows per table, so one
// session cannot grow storage without bound and nothing is retained beyond what the app can
// still show or search. Limits sit at or above every list route's own LIMIT.
import { run } from './db.js';

export const RETENTION = Object.freeze({
  memories: Object.freeze({ order: 'created_at', keep: 500 }),
  rooms: Object.freeze({ order: 'updated_at', keep: 100 }),
  events: Object.freeze({ order: 'created_at', keep: 200 }),
  agent_tasks: Object.freeze({ order: 'updated_at', keep: 50 }),
  knowledge_docs: Object.freeze({ order: 'updated_at', keep: 200 }),
});

// Identifiers come only from the frozen table above, never from a request; values stay bound.
export async function applyRetention(table, userId) {
  const rule = Object.hasOwn(RETENTION, table) ? RETENTION[table] : null;
  if (!rule) throw new Error('Unsupported retention table');
  try {
    await run(`DELETE FROM ${table} WHERE user_id = ? AND id NOT IN (SELECT id FROM ${table} WHERE user_id = ? ORDER BY ${rule.order} DESC, id DESC LIMIT ${rule.keep})`,
      [userId, userId]);
    return true;
  } catch {
    // The save that triggered this prune is already committed. Reporting it as failed would
    // make the phone retry and duplicate the record; the next write prunes again.
    return false;
  }
}
