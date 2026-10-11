// Existing SQLite development/storage remains available. Supabase uses the same
// parameterized interface; callers await operations for either provider.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { connectPostgres } from './postgres.js';
import { nanoid } from 'nanoid';

export const storageProvider = process.env.DB_PROVIDER || 'sqlite';
if (!['sqlite', 'supabase'].includes(storageProvider)) throw new Error('Unsupported DB_PROVIDER');
let postgres;
export let db;
if (storageProvider === 'supabase') {
  postgres = await connectPostgres();
  db = { close: postgres.close };
} else {
const DB_PATH = process.env.DB_PATH || './data/astha.db';
mkdirSync(dirname(DB_PATH), { recursive: true });
db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT UNIQUE,
  passcode_hash TEXT NOT NULL,
  passcode_salt TEXT NOT NULL,
  voice_lang TEXT NOT NULL DEFAULT 'bn',
  mode TEXT NOT NULL DEFAULT 'auto',
  face_descriptor TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item TEXT NOT NULL,
  location TEXT NOT NULL,
  source TEXT NOT NULL,
  score REAL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memories_user ON memories(user_id, created_at DESC);
CREATE TABLE IF NOT EXISTS rooms (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  notes TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rooms_user ON rooms(user_id, updated_at DESC);
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_user ON events(user_id, created_at DESC);
CREATE TABLE IF NOT EXISTS agent_tasks (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  goal TEXT NOT NULL,
  plan_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  step_history_json TEXT,
  result_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_tasks_user ON agent_tasks(user_id, updated_at DESC);
CREATE TABLE IF NOT EXISTS knowledge_docs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  tags_json TEXT,
  embedding_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_knowledge_user ON knowledge_docs(user_id, category);
`);
}

export function run(sql, params = []) { return postgres ? postgres.run(sql, params) : db.prepare(sql).run(...params); }
export function get(sql, params = []) { return postgres ? postgres.get(sql, params) : db.prepare(sql).get(...params); }
export function all(sql, params = []) { return postgres ? postgres.all(sql, params) : db.prepare(sql).all(...params); }
export function saveRoom({ userId, name, notes }) {
  if (postgres) return postgres.saveRoom({ userId, name, notes });
  // Keep SQLite's original read/write together, with no asynchronous gap or data migration.
  const existing = get('SELECT id FROM rooms WHERE user_id = ? AND lower(name) = lower(?)', [userId, name]);
  const id = existing ? existing.id : nanoid();
  const now = Date.now();
  if (existing) run('UPDATE rooms SET notes = ?, updated_at = ? WHERE id = ? AND user_id = ?', [notes, now, id, userId]);
  else run('INSERT INTO rooms (id, user_id, name, notes, updated_at) VALUES (?,?,?,?,?)', [id, userId, name, notes, now]);
  return id;
}
export async function storageReady() {
  if (postgres) await postgres.ready();
  else db.prepare('SELECT 1').get();
}
