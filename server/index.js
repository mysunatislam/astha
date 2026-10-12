import './env.js';
import express from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createUser, registerGuest, discardEmptyGuest, findByPhone, findByPhoneEquivalent, verifyPasscode, signToken, authMiddleware, getAuthenticatedUser } from './auth.js';
import { memoryRouter } from './memory.js';
import { ragRouter } from './rag.js';
import { agentRouter } from './agent.js';
import { createAccountRouter } from './account.js';
import { callCloudAI, hasCloudAI, getCloudProvider } from './gemini.js';
import { synthesize } from './tts.js';
import { createSpeechRouter } from './speech.js';
import { asyncRoute } from './async-route.js';
import { createRequestObservability } from './observability.js';
import { db, storageReady } from './db.js';
import { getAllowedOrigins, getTrustProxyHops, getPublicOrigin, isAllowedOrigin, originGuard, createAuthRateLimiter, validateAuthBody } from './security.js';
import { isBody, isText, isFrame } from './validate.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.join(__dirname, '..', 'web');
const PORT = process.env.PORT || 8787;
const IS_PROD = process.env.NODE_ENV === 'production';
// Set when the frontend is hosted on a different origin than this API (e.g. a GitHub Pages
// shell talking to this server) -- cross-site fetch() only carries cookies when they are
// SameSite=None, which in turn requires Secure, so both flip on together below.
const ALLOWED_ORIGINS = getAllowedOrigins();
const PUBLIC_ORIGIN = getPublicOrigin();
const CROSS_ORIGIN = ALLOWED_ORIGINS.length > 0;
const COOKIE_OPTS = { httpOnly: true, sameSite: CROSS_ORIGIN ? 'none' : 'lax', secure: CROSS_ORIGIN || IS_PROD, maxAge: 180 * 24 * 3600 * 1000 };

const app = express();
app.disable('x-powered-by');
const requestMonitor = createRequestObservability({
  logger: process.env.ASTHA_LOG_REQUEST_ERRORS === '1' ? line => console.error(line) : null,
});
app.use(requestMonitor.middleware);
// Trust only the explicitly configured number of ingress hops; direct connections default to zero.
app.set('trust proxy', getTrustProxyHops());
app.use((req, res, next) => cors({
  origin: (origin, callback) => callback(null, isAllowedOrigin(origin, req, ALLOWED_ORIGINS, PUBLIC_ORIGIN)),
  credentials: true,
  exposedHeaders: ['X-Request-ID'],
})(req, res, next));
app.use('/api', (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
app.use('/api', originGuard(ALLOWED_ORIGINS, PUBLIC_ORIGIN));
// Reject abusive auth traffic and large auth payloads before doing synchronous PIN hashing.
const authRateLimiter = createAuthRateLimiter();
app.use('/api/auth', (req, res, next) => {
  if (req.method === 'POST' && ['/signup', '/login', '/guest'].includes(req.path)) {
    return authRateLimiter(req, res, next);
  }
  next();
}, express.json({ limit: '8kb' }));
// Account deletion re-checks the PIN, so it shares sign-in's attempt limit and small body.
app.use('/api/account', (req, res, next) => {
  if (req.method === 'POST' && req.path === '/delete') return authRateLimiter(req, res, next);
  next();
}, express.json({ limit: '8kb' }));
app.use(cookieParser());
app.use('/api/speak', express.json({ limit: '8kb' }));
app.use(express.json({ limit: '12mb' })); // camera frames as base64 JPEG can be a few MB

// ---- Health ----
app.get('/api/health', asyncRoute(async (req, res) => {
  try { await storageReady(); }
  catch { return res.status(503).json({ ok: false, error: 'storage_unavailable', cloud: false, cloudProvider: null }); }
  const cloud = hasCloudAI();
  res.json({ ok: true, name: 'Astha', name_bn: 'আস্থা', cloud, cloudProvider: cloud ? getCloudProvider() : null });
}));

// ---- Auth: name + a spoken passcode, no email required ----
app.post('/api/auth/signup', asyncRoute(async (req, res) => {
  const validated = validateAuthBody(req.body, true);
  if (!validated) return res.status(400).json({ error: 'invalid_auth_input' });
  const { name, phone, passcode } = validated;
  // Phone is required (not just optional) so the account is recoverable on a new device or
  // after clearing cookies -- the 180-day session cookie alone is not enough for a blind user
  // who cannot easily read back a lost token.
  if (await findByPhoneEquivalent(phone)) return res.status(409).json({ error: 'phone_taken' });
  // The app starts as a guest; registering from that session claims the same account.
  const guest = await getAuthenticatedUser(req);
  let id;
  try {
    const account = { name: String(name).slice(0, 80), phone, passcode };
    id = (guest?.phone === null && await registerGuest(guest.id, account)) || await createUser(account);
  }
  catch (err) {
    // Concurrent signup can reach the unique constraint after the initial lookup.
    if (err.code === '23505' || err.code === 'ERR_SQLITE_ERROR' && err.errcode === 2067) return res.status(409).json({ error: 'phone_taken' });
    throw err;
  }
  const token = signToken(id);
  res.cookie('astha_session', token, COOKIE_OPTS);
  res.json({ token, userId: id });
}));
app.post('/api/auth/login', asyncRoute(async (req, res) => {
  const validated = validateAuthBody(req.body);
  if (!validated) return res.status(400).json({ error: 'invalid_auth_input' });
  const { phone, passcode } = validated;
  // Before normalization, existing accounts could store spoken Bangla digits literally.
  const user = await findByPhone(req.body.phone) || await findByPhoneEquivalent(phone);
  const matches = user && (verifyPasscode(passcode, user.passcode_hash, user.passcode_salt) ||
    (req.body.passcode !== passcode && verifyPasscode(req.body.passcode, user.passcode_hash, user.passcode_salt)));
  if (!matches) return res.status(401).json({ error: 'invalid_credentials' });
  const previous = await getAuthenticatedUser(req);
  if (previous?.phone === null && previous.id !== user.id) await discardEmptyGuest(previous.id);
  const token = signToken(user.id);
  res.cookie('astha_session', token, COOKIE_OPTS);
  res.json({ token, userId: user.id });
}));
app.post('/api/auth/guest', asyncRoute(async (req, res) => {
  const existing = await getAuthenticatedUser(req);
  const id = existing?.phone === null ? existing.id :
    await createUser({ name: 'User', phone: null, passcode: randomBytes(32).toString('hex') });
  const token = signToken(id);
  res.cookie('astha_session', token, COOKIE_OPTS);
  res.json({ token, userId: id });
}));
app.post('/api/auth/logout', (req, res) => {
  const options = { ...COOKIE_OPTS }; delete options.maxAge;
  res.clearCookie('astha_session', options); res.json({ ok: true });
});
app.get('/api/auth/me', authMiddleware, (req, res) => {
  const { id, name, phone, voice_lang, mode, face_descriptor } = req.user;
  res.json({ id, name, phone, voice_lang, mode, face_descriptor: face_descriptor ? JSON.parse(face_descriptor) : null });
});

// ---- Memory, rooms, activity log (all require sign-in) ----
app.use('/api', authMiddleware, memoryRouter);
app.use('/api', authMiddleware, ragRouter);
app.use('/api', authMiddleware, agentRouter);
app.use('/api', authMiddleware, createAccountRouter(COOKIE_OPTS));

// ---- Configured cloud vision proxy: deployment keys never reach the browser ----
const VISION_STATUS = Object.freeze({ no_key: 503, bad_key: 502, rate_limit: 429, bad_request: 400, network: 502, upstream: 502, bad_response: 502 });
app.post('/api/vision', authMiddleware, async (req, res) => {
  const { task, image, prompt, maxTokens } = req.body || {};
  if (!isBody(req.body) || (task === undefined && prompt === undefined) ||
      (task !== undefined && !isText(task, 32)) || (prompt !== undefined && !isText(prompt, 32000)) ||
      !isFrame(image) || (maxTokens !== undefined && (!Number.isInteger(maxTokens) || maxTokens < 16 || maxTokens > 4096))) {
    return res.status(400).json({ error: 'bad_request', message: 'bad_request' });
  }
  try {
    const result = await callCloudAI({ task, customPrompt: prompt, imageBase64: image, maxTokens, userId: req.user.id });
    res.json(result);
  } catch (e) {
    requestMonitor.markError(req, e);
    // Only the fixed category leaves the server; provider and runtime messages stay private.
    const code = Object.hasOwn(VISION_STATUS, e?.code) ? e.code : 'error';
    res.status(VISION_STATUS[code] || 500).json({ error: code, message: code });
  }
});

// ---- Speech: real neural voices (Bangla female included), MP3 streamed back ----
app.use('/api', authMiddleware, createSpeechRouter(synthesize));

// Unknown API paths answer in the API's own JSON shape instead of the HTML shell or a framework page.
app.use('/api', (req, res) => res.status(404).json({ error: 'not_found' }));

// ---- Static PWA ----
app.use(express.static(WEB_DIR, { maxAge: IS_PROD ? '1d' : 0 }));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api')) return next();
  res.sendFile(path.join(WEB_DIR, 'index.html'));
});

// Body-parser and unexpected route failures return bounded JSON without exposing a stack.
app.use(requestMonitor.errorMiddleware);

const server = app.listen(PORT, () => console.log(`Astha server listening on :${PORT}`));
let stopping = false;
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {
  if (stopping) return;
  stopping = true;
  // Allow in-flight requests to finish before draining the pool; bound shutdown.
  const deadline = setTimeout(() => process.exit(1), 15000);
  deadline.unref();
  server.close(async () => {
    try { await db.close(); clearTimeout(deadline); process.exit(0); }
    catch { process.exit(1); }
  });
});
