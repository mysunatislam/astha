-- Reviewed, explicit one-time migration. Never run this from application startup.
-- Provision the limited astha_backend LOGIN role separately, without embedding its password.
-- Run as a distinct migration owner against the selected database, with ON_ERROR_STOP enabled.
BEGIN;

DO $preflight$
DECLARE
  backend_role RECORD;
BEGIN
  IF pg_catalog.to_regnamespace('astha') IS NOT NULL THEN
    RAISE EXCEPTION 'Refusing to reuse an existing astha schema. Review its version and data before migration.';
  END IF;
  SELECT * INTO backend_role FROM pg_catalog.pg_roles WHERE rolname = 'astha_backend';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Provision the limited astha_backend LOGIN role separately before applying this migration.';
  END IF;
  IF CURRENT_USER = 'astha_backend' THEN
    RAISE EXCEPTION 'Run this migration as a distinct schema owner, not the application role.';
  END IF;
  IF NOT backend_role.rolcanlogin OR backend_role.rolsuper OR backend_role.rolcreatedb
     OR backend_role.rolcreaterole OR backend_role.rolreplication OR backend_role.rolbypassrls THEN
    RAISE EXCEPTION 'astha_backend must be a LOGIN role without administrative or BYPASSRLS privileges.';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members WHERE member = backend_role.oid) THEN
    RAISE EXCEPTION 'astha_backend must not inherit other database roles.';
  END IF;
END;
$preflight$;

CREATE SCHEMA astha;
COMMENT ON SCHEMA astha IS 'astha-schema-v1';

-- Preserve ASTHA's existing IDs, PIN hashes, JSON strings and millisecond API values.
-- This users table is independent from Supabase Auth's auth.users table.
CREATE TABLE astha.users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT UNIQUE,
  passcode_hash TEXT NOT NULL,
  passcode_salt TEXT NOT NULL,
  voice_lang TEXT NOT NULL DEFAULT 'bn',
  mode TEXT NOT NULL DEFAULT 'auto',
  face_descriptor TEXT,
  created_at BIGINT NOT NULL
);
CREATE TABLE astha.memories (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES astha.users(id) ON DELETE CASCADE,
  item TEXT NOT NULL,
  location TEXT NOT NULL,
  source TEXT NOT NULL,
  score DOUBLE PRECISION,
  created_at BIGINT NOT NULL
);
CREATE INDEX idx_memories_user ON astha.memories(user_id, created_at DESC);
CREATE TABLE astha.rooms (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES astha.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  notes TEXT NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE INDEX idx_rooms_user ON astha.rooms(user_id, updated_at DESC);
CREATE UNIQUE INDEX idx_rooms_user_name ON astha.rooms(user_id, lower(name));
CREATE TABLE astha.events (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES astha.users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE INDEX idx_events_user ON astha.events(user_id, created_at DESC);
CREATE TABLE astha.agent_tasks (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES astha.users(id) ON DELETE CASCADE,
  goal TEXT NOT NULL,
  plan_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  step_history_json TEXT,
  result_json TEXT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE INDEX idx_agent_tasks_user ON astha.agent_tasks(user_id, updated_at DESC);
CREATE TABLE astha.knowledge_docs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES astha.users(id) ON DELETE CASCADE,
  category TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  tags_json TEXT,
  embedding_json TEXT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE INDEX idx_knowledge_user ON astha.knowledge_docs(user_id, category);

REVOKE ALL ON SCHEMA astha FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA astha FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA astha REVOKE ALL ON TABLES FROM PUBLIC;

-- These Supabase Data API roles may be absent on generic Postgres test databases.
DO $deny_data_api$
DECLARE
  api_role TEXT;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON SCHEMA astha FROM %I', api_role);
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA astha FROM %I', api_role);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA astha REVOKE ALL ON TABLES FROM %I', api_role);
    END IF;
  END LOOP;
END;
$deny_data_api$;

REVOKE ALL ON SCHEMA astha FROM astha_backend;
GRANT USAGE ON SCHEMA astha TO astha_backend;
GRANT SELECT, INSERT, UPDATE, DELETE ON
  astha.users, astha.memories, astha.rooms, astha.events, astha.agent_tasks, astha.knowledge_docs
TO astha_backend;

-- Only the trusted Express backend is admitted. ASTHA's existing JWT middleware and
-- parameterized user_id filters enforce account ownership; these are not auth.uid() policies.
DO $backend_rls$
DECLARE
  app_table TEXT;
BEGIN
  FOREACH app_table IN ARRAY ARRAY['users', 'memories', 'rooms', 'events', 'agent_tasks', 'knowledge_docs'] LOOP
    EXECUTE format('ALTER TABLE astha.%I ENABLE ROW LEVEL SECURITY', app_table);
    EXECUTE format('ALTER TABLE astha.%I FORCE ROW LEVEL SECURITY', app_table);
    EXECUTE format(
      'CREATE POLICY astha_backend_api ON astha.%I FOR ALL TO astha_backend USING (true) WITH CHECK (true)',
      app_table
    );
  END LOOP;
END;
$backend_rls$;

COMMIT;
