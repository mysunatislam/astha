// Process-local operational counters and failure logs. Request content never enters telemetry.
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

const STATE = Symbol('astha-request-observability');
const ROUTES = Object.freeze([
  '/api/health', '/api/auth/signup', '/api/auth/login', '/api/auth/guest',
  '/api/auth/logout', '/api/auth/me', '/api/memories', '/api/memories/:id',
  '/api/rooms', '/api/rooms/:id', '/api/log', '/api/settings', '/api/rag/query',
  '/api/rag/docs', '/api/rag/docs/:id', '/api/agent/plan', '/api/agent/evaluate', '/api/agent/run',
  '/api/account/export', '/api/account/delete', '/api/vision', '/api/speak', 'other',
]);
const STATUSES = Object.freeze(['1xx', '2xx', '3xx', '4xx', '5xx', 'aborted']);
const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
const TIMEOUT_CODES = new Set(['ETIMEDOUT', 'ESOCKETTIMEDOUT', 'QUERY_TIMEOUT', '57014']);
const LATENCY_BOUNDS = Object.freeze([10, 50, 100, 250, 500, 1000, 5000, 30000, null]);
const MAX_VALUE = Number.MAX_SAFE_INTEGER;
const MAX_DURATION_MS = 24 * 60 * 60 * 1000;
const FAILURE_LOG_LIMIT = 30;

function routeIndex(req) {
  // Match a fixed allowlist, never req.route or an arbitrary path supplied to a logger.
  // The bound also prevents retaining a very long pathname in a request closure.
  const url = typeof req.originalUrl === 'string' ? req.originalUrl : '';
  const queryAt = url.indexOf('?');
  const pathLength = queryAt < 0 ? url.length : queryAt;
  if (pathLength > 1024) return ROUTES.length - 1;
  const pathname = url.slice(0, pathLength).replace(/\/$/, '');
  const exact = ROUTES.indexOf(pathname);
  if (exact >= 0 && exact < ROUTES.length - 1) return exact;
  if (/^\/api\/memories\/[^/]+$/.test(pathname)) return ROUTES.indexOf('/api/memories/:id');
  if (/^\/api\/rooms\/[^/]+$/.test(pathname)) return ROUTES.indexOf('/api/rooms/:id');
  if (/^\/api\/rag\/docs\/[^/]+$/.test(pathname)) return ROUTES.indexOf('/api/rag/docs/:id');
  return ROUTES.length - 1;
}

function add(value, increment = 1) { return Math.min(MAX_VALUE, value + increment); }

// Inject a local JSON-line sink, for example line => console.error(line). Null
// disables failure logging; enabled=false also disables counters. No network sink
// or public metrics endpoint is created. Counters reset when the process restarts.
export function createRequestObservability({ logger = null, enabled = true } = {}) {
  if (logger !== null && typeof logger !== 'function') throw new TypeError('Observability logger must be a function or null');
  const cells = ROUTES.flatMap(route => STATUSES.map(status => ({
    route, status, count: 0, durationMs: 0, maxDurationMs: 0,
    latencyCounts: LATENCY_BOUNDS.map(() => 0),
  })));
  let inFlight = 0;
  let logWindowStarted = performance.now();
  let logWindowCount = 0;
  let droppedLogs = 0;

  function middleware(req, res, next) {
    // Never trust an incoming X-Request-ID, even when the deployment uses a proxy.
    const requestId = randomUUID();
    req.requestId = requestId;
    res.setHeader('X-Request-ID', requestId);
    if (!enabled) return next();

    const route = routeIndex(req);
    const method = METHODS.has(req.method) ? req.method : 'OTHER';
    const started = performance.now();
    const state = { category: 'internal_error' };
    req[STATE] = state;
    inFlight = add(inFlight);
    let recorded = false;

    function record(aborted) {
      if (recorded) return;
      recorded = true;
      res.removeListener('finish', onFinish);
      res.removeListener('close', onClose);
      delete req[STATE];
      inFlight = Math.max(0, inFlight - 1);
      const now = performance.now();
      const durationMs = Math.round(Math.min(MAX_DURATION_MS, Math.max(0, now - started)));
      const status = Number.isInteger(res.statusCode) && res.statusCode >= 100 && res.statusCode <= 599 ? res.statusCode : 500;
      const statusIndex = aborted ? STATUSES.length - 1 : Math.floor(status / 100) - 1;
      const cell = cells[route * STATUSES.length + statusIndex];
      cell.count = add(cell.count);
      cell.durationMs = add(cell.durationMs, durationMs);
      cell.maxDurationMs = Math.max(cell.maxDurationMs, durationMs);
      const bucket = LATENCY_BOUNDS.findIndex(bound => bound === null || durationMs <= bound);
      cell.latencyCounts[bucket] = add(cell.latencyCounts[bucket]);
      if (logger && (aborted || status >= 500)) {
        // Bound log volume during an outage without losing aggregate request counts.
        if (now - logWindowStarted >= 60000) { logWindowStarted = now; logWindowCount = 0; }
        if (logWindowCount >= FAILURE_LOG_LIMIT) { droppedLogs = add(droppedLogs); return; }
        logWindowCount++;
        const entry = {
          event: aborted ? 'request_aborted' : 'request_failed', requestId,
          method, route: ROUTES[route], status: aborted ? null : status,
          durationMs, category: aborted && state.category !== 'timeout' ? 'request_aborted' : state.category,
        };
        // A failed log sink cannot change the response or emit unsanitized errors.
        try { logger(JSON.stringify(entry)); } catch { /* Keep request handling available. */ }
      }
    }
    const onFinish = () => record(false);
    const onClose = () => record(!res.writableFinished);
    res.once('finish', onFinish);
    res.once('close', onClose);
    next();
  }

  function markError(req, error) {
    const state = req[STATE];
    if (state && TIMEOUT_CODES.has(error?.code)) state.category = 'timeout';
  }

  function errorMiddleware(err, req, res, _next) {
    markError(req, err);
    // Forwarding a late error invokes Express's raw stack logger. Close without
    // the error object; our close listener emits only the sanitized failure record.
    if (res.headersSent) { res.destroy(); return; }
    const status = err.type === 'entity.too.large' ? 413 :
      err.type === 'entity.parse.failed' ? 400 : 500;
    res.status(status).json({ error: status === 413 ? 'payload_too_large' :
      status === 400 ? 'invalid_json' : 'internal_error' });
  }

  function snapshot() {
    return {
      inFlight, capacity: cells.length, droppedLogs, failureLogLimitPerMinute: FAILURE_LOG_LIMIT,
      latencyUpperBoundsMs: [...LATENCY_BOUNDS],
      // Sparse output is bounded by the preallocated cells; callers receive copies.
      counters: cells.filter(cell => cell.count > 0).map(cell => ({ ...cell, latencyCounts: [...cell.latencyCounts] })),
    };
  }

  return { middleware, errorMiddleware, markError, snapshot };
}
