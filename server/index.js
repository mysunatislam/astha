import 'dotenv/config';
import express from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createUser, findByPhone, verifyPasscode, signToken, authMiddleware } from './auth.js';
import { memoryRouter } from './memory.js';
import { ragRouter } from './rag.js';
import { agentRouter } from './agent.js';
import { callGemini, hasCloudAI } from './gemini.js';
import { synthesize } from './tts.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.join(__dirname, '..', 'web');
const PORT = process.env.PORT || 8787;
const IS_PROD = process.env.NODE_ENV === 'production';
// Set when the frontend is hosted on a different origin than this API (e.g. a GitHub Pages
// shell talking to this server) -- cross-site fetch() only carries cookies when they are
// SameSite=None, which in turn requires Secure, so both flip on together below.
const CROSS_ORIGIN = !!(process.env.CORS_ORIGIN && process.env.CORS_ORIGIN !== '*');
const COOKIE_OPTS = { httpOnly: true, sameSite: CROSS_ORIGIN ? 'none' : 'lax', secure: CROSS_ORIGIN || IS_PROD, maxAge: 180 * 24 * 3600 * 1000 };

const app = express();
app.disable('x-powered-by');
app.use(cors({ origin: process.env.CORS_ORIGIN || true, credentials: true }));
app.use(cookieParser());
app.use(express.json({ limit: '12mb' })); // camera frames as base64 JPEG can be a few MB

// ---- Health ----
app.get('/api/health', (req, res) => res.json({ ok: true, name: 'Astha', name_bn: 'আস্থা', cloud: hasCloudAI() }));

// ---- Auth: name + a spoken passcode, no email required ----
app.post('/api/auth/signup', (req, res) => {
  const { name, phone, passcode } = req.body || {};
  // Phone is required (not just optional) so the account is recoverable on a new device or
  // after clearing cookies -- the 180-day session cookie alone is not enough for a blind user
  // who cannot easily read back a lost token.
  if (!name || !phone || !passcode || String(passcode).length < 4) return res.status(400).json({ error: 'name_phone_and_passcode_required' });
  if (findByPhone(phone)) return res.status(409).json({ error: 'phone_taken' });
  const id = createUser({ name: String(name).slice(0, 80), phone, passcode });
  const token = signToken(id);
  res.cookie('astha_session', token, COOKIE_OPTS);
  res.json({ token, userId: id });
});
app.post('/api/auth/login', (req, res) => {
  const { phone, passcode } = req.body || {};
  const user = phone && findByPhone(phone);
  if (!user || !verifyPasscode(passcode, user.passcode_hash, user.passcode_salt)) return res.status(401).json({ error: 'invalid_credentials' });
  const token = signToken(user.id);
  res.cookie('astha_session', token, COOKIE_OPTS);
  res.json({ token, userId: user.id });
});
app.post('/api/auth/guest', (req, res) => {
  let user = findByPhone('01000000000');
  let id = user?.id;
  if (!user) {
    id = createUser({ name: 'User', phone: '01000000000', passcode: '1234' });
  }
  const token = signToken(id);
  res.cookie('astha_session', token, COOKIE_OPTS);
  res.json({ token, userId: id });
});
app.post('/api/auth/logout', (req, res) => { res.clearCookie('astha_session', COOKIE_OPTS); res.json({ ok: true }); });
app.get('/api/auth/me', authMiddleware, (req, res) => {
  const { id, name, phone, voice_lang, mode, face_descriptor } = req.user;
  res.json({ id, name, phone, voice_lang, mode, face_descriptor: face_descriptor ? JSON.parse(face_descriptor) : null });
});

// ---- Memory, rooms, activity log (all require sign-in) ----
app.use('/api', authMiddleware, memoryRouter);
app.use('/api', authMiddleware, ragRouter);
app.use('/api', authMiddleware, agentRouter);

// ---- Gemini vision proxy: the API key never reaches the browser ----
app.post('/api/vision', authMiddleware, async (req, res) => {
  const { task, image, prompt, maxTokens } = req.body || {};
  try {
    const result = await callGemini({ task, customPrompt: prompt, imageBase64: image, maxTokens, userId: req.user?.id || 'astha-user' });
    res.json(result);
  } catch (e) {
    console.error('vision error:', e.code || e.message, e.stack);
    const code = e.code || 'error';
    const status = { no_key: 503, bad_key: 502, rate_limit: 429, bad_request: 400, network: 502 }[code] || 500;
    res.status(status).json({ error: code, message: e.message });
  }
});

// ---- Speech: real neural voices (Bangla female included), MP3 streamed back ----
app.get('/api/speak', authMiddleware, async (req, res) => {
  const text = String(req.query.text || '').slice(0, 900);
  const voice = String(req.query.voice || 'bn-female');
  if (!text.trim()) return res.status(400).json({ error: 'text_required' });
  try {
    const audio = await synthesize(text, voice);
    res.set('Content-Type', 'audio/mpeg');
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(audio);
  } catch (e) { console.error('tts', e); res.status(502).json({ error: 'tts_unavailable' }); }
});

// ---- Static PWA ----
app.use(express.static(WEB_DIR, { maxAge: IS_PROD ? '1d' : 0 }));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api')) return next();
  res.sendFile(path.join(WEB_DIR, 'index.html'));
});

app.listen(PORT, () => console.log(`Astha server listening on :${PORT}`));
