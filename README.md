# Astha (আস্থা)

A Bangla-first, voice-led AI visual companion for blind and low-vision users. A single Node
server serves both the API and an installable phone web app (PWA) from one origin, so there is
one URL to deploy and one process to run.

Round 1 scope: read a board or book aloud with a concise explanation, remember approved object
events ("glasses seen on the bedside table at 10:05") and answer with location, time and
confidence, short safety-conscious Bangla voice interaction, and advisory-only obstacle warnings.
Astha's eye can also watch a shared computer screen and narrate it. See `docs/ROADMAP.md` for
what is intentionally out of scope for now.

## How it fits together

```
tools/        Source files for the phone app: base.html (the whole UI + on-device logic) plus
              vocab.js, module.js, eye.js, cloud.js, account.js, i18n.js, styles.css that
              build.py inlines into it, and i18n.json (interface strings, English and Bangla).
              Edit these, never web/index.html directly -- it is generated.
web/          The built PWA: index.html (generated), manifest.webmanifest, sw.js, icons/,
              config.js (deployment overrides), backend.js (sign-in gate + boot).
server/       Express API: auth, per-user storage (Supabase Postgres or existing SQLite),
              a configured Maira/Gemini proxy that keeps deployment keys server-side, and neural
              text-to-speech (Microsoft Edge voices, including a real Bangla female voice).
```

The phone talks to `/api/*` on its configured ASTHA API origin. Maira is the selected AI
provider and Supabase is the selected database service. Deployment credentials stay in
server secret storage. Existing on-device detection remains available; model readiness,
accuracy and cold offline behavior require device verification.

## Run it locally

Requires Node 22.5+ (for the built-in `node:sqlite`) and Python 3 (only to run the build step).

```bash
npm ci
npm run install:server
cp server/.env.example server/.env
# For local SQLite development, set DB_PROVIDER=sqlite in server/.env.
# Set a strong JWT_SECRET; fill in server-only Maira keys if testing cloud processing.
npm run build                          # regenerates web/index.html from tools/
npm start                              # serves the API + PWA on http://localhost:8787
```

Open `http://localhost:8787`. Camera, microphone and screen sharing all require a secure
context -- `localhost` counts as one, a plain `http://<lan-ip>` does not. To test on a phone on
the same network, either deploy it (below) or tunnel it, e.g. `cloudflared tunnel --url
http://localhost:8787`, which hands you a temporary `https://*.trycloudflare.com` address.

## Deploy it for real

The release is still a review candidate. Read [the audit and release plan](docs/source-audit-and-release-plan.md),
[Maira setup and verification](docs/maira-integration.md), and [Supabase setup and migration](docs/supabase-integration.md).
Configure `DB_PROVIDER=supabase` with the limited backend role, verified TLS and explicitly
reviewed private schema. Startup verifies the database; it does not migrate or import data.
Keep existing SQLite data and backups until a verified cutover.

The current Express API still needs a permanent HTTPS Node/container host. Supabase's project
URL identifies its services; it is not this Express API's origin. A separate Edge Functions
migration needs runtime validation. Docker can run the existing server with externally supplied
database, JWT and provider secrets. Its production default is Supabase; SQLite requires an
explicit override. Read [container checks and request monitoring](docs/operations.md) for
readiness, certificate mounts, sanitized logging and remaining hosting gates.

### A shareable preview with online AI and Supabase (Render, free)

A static page cannot keep a secret: a provider key placed in `web/` is readable by every visitor,
and the Maira key pair opens the whole Gigalogy project, not only `/v1/maira/ask`. The server
holds the keys instead. `render.yaml` describes one free preview service with the selected
Supabase database; accounts and synced records stay outside the disposable container:

1. After reviewing and merging the corrected blueprint, open
   [Deploy to Render](https://render.com/deploy?repo=https://github.com/mysunatislam/astha)
   and sign in. Confirm the service uses the reviewed source commit.
2. Enter `MAIRA_API_KEY`, `MAIRA_PROJECT_KEY` and the restricted `SUPABASE_DB_URL` in Render's
   private form. Use the approved `astha_backend` session-pool URL on port **5432**, with an
   encoded password; do not use a project HTTP URL, administrator login or port 6543.
   Render generates `JWT_SECRET`; preserve it on subsequent redeploys.
3. In the service's **Environment > Secret Files**, upload the trusted Supabase CA as
   `supabase-root-ca.crt`. It is mounted at `/etc/secrets/supabase-root-ca.crt`, matching the
   blueprint. Use the verified certificate supplied for the selected project, not a Windows
   pathname. Startup intentionally fails until the credentials, certificate and existing
   private schema are valid. Then manually deploy the reviewed commit.
4. When Render reports healthy, use its actual `https://<name>.onrender.com` address and verify
   sign-in, account isolation, consent-gated AI and persistence across a restart. A generated
   address or a successful image build alone does not verify these flows.

Visitors choose "Online AI" once and accept the consent prompt; nobody is asked for a key. The
existing server-side provider route remains unchanged. Leave `web/config.js` empty when the
same Express service serves the PWA. `PUBLIC_ORIGIN` defaults to Render's verified-format
external HTTPS address; set an explicit exact origin for a custom domain.

The [free plan](https://render.com/docs/free) sleeps after 15 idle minutes and can take about
a minute to wake. It is for preview/judging; select and approve an always-on plan before a
production launch. Supabase account data is not stored on Render's ephemeral filesystem.
Automatic redeploys are off, and only one process/instance is configured. Forwarded headers
remain untrusted until the deployed ingress is checked; the authentication limit may group
visitors behind the same router in the meantime. Read [operations](docs/operations.md) for
the deployment checks. Neither a live Render deployment nor physical-device behavior is
verified by this configuration. Secret files are runtime mounts, excluded from the image;
see [Render's Docker secret guidance](https://render.com/docs/docker-secrets).

### GitHub Pages (frontend only)

`.github/workflows/pages.yml` checks review changes and deploys `web/` only from `main`.
GitHub Pages is static hosting -- it cannot run the server, hold deployment provider keys, check
passcodes, or write to the database, so this alone is not a working deployment. It becomes one
once `web/config.js` points `window.ASTHA_API_BASE` at a real, separately-hosted backend (Render,
Fly), and that backend's `CORS_ORIGIN` is set to the Pages origin (e.g.
`https://<you>.github.io`, no trailing path) so the cross-site cookie is accepted. Setting
`CORS_ORIGIN` also switches the session cookie to `SameSite=None; Secure`, which is required for
a fetch from one origin to carry a cookie from another.

## Editing the frontend

Never edit `web/index.html` by hand -- it is regenerated from `tools/*` on every `npm run
build` and any manual edit will be overwritten. Change `tools/base.html` (structure/CSS) or
`tools/{vocab,module,eye,cloud,account}.js` (behaviour), then rebuild.

Interface text added since the original dictionary lives in `tools/i18n.json`: `strings` maps
each key to an `[English, Bangla]` pair, and `hooks` lists the elements that show it. A hook
names an element by its opening tag and says what to translate: `text` (the whole content),
`lead` (the text before a child control, as in a label that wraps its input) or an attribute
(`aria-label`, `title`, `placeholder`, `alt`). The build stops if a listed element is missing
or its English text no longer matches, and `npm run check` fails on any visible label left in
English only. Labels that show a state are set from code with `t('key')` and redrawn by
`refreshStateLabels()` when the language changes.

## Environment variables (`server/.env`)

| Variable | Meaning |
| --- | --- |
| `PORT` | Port the server listens on (default 8787) |
| `JWT_SECRET` | Long random string signing session cookies -- required |
| `DB_PATH` | Where the SQLite file lives (default `./data/astha.db`) |
| `DB_PROVIDER` | `supabase` for selected production storage; `sqlite` preserves the default development path |
| `SUPABASE_DB_URL` | Server-only Postgres connection URL for the limited `astha_backend` role |
| `SUPABASE_DB_CA_FILE` | Optional trusted CA certificate file; TLS verification stays enabled |
| `CLOUD_AI_PROVIDER` | Explicit `maira` or `gemini`; `auto` supports existing deployments |
| `MAIRA_API_KEY`, `MAIRA_PROJECT_KEY` | Server-only Maira credentials |
| `MAIRA_PROFILE_ID` | Optional reviewed profile; omit to use the project default |
| `GEMINI_API_KEY` | Optional for explicit Gemini configuration |
| `PUBLIC_ORIGIN`, `CORS_ORIGIN` | Exact HTTPS API origin and additional allowed frontend origins |
| `TRUST_PROXY_HOPS` | Explicit verified ingress hop count; default 0 |

## Privacy

Cloud image/screen reasoning uses the configured Maira/Gemini provider after session consent.
Speech may use Microsoft or the browser's speech service. The backend stores account data,
PIN hashes, approved memories, rooms, settings, activity, agent tasks and documents; enrolled
biometric data has additional privacy requirements. Offline mode blocks remote processing.
Each account keeps a rolling newest-N of its records on the server. Your preferences offers
"Download my data", "Forget my face and voice" and "Delete my account"; deletion needs the PIN
for a registered account and removes every record that account owns.
[What Astha stores](docs/data-handling.md) describes this in English and Bangla. The published
policy, provider retention and backup handling remain a release gate; provider retention is
not established by the local tests.

The app starts as a guest so nobody has to type first. "Create account or log in" in Your
preferences registers that guest in place, keeping its notes, or signs in to an existing account.
