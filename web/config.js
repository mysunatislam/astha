// This file is the one place a separately-hosted frontend points at its backend. It is only
// needed when this page is NOT served by the Astha server itself -- e.g. this GitHub Pages
// deployment, which is static-only and cannot run the server, database, or hold provider keys.
//
// Once you deploy the Astha server somewhere permanent (e.g. Render, Fly, or a VPS),
// set its URL here (e.g. "https://astha-backend.onrender.com").
// When served by the ASTHA server, leave this empty for same-origin account/storage/AI APIs.
// On static hosting without a backend, the shell uses its existing local fallback.
// This must be the ASTHA server origin, not Gigalogy's /v1/maira/ask endpoint.
// Configure CLOUD_AI_PROVIDER=maira and MAIRA_API_KEY/MAIRA_PROJECT_KEY on that server.
// Never put shared deployment credentials in this public file or generated index.html.
window.ASTHA_API_BASE = '';
