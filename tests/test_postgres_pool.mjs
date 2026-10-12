import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { setImmediate } from 'node:timers/promises';
import { postgresConfig } from '../server/postgres.js';

const require = createRequire(new URL('../server/postgres.js', import.meta.url));
const { Pool } = require('pg');
const fixtureUrl = 'postgresql://astha_backend:fixture-password@db.fixture.supabase.co:5432/postgres';

// Exercise the installed pool's actual checkout and destruction behavior. These
// clients replace only network transport and never open a socket or load .env.
function fixturePool({ initialize = async () => {}, reportedTimeout = '10s' } = {}) {
  const clients = [];
  class FixtureClient extends EventEmitter {
    constructor() {
      super(); this.queries = []; this.ended = false; this._queryable = true; this._ending = false;
      clients.push(this);
    }
    connect(callback) { queueMicrotask(() => callback(null)); }
    async query(text) {
      this.queries.push(text);
      if (text === "SET statement_timeout = '10s'") await initialize(this);
      return { rows: [{ statement_timeout: reportedTimeout }] };
    }
    end(callback) {
      this.ended = true; this._ending = true;
      queueMicrotask(() => { this.emit('end'); callback?.(); });
    }
  }
  return { pool: new Pool({ ...postgresConfig({ SUPABASE_DB_URL: fixtureUrl }), Client: FixtureClient, max: 1 }), clients };
}

test('real pg pool waits for session timeout initialization before checkout', async t => {
  const started = Promise.withResolvers(), gate = Promise.withResolvers();
  const { pool, clients } = fixturePool({ initialize: async () => { started.resolve(); await gate.promise; } });
  let settled = false;
  const checkout = pool.connect().then(client => { settled = true; return client; });
  t.after(async () => { gate.resolve(); const client = await checkout; client.release(); await pool.end(); });
  await started.promise;
  await setImmediate();
  assert.equal(settled, false);
  assert.deepEqual(clients[0].queries, ["SET statement_timeout = '10s'"]);
  gate.resolve();
  const client = await checkout;
  assert.equal(client, clients[0]);
  assert.deepEqual(client.queries, ["SET statement_timeout = '10s'", 'SHOW statement_timeout']);
});

test('real pg pool destroys failed initializations and initializes their replacements', async t => {
  let initializations = 0;
  const { pool, clients } = fixturePool({ initialize: async () => {
    if (++initializations === 1) throw new Error('private connection fixture detail');
  } });
  t.after(() => pool.end());
  await assert.rejects(pool.connect(), error => {
    assert.equal(error.message, 'Supabase statement timeout initialization failed');
    assert.equal(error.cause, undefined);
    return true;
  });
  assert.equal(clients[0].ended, true);
  assert.equal(pool.totalCount, 0);
  const client = await pool.connect();
  try {
    assert.equal(initializations, 2);
    assert.equal(client, clients[1]);
    assert.deepEqual(client.queries, ["SET statement_timeout = '10s'", 'SHOW statement_timeout']);
  } finally { client.release(); }
});

test('real pg pool refuses a backend that does not apply the required timeout', async t => {
  const { pool, clients } = fixturePool({ reportedTimeout: '2min' });
  t.after(() => pool.end());
  await assert.rejects(pool.connect(), { message: 'Supabase statement timeout initialization failed' });
  assert.equal(clients[0].ended, true);
  assert.equal(pool.totalCount, 0);
});
