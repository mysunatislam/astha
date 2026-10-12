# ASTHA operations and container verification

The existing Express application is retained. Its production image defaults to `DB_PROVIDER=supabase` and refuses startup when the restricted database configuration is missing. Development or legacy SQLite operation requires the explicit `DB_PROVIDER=sqlite` override and a persisted `/data` volume. The legacy paid Render blueprint explicitly selects SQLite; it is not the selected Supabase deployment configuration.

## Container and secrets

`Dockerfile` pins the official Node 24.21.0 Bookworm image by its verified multi-platform manifest digest. Digest references prevent the tag from silently selecting different base bytes; package repositories and npm distribution availability remain external build dependencies. Review base updates deliberately and rerun the image gate. [Docker FROM reference](https://docs.docker.com/reference/dockerfile/#from).

Supply `JWT_SECRET`, the restricted `SUPABASE_DB_URL` and Maira credentials through the chosen host's protected environment. Mount the project's trusted CA read-only and set `SUPABASE_DB_CA_FILE` to its path inside the container; a Windows workstation path is not a container path. Keep TLS verification enabled. Do not bake credentials or the CA path into frontend assets or an image. `.dockerignore` excludes environment files, databases, signing keys and local dependencies. It also omits the unverified historical `web/downloads/astha.apk`; that source archive is preserved separately and is not a reviewed production installer.

The image runs as `node`. `server/check-health.mjs` probes only the configured loopback port and `/api/health`, requires HTTP 200 with `ok=true`, rejects redirects and bounds both time and response size. It emits no response content. Docker runs that readiness check periodically. Readiness covers application storage, not provider availability or visual accuracy. [Docker HEALTHCHECK reference](https://docs.docker.com/reference/dockerfile/#healthcheck).

`node tools/check-container.mjs` builds a disposable context from tracked application files and synthetic canaries, never reading operator environment files. It checks image exclusion boundaries, nonroot writes, failed startup without selected Supabase configuration, healthy status, no-store health, unauthenticated denial, synthetic SQLite account/memory persistence across restart and graceful shutdown. Cleanup targets only generated container IDs, the verified labelled volume and this run's image. CI runs this gate after regressions and dependency audits. Actual image verification must be recorded from a passing hosted run; Docker is unavailable on the Windows workstation.

## Request monitoring

Every response receives a generated `X-Request-ID`. Caller-supplied IDs are ignored; trusted CORS responses expose this header. `server/observability.js` keeps process-local counters for a fixed set of route templates and HTTP status classes, with bounded latency histograms. These counters reset on restart and have no public endpoint. They are infrastructure diagnostics, without account identities, raw URLs, queries, request bodies, images, audio, phone numbers, tokens or error messages.

Set `ASTHA_LOG_REQUEST_ERRORS=1` to enable sanitized JSON lines for 5xx responses and aborted streams. The default is disabled. Logging is capped at 30 records per process per minute; counters retain all failures and record the dropped-log count. Each line contains only event, generated request ID, allowlisted method/route, status, bounded elapsed milliseconds and a fixed error category. Log-sink failures cannot change API behavior. Late errors close the response without forwarding an error object to Express's raw stack logger. Earlier body-parser errors preserve the existing bounded 400/413 JSON responses.

The focused regressions cover sensitive markers in paths, queries, bearer headers, bodies and error objects, variable resource IDs, duplicate finish/close events, disconnects, timeout categories, disabled/broken sinks, overload limits and real HTTP late errors. Ordinary success traffic produces no per-request log.

## Deployment and incident gates

Permanent HTTPS hosting remains unselected. Before deployment, configure exact `PUBLIC_ORIGIN`, trusted CORS origins and verified proxy-hop count. Verify the mounted CA and restricted database readiness on that host, then exercise same-origin and Capacitor clients through its HTTPS ingress. One API instance remains the supported initial configuration until the in-memory authentication rate limiter has a reviewed shared replacement.

Configure host alerts for availability, health-check failures, 5xx/timeout rates and resource saturation. Choose the provider log retention and access policy before enabling failure logs; this code does not send telemetry to a new external service. Exercise an outage and confirm alert delivery and recovery. Provider/model fallback measurements, telemetry retention, backup restoration, privacy/deletion policy and operator rollback rehearsal remain open release gates.

For an incident, preserve the generated request ID and sanitized category. Do not add request payloads, authorization headers, credentials or SQL results to troubleshooting logs. Verify restricted storage readiness, HTTPS ingress configuration and the chosen provider's operational status independently. Restore a previously reviewed app/API pair only with a compatible schema and a reconciliation plan for any new PostgreSQL writes; reverting to an old SQLite snapshot can lose data.
