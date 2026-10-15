# Part 1: remaining requirements and release gates

Prepared 15 October 2026 against the source reviewed at `0be7a8a`, plus the current
incremental Stop, timing and native speech privacy work. Deliver the reviewed web app
first, then build an APK from that exact reviewed commit. This is a requirements and
verification plan, not a declaration that all ten requested areas work.

Preserve the existing plain JavaScript/PWA, Python asset builder, Node API, Maira
integration, restricted Supabase storage and Capacitor projects. Do not replace the
working application, add another provider, migrate the database or silently enable
observation/enrollment to satisfy this list.

## Evidence and priorities

- **Implemented / automated** means the real code path is exercised with controlled
  browser, model or native-plugin stand-ins. It does not establish perception accuracy.
- **Hardware checked** identifies the specific physical link exercised. It does not
  establish the complete phone-to-answer experience.
- **Pending** means no sufficient verification exists. Proposed acceptance budgets are
  engineering targets, not measured performance or a product promise.
- **P0** blocks distribution of the affected behavior. **P1** is needed for the claimed
  Part 1 capability; a limited preview must identify its absence. **P2** follows the
  stable core and must not delay correctness or accessible recovery.

| Evidence on this date | Verified boundary | Still unverified |
| --- | --- | --- |
| Final integrated check `part1-final-check-2026-10-15-r2.log` | All 446 regressions, syntax and reproducible web generation passed after extending cancellation to local perception/identification and adding explicit Android backup/transfer exclusions. | Device behavior, actual backup/restore and visual or spatial accuracy are not established by these checks. |
| Integrated Part 1 check `part1-integrated-check-2026-10-15.log` | All 423 regressions, JavaScript syntax and reproducible web builds passed after the cancellation, diagnostic and native speech policy changes. Root/server npm audits each reported zero vulnerabilities. | Physical speech recognition, acoustic interruption, model accuracy and phone behavior are not established by these tests. |
| Existing baseline log `part1-baseline-check-2026-10-15.log` | Reproducible generated assets, JavaScript syntax and 374 regressions passed in the recorded run. | Changes after that run require the integrated check again. |
| Focused review run | 99/99 tests passed across `test_speech_priority.mjs`, `test_experience.mjs`, `test_measured_distance.mjs`, `test_pi_camera.mjs`, `test_offline_release.mjs`. | Models, devices and recognition/synthesis engines are stand-ins, except the Python loopback handler. |
| Native speech privacy increment | 36/36 focused native-device, message and speech-privacy regressions passed. Defaults require local STT/TTS; explicit permission is needed for a network-capable foreground engine. | Java compilation/lint and physical engine behavior must be recorded for the final increment. |
| `pi-hardware-verification-2026-10-15.md` | Actual Pi 4 Model B, NoIR IMX219, Picamera2; authenticated TLS camera over Wi-Fi at about 4 frames/s, 640×480. Missing/wrong token and disallowed origin were refused. | Phone pairing, Android release certificate trust, NoIR color accuracy, sustained battery use and image-to-spoken-answer delay. |
| Same hardware record | HC-SR04 → ESP32 → Pi telemetry: 10 readings/s; delivered sample age median 50 ms, maximum 100 ms during that check. | Accuracy against measured distances and app use on a real phone. MPU6050 was not detected and was deferred. |
| Earlier signed APK/AAB evidence | Signed artifacts exist for exact commit `885001f`; signatures, packaged backend/source identity and AAB structure were checked. | Those artifacts do not contain later Part 1 changes and must not be relabeled as the new build. No phone install or Play upload is established. |

The blanket “no Pi has run it” statements in older review documents are superseded only
by the specific hardware results above. Their phone, Braille and blind-user testing
limits remain valid. Update those older statements when publishing the final review.

### This increment

Voice Stop uses the shared cancellation path, including pending online requests, OCR,
placement, agent work and reading. It releases the foreground busy state immediately;
late work cannot release a newer action's lock. Exact Stop commands in Bangla and English
are supported without treating a bus stop or quoted instruction as a command. Recognition
events are simulated in regressions; human speech and loudspeaker echo still need a real
device test.

Final review extended the same boundary through local descriptions, spatial answers,
object identification, clothing, mirror refinement, still-image hazard checking and
pending camera actions. Their root cause was inference continuing after the audio had
stopped: `withBusy` cleanup alone did not guard the callback's own speech or state writes.
The smallest fix carries `captureLocalActionGuard()` across each awaited model stage in
`tools/base.html`, `tools/build.py`, `tools/perceive.js`, `tools/spatial.js` and the relevant
`tools/module.js` / `tools/cloud.js` helpers. Explicit Stop also clears pending camera
reading/actions in `tools/offline.js`. Deferred-result regressions exercise the actual
actions with synthetic model results; ordinary successful descriptions remain covered.

The optional Camera and tools → Vision diagnostics panel adds local-only object-detection,
online-reasoning and speech-request-to-first-audio-event timings to the existing real
preview/boxes. It starts disabled, clears on closing/background/source change, and records
no images, prompts or transcripts. Native first-audio, wake-word, transcription and
complete image-to-answer timings remain unmeasured. The panel was inspected in a desktop
browser in Bangla and English with the camera off and online processing declined.

Android now declares explicit legacy, cloud-backup and device-transfer exclusions for
all documented app-storage domains in `android/app/src/main/res/xml/astha_backup_rules.xml`
and `astha_data_extraction_rules.xml`, linked by `AndroidManifest.xml`. The existing
`allowBackup=false` alone did not address every manufacturer's device-transfer behavior.
XML/manifest regression checks pass; actual OEM restore testing remains pending.
[Android backup configuration](https://developer.android.com/identity/data/autobackup).

Native STT/TTS default to installed on-device engines. An online-capable foreground
engine requires an explicit processing option supplied only after session consent;
background message speech remains local-only. A request identity spans permission
dialogs and queued callbacks, so Stop, app pause/destruction or replacement invalidates
it before microphone capture can start. Four pure Java request-lifecycle tests passed;
Android compilation, lint and artifact results are recorded with the candidate build.

## 1. Fully hands-free voice activation — P1, with P0 privacy boundaries

**Requested:** optional voice enrollment, “Astha” activation, continuous interaction,
Android background operation where permitted, preferably on-device.

**Current:** `tools/module.js` has foreground `SiriVoice` using Web Speech; the app hides
hands-free controls when continuous recognition is unavailable. `tools/offline.js`
provides push-to-talk/Whisper fallback. Android has bounded one-request recognition and
an explicitly enabled message service, not a general wake-word engine. Voice templates
in `tools/cloud.js` do not establish a validated speaker-verification or wake-word system.

**Gap / root cause:** browser recognition and page lifetime cannot provide a dependable
locked/background assistant. Existing speech APIs are being mistaken for a local wake
word. Enrollment is not a microphone permission or authorization to run indefinitely.

**Smallest safe work:** preserve one-tap input and explicit capability explanations now.
Keep local-only recognition the default in `web/native-device.js` and
`AsthaNativePlugin.java`; use the existing local fallback when unavailable. Treat a real
local wake-word engine as a separate Android increment: explicit opt-in, visible
microphone foreground-service state, Stop control, lifecycle cleanup and bounded power
use. Do not implement it by endlessly restarting the ordinary recognizer. Existing
voice enrollment must stay optional and must not gate essential access.

**Acceptance:** Bangla/English foreground requests, missing engine/language, denied
microphone, offline cold start and user cancellation all have spoken/text recovery.
Before claiming background wake: measure false wakes/misses, lock/unlock, calls, audio
focus, permission revocation, battery saver and a sustained session on real phones.
No microphone survives opt-out. Record supported device/API/language combinations.

Browser Web Speech can use a server and is not universally available; hidden pages can
freeze or be discarded. An always-available browser wake word is therefore not a
supported release promise. [Web Speech](https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognition),
[browser lifecycle](https://developer.chrome.com/docs/web-platform/page-lifecycle-api).

Android documents that its ordinary recognizer can stream audio and is unsuitable for
continuous recognition. On-device recognition requires a supported API 31+ service;
API 33 can report installed languages. Microphone foreground services require the
relevant permission and obey background-start restrictions.
[SpeechRecognizer](https://developer.android.com/reference/android/speech/SpeechRecognizer),
[language support](https://developer.android.com/reference/android/speech/RecognitionSupport),
[microphone service restrictions](https://developer.android.com/develop/background-work/services/fgs/service-types#microphone).

## 2. ASTHA as the central AI controller — P0 action boundaries, P1 coverage

**Current:** `tools/module.js`, `tools/experience.js`, `tools/agent.js`, `tools/cloud.js`
and `tools/screen-access.js` route supported requests. Camera use is permission based.
Android notifications and replies use `tools/messages.js`, `web/native-device.js`,
`AsthaNotificationListener.java`, `MessageTargets.java` and `AsthaMessageAssistant.java`.
Replies bind confirmation to one expiring notification revision. Opening apps or sharing
text uses ordinary Android intents; browser screen sharing does not control other apps.

**Gap / root cause:** a general language-model answer or plan is not evidence that a
tool executed. “Read latest messages” currently means available consented notifications,
not arbitrary messaging history. Browser and Android capabilities differ.

**Smallest safe work:** retain one explicit tool capability/permission contract in the
existing dispatcher. Check source freshness, app visibility, account and consent before
execution and before consuming results. Unsupported tools must explain the limitation.
Sensitive actions require a separate read-back and strict confirmation tied to immutable
target and content; model output cannot bypass that boundary.

**Acceptance:** camera off, no notification access, removed/changed notification,
wrong account, denied screen access and unsupported browser actions never produce
claims of success. “Yes, don't send”, noise, silence and stale confirmations send
nothing. A real messaging-app test confirms the exact conversation and text. Preserve
`test_agent_bounds.mjs`, `test_agent_evidence.mjs`, `test_messages.mjs` and native tests.

## 3. Consented proactive visual memory — P1, not currently implemented as requested

**Current:** explicit object/room memory exists in `tools/module.js`, `tools/offline.js`,
`server/memory.js` and account-scoped storage. Tests deliberately prevent passive
observations from automatically saving memory. Recall uses historical last-seen wording.

**Gap / root cause:** the current consent contract authorizes explicit saves. Turning on
a camera is not consent for background storage. Raw detector scores are not calibrated
probabilities, and a camera cannot observe an object outside its current view.

**Smallest safe work:** add a separate, initially off “remember observed objects” choice
only after its retention/deletion behavior is reviewed. Use a bounded, deduplicated
observation buffer while a fresh camera is active; promote only permitted observations
through the existing owned-memory API. Store observation time, source and object label;
store place only when actually supported. Distinguish visible evidence, user-provided
location and inference. Verify the existing record validation before adding fields;
do not introduce a schema migration as part of this stabilization pass.

**Acceptance:** no memory writes before consent, with inactive/stale camera, in Privacy,
after sign-out or from late results. Repeated frames do not flood storage. Revocation
stops capture/storage promptly. Recall says “last seen” with time and uncertainty;
it never converts a historic location into a current sighting. Delete works offline and
after reconnect, including an in-flight save. Add tests beside `test_offline_release.mjs`,
`test_account_data.mjs`, `test_async_agent_storage.mjs` and `test_spatial_memory.mjs`.

## 4. Immediate spoken interruption — P0

**Current:** `tools/experience.js`, `tools/module.js` and `tools/offline.js` have user
Stop, speech priority, cancellation generations and stale-result guards. Touch/Braille
Stop already reaches the shared stop path. The current increment unifies the Siri
interim/final Stop path so pending answers cannot resume after a spoken interruption.

**Gap / root cause:** stopping audio alone leaves synthesis, reasoning or queued answers
alive. A recognizer may be suspended or echo-filtered while ASTHA speaks, so a text-level
Stop test does not prove that a real user can interrupt long TTS.

**Smallest safe work:** route “Stop”, “Astha stop”, “don't talk” and Bangla equivalents
to one cancellation boundary before ordinary intent handling. Abort outstanding work,
clear pending speech/drafts, invalidate late results and suppress routine updates for
the existing quiet period. Preserve the chosen mode. Return to listening only when the
user has enabled a supported foreground listener; never silently open a new microphone.

**Acceptance:** exercise interim and final recognition during long TTS, pending network
audio, an urgent alert, a silent reasoning interval and before/after source changes.
No late speech or memory save may escape. Button/type/Braille Stop must remain usable
without speech recognition. Measure physical stop-to-silence separately from recognition
delay; do not claim the old “<50 ms” comment as measured performance.

## 5. Reliable agent architecture — P0 correctness, P1 capability

**Current:** existing LLM/Maira routes, tool dispatch, retrieval, visual processing,
STT/TTS and session/account state remain in `tools/agent.js`, `tools/cloud.js`,
`tools/experience.js`, `tools/module.js`, `server/agent.js`, `server/rag.js` and storage
routes. Bounded tool/agent tests exist. Some planning is heuristic and reports a need
for verification rather than successful execution.

**Gap / root cause:** several modules own overlapping speech/listening/busy flags.
Crossing request, account, camera and permission lifetimes can admit an old result.
Retrieval relevance and actual perception/provider quality are not established by mocks.

**Smallest safe work:** use the existing generation/cancellation owner consistently;
carry one task/source/account identity through perception → reasoning → speech and
memory effects. Keep errors typed and bounded. Short-term conversation context must
not silently become long-term memory. Preserve local answer paths when cloud fails;
never invent tool results or treat a model's own self-check as external verification.

**Acceptance:** provider timeout/401/429/malformed output, irrelevant retrieved notes,
new request, sign-out, Privacy, hidden page and source switch all reach a coherent state
without stuck busy/microphone flags or stale speech. Every reported action has tool
evidence. Use agent bounds/evidence/client/server, account and TTS resource regressions;
run real-provider quality checks separately with authorized non-personal fixtures.

## 6. Response speed and fast local cues — P0 for misleading urgent claims, P1 latency

**Current:** local detection and advisory hazard cues exist; Pi polling keeps only the
newest frame. The current increment adds optional metadata-only timing diagnostics.
No physical 50-second incident or end-to-end latency distribution has been reproduced.

**Gap / root cause:** cold model loads, STT end-of-speech delay, cloud reasoning and
speech startup can accumulate. One total elapsed time cannot identify the bottleneck.
A visual model cannot establish a person's intention to attack from an image.

**Smallest safe work:** instrument actual wake/activation, speech-end → transcript,
capture/detection, reasoning and first audible speech as separate stages. Start with
existing `tools/diagnostics.js`, `tools/module.js`, `tools/offline.js`,
`tools/experience.js`, `tools/base.html`, `tools/perceive.js` and
`server/observability.js`; do not place private content in telemetry. Show cold/loading
state, use one inference at a time, avoid old-frame queues and speak short useful
local evidence before optional lengthy cloud detail. Do not call an uncertain person
an attacker or a direction safe. Keep advisory cues available only in an opted-in mode.

**Acceptance:** publish cold/warm p50/p95 for each stage on named devices with at least
20 controlled samples per scenario, including poor/offline network. Proposed first
targets: visible/local acknowledgment within 200 ms and Stop handling within 250 ms
after the command is delivered to the app; measure and revise rather than claim these
targets are achieved. Report recognition delay and actual audio onset separately.
Pi's 4 frames/s throughput is not reasoning speed or a collision-avoidance guarantee.

## 7. Optional known-person learning — P1, needs a separate consented increment

**Current:** `tools/cloud.js` contains face/voice enrollment code and account-scoped
template guards. It is not a validated familiar-person alert workflow. The roadmap
defers consented per-person on-device matching. No identification accuracy is established.

**Gap / root cause:** a template, a name and a classifier result do not provide enrollment
consent, robust identity, relationship knowledge or a deletion lifecycle. Visible facial
expression and movement cannot establish emotion, intent or a relationship.

**Smallest safe work:** leave existing enrollment optional. Before enabling familiar
person alerts, review storage/protection and per-person consent, teach/correct/delete
flows, account isolation and retention. Store relationship only from the user's explicit
description. Prefer on-device matching with an unknown/uncertain result and rate-limited
announcements. Do not collect new faces or add a biometric provider during this pass.

**Acceptance:** consent denial, two similar people, poor light, NoIR images, partial
faces, unfamiliar people, deleted templates and account changes cannot produce confident
names. Display/speak uncertainty and only observable movement/expression. A consenting
test group reviews false identifications and wording before identity alerts are enabled.
Identity enrollment must never substitute for PIN/session authentication.

## 8. Optional Camera/Vision Debug — P1 diagnostics, normal use remains voice first

**Current:** camera/Pi preview, detected boxes/labels, local model state and optional
timing infrastructure exist in `tools/base.html`, `tools/pi-camera-ui.js`,
`web/pi-camera.js`, perception modules and `tools/diagnostics.js`.

**Gap / root cause:** screenshots/demo scenes, model scores and end-to-end timings can
be mistaken for live camera evidence, confidence or measured performance. A displayed
old box can refer to a previous frame/source.

**Smallest safe work:** make debug explicitly optional. Show the actual selected frame,
source state/age, real boxes/labels/raw model scores, active model/backend and real
measured stage durations. Label demo/still images and scores as such. Clear overlays
and timings on source change, Stop/invalidated request and camera loss. Default
diagnostics to off; keep only bounded numeric metadata in memory, with no automatic export.

**Acceptance:** no camera/empty detector means no fabricated boxes. Old frames/results
cannot populate a new source. Delayed results keep their original task identity. The
same feature remains operable with debug hidden. Debug contains no pairing token, raw
transcript, image upload, private note, person name, session secret or provider key.

## 9. Accessibility-first setup, navigation and recovery — P0 core access

**Current:** `tools/base.html`, `tools/i18n.json`, `tools/experience.js`,
`tools/braille.js`, Pi controls and native bridges provide a voice-led Home, semantic
controls, captions, haptics, high contrast, text size and guided Bangla/English setup.
Recorded desktop audits found named controls and narrow-screen reflow. They are not a
phone screen-reader or WCAG certification. A physical Braille controller is unverified.

**Gap / root cause:** permission denial, missing Bangla voices, offline models not yet
downloaded, native settings detours and camera failure can strand a voice-first user.
On a device with no local Bangla voice, the online-consent question may only be voiced
in English. Broad cloud consent must not be assumed to resolve that bootstrapping issue.

**Smallest safe work:** preserve keyboard/touch/type alternatives and accessible modal
focus. Explain each capability before its own permission prompt; keep navigation,
cancel/repeat/help and camera/message connection status available in both languages.
Validate separate UI/speech preferences. Use spoken plus caption/haptic failure cues
when possible; a missing speech engine must leave clear text and reachable controls.

**Acceptance:** a Bangla-speaking blind tester completes first launch, decline/retry
permissions, setup, navigation, camera/Pi failure, message opt-out and deletion unaided.
Test TalkBack, large text/reflow, headphones and voice-off without double announcements.
Test foreground/background return and no internet. Braille key simulation cannot close
the physical-controller or Android Bluetooth transport requirement.

## 10. Privacy, enrollment, observation and deletion — P0

**Current:** session remote-processing consent, Privacy/On-device modes, guarded owned
memory/preferences and deletion retries exist. Pi pairing stays in session memory and
uses HTTPS, token/origin checks and no ASTHA cookies. The native increment requires a
local recognizer/installed non-network voice by default, including background messages.

**Gap / root cause:** OS microphone permission is not permission to send speech online;
`isLanguageAvailable()` alone does not prove TTS is local. Camera activity is not consent
to proactive memory or face learning. Debug/audit text must not overstate these limits.

**Smallest safe work:** propagate explicit local-only policy at each native STT/TTS call;
fail closed and explain unavailable language/engine. Keep camera, cloud processing,
proactive storage, biometric enrollment, screen access and locked-message microphone
choices distinct and revocable. Invalidate in-flight effects on revocation/account
change. Review local logs/exports as well as server telemetry for content retention;
never send personal speech to monitoring as timing data.

**Acceptance:** test a denied cloud consent with network-capable default OS engines;
neither STT nor local-only TTS may select them. Revoking any capability stops its work.
Deleting observations/templates accounts for local caches, queued writes and remote
records without deleting unrelated data. No current-sighting claim is allowed with an
inactive/stale camera. Notifications/message speech follow the disclosed processing
choice, including any permitted remote TTS. Verify behavior on real Android engines.

Android's documented embedded-voice selection checks
`Voice.isNetworkConnectionRequired()`; voices marked not installed may trigger downloads
when selected. [Android voice selection](https://developer.android.com/reference/android/speech/tts/TextToSpeech.Engine).

## Web-first delivery and APK follow-up

1. Finish P0 cancellation, native privacy and stale-task boundaries; integrate focused
   regressions and optional real-data diagnostics. Run `npm run check` after integration,
   then inspect the built Bangla/English app in a browser with debug both off and on.
2. Verify deployed asset identity, guest/session flow, consent rejection, permitted
   Maira flow, provider failure, Stop and offline recovery. Keep genuinely unavailable
   wake-word, proactive-memory and known-person capabilities labeled as pending.
3. Record the exact reviewed commit; rebuild/sync Capacitor from that commit. Run Android
   JVM tests, lint and debug build before signed APK/AAB tasks. Verify signatures,
   package/version, non-debuggable release manifest, backend identity and all generated
   native/web assets. Supply hashes and record real toolchain/cache limitations.
4. Close the Pi release trust gap deliberately: current Android configuration trusts
   user-installed private CAs only in debug builds. A private-CA Pi test does not prove
   signed-release pairing. Choose a narrowly scoped trusted certificate strategy in
   `android/app/src/main/res/xml/network_security_config.xml`; never bypass TLS or enable
   global user-CA/HTTP trust. Test the actual release APK and camera together.
5. Install and exercise the signed build on real phones with the checklist above.
   Store upload, iOS signing/TestFlight and general background wake-word readiness
   remain separate release work; a web deployment cannot establish them.

Before marking Part 1 complete, retain evidence for all ten areas and explicitly list
any capability excluded from the release. Passing source/mock tests alone is insufficient
for hands-free availability, latency, visual accuracy, identity or mobility claims.
