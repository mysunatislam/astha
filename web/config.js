// Astha is served as one app: the same origin serves this page and the /api/* endpoints, so
// every fetch in the app uses a plain relative path and this file needs no changes for the
// normal deployment. It exists as the one place to override that, if you ever split the
// frontend and backend across two different hosts (e.g. a static CDN plus a separate API
// server) -- set window.ASTHA_API_BASE to the API's origin, such as "https://api.example.com".
window.ASTHA_API_BASE = '';
