// This file is the one place a separately-hosted frontend points at its backend. It is only
// needed when this page is NOT served by the Astha server itself -- e.g. this GitHub Pages
// deployment, which is static-only and cannot run the server, database, or hold the Gemini key.
//
// Right now this points at a temporary tunnel to a locally-running server, so it only works
// while that machine and tunnel are up. Once you deploy the server somewhere permanent (Render,
// Fly, a VPS -- see README.md), replace the URL below with that server's address, e.g.
// "https://astha-xxxx.onrender.com", and the server's CORS_ORIGIN must be set to
// "https://mysunatislam.github.io" for requests from this page to be allowed.
window.ASTHA_API_BASE = 'https://handled-carpet-worked-attempts.trycloudflare.com';
