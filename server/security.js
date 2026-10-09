import { randomBytes } from 'node:crypto';

const LEGACY_SECRET = 'astha-default-secure-companion-secret-key-2026';
export const LEGACY_GUEST_PHONE = '01000000000';

// Development sessions deliberately expire on process restart unless a strong secret is set.
export function getJwtSecret(env = process.env) {
  const secret = env.JWT_SECRET;
  const valid = typeof secret === 'string' && Buffer.byteLength(secret, 'utf8') >= 32 &&
    secret !== LEGACY_SECRET && !/^replace[-_ ]with|^your[-_ ]|^change[-_ ]me/i.test(secret);
  if (valid) return secret;
  if (env.NODE_ENV === 'production') {
    throw new Error('Production JWT_SECRET must be a unique random secret of at least 32 bytes.');
  }
  return randomBytes(32).toString('hex');
}

export function normalizeDigits(value) {
  return value.replace(/[০-৯]/g, digit => String(digit.charCodeAt(0) - '০'.charCodeAt(0)));
}

export function normalizePasscode(value) {
  if (typeof value !== 'string' || value.length > 32) return null;
  const normalized = normalizeDigits(value).replace(/\s/g, '');
  return /^[0-9]{4,8}$/.test(normalized) ? normalized : null;
}

export function normalizePhone(value) {
  if (typeof value !== 'string' || value.length > 40) return null;
  const normalized = normalizeDigits(value).replace(/[\s()-]/g, '');
  return /^\+?[0-9]{7,15}$/.test(normalized) ? normalized : null;
}

export function validateAuthBody(body, signup = false) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  if (typeof body.phone !== 'string' || !body.phone.trim() || body.phone.length > 40 ||
      typeof body.passcode !== 'string') return null;
  const normalizedPhone = normalizePhone(body.phone);
  if (body.phone.trim() === LEGACY_GUEST_PHONE || normalizedPhone === LEGACY_GUEST_PHONE) return null;
  // Existing signup allowed nonnumeric PINs. Bound legacy login inputs without locking out those users.
  if (!signup) {
    if (body.passcode.length < 4 || body.passcode.length > 128) return null;
    return { phone: normalizedPhone || body.phone.trim(), passcode: normalizePasscode(body.passcode) || body.passcode };
  }
  const phone = normalizedPhone;
  const passcode = normalizePasscode(body.passcode);
  if (!phone || !passcode) return null;
  if (typeof body.name !== 'string' || !body.name.trim() || body.name.length > 80) return null;
  return { phone, passcode, name: body.name.trim() };
}

// Exact http(s) and Capacitor origins only; URLs with credentials/path/query are not origins.
export function normalizeOrigin(value) {
  if (typeof value !== 'string' || value === 'null' || value === '*') return null;
  try {
    const url = new URL(value);
    if (!['http:', 'https:', 'capacitor:', 'ionic:'].includes(url.protocol) ||
        !url.host || url.username || url.password || url.search || url.hash ||
        (url.pathname && url.pathname !== '/')) return null;
    return url.protocol + '//' + url.host;
  } catch {
    return null;
  }
}

export function getAllowedOrigins(env = process.env) {
  const entries = (env.CORS_ORIGIN || '').split(',').map(origin => origin.trim()).filter(Boolean);
  return entries.map(origin => {
    const normalized = normalizeOrigin(origin);
    if (!normalized) throw new Error('CORS_ORIGIN must contain exact trusted origins, separated by commas.');
    return normalized;
  });
}

export function getTrustProxyHops(env = process.env) {
  const value = env.TRUST_PROXY_HOPS ?? '0';
  if (!/^[0-3]$/.test(String(value))) {
    throw new Error('TRUST_PROXY_HOPS must be an integer between 0 and 3.');
  }
  return Number(value);
}

export function getPublicOrigin(env = process.env) {
  if (!env.PUBLIC_ORIGIN) return null;
  const origin = normalizeOrigin(env.PUBLIC_ORIGIN);
  if (!origin || !/^https?:/.test(origin) || (env.NODE_ENV === 'production' && !origin.startsWith('https://'))) {
    throw new Error('PUBLIC_ORIGIN must be an exact HTTP origin (HTTPS in production).');
  }
  return origin;
}

export function isAllowedOrigin(origin, req, allowedOrigins, publicOrigin = null) {
  if (!origin) return true; // Native clients and server-to-server Bearer requests have no browser Origin.
  const normalized = normalizeOrigin(origin);
  if (!normalized) return false;
  const sameOrigin = publicOrigin || normalizeOrigin(req.protocol + '://' + req.get('host'));
  return normalized === sameOrigin || allowedOrigins.includes(normalized);
}

export function originGuard(allowedOrigins, publicOrigin = null) {
  return (req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    if (!isAllowedOrigin(req.get('origin'), req, allowedOrigins, publicOrigin) ||
        (!req.get('origin') && req.get('sec-fetch-site') === 'cross-site')) {
      return res.status(403).json({ error: 'untrusted_origin' });
    }
    next();
  };
}

// Single-process guard. A distributed deployment must use a shared store at its ingress.
// Never trust unconfigured X-Forwarded-For; req.ip follows Express's explicit trust-proxy setting.
export function createAuthRateLimiter({ limit = 30, windowMs = 15 * 60_000, maxEntries = 10_000, now = Date.now } = {}) {
  const attempts = new Map();
  return (req, res, next) => {
    const timestamp = now();
    const key = req.ip || req.socket?.remoteAddress || 'unknown';
    let entry = attempts.get(key);
    if (!entry || entry.resetAt <= timestamp) {
      if (attempts.size >= maxEntries) {
        for (const [candidate, record] of attempts) {
          if (record.resetAt <= timestamp) attempts.delete(candidate);
        }
        // Keep memory bounded without evicting active limits to admit untrusted callers.
        if (attempts.size >= maxEntries) {
          res.set('Retry-After', String(Math.ceil(windowMs / 1000)));
          return res.status(429).json({ error: 'auth_rate_limit' });
        }
      }
      entry = { count: 0, resetAt: timestamp + windowMs };
      attempts.set(key, entry);
    }
    entry.count += 1;
    if (entry.count > limit) {
      res.set('Retry-After', String(Math.max(1, Math.ceil((entry.resetAt - timestamp) / 1000))));
      return res.status(429).json({ error: 'auth_rate_limit' });
    }
    next();
  };
}

export function cloudTimeoutMs(env = process.env) {
  const value = Number(env.CLOUD_TIMEOUT_MS || 30_000);
  if (!Number.isInteger(value) || value < 1000 || value > 60_000) {
    throw new Error('CLOUD_TIMEOUT_MS must be an integer between 1000 and 60000.');
  }
  return value;
}

// The signal remains active for response-body consumption, including response.json().
export function fetchCloud(url, options, timeoutMs = cloudTimeoutMs()) {
  return fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
}

