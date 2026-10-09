// Passcode auth designed for a voice-first, often screenless setup flow: name + a spoken
// 4-8 digit PIN read back by the app, not a typed password. Scrypt-hashed, JWT session cookie.
import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { nanoid } from 'nanoid';
import { run, get, all } from './db.js';
import { getJwtSecret, LEGACY_GUEST_PHONE, normalizePhone } from './security.js';

const JWT_SECRET = getJwtSecret();

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

export function createUser({ name, phone, passcode }) {
  const id = nanoid();
  const { hash, salt } = hashPasscode(passcode);
  run('INSERT INTO users (id, name, phone, passcode_hash, passcode_salt, created_at) VALUES (?,?,?,?,?,?)',
    [id, name, phone || null, hash, salt, Date.now()]);
  return id;
}
export function findByPhone(phone) { return get('SELECT * FROM users WHERE phone = ?', [phone]); }
export function findByPhoneEquivalent(phone) {
  const exact = findByPhone(phone);
  if (exact) return exact;
  const normalized = normalizePhone(phone);
  if (!normalized) return null;
  // Preserve old stored formats without rewriting or merging accounts during a security patch.
  const legacy = all('SELECT id, phone FROM users WHERE phone IS NOT NULL')
    .find(user => normalizePhone(user.phone) === normalized);
  return legacy ? findById(legacy.id) : null;
}
export function findById(id) { return get('SELECT * FROM users WHERE id = ?', [id]); }

export function signToken(userId) {
  return jwt.sign({ sub: userId }, JWT_SECRET, { expiresIn: '180d', algorithm: 'HS256' });
}
export function getAuthenticatedUser(req) {
  const bearer = (req.headers.authorization || '').match(/^Bearer\s+(\S+)$/i);
  const token = bearer?.[1] || req.cookies?.astha_session;
  if (!token) return null;
  try {
    const payload = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
    if (typeof payload.sub !== 'string') return null;
    const user = findById(payload.sub);
    // All former shared-guest sessions are unsafe; their data stays quarantined in the DB.
    return user && user.phone !== LEGACY_GUEST_PHONE ? user : null;
  } catch {
    return null;
  }
}
export function authMiddleware(req, res, next) {
  const user = getAuthenticatedUser(req);
  if (!user) return res.status(401).json({ error: 'not_signed_in' });
  req.user = user;
  next();
}
