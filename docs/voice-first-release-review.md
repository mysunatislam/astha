# Voice-first ASTHA: what is built, what is simulated, what is pending

Status on 15 October 2026 for branch `feature/voice-first-continuation`. This supplements
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
| Medium | Updates the user asked to keep receiving: surroundings changes, changed text during continuous reading, a new message (Android), a nearby person or obstacle, camera link status | Wait until the user is not speaking and ASTHA is not answering, reading or working. Same update not repeated within 30 s; updates at least 4 s apart. |
| Low | Routine "there is a cup ahead" observations | Only in surroundings mode, with the same waiting rules. Never in ask or continuous-reading mode. |

Other rules:

- **Stop** (voice, button, or all six Braille keys) silences everything including an alert,
  drops answers that have not been spoken yet, and holds back medium and low speech for
  10 s. It does not change the mode. "Stop updates" or "only when I ask" changes the mode.
- **Modes last until changed.** Ask (default), Awareness (surroundings), continuous reading. A new session
  always starts in ask mode so camera analysis never resumes silently.
- **Stale visual work is cancelled** when the camera source changes, the account changes,
  the app goes to the background, a newer question arrives, or the Wi-Fi camera link
  drops. A cancelled answer is neither spoken nor saved to memory.
- In ask and continuous-reading modes ASTHA says plainly that it is not watching for obstacles.

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
| "Astha, I'm in a classroom. Just update me about the whiteboard." | Continuous reading: every 12 s a fresh frame is read for text, and changed text is spoken once ("It now reads: …"). Routine objects are silent. Polling pauses while answering. The same works for a page, a slide, a tablet or a screen ("keep reading", "watch the screen"); "stop reading" ends it. | Needs online processing; with it unavailable nothing is invented and nothing is read automatically. Legibility at classroom distances is pending. |
| "Astha, where is my pink pen?" | Acknowledges, captures a fresh frame, asks the vision model with instructions to verify colour, object and position and to say when unsure. Offline, the local detector reports only an object class and rough position and says it cannot confirm colour or surface. "Check again" repeats with a new frame. | The wording is conservative; whether the model's answers are correct is pending measurement. |

## Interface

One task per screen, reachable by touch, keyboard and voice ("open devices", "সেটিংস"):

- **Home** (redesigned 14 October to follow the owner's mockup): a status line (which
  camera is connected), one large card with ASTHA's presence orb, her state ("I'm here with
  you", listening, working, speaking) and a large **Talk to ASTHA** button; then four
  essentials: **Explore** (describe the surroundings), **Read** (any text: a page, a board,
  a slide, a screen), **Remember** (saved memories) and **Awareness** (a switch for
  surroundings updates). Typing is folded under **Type instead**. Repeat, Stop and the
  caption of the last answer stay.
- A bottom tab bar: **Home**, **Memories**, **Devices**. A settings button in the header
  opens **Settings**, which holds the voice, online/offline and hands-free switches,
  **Personal setup** and **Camera and tools**.
- **Camera and tools**: the camera view for sighted helpers, source selection, the action
  grid, reading transcript and the screen helper. The screen helper is not limited to code:
  **Explain what is on my screen** explains slides, documents, designs, web pages or code.
  The former "add VS Code" option is gone.

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
speech, short speech, text only), devices used, whether Awareness is on at Home,
text size, colours, speaking speed and vibration. Each question is read aloud when focus
enters it, and a button reads the instructions.

**Answering by voice.** "Start guided setup" (or the **Answer by voice** button) asks the
four main questions one at a time and listens after each: vision, language, feedback
style, and whether surroundings updates should be on at Home. Answers can be a
number or a word, in Bangla or English. "Repeat", "back", "skip" and "cancel" work at any
point, and nothing is saved until the last answer. While the guide is running every
request is treated as an answer, so saying "one" cannot trigger another feature. Devices
and display settings stay in the form.

Answers apply immediately through the existing controls, are saved on the phone, and sync
to the account through `/api/preferences` (see [data handling](data-handling.md)). They are
removed from the phone on sign-out. This is a statement of preference, not an assessment
of sight, and it does not change what ASTHA is able to detect.

## Capability table

| Area | State | Evidence and limits |
| --- | --- | --- |
| Speech priority, Stop, mode persistence, stale-answer cancellation | Tested | `test_speech_priority.mjs`, `test_experience.mjs` run the real manager, voice engine and live-detection path against a recording voice. |
| Home, pages, voice navigation, setup, account sync | Tested | `test_experience.mjs`, `test_preferences.mjs`, `test_i18n_release.mjs` (every label has Bangla and English). Viewed in a desktop browser. |
| Fresh-frame visual questions, continuous reading | Tested with a stand-in model | Real model accuracy pending. |
| Screen helper on a computer (explain slides, documents, designs, code) | Built | The control and its route exist and were viewed in a desktop browser. Explanation quality depends on the online model and is pending. |
| Raspberry Pi camera bridge | Simulated | `test_pi_camera.mjs` including the Python handler. No Pi has run it. |
| Android device voice and speech recognition | Simulated | `test_native_device.mjs` against a stand-in plugin. The Java compiles and passes lint; it has not run on a phone. |
| Reading other apps on Android | Simulated | Same. Opt-in twice (ASTHA, then Android). Read-only; cannot tap, type or send. |
| Six-key Braille controller | Simulated | `test_braille.mjs`. Keyboard practice works in a browser. No controller exists; the Bluetooth transport has only met a stand-in. Android needs a native Bluetooth transport because the WebView has no Web Bluetooth. |
| Distance sensor | Hardware link verified; app side simulated | HC-SR04 on an ESP32 → Pi `/telemetry` verified on hardware (10 readings a second, at most 100 ms old). The app's use of it (`test_pi_camera.mjs`, `test_measured_distance.mjs`) is tested with stand-ins; not yet run on a phone, and accuracy at known distances is unmeasured. |
| Hands-free wake word in the Android app | Not available | The WebView has no continuous recognizer. Where that is the case the hands-free button is hidden and asking for it is explained, instead of failing silently. The microphone button works one request at a time. |
| Opening an app, preparing a message (Android) | Simulated | "Open the WhatsApp app" finds the app by its launcher name and asks before opening. "Write a message saying …" asks, then opens Android's share menu with the text; the user chooses the app and the person and presses send. ASTHA cannot address or send anything. |
| Message agent (Android) | Simulated | `test_messages.mjs` runs the page side against a stand-in; `MessageCommandsTest` (JVM) covers the spoken answers; `test_native_device.mjs` checks the guardrails. Not run with a real messaging app. |
| Messages with the phone locked (Android) | Simulated | The service compiles and passes lint. Whether the recognizer works with the screen locked, and how each phone's battery saver treats the service, are pending. |
| Operating other apps (tapping, typing) | Not built | Deliberately out of scope for now; the accessibility service has no such powers. Replying to a message notification is the one way ASTHA writes into another app. |
| Bangla Braille | Not built | Needs a table reviewed by a Braille reader. |
| Offline use | Unchanged from before | First-use model downloads, cache eviction and device Bangla voices still need device testing. |

## Messages: the personal agent (Android)

The owner asked for ASTHA to act as a personal agent for messages: tell the user that
someone has written, read it, and send the reply they dictate. This is built for the
Android app; a browser shows a note that it lives there.

1. **Two consents.** Devices → Messages → *Let Astha read and answer my messages* explains
   what happens, then opens Android's notification access settings, where Android shows
   its own warning. Either step alone does nothing.
2. **Announcing.** For a conversation notification (Messenger, WhatsApp, SMS apps and
   others), ASTHA says "New message from Messenger, Rina: Are you coming? Say reply and
   your answer, say suggest a reply, or say ignore." It waits for the user to finish
   speaking and for any answer in progress, like other requested updates.
3. **Answering.** "Reply I'm on my way" (or "উত্তর দাও আসছি") reads the words back and asks
   for a yes. Only a clear yes sends. "Suggest a reply" asks the online model for a short
   draft, only when online processing is allowed, and that draft is read back the same way.
   "Change" lets the user say it again; "no", "cancel", silence or noise sends nothing.
4. **Sending** goes through the messaging app's own reply action, to the conversation the
   notification belongs to. ASTHA cannot start a new conversation, choose a recipient,
   text or call anyone.
5. **With the phone locked.** A separate, off-by-default switch, *Also read messages aloud
   when the phone is locked*, starts a foreground service (type microphone) while ASTHA is
   not on screen. It shows a notification with **Turn off** for as long as it runs, opens
   the microphone for about nine seconds only right after it has spoken, waits while a call
   is in progress, lowers music while it talks, and never starts by itself after a reboot.
   Withdrawing the message consent stops it.

Nothing a message says is stored or logged. Message text goes to the online model only
when the user asks for a suggested reply, under the session consent.

**Not verified:** none of this has run on a phone. Whether the speech recognizer works
with the screen locked, how phone makers' battery savers treat the service, and how each
messaging app's reply action behaves all need the device checklist below. Google Play
requires a declaration for the microphone foreground service and reviews notification
access; those are the owner's to complete at submission.

## Checks run in a desktop browser

These were run against the built page, in both languages, on every page with all panels
open. They are useful, and they are not a substitute for a screen reader on a phone.

- 189 buttons, links, menus and fields: every one has an accessible name; no field is
  labelled only by its placeholder; no duplicate ids; no broken ARIA references; heading
  levels do not skip; no positive `tabindex`.
- About 390 pieces of visible text: the lowest contrast found is 5.95:1.
- At 375 px wide with extra-large text, no page scrolls sideways.
- Two defects were found and fixed this way: the voice menu grew wider than the phone
  once long voice names loaded, and placeholder text fell to about 3.9:1 on tinted fields.

## Where the Bangla voice comes from

Almost no computer and few phones ship a Bangla voice. ASTHA's Bangla voice is therefore
the online one: the text to be spoken goes to the ASTHA server and on to Microsoft's
speech service, which is why it is covered by the online-processing consent.

| Situation | What the user hears |
| --- | --- |
| Online allowed for this session | The Bangla neural voice |
| Online off, device has a Bangla voice (some Android phones, after installing one) | The device's Bangla voice |
| Online off, no Bangla voice on the device | English, with a one-time spoken explanation and a notice beside the Online switch. Before this fix: silence. |
| Bangla-only text with no English version (a page being read aloud) | Nothing is spoken and the reader reports that it could not read it |

Consent lasts one session. Online is the default choice, so ASTHA asks when it starts,
on the page itself; **Cancel, keep on this phone** switches to on-device mode.
Online answers come from Maira; the project's default profile ("Asha") uses
`gemini-3.5-flash` (see [Maira integration](maira-integration.md)). The native confirmation dialog is still used when Online is
switched on by hand, and if the host suppresses it (it answers "no" in a few
milliseconds), the same question is asked on the page instead. Only activating **Allow**
grants consent; nothing is granted by voice or by default.

A Bangla-speaking blind user on a device without a Bangla voice therefore hears the
consent question in English. That is a real limit of this design, and the owner's
decision listed in [data handling](data-handling.md): whether speech output alone may use
the online voice without the broader consent.

## A Bangla defect worth knowing about

JavaScript's `\b` word boundary only understands ASCII letters, so a pattern such as
`\b(stop|থামো)\b` never matches the Bangla word. Fifteen patterns were affected, nine of
them older than this branch. In practice Bangla "হ্যাঁ" and "না" did not answer a yes/no
question, and several Bangla commands fell through to slower handlers. They now use a
boundary that understands both scripts, and a test over the built page fails if the
pattern returns. One consequence to check on a device: the general fallback that hands
multi-step requests to the planning agent now also triggers on its Bangla words (এবং, আর,
দেখো), as it always did on "and", "find" and "where".

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
- [ ] Say "start guided setup" and answer all four questions by voice in Bangla, then again in English.
- [ ] Answer a yes/no question with "হ্যাঁ" and with "না".
- [ ] "Open the WhatsApp app" and "write a message saying …": both ask first; declining does nothing; ASTHA never presses send.
- [ ] Sign in on a second phone: the setup follows the account. Sign out: it is gone from the first.
- [ ] Devices → Messages: both consent steps appear. Ask someone to send a Messenger and a WhatsApp message: ASTHA announces each; "reply …" reads the words back; only "yes" sends; "no", silence and noise send nothing; the reply lands in the right conversation.
- [ ] Turn on "Also read messages aloud when the phone is locked", lock the phone, repeat the test. The notification with Turn off is visible; the microphone indicator appears only right after ASTHA speaks; during a call nothing is announced until it ends; Turn off in the notification stops it.
- [ ] Devices → let ASTHA read other apps: both consent steps appear; "what is on my screen" reads; a password field is skipped; turning it off in ASTHA disables it in Android settings.
- [ ] The Pi camera checklist in [pi-camera.md](pi-camera.md).
- [ ] A Bangla-speaking blind tester reviews the spoken wording.
