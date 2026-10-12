// Passcode auth designed for a voice-first, often screenless setup flow: name + a spoken
// 4-8 digit PIN read back by the app, not a typed password. Scrypt-hashed, JWT session cookie.
import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { nanoid } from 'nanoid';
import { run, get, all } from './db.js';
import { getJwtSecret, LEGACY_GUEST_PHONE, normalizePhone } from './security.js';
import { asyncRoute } from './async-route.js';

const JWT_SECRET = getJwtSecret();
const VERIFIED_SESSION = Symbol('astha-verified-session');

export function hashPasscode(passcode) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(String(passcode), salt, 64).toString('hex');
  return { hash, salt };
}
export function verifyPasscode(passcode, hash, salt) {
  const check = scryptSync(String(passcode), salt, 64);
  const stored = Buffer.from(hash, 'hex');
  return check.length === stored.length && timingSafeEqual(check, stored);
}

export async function createUser({ name, phone, passcode }) {
  const id = nanoid();
  const { hash, salt } = hashPasscode(passcode);
  await run('INSERT INTO users (id, name, phone, passcode_hash, passcode_salt, created_at) VALUES (?,?,?,?,?,?)',
    [id, name, phone || null, hash, salt, Date.now()]);
  return id;
}
export async function findByPhone(phone) { return await get('SELECT * FROM users WHERE phone = ?', [phone]); }
export async function findByPhoneEquivalent(phone) {
  const exact = await findByPhone(phone);
  if (exact) return exact;
  const normalized = normalizePhone(phone);
  if (!normalized) return null;
  // Preserve old stored formats without rewriting or merging accounts during a security patch.
  const legacy = (await all('SELECT id, phone FROM users WHERE phone IS NOT NULL'))
    .find(user => normalizePhone(user.phone) === normalized);
  return legacy ? await findById(legacy.id) : null;
}
export async function findById(id) { return await get('SELECT * FROM users WHERE id = ?', [id]); }

export function signToken(userId) {
  return jwt.sign({ sub: userId }, JWT_SECRET, { expiresIn: '180d', algorithm: 'HS256' });
}
export async function getAuthenticatedUser(req) {
  const bearer = (req.headers.authorization || '').match(/^Bearer\s+(\S+)$/i);
  const token = bearer?.[1] || req.cookies?.astha_session;
  if (!token) return null;
  const cached = req[VERIFIED_SESSION];
  if (cached?.token === token) return cached.user;
  let payload;
  try {
    payload = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
    if (typeof payload.sub !== 'string') return null;
  } catch {
    return null;
  }
  // A storage outage must reach error middleware, not masquerade as an invalid session.
  const user = await findById(payload.sub);
  // All former shared-guest sessions are unsafe; their data stays quarantined in the DB.
  if (!user || user.phone === LEGACY_GUEST_PHONE) return null;
  // Router chains share this verified lookup only within the current request. req.user alone
  // is never a trust signal, and neither failures nor different tokens reuse this result.
  req[VERIFIED_SESSION] = { token, user };
  return user;
}
export const authMiddleware = asyncRoute(async (req, res, next) => {
  const user = await getAuthenticatedUser(req);
  if (!user) return res.status(401).json({ error: 'not_signed_in' });
  req.user = user;
  next();
});
