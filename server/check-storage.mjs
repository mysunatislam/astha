// Read-only connection/role/schema verification. Never prints URLs or credentials.
import './env.js';
try {
  const { db, storageProvider, storageReady } = await import('./db.js');
  try { await storageReady(); console.log(JSON.stringify({ provider: storageProvider, ready: true })); }
  finally { await db.close(); }
} catch {
  console.error('Storage verification failed; check server configuration, TLS, role and reviewed schema');
  process.exitCode = 1;
}
