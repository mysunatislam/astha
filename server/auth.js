// Passcode auth designed for a voice-first, often screenless setup flow: name + a spoken
// 4-8 digit PIN read back by the app, not a typed password. Scrypt-hashed, JWT session cookie.
import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { nanoid } from 'nanoid';
import { run, get } from './db.js';

const JWT_SECRET = process.env.JWT_SECRET || 'astha-default-secure-companion-secret-key-2026';

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
export function findById(id) { return get('SELECT * FROM users WHERE id = ?', [id]); }

export function signToken(userId) {
  return jwt.sign({ sub: userId }, JWT_SECRET, { expiresIn: '180d' });
}
export function authMiddleware(req, res, next) {
  const token = req.cookies?.astha_session || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) return res.status(401).json({ error: 'not_signed_in' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user = findById(payload.sub);
    if (!user) return res.status(401).json({ error: 'not_signed_in' });
    req.user = user;
    next();
  } catch (e) { return res.status(401).json({ error: 'not_signed_in' }); }
}
