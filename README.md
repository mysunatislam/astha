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
              vocab.js, module.js, eye.js, cloud.js, styles.css that build.py inlines into it.
              Edit these, never web/index.html directly -- it is generated.
web/          The built PWA: index.html (generated), manifest.webmanifest, sw.js, icons/,
              config.js (deployment overrides), backend.js (sign-in gate + boot).
server/       Express API: auth, per-user memory/rooms/activity log (SQLite via node:sqlite),
              a Gemini vision proxy that keeps the API key server-side, and neural
              text-to-speech (Microsoft Edge voices, including a real Bangla female voice).
```

The phone talks to `/api/*` on the same origin it loaded the page from. The Gemini key lives
only in `server/.env` -- the browser never sees it. On-device object detection (COCO-SSD + CLIP)
still runs as a fast, offline fallback when the cloud is unreachable.

## Run it locally

Requires Node 22.5+ (for the built-in `node:sqlite`) and Python 3 (only to run the build step).

```bash
npm run install:server
cp server/.env.example server/.env    # then fill in JWT_SECRET and GEMINI_API_KEY
npm run build                          # regenerates web/index.html from tools/
npm start                              # serves the API + PWA on http://localhost:8787
```

Open `http://localhost:8787`. Camera, microphone and screen sharing all require a secure
context -- `localhost` counts as one, a plain `http://<lan-ip>` does not. To test on a phone on
the same network, either deploy it (below) or tunnel it, e.g. `cloudflared tunnel --url
http://localhost:8787`, which hands you a temporary `https://*.trycloudflare.com` address.

## Deploy it for real

**Render** (free tier, no credit card): push this repo to GitHub, then in Render choose
*New → Blueprint* and point it at the repo -- `render.yaml` configures the service, a persistent
disk for the SQLite database, and a generated `JWT_SECRET`. Add your `GEMINI_API_KEY` in the
Render dashboard's environment variables (marked `sync: false` in the blueprint so it is never
committed).

**Any Docker host** (Fly.io, a VPS, etc.): `docker build -t astha .`, then run it with a mounted
volume at `/data` and `JWT_SECRET` / `GEMINI_API_KEY` set as environment variables.

Once deployed, install it on a phone as a normal PWA -- Chrome's "Add to Home screen" -- and it
opens full-screen with no browser chrome, with an icon like any other app.

### GitHub Pages (frontend only)

`.github/workflows/pages.yml` publishes `web/` to `https://<you>.github.io/astha/` on every push.
GitHub Pages is static hosting -- it cannot run the server, hold the Gemini key, check
passcodes, or write to the database, so this alone is not a working deployment. It becomes one
once `web/config.js` points `window.ASTHA_API_BASE` at a real, separately-hosted backend (Render,
Fly, a tunnel), and that backend's `CORS_ORIGIN` is set to the Pages origin (e.g.
`https://<you>.github.io`, no trailing path) so the cross-site cookie is accepted. Setting
`CORS_ORIGIN` also switches the session cookie to `SameSite=None; Secure`, which is required for
a fetch from one origin to carry a cookie from another.

## Editing the frontend

Never edit `web/index.html` by hand -- it is regenerated from `tools/*` on every `npm run
build` and any manual edit will be overwritten. Change `tools/base.html` (structure/CSS) or
`tools/{vocab,module,eye,cloud}.js` (behaviour), then rebuild.

## Environment variables (`server/.env`)

| Variable | Meaning |
| --- | --- |
| `PORT` | Port the server listens on (default 8787) |
| `JWT_SECRET` | Long random string signing session cookies -- required |
| `DB_PATH` | Where the SQLite file lives (default `./data/astha.db`) |
| `GEMINI_API_KEY` | Optional but strongly recommended -- enables accurate cloud vision/reading |
| `CORS_ORIGIN` | Restrict this in production if the frontend is ever hosted separately |

## Privacy

Camera and screen frames sent for cloud reasoning go straight to Google's Gemini API and are not
stored by this server. Only what a user explicitly asks Astha to remember (an object location, a
room note) is saved, tied to their account, and deletable at any time from the app.
