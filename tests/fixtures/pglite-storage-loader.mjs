// Test-only full PostgreSQL API fixture. No Supabase network or deployment credentials.
const storageUrl = new URL('../../server/db.js', import.meta.url).href;
export async function load(url, context, nextLoad) {
  if (url !== storageUrl || process.env.ASTHA_TEST_PGLITE !== '1') return nextLoad(url, context);
  if (process.env.SUPABASE_DB_URL) throw new Error('Local PostgreSQL fixture must not have connection credentials');
  return { format: 'module', shortCircuit: true, source: `
    import { PGlite } from '@electric-sql/pglite';
    import { readFileSync } from 'node:fs';
    import { createPostgresStorage, verifyPostgresStorage } from './postgres.js';
    const engine = await PGlite.create();
    await engine.exec('CREATE ROLE astha_backend LOGIN');
    await engine.exec(readFileSync(new URL('./migrations/001_supabase.sql', import.meta.url), 'utf8'));
    await engine.exec('SET ROLE astha_backend');
    const pool = {
      query: async (text, params = []) => {
        const result = await engine.query(text, params);
        return { rows: result.rows, rowCount: result.affectedRows };
      },
      end: () => engine.close(),
    };
    await verifyPostgresStorage(pool);
    const storage = createPostgresStorage(pool);
    export const storageProvider = 'supabase';
    export const db = { close: storage.close };
    export const run = storage.run, get = storage.get, all = storage.all;
    export const saveRoom = storage.saveRoom, storageReady = storage.ready;
  ` };
}
