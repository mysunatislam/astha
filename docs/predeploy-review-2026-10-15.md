# Voice-first preview deployment review — 15 October 2026

The continuation branch retains the Mulberry & Apricot interface, Bangla/English setup,
voice-led home, continuous reading, current-frame questions and the paired Pi camera
adapter. The server continues to hold Maira credentials and use the existing restricted
Supabase schema. This review does not certify navigation safety or hardware readiness.

## Issues fixed before merging

| Issue and root cause | Smallest fix and relevant files | Verification |
| --- | --- | --- |
| A reply such as “yes, don't send it” matched an affirmative prefix. | Match the complete confirmation utterance in `tools/messages.js` and Android `MessageCommands.java`; mixed or uncertain speech cannot send. | JS negative-phrase regressions and Android command tests. |
| A notification could change while its old message was being confirmed. | Give each notification revision an expiring, single-use target in `MessageTargets.java`; revalidate its publisher, message and original reply action in `AsthaNotificationListener.java`. A revision cancels the old confirmation in both message assistants. | Target replacement/removal/expiry/reuse tests and frontend revision regression. |
| Hidden-page callbacks could speak; a failed native TTS prompt could open the confirmation microphone. | Restrict foreground callbacks to a visible app; clear hidden-page drafts; require successful prompt completion before listening in `AsthaMessageAssistant.java`. | Hidden-page and failed-prompt regressions; physical-device behavior remains pending. |
| Setup answers bypassed personal-data synchronization rules. | Include `/api/preferences` in the API privacy guard (`tools/module.js`); guard local writes and remote requests in `tools/experience.js`, invalidate pending requests on Privacy/Offline, retry only after explicit online permission in `tools/cloud.js`. | Consent, offline, privacy, account change, newer save and late-response tests. |
| Concurrent first saves could create duplicate preference records. | One deterministic primary key and guarded atomic upsert in `server/preferences.js`; support the static upsert syntax in `server/postgres.js`. Clean only the owner's reserved legacy duplicates. | Concurrent HTTP tests and actual local PostgreSQL with forced RLS; ordinary notes and other accounts preserved. |
| An unrelated Pages publishing job ran on every merge despite Render being the host. | Require repository variable `ASTHA_ENABLE_PAGES=true` and the main ref in `.github/workflows/pages.yml`. The regular CI workflow remains unconditional. | Workflow source review; CI still checks builds, regressions, advisories and container behavior. |

The combined local check passed 361 regressions, JavaScript syntax and reproducible
generated assets. Root and server dependency audits reported zero vulnerabilities.
Known private provider/database/session/signing values were absent from review files and
delivery artifacts. CI and Render results are recorded separately after publication.

No schema migration or credential replacement is required for this deployment. The
existing six tables and restricted database role remain the contract.

## Release limits

The Pi camera, Braille controller, screen reading, notification replies and locked-phone
microphone service still need tests on real hardware. Android debug build success does
not prove device behavior. The web preview cannot operate other apps through browser
camera permission. No signed Play release is claimed by this web deployment.

Run the device acceptance checklist in `voice-first-release-review.md` before distributing
the Android app as a production assistive product. Continuous-reading and question
answers must be evaluated with blind users; image-derived hazard cues cannot establish
a safe walking or crossing route.
