import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { createRequestObservability } from '../server/observability.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const require = createRequire(new URL('../server/index.js', import.meta.url));
const express = require('express');

function request(monitor, { path = '/api/health', method = 'GET', status = 200, decorate = () => {} } = {}) {
  const req = { originalUrl: path, method, requestId: 'caller-supplied-private-id' };
  decorate(req);
  const res = new EventEmitter();
  const headers = new Map();
  res.statusCode = status;
  res.writableFinished = false;
  res.setHeader = (name, value) => headers.set(name, value);
  let nextCalls = 0;
  monitor.middleware(req, res, () => nextCalls++);
  assert.equal(nextCalls, 1);
  return { req, res, headers, finish() { res.writableFinished = true; res.emit('finish'); res.emit('close'); } };
}

test('generated request IDs ignore caller IDs and correlate sanitized server failures', () => {
  const lines = [];
  const monitor = createRequestObservability({ logger: line => lines.push(line) });
  const first = request(monitor, { path: '/api/vision', method: 'POST', status: 502 });
  assert.match(first.req.requestId, UUID);
  assert.equal(first.headers.get('X-Request-ID'), first.req.requestId);
  assert.notEqual(first.req.requestId, 'caller-supplied-private-id');
  monitor.markError(first.req, { code: 'unexpected-sensitive-provider-code', message: 'private provider error' });
  first.finish();
  const log = JSON.parse(lines[0]);
  assert.deepEqual(Object.keys(log), ['event', 'requestId', 'method', 'route', 'status', 'durationMs', 'category']);
  assert.equal(log.requestId, first.req.requestId);
  assert.equal(log.route, '/api/vision');
  assert.equal(log.category, 'internal_error');
  assert.equal(log.status, 502);
  assert.equal(log.event, 'request_failed');
  assert.ok(Number.isInteger(log.durationMs) && log.durationMs >= 0);
  const second = request(monitor);
  second.finish();
  assert.notEqual(second.req.requestId, first.req.requestId);
  assert.equal(lines.length, 1);
});

test('private paths, queries, bearer tokens, bodies and error messages never enter logs or counters', () => {
  const lines = [];
  const monitor = createRequestObservability({ logger: line => lines.push(line) });
  const marker = 'SENSITIVE_PHONE_TOKEN_BODY_ERROR_01700000000';
  for (const path of [`/api/memories/${marker}?q=${marker}`, `/private/${marker}?token=${marker}`]) {
    const fixture = request(monitor, { path, status: 500, decorate: req => Object.assign(req, {
      headers: { Authorization: `Bearer ${marker}`, 'X-Request-ID': marker },
      query: { q: marker }, body: { text: marker }, user: { id: marker, phone: marker }, params: { id: marker },
    }) });
    const error = { code: marker };
    Object.defineProperty(error, 'message', { get() { throw new Error('error.message must never be inspected'); } });
    monitor.markError(fixture.req, error);
    fixture.finish();
  }
  const serialized = JSON.stringify({ logs: lines, counters: monitor.snapshot() });
  assert.equal(serialized.includes(marker), false);
  assert.deepEqual(lines.map(line => JSON.parse(line).route), ['/api/memories/:id', 'other']);
  const inaccessible = request(monitor, { status: 500, decorate: req => {
    for (const key of ['headers', 'query', 'body', 'user', 'params']) {
      Object.defineProperty(req, key, { get() { throw new Error(`${key} must never be inspected`); } });
    }
  } });
  inaccessible.finish();
});

test('varied IDs, unknown routes and arbitrary methods have fixed counter cardinality', () => {
  const monitor = createRequestObservability();
  for (let i = 0; i < 1000; i++) {
    request(monitor, { path: `/api/rooms/private-${i}?notes=${i}` }).finish();
    request(monitor, { path: `/api/unknown/private-${i}`, method: `PRIVATE_METHOD_${i}`, status: 404 }).finish();
  }
  const snapshot = monitor.snapshot();
  assert.equal(snapshot.capacity, 138);
  assert.equal(snapshot.counters.length, 2);
  assert.equal(snapshot.inFlight, 0);
  assert.deepEqual(snapshot.counters.map(({ route, status, count }) => ({ route, status, count })), [
    { route: '/api/rooms/:id', status: '2xx', count: 1000 },
    { route: 'other', status: '4xx', count: 1000 },
  ]);
  for (const cell of snapshot.counters) assert.equal(cell.latencyCounts.reduce((sum, count) => sum + count, 0), cell.count);
  snapshot.counters[0].count = 0;
  snapshot.counters[0].latencyCounts.fill(0);
  assert.equal(monitor.snapshot().counters[0].count, 1000);
  assert.equal(monitor.snapshot().counters[0].latencyCounts.reduce((sum, count) => sum + count, 0), 1000);
});

test('finish and close count once while disconnects are separate from completed HTTP success', () => {
  const lines = [];
  const monitor = createRequestObservability({ logger: line => lines.push(line) });
  const completed = request(monitor);
  const aborted = request(monitor, { path: '/api/speak', method: 'POST' });
  assert.equal(monitor.snapshot().inFlight, 2);
  completed.finish();
  completed.res.emit('close');
  aborted.res.emit('close');
  aborted.res.emit('finish');
  assert.equal(completed.res.listenerCount('finish'), 0);
  assert.equal(completed.res.listenerCount('close'), 0);
  assert.equal(aborted.res.listenerCount('finish'), 0);
  assert.equal(aborted.res.listenerCount('close'), 0);
  assert.equal(monitor.snapshot().inFlight, 0);
  assert.equal(monitor.snapshot().counters.reduce((sum, cell) => sum + cell.count, 0), 2);
  assert.equal(lines.length, 1);
  const log = JSON.parse(lines[0]);
  assert.equal(log.event, 'request_aborted');
  assert.equal(log.status, null);
  assert.equal(log.category, 'request_aborted');
  assert.equal(log.requestId, aborted.req.requestId);
});

test('timeout markers use a fixed category and log failures without retaining error details', () => {
  const lines = [];
  const monitor = createRequestObservability({ logger: line => lines.push(line) });
  for (const code of ['ETIMEDOUT', 'ESOCKETTIMEDOUT', 'QUERY_TIMEOUT', '57014']) {
    const fixture = request(monitor, { path: '/api/rag/query', method: 'POST', status: 500 });
    monitor.markError(fixture.req, { code, message: 'sensitive query or connection string' });
    fixture.finish();
  }
  assert.equal(lines.length, 4);
  assert.equal(lines.every(line => JSON.parse(line).category === 'timeout'), true);
  assert.equal(lines.join('').includes('sensitive'), false);
});

test('a disabled or failing logger preserves request IDs, completion and counters', () => {
  const noLogger = createRequestObservability();
  request(noLogger, { status: 503 }).finish();
  assert.equal(noLogger.snapshot().counters[0].count, 1);
  const failingLogger = createRequestObservability({ logger: () => { throw new Error('private sink details'); } });
  const fixture = request(failingLogger, { status: 500 });
  assert.doesNotThrow(() => fixture.finish());
  assert.equal(failingLogger.snapshot().counters[0].count, 1);
  const disabled = createRequestObservability({ enabled: false, logger: () => assert.fail('disabled logging') });
  const disabledRequest = request(disabled, { status: 500 });
  assert.match(disabledRequest.headers.get('X-Request-ID'), UUID);
  disabledRequest.finish();
  assert.deepEqual(disabled.snapshot().counters, []);
  assert.equal(disabled.snapshot().inFlight, 0);
});

test('long or malformed paths and invalid statuses remain in bounded buckets', () => {
  const lines = [];
  const monitor = createRequestObservability({ logger: line => lines.push(line) });
  for (const path of ['/api/rooms/' + 'x'.repeat(2000), '/api/rooms/private/extra', null]) {
    request(monitor, { path, status: 999 }).finish();
  }
  assert.equal(monitor.snapshot().counters.length, 1);
  assert.equal(monitor.snapshot().counters[0].route, 'other');
  assert.equal(monitor.snapshot().counters[0].status, '5xx');
  assert.equal(monitor.snapshot().counters[0].count, 3);
  assert.equal(lines.every(line => JSON.parse(line).method === 'GET' && JSON.parse(line).status === 500), true);
});

test('outage log volume is capped while counters still include every failed request', () => {
  const lines = [];
  const monitor = createRequestObservability({ logger: line => lines.push(line) });
  for (let i = 0; i < 1000; i++) request(monitor, { status: 503 }).finish();
  const snapshot = monitor.snapshot();
  assert.equal(lines.length, snapshot.failureLogLimitPerMinute);
  assert.equal(snapshot.failureLogLimitPerMinute, 30);
  assert.equal(snapshot.droppedLogs, 970);
  assert.equal(snapshot.counters[0].count, 1000);
  assert.equal(snapshot.inFlight, 0);
});

test('real HTTP errors keep request content private and late failures bypass raw Express logging', async t => {
  const marker = 'private-phone-token-prompt-fixture';
  const lines = [];
  const monitor = createRequestObservability({ logger: line => lines.push(line) });
  const app = express();
  const lateClosed = Promise.withResolvers();
  app.use(monitor.middleware);
  app.use(express.json({ limit: '1kb' }));
  app.get('/api/memories/:id', (_req, _res, next) => next(new Error(marker)));
  app.get('/late', (_req, res, next) => {
    res.once('close', () => lateClosed.resolve());
    res.write('synthetic partial response');
    setTimeout(() => next(new Error(marker)), 20);
  });
  app.use(monitor.errorMiddleware);
  let rawHandlerCalls = 0;
  app.use((_err, _req, res, _next) => { rawHandlerCalls++; res.destroy(); });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = 'http://127.0.0.1:' + server.address().port;
  const failed = await fetch(base + '/api/memories/' + marker + '?token=' + marker, {
    headers: { Authorization: 'Bearer ' + marker, 'X-Request-ID': marker },
    signal: AbortSignal.timeout(3000),
  });
  assert.equal(failed.status, 500);
  assert.deepEqual(await failed.json(), { error: 'internal_error' });
  assert.match(failed.headers.get('x-request-id'), UUID);
  assert.equal(JSON.parse(lines[0]).requestId, failed.headers.get('x-request-id'));
  const malformed = await fetch(base + '/api/vision', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' + marker,
    signal: AbortSignal.timeout(3000),
  });
  assert.equal(malformed.status, 400);
  assert.deepEqual(await malformed.json(), { error: 'invalid_json' });
  const oversized = await fetch(base + '/api/vision', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: marker.repeat(100) }), signal: AbortSignal.timeout(3000),
  });
  assert.equal(oversized.status, 413);
  assert.deepEqual(await oversized.json(), { error: 'payload_too_large' });
  await assert.rejects(async () => {
    const response = await fetch(base + '/late', { signal: AbortSignal.timeout(3000) });
    await response.text();
  });
  await lateClosed.promise;
  assert.equal(rawHandlerCalls, 0);
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[1]).event, 'request_aborted');
  assert.equal(JSON.stringify({ lines, snapshot: monitor.snapshot() }).includes(marker), false);
});
