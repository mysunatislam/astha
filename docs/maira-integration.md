# Maira integration and verified scope

Maira is the selected production AI provider. The existing authenticated Express `/api/vision` and agent routes forward requests to Maira; deployment credentials stay on the server. Gemini remains an explicit supported configuration. Selecting Maira never silently routes a failed server request to Gemini.

## Configuration

Set `CLOUD_AI_PROVIDER=maira`, `MAIRA_API_KEY` and `MAIRA_PROJECT_KEY` in the backend's secret store. `MAIRA_PROFILE_ID` is optional: omit it to use the project's default profile, or configure a reviewed ASTHA profile. The fixed default endpoint is `https://api.recommender.gigalogy.com/v1/maira/ask`. No deployment key belongs in `web/config.js`, generated HTML, an APK, Git, a public pull request, or a Supabase browser key.

The owner-supplied `mairaapi.json` was read only into process memory for two bounded smoke requests; it was not copied into the repository or delivery artifacts. The supplied recommender document was treated as API reference data. The [provider's current OpenAPI](https://api.recommender.gigalogy.com/v1/recommender.json) supports JSON `images` on `/v1/maira/ask`, so the existing image transport is retained.

Each server request uses the authenticated ASTHA user ID, ignoring caller-supplied IDs. Shared default user/profile IDs were removed. Existing personal-key browser integration requires a verified owner ID and cloud consent. Health reports configuration, not provider reachability. Deadlines, request/response limits, redirect refusal, private caching and response validation apply before reporting a result.

## Finding S24: incomplete production Maira configuration

Files: `server/gemini.js`, `server/index.js`, `server/agent.js`, `server/.env.example`, `render.yaml`, `tools/cloud.js`, `web/config.js`, and the Maira regression fixtures/tests.

Root cause: the existing mixed provider selection relied on legacy environment names, a hardcoded profile/shared user ID, permissive response parsing and a generic cloud badge. A deployment could look configured while using the wrong provider or accepting an empty response.

Smallest safe fix: retain the current provider interface and JSON image contract; add explicit provider selection and server-only canonical keys, bind identity to the session, make profiles optional, validate bounded final responses, and expose truthful configuration status. Existing consent, local processing and explicit Gemini support remain available.

Verification on 10 October 2026: `npm run check` passed 125 regressions and two existing agent suites, including mocked authenticated Maira routes and frontend behavior. Capacitor sync and Android debug unit/lint/build passed, with 0 lint errors and 15 warnings. One live text request returned the expected Bangla/English JSON. One live synthetic printed-text image request read `ASTHA TEST 7429` and returned both language fields. Neither request used camera frames, personal memories or real user information. Local evidence is in `maira-live-verification.json` and `maira-image-verification.json` in the delivery folder; secrets are absent.

Remaining gates: live application/camera and accessibility/device testing, reviewed provider profile/retention/isolation, exposed historical credential revocation, production HTTPS/API configuration, and signed store artifacts. These two live requests establish the tested request contracts only; they do not establish visual accuracy, physical safety, offline performance, service availability or production deployment.

## Supabase next increment

Supabase is the selected database service. Preserve the existing PIN/JWT and Express routes while adding a server-side Postgres adapter and a private application schema. Do not point `ASTHA_API_BASE` at a Supabase project URL: it identifies the ASTHA API host. Project selection, secure connection setup, schema application and any existing-data migration require separate verification before enabling the database in production.
