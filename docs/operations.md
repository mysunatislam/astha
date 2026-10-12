# ASTHA operations and container verification

The existing Express application is retained. Its production image defaults to `DB_PROVIDER=supabase` and refuses startup when the restricted database configuration is missing. Development or legacy SQLite operation requires the explicit `DB_PROVIDER=sqlite` override and a persisted `/data` volume. The Render preview blueprint also selects Supabase, with no local database or paid disk; its free plan is not an always-on production service.

## Container and secrets

`Dockerfile` pins the official Node 24.21.0 Bookworm image by its verified multi-platform manifest digest. Digest references prevent the tag from silently selecting different base bytes; package repositories and npm distribution availability remain external build dependencies. Review base updates deliberately and rerun the image gate. [Docker FROM reference](https://docs.docker.com/reference/dockerfile/#from).

Supply `JWT_SECRET`, the restricted `SUPABASE_DB_URL` and Maira credentials through the chosen host's protected environment. Mount the project's trusted CA read-only and set `SUPABASE_DB_CA_FILE` to its path inside the container; a Windows workstation path is not a container path. Keep TLS verification enabled. Do not bake credentials or the CA path into frontend assets or an image. `.dockerignore` excludes environment files, databases, signing keys and local dependencies. It also omits the unverified historical `web/downloads/astha.apk`; that source archive is preserved separately and is not a reviewed production installer.

The image runs as `node`. `server/check-health.mjs` probes only the configured loopback port and `/api/health`, requires HTTP 200 with `ok=true`, rejects redirects and bounds both time and response size. It emits no response content. Docker runs that readiness check periodically. Readiness covers application storage, not provider availability or visual accuracy. [Docker HEALTHCHECK reference](https://docs.docker.com/reference/dockerfile/#healthcheck).

`node tools/check-container.mjs` builds a disposable context from tracked application files and synthetic canaries, never reading operator environment files. It checks image exclusion boundaries, nonroot writes, failed startup without selected Supabase configuration, healthy status, no-store health, unauthenticated denial, synthetic SQLite account/memory persistence across restart and graceful shutdown. Cleanup targets only generated container IDs, the verified labelled volume and this run's image. CI runs this gate after regressions and dependency audits. Actual image verification must be recorded from a passing hosted run; Docker is unavailable on the Windows workstation.

## Request monitoring

Every response receives a generated `X-Request-ID`. Caller-supplied IDs are ignored; trusted CORS responses expose this header. `server/observability.js` keeps process-local counters for a fixed set of route templates and HTTP status classes, with bounded latency histograms. These counters reset on restart and have no public endpoint. They are infrastructure diagnostics, without account identities, raw URLs, queries, request bodies, images, audio, phone numbers, tokens or error messages.

Set `ASTHA_LOG_REQUEST_ERRORS=1` to enable sanitized JSON lines for 5xx responses and aborted streams. The default is disabled. Logging is capped at 30 records per process per minute; counters retain all failures and record the dropped-log count. Each line contains only event, generated request ID, allowlisted method/route, status, bounded elapsed milliseconds and a fixed error category. Log-sink failures cannot change API behavior. Late errors close the response without forwarding an error object to Express's raw stack logger. Earlier body-parser errors preserve the existing bounded 400/413 JSON responses.

The focused regressions cover sensitive markers in paths, queries, bearer headers, bodies and error objects, variable resource IDs, duplicate finish/close events, disconnects, timeout categories, disabled/broken sinks, overload limits and real HTTP late errors. Ordinary success traffic produces no per-request log.

## Account data and retention

`server/retention.js` keeps each account's newest 500 memories, 100 rooms, 200 activity
entries, 50 agent tasks and 200 personal notes. The limit runs after each write as a single
owner-scoped delete; a failed prune never fails the save that triggered it, and the next write
prunes again. Changing a limit changes what users keep, so update
[data-handling.md](data-handling.md) and the published policy with it.

`GET /api/account/export` returns the caller's records without credentials.
`POST /api/account/delete` requires `confirm: "delete_my_account"` and, for a registered
account, its PIN. It shares the sign-in attempt limiter, so repeated wrong PINs return 429
together with sign-in attempts from the same address. One `DELETE` on `users` cascades to every
owned table in both storage providers. Deletion does not reach backups: record how a restored
backup is reconciled with deletions made since it was taken before relying on backups.

Guest accounts that hold records and are never registered are not removed by any job. Decide a
retention period before launch; it needs a last-used timestamp, which is a reviewed schema
migration on Supabase.

## Deployment and incident gates

Permanent HTTPS hosting remains unselected. Before deployment, configure exact `PUBLIC_ORIGIN`, trusted CORS origins and verified proxy-hop count. Verify the mounted CA and restricted database readiness on that host, then exercise same-origin and Capacitor clients through its HTTPS ingress. One API instance remains the supported initial configuration until the in-memory authentication rate limiter has a reviewed shared replacement.

For the Render preview, follow the [README setup](../README.md). Set the restricted port-5432
session-pool URL privately and upload the trusted CA as the runtime secret file
`supabase-root-ca.crt`; the service reads `/etc/secrets/supabase-root-ca.crt`. The `node` user
already belongs to group 1000, which Render requires for runtime secret-file access.
`.dockerignore` excludes that filename and the image gate checks a synthetic CA canary.
Do not add secret build arguments or copy the workstation's private environment into the
image. [Render runtime secrets](https://render.com/docs/docker-secrets).

`RENDER_EXTERNAL_URL` supplies the exact HTTPS origin when `PUBLIC_ORIGIN` is unset. The
blueprint keeps `TRUST_PROXY_HOPS=0` until actual ingress/header behavior is verified and
disables automatic deployments. The auth limiter can group router traffic at that setting;
before public use, check actual visitor separation and spoofed `X-Forwarded-For` behavior,
then select the verified supported hop count. Keep one instance. Record the deployed commit,
CA readability, storage readiness, HTTPS cookies/origin rejection, signup, isolation and
restart persistence before sharing a functioning judge link. Camera, speech and device
accessibility need separate physical-device evidence.

Configure host alerts for availability, health-check failures, 5xx/timeout rates and resource saturation. Choose the provider log retention and access policy before enabling failure logs; this code does not send telemetry to a new external service. Exercise an outage and confirm alert delivery and recovery. Provider/model fallback measurements, telemetry retention, backup restoration, privacy/deletion policy and operator rollback rehearsal remain open release gates.

For an incident, preserve the generated request ID and sanitized category. Do not add request payloads, authorization headers, credentials or SQL results to troubleshooting logs. Verify restricted storage readiness, HTTPS ingress configuration and the chosen provider's operational status independently. Restore a previously reviewed app/API pair only with a compatible schema and a reconciliation plan for any new PostgreSQL writes; reverting to an old SQLite snapshot can lose data.
