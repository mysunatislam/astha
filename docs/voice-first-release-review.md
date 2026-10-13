# Voice-first ASTHA: what is built, what is simulated, what is pending

Status on 13 October 2026 for branch `feature/voice-first-continuation`. This supplements
the [source audit](source-audit-and-release-plan.md), the [native release notes](native-release.md),
the [Pi camera guide](pi-camera.md) and the [Braille controller design](braille-controller.md).

Three words are used precisely here:

- **Tested** means an automated test exercises the real code path. Unless stated, the
  microphone, camera, speaker, phone and network are stand-ins.
- **Simulated** means the code exists and is tested against a stand-in for hardware that
  has not been built or connected.
- **Pending** means it needs a physical device or a person and has not been done.

Nothing in this document has been verified on a physical phone, a Raspberry Pi or a
Braille controller, and no blind or low-vision person has tested it.

## How ASTHA decides when to speak

`tools/experience.js` owns this. It is state and cancellation, not prompt wording.

| Priority | What it is | Behaviour |
| --- | --- | --- |
| Critical | Stairs, a drop-off, or a vehicle approaching, detected from the image | Interrupts anything, including an answer. Raised only while the user has asked ASTHA to watch (surroundings mode, or the Safety shield switch). The same alert is not repeated within 8 s, and two alerts are at least 2.5 s apart. |
| High | The user's command and ASTHA's answer to it | Never held back. A newer command replaces an older answer. If an alert is being spoken, the answer waits for it and only the newest waiting answer is spoken. |
| Medium | Updates the user asked to keep receiving: surroundings changes, whiteboard changes, a nearby person or obstacle, camera link status | Wait until the user is not speaking and ASTHA is not answering, reading or working. Same update not repeated within 30 s; updates at least 4 s apart. |
| Low | Routine "there is a cup ahead" observations | Only in surroundings mode, with the same waiting rules. Never in ask or whiteboard mode. |

Other rules:

- **Stop** (voice, button, or all six Braille keys) silences everything including an alert,
  drops answers that have not been spoken yet, and holds back medium and low speech for
  10 s. It does not change the mode. "Stop updates" or "only when I ask" changes the mode.
- **Modes last until changed.** Ask (default), surroundings, whiteboard. A new session
  always starts in ask mode so camera analysis never resumes silently.
- **Stale visual work is cancelled** when the camera source changes, the account changes,
  the app goes to the background, a newer question arrives, or the Wi-Fi camera link
  drops. A cancelled answer is neither spoken nor saved to memory.
- In ask and whiteboard modes ASTHA says plainly that it is not watching for obstacles.

Why hazards are tied to "asked to watch": the detectors are image heuristics. In a
classroom a picture of a bus or the edge of a desk would otherwise trigger emergency
speech. This is a deliberate limit, and it means **ASTHA gives no hazard warnings in ask
mode**. It is not a collision-avoidance or navigation system in any mode.

One behaviour changed from the earlier uncommitted work: that version made every
image-derived warning wait for the current answer. Credible hazards now interrupt.

## The three example requests

| Request | What happens | Limits |
| --- | --- | --- |
| "Astha, I'm on a busy road. Keep updating me." | Surroundings mode: narration and hazard watching on, camera requested if off, spoken disclaimer that hazards can be missed. | Tested with stand-in detections. Detection accuracy, timing and usefulness outdoors are pending. Not validated for crossing roads. |
| "Astha, I'm in a classroom. Just update me about the whiteboard." | Whiteboard mode: every 12 s a fresh frame is read for board text, and changed text is spoken once. Routine objects are silent. Polling pauses while answering. | Needs online processing; with it unavailable nothing is invented and nothing is read automatically. Legibility at classroom distances is pending. |
| "Astha, where is my pink pen?" | Acknowledges, captures a fresh frame, asks the vision model with instructions to verify colour, object and position and to say when unsure. Offline, the local detector reports only an object class and rough position and says it cannot confirm colour or surface. "Check again" repeats with a new frame. | The wording is conservative; whether the model's answers are correct is pending measurement. |

## Interface

One task per screen, reachable by touch, keyboard and voice ("open devices", "সেটিংস"):

- **Home**: avatar with idle, listening, working and speaking states (also distinguishable
  without motion or colour), one microphone control, hands-free and online/offline
  switches, the focus selector with a one-line description, camera status, a typed
  request field, Repeat and Stop, and the caption of the last answer.
- **Camera and tools**: the camera view for sighted helpers, source selection, the action
  grid, reading transcript and shared-screen reader.
- **Memory**, **Devices**, **Personal setup**, **Settings**.

The avatar is decorative (`aria-hidden`) and nothing depends on it. The state line is a
live region only when ASTHA's own voice is off, to avoid two voices announcing each step.

Mulberry & Apricot is the default theme; the high-contrast themes remain. Sampled contrast
in the default theme: body text 11.3:1, text on apricot 6.1:1, control borders 4.0:1. At
375 px wide there is no horizontal scrolling and every button, menu and summary is at
least 44 px tall (measured in a desktop browser at that width).

**Pending:** TalkBack and VoiceOver, 200% text and reflow on a phone, switch access, and
whether a blind user can complete setup unaided. No WCAG conformance is claimed.

## Personal setup

Vision (four choices including "prefer not to say"), language, feedback style (full
speech, short speech, text only), devices used, which continuous modes appear on Home,
text size, colours, speaking speed and vibration. Each question is read aloud when focus
enters it, and a button reads the instructions.

Answers apply immediately through the existing controls, are saved on the phone, and sync
to the account through `/api/preferences` (see [data handling](data-handling.md)). They are
removed from the phone on sign-out. This is a statement of preference, not an assessment
of sight, and it does not change what ASTHA is able to detect.

## Capability table

| Area | State | Evidence and limits |
| --- | --- | --- |
| Speech priority, Stop, mode persistence, stale-answer cancellation | Tested | `test_speech_priority.mjs`, `test_experience.mjs` run the real manager, voice engine and live-detection path against a recording voice. |
| Home, pages, voice navigation, setup, account sync | Tested | `test_experience.mjs`, `test_preferences.mjs`, `test_i18n_release.mjs` (every label has Bangla and English). Viewed in a desktop browser. |
| Fresh-frame visual questions, whiteboard watching | Tested with a stand-in model | Real model accuracy pending. |
| Raspberry Pi camera bridge | Simulated | `test_pi_camera.mjs` including the Python handler. No Pi has run it. |
| Android device voice and speech recognition | Simulated | `test_native_device.mjs` against a stand-in plugin. The Java compiles and passes lint; it has not run on a phone. |
| Reading other apps on Android | Simulated | Same. Opt-in twice (ASTHA, then Android). Read-only; cannot tap, type or send. |
| Six-key Braille controller | Simulated | `test_braille.mjs`. Keyboard practice works in a browser. No controller exists; the Bluetooth transport has only met a stand-in. Android needs a native Bluetooth transport because the WebView has no Web Bluetooth. |
| Distance sensor | Interface only | `tools/sensors.js`. Nothing reports to it and no spoken distance uses it yet. |
| Hands-free wake word in the Android app | Not available | The WebView has no continuous recognizer. The microphone button works one request at a time. |
| Sending messages or operating other apps | Not built | Would need confirmation before every consequential action. Not started. |
| Bangla Braille | Not built | Needs a table reviewed by a Braille reader. |
| Offline use | Unchanged from before | First-use model downloads, cache eviction and device Bangla voices still need device testing. |

## Device acceptance checklist (all pending)

Record the commit, the APK hash, the phone model, Android and WebView versions.

- [ ] Install the debug APK. First launch reaches Home as a guest against the configured backend.
- [ ] Tap the microphone: permission prompt, chime, Bangla and English requests recognised.
- [ ] With the network off, ASTHA still speaks through the device voice. Note whether a Bangla voice exists.
- [ ] Ask a long question in surroundings mode while someone walks into view: the answer is not interrupted.
- [ ] Point at a staircase in surroundings mode during an answer: the alert interrupts, then the answer resumes or is replaced.
- [ ] Say "stop" during speech, during a pending answer and during an alert.
- [ ] Switch camera source during a pending answer: no old answer is spoken.
- [ ] Complete Personal setup with TalkBack on, with the screen off, and with a Braille display if available.
- [ ] Sign in on a second phone: the setup follows the account. Sign out: it is gone from the first.
- [ ] Devices → let ASTHA read other apps: both consent steps appear; "what is on my screen" reads; a password field is skipped; turning it off in ASTHA disables it in Android settings.
- [ ] The Pi camera checklist in [pi-camera.md](pi-camera.md).
- [ ] A Bangla-speaking blind tester reviews the spoken wording.
