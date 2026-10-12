// Test-only adapter shim: real SQLite operations settle asynchronously so route tests
// detect missing awaits without changing the production adapter or reaching Supabase.
const storageUrl = new URL('../../server/db.js', import.meta.url).href;

export async function load(url, context, nextLoad) {
  if (url !== storageUrl || process.env.ASTHA_TEST_ASYNC_SQLITE !== '1') return nextLoad(url, context);
  if (process.env.DB_PROVIDER !== 'sqlite') throw new Error('Async SQLite fixture requires disposable SQLite storage');
  const originalUrl = storageUrl + '?astha_async_sqlite_original=1';
  return {
    format: 'module', shortCircuit: true,
    source: `
      import * as original from ${JSON.stringify(originalUrl)};
      export * from ${JSON.stringify(originalUrl)};
      const settle = () => new Promise(resolve => setImmediate(resolve));
      const roomReads = new Map();
      function readConcurrentRoom(sql, params) {
        const key = params[0];
        let batch = roomReads.get(key);
        if (!batch) {
          batch = { reads: [], timer: null };
          roomReads.set(key, batch);
          const release = () => {
            roomReads.delete(key); clearTimeout(batch.timer);
            // Observe all values before releasing callers: read-then-write handlers
            // see the same absent room and cannot accidentally pass due to HTTP timing.
            const observed = batch.reads.map(read => {
              try { return { value: original.get(read.sql, read.params) }; }
              catch (error) { return { error }; }
            });
            batch.reads.forEach((read, index) => observed[index].error ? read.reject(observed[index].error) : read.resolve(observed[index].value));
          };
          batch.release = release;
          batch.timer = setTimeout(release, 250);
        }
        return new Promise((resolve, reject) => {
          batch.reads.push({ sql, params, resolve, reject });
          if (batch.reads.length === 6) batch.release();
        });
      }
      export async function run(...args) { await settle(); return original.run(...args); }
      export async function get(sql, params = []) {
        if (sql.includes('FROM rooms') && sql.includes('lower(name)') && String(params[1]).toLowerCase() === 'concurrent room') {
          return readConcurrentRoom(sql, params);
        }
        await settle(); return original.get(sql, params);
      }
      export async function all(...args) { await settle(); return original.all(...args); }
      export async function saveRoom(...args) { await settle(); return original.saveRoom(...args); }
    `,
  };
}
