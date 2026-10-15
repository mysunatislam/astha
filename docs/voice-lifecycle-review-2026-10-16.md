# Foreground voice cancellation — 16 October 2026

This increment preserves the existing web/Capacitor application, Gemini/Maira gateway,
Supabase storage and bounded Android speech APIs. It fixes foreground microphone
request lifetimes. It does not implement a new background wake-word service or expand
message/app-control permissions. The existing free hosting configuration is unchanged.

| Priority / issue | Relevant files and root cause | Smallest safe correction |
| --- | --- | --- |
| P0: expired hands-free commands | `tools/module.js`: recognizer handlers and delayed dispatch/restart callbacks did not check ownership after Stop or opt-out. An old `onend` could clear a replacement recognizer. | Invalidate a session generation before abort; bind callbacks to the current recognizer, consent, account and visible foreground. Guard delayed work. Preserve a legitimate final across a natural continuous-recognizer restart. |
| P0: Android Stop did not reach input | `tools/module.js` and `tools/offline.js`: shared Stop cleared browser UI, while only a second microphone tap called native Stop. The native result checked one global listening flag. | Shared Stop invalidates the native request and calls its cancellation bridge immediately. Bind completion to its own request/context; a late old result/error cannot clear a newer input or launch a fallback. |
| P0: one-tap browser replacement | `tools/offline.js` supplies the final generated `toggleListening`; `tools/module.js` also contains an earlier definition. Results, errors and finish timers could operate on a replacement request. | Add matching generation/recognizer/context checks to both implementations. Preserve the current network-to-local fallback; stale errors cannot initiate it. Tests execute the final generated override order too. |
| P0: local recorder cancellation | `tools/offline.js`: one shared `cancelFlag` could be reset by a new request; cancellation waited for another audio callback. A late permission grant could create a recorder after Stop. | Give each request its own ownership and cleanup. Stop tracks/context/timer immediately, finish without another audio callback, and stop late-granted tracks before constructing audio processing. Check ownership after recording, loading and transcription; old cleanup cannot clear new UI. |
| P1: permission and lifecycle recovery | `tools/module.js`: terminal hands-free permission errors were silent, and only `pagehide` paused the listener. Sleep wording incorrectly suggested a stopped listener could hear a wake phrase. | Provide bilingual permission/unavailable guidance. Hide/pagehide disables foreground hands-free and cancels one-tap/local capture; returning alone does not reopen a microphone. Explain that the user must enable hands-free or tap the microphone again. |

## Verification

The integrated check passed **518 regressions**, JavaScript syntax and two identical web
generations. New controlled tests reproduce late recognition results, Stop/restart
races, consent/account/source boundaries, late permission grants, current-result
dispatch, microphone track cleanup, network fallback and interim spoken Stop.

- `tests/test_voice_barge_in.mjs`: real voice/Stop code with controlled recognizers,
  timers, audio and final one-tap override; existing English/Bangla Stop coverage remains.
- `tests/test_native_device.mjs`: real shared Stop and native-input JavaScript with a
  controlled bridge; native Java request protections remain unchanged.
- `tests/test_offline_voice_lifecycle.mjs`: real local recorder and request flow with
  controlled media/model promises; checks stream shutdown, late grants and stale work.
- `tests/frontend_release.test.mjs`: consent/bootstrap regression harness includes
  document visibility events. No automatic microphone start was added.

Isolated Chrome also ran the generated application with synthetic recognition/native
bridge events and no real microphone, camera, provider or database requests. It checked
exact local identity, stale callbacks, normal dispatch, controlled foreground-hide
cancellation, replacement native input and Bangla layout. Local evidence is under
`outputs/voice-lifecycle-2026-10-16/`; signed packages, CI and deployment checks are
recorded separately against the final immutable commit.

## Boundaries and remaining release gates

A Whisper model download already started by an authorized request may finish into its
existing cache after Stop. Its result cannot revive the cancelled request. Concurrent
warmup is retained to avoid adding first-use latency. An already running model inference
may also finish; its old transcript/effects are ignored. This is not proof that every
underlying inference library can be interrupted.

The web listener remains foreground and explicitly enabled. Ordinary Android
[SpeechRecognizer](https://developer.android.com/reference/android/speech/SpeechRecognizer)
is not suitable for continuous recognition, and browser pages can be frozen or discarded
under the [page lifecycle](https://developer.chrome.com/docs/web-platform/page-lifecycle-api).
No background wake capability is claimed. The separately enabled native message service
is unchanged by the foreground-hide policy.

Physical Android microphone/permission dialogs, Bangla recognition, TalkBack, lock/call
transitions, acoustic echo and speech interruption latency still need real-device tests.
Synthetic callbacks prove application dispatch/cancellation, not that a spoken Stop
will be recognized during loud speech. Pi release pairing, store upload, iOS signing,
proactive visual memory and known-person alerts remain separate gates. No paid hosting,
database migration, provider-profile change or new permission is included here.
