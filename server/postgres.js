// Server-only Supabase Postgres storage. No migrations or SQLite fallback on failure.
import { readFileSync } from 'node:fs';
import { nanoid } from 'nanoid';

const TABLES = ['users', 'memories', 'rooms', 'events', 'agent_tasks', 'knowledge_docs'];
const COLUMNS = {
  users: ['id:text', 'name:text', 'phone:text', 'passcode_hash:text', 'passcode_salt:text', 'voice_lang:text', 'mode:text', 'face_descriptor:text', 'created_at:bigint'],
  memories: ['id:text', 'user_id:text', 'item:text', 'location:text', 'source:text', 'score:double precision', 'created_at:bigint'],
  rooms: ['id:text', 'user_id:text', 'name:text', 'notes:text', 'updated_at:bigint'],
  events: ['id:text', 'user_id:text', 'kind:text', 'text:text', 'created_at:bigint'],
  agent_tasks: ['id:text', 'user_id:text', 'goal:text', 'plan_json:text', 'status:text', 'step_history_json:text', 'result_json:text', 'created_at:bigint', 'updated_at:bigint'],
  knowledge_docs: ['id:text', 'user_id:text', 'category:text', 'title:text', 'content:text', 'tags_json:text', 'embedding_json:text', 'created_at:bigint', 'updated_at:bigint'],
};

async function initializePostgresClient(client) {
  // Supavisor can ignore startup parameters. Session pooling keeps this setting
  // on the backend; the awaited hook runs before a client reaches application SQL.
  try {
    await client.query("SET statement_timeout = '10s'");
    const result = await client.query('SHOW statement_timeout');
    if (result.rows[0]?.statement_timeout !== '10s') throw new Error('Unexpected statement timeout');
  } catch {
    throw new Error('Supabase statement timeout initialization failed');
  }
}

export function postgresConfig(env = process.env) {
  let url;
  try { url = new URL(env.SUPABASE_DB_URL || ''); } catch { throw new Error('Supabase database URL is required'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.username || !url.password ||
      !/^astha_backend(?:\.[a-z0-9]+)?$/.test(decodeURIComponent(url.username)) ||
      !(/\.supabase\.co$/.test(url.hostname) || /\.pooler\.supabase\.com$/.test(url.hostname)) ||
      !['', '5432'].includes(url.port) || url.pathname !== '/postgres' || url.search || url.hash) {
    throw new Error('Use the Supabase Connect direct or session database URL on port 5432 for astha_backend without URL options');
  }
  const ssl = { rejectUnauthorized: true };
  if (env.SUPABASE_DB_CA_FILE) ssl.ca = readFileSync(env.SUPABASE_DB_CA_FILE, 'utf8');
  return { connectionString: url.href, ssl, max: 5, connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 10000, statement_timeout: 10000, query_timeout: 12000,
    application_name: 'astha', keepAlive: true, onConnect: initializePostgresClient };
}

// These are application-owned, static SQL strings. Values remain bound parameters.
// Reject SQL quoting/comments/operators this small adapter does not need instead of
// pretending a regex is a general SQL parser. Fully qualify tables for pooled connections.
export function postgresQuery(sql, params = []) {
  if (typeof sql !== 'string' || !Array.isArray(params) || /['"`;]|--|\/\*|\$/.test(sql) ||
      !/^\s*(SELECT|INSERT|UPDATE|DELETE)\b/i.test(sql)) throw new Error('Unsupported storage query');
  let bindings = 0;
  let tables = 0;
  const text = sql.replace(/\b(FROM|INTO|UPDATE|JOIN)\s+([a-z_][a-z_0-9]*)\b/gi, (match, keyword, table, offset) => {
    // The UPDATE in a static INSERT ... ON CONFLICT ... DO UPDATE SET has no table.
    // Continue validating real table references; values are still bound below.
    if (/^UPDATE$/i.test(keyword) && /^SET$/i.test(table) &&
        /^\s*INSERT\b/i.test(sql) && /\bON\s+CONFLICT\s*\([a-z_][a-z_0-9]*\)\s+DO\s*$/i.test(sql.slice(0, offset))) return match;
    if (!TABLES.includes(table)) throw new Error('Unsupported storage table');
    tables++;
    return `${keyword} astha.${table}`;
  }).replace(/\?/g, () => '$' + (++bindings));
  if (!tables || bindings !== params.length) throw new Error('Storage parameter mismatch');
  return { text, values: params };
}

function normalizeRow(row) {
  const result = { ...row };
  for (const key of ['created_at', 'updated_at']) {
    if (result[key] === undefined || result[key] === null) continue;
    const value = Number(result[key]);
    if (!Number.isSafeInteger(value)) throw new Error('Invalid stored timestamp');
    result[key] = value;
  }
  return result;
}

export function createPostgresStorage(pool) {
  const query = (sql, params) => {
    const compiled = postgresQuery(sql, params);
    return pool.query(compiled.text, compiled.values);
  };
  return {
    run: async (sql, params = []) => ({ changes: (await query(sql, params)).rowCount }),
    get: async (sql, params = []) => {
      const row = (await query(sql, params)).rows[0];
      return row ? normalizeRow(row) : undefined;
    },
    all: async (sql, params = []) => (await query(sql, params)).rows.map(normalizeRow),
    ready: async () => { await pool.query('SELECT 1'); },
    saveRoom: async ({ userId, name, notes }) => {
      const result = await pool.query(`INSERT INTO astha.rooms (id, user_id, name, notes, updated_at)
        VALUES ($1,$2,$3,$4,$5) ON CONFLICT (user_id, lower(name))
        DO UPDATE SET notes = EXCLUDED.notes, updated_at = EXCLUDED.updated_at RETURNING id`,
      [nanoid(), userId, name, notes, Date.now()]);
      return result.rows[0].id;
    },
    close: () => pool.end(),
  };
}

export async function verifyPostgresStorage(pool) {
  const roles = await pool.query(`SELECT r.rolname, r.rolcanlogin, r.rolsuper, r.rolcreatedb, r.rolcreaterole, r.rolreplication, r.rolbypassrls,
    EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.member = r.oid) AS has_memberships
    FROM pg_roles r WHERE r.rolname = current_user`);
  const role = roles.rows[0];
  if (!role || role.rolname !== 'astha_backend' || !role.rolcanlogin || role.rolsuper || role.rolcreatedb ||
      role.rolcreaterole || role.rolreplication || role.rolbypassrls || role.has_memberships) {
    throw new Error('Supabase storage requires the limited astha_backend role');
  }
  const schema = await pool.query(`SELECT obj_description(n.oid, 'pg_namespace') AS version,
    n.nspowner = (SELECT oid FROM pg_roles WHERE rolname = current_user) AS owned
    FROM pg_namespace n WHERE n.nspname = 'astha'`);
  if (schema.rows[0]?.version !== 'astha-schema-v1' || schema.rows[0].owned) throw new Error('Supabase schema must be reviewed and migrated before startup');
  const columns = await pool.query(`SELECT table_name, column_name, data_type FROM information_schema.columns WHERE table_schema = 'astha' ORDER BY ordinal_position`);
  for (const table of TABLES) {
    const found = columns.rows.filter(row => row.table_name === table).map(row => `${row.column_name}:${row.data_type}`);
    if (JSON.stringify(found) !== JSON.stringify(COLUMNS[table])) throw new Error('Supabase schema columns are incompatible');
  }
  const protections = await pool.query(`SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity,
    c.relowner = (SELECT oid FROM pg_roles WHERE rolname = current_user) AS owned
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'astha' AND c.relkind = 'r'`);
  for (const table of TABLES) {
    const row = protections.rows.find(row => row.relname === table);
    if (!row?.relrowsecurity || !row.relforcerowsecurity || row.owned) throw new Error('Supabase storage table protections are incompatible');
    // Zero rows returned: verify access without reading personal records or mutating the DB.
    await pool.query(`SELECT * FROM astha.${table} LIMIT 0`);
  }
  const index = await pool.query(`SELECT pg_get_indexdef(i.indexrelid) AS indexdef, i.indisvalid, i.indisready
    FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'astha' AND c.relname = 'idx_rooms_user_name'`);
  if (!index.rows[0]?.indisvalid || !index.rows[0]?.indisready ||
      !/^CREATE UNIQUE INDEX idx_rooms_user_name ON astha\.rooms USING btree \(user_id, lower\(name\)\)$/.test(index.rows[0]?.indexdef || '')) {
    throw new Error('Supabase room uniqueness index is incompatible');
  }
}

export async function connectPostgres(env = process.env) {
  const config = postgresConfig(env);
  const { Pool } = await import('pg');
  const pool = new Pool(config);
  // Pool background errors may contain credentials, queries or private data.
  pool.on('error', () => console.error('storage_pool_error'));
  try {
    await verifyPostgresStorage(pool);
    return createPostgresStorage(pool);
  } catch {
    try { await pool.end(); } catch { /* Never expose cleanup errors containing private connection data. */ }
    throw new Error('Supabase storage startup failed; verify connection, TLS, role and schema');
  }
}
