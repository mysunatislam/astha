# Detailed view, Astha identity and locked-message permission review

This increment preserves the existing web/PWA, Maira backend and Capacitor application.
It adds no model, provider, database migration or Android permission.

| Issue and relevant files | Root cause | Smallest fix |
| --- | --- | --- |
| Camera validation was difficult to find: `tools/assessment.html`, `tools/base.html`, `tools/experience.js`, `tools/i18n.json` | The existing preview was buried under Settings → Camera and tools. Home intentionally hides it for the normal voice-first experience. | Add clearly labelled Detailed view buttons in Devices and Settings, reusing the Tools route and the single preview/overlay. Preserve Home. Support English/Bangla and spoken navigation. |
| Validation lacked a clear current result summary: `tools/vision-details.js`, capture/detection/overlay hooks in `tools/base.html`, `tools/build.py`, `tools/i18n.js` | The existing overlay did not expose its detector identity, frame freshness or result types in a dedicated table. Contextual relabelling could also change a detector label/score. | Present actual detector output and keep its original class/score. Distinguish YOLO26n from COCO fallback, detector boxes from CLIP ranking zones, and selected photographs from live views. Invalidate old results across Stop, source/account changes, backgrounding and lost/stale Pi frames. No simulated boxes or segmentation masks. |
| Spoken introduction used another identity: `tools/experience.js`, `tools/base.html`, `tools/i18n.json`, `tools/cloud.js`, `server/gemini.js` | The reported provider identity is absent from application source, so a provider profile is a possible cause, not a confirmed diagnosis. Greetings previously reached provider conversation. | Handle complete greeting/identity requests locally with exactly “Hello, I am Astha, your AI vision companion.” and the Bangla equivalent. Keep guided setup and message replies in control of their next answer. Reinforce the provider prompt without replacing names in OCR/document text. |
| Locked-message enable/recovery: `tools/messages.js`, `AsthaNativePlugin.java`, `AsthaMessageAssistant.java` | Enablement could overlook denied/blocked notifications or a late permission callback, and generic microphone feedback could identify the wrong missing capability. | Require current consent, foreground enablement and all required permission/notification states; invalidate superseded callbacks and recheck before service work. Explain the actual denied capability in English/Bangla. |

## Verification boundaries

- Source regressions exercise the real route, capture/overlay and message UI functions
  with controlled model/native stand-ins. They do not establish physical perception,
  microphone, notification delivery or TalkBack behavior.
- The final integrated check passed all 469 regressions, JavaScript syntax checks and
  reproducible web generation. Independent native policy/request-lifecycle compilation
  and tests passed 8/8 before the Android release build.
- Release lint caught a channel API guard that it could not establish for Android
  7 (API 24/25). The correction returns after the global notification check on those
  versions; channel creation/importance checks remain inside the explicit API 26+
  path. This preserves the minimum SDK instead of suppressing lint or raising it.
- An isolated headless Chrome run exercised the generated app at desktop and mobile
  widths, verified the exact English greeting, and checked the Devices entry and
  Bangla layout without horizontal overflow. Opening Detailed view requested neither
  camera nor microphone access.
- The same run used the official TensorFlow.js COCO demo photograph with the real
  COCO-SSD fallback. Seven detector boxes and their scores appeared in the actual
  preview and result table. YOLO downloads were blocked specifically to exercise
  fallback; YOLO accuracy, live cameras, Pi and segmentation were not tested by it.
- Review found and corrected a CLIP-only fallback regression: a fresh frame whose
  object detector is unavailable may retain actual CLIP search zones, without marking
  detection complete or accepting pending/failed detector output. Deferred-result
  regressions also prevent an old native-status read from reversing a newer disable.
- Result scores are model scores, not measured accuracy. Local model downloads and
  browser speech availability retain the existing platform/offline limits.

Release build, full regression, independent package and live deployment evidence are
recorded separately for the exact final commit. Until those checks succeed, this
document is a review of the increment, not a production-readiness declaration.

Locked-phone message delivery/reply, notification permission changes, local speech,
acoustic interruption and screen-reader use still require a real Android device.
An unfinished enable request is cancelled when the activity pauses. If an OEM's
permission dialog pauses the activity, the user must return and enable it again after
granting permission. A completed enable remains authorized across screen lock.
General background wake-word listening, arbitrary app control, proactive visual memory
and known-person recognition remain outside this increment and must not be claimed.
