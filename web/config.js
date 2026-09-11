// This file is the one place a separately-hosted frontend points at its backend. It is only
// needed when this page is NOT served by the Astha server itself -- e.g. this GitHub Pages
// deployment, which is static-only and cannot run the server, database, or hold the Gemini key.
//
// Once you deploy the Astha server somewhere permanent (e.g. Render, Fly, or a VPS),
// set its URL here (e.g. "https://astha-backend.onrender.com").
// When left empty (''), Astha functions completely on-device without requiring a server.
window.ASTHA_API_BASE = '';
