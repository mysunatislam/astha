# ASTHA latency correction — 16 October 2026

Preserve the existing Maira gateway, private keys, Supabase backend, PWA and Capacitor
application. The owner requested faster loading and Gemini, then explicitly chose to
keep Render hosting free. No paid plan, provider migration or database change is part
of this increment.

| Priority / issue | Files or configuration / root cause | Smallest correction |
| --- | --- | --- |
| P0: excessive provider work | The live Maira default was already `gemini-3.5-flash`. Its Asha profile enabled automatic evaluation and 2,500 retrieval tokens; ASTHA omitted an explicit profile. | Create a separate ASTHA-only `gemini-3.1-flash-lite` profile, disable evaluation and unneeded provider retrieval/history/learning, retain image support, and set server-only `MAIRA_PROFILE_ID`. Preserve shared project defaults and other applications. |
| P0: Home waits for optional libraries | `tools/base.html` loaded ORT, TensorFlow, COCO and Tesseract as four parser-blocking CDN scripts. `tools/build.py` warmed the detector at startup even for online use. | Load each pinned runtime through `tools/runtime-loader.js` only when needed. Keep shared requests, timeout/retry, TF-before-COCO fallback and OCR worker reuse. Remove unconditional model warmup. |
| P0: extra voice round trip | `tools/experience.js` awaited online synthesis/playback of “Checking…” before visual work. | Use the existing device voice path through `tools/module.js` and explicitly select local browser voices in `tools/base.html`. Without Bangla use the short English acknowledgment, preserving Stop-before-inference and ordinary online speech. |
| P1: long default answers | `server/gemini.js` and `tools/cloud.js` requested exceptionally comprehensive descriptions, all details and rough distances. | Ask for one or two direct sentences by default, more detail on explicit request, and current visible evidence. Preserve full legible transcription, bilingual meaning, Astha identity and JSON fields. |
| P1: installation bandwidth and offline upgrades | `web/sw.js` downloaded optional runtimes on install; removing that alone loses previous scripts when old shells are deleted. | Cache on first use. Copy only already cached, still-approved runtime URLs from old ASTHA shell caches without network before activation. Preserve API/audio bypass and unrelated caches. |
| Remaining: free-host cold start | Existing Render service uses free compute. | Owner declined the $7/month upgrade. Keep hosting free; do not imply a model or JavaScript fix removes idle spin-down. |

## Provider configuration and measured boundary

The active model and settings were read through Maira's API without printing keys or
private profile text. The new isolated profile uses `gemini-3.1-flash-lite`,
`search_max_token=0`, `is_auto_evaluation=false`, `chat_history_length=0`, image context
enabled and conversation learning disabled. `completion_token=2000` is retained so a
reading task is not shortened merely to improve benchmarks. This is not a zero-retention
claim. Maira profile selection is an operator configuration, never a browser key.

Eight alternating requests compared the prior and candidate profiles using synthetic
text and the official public TensorFlow.js COCO photograph. Each profile had only two
text and two image samples:

| Provider wall time | Prior Gemini 3.5 Flash profile | Selected Gemini 3.1 Flash-Lite profile |
| --- | ---: | ---: |
| Short bilingual text, mean of 2 | 8,289 ms | 3,721 ms |
| Brief bilingual image answer, mean of 2 | 13,274 ms | 8,683 ms |

All eight returned nonempty English/Bangla JSON. Model and profile settings changed
together, so this does not isolate the model's contribution. Times include network and
orchestration, not speech, cold start, sustained p95, visual accuracy or hazard safety.
Local delivery evidence: `outputs/latency-2026-10-16/maira-model-comparison.json`.

A separate Gemini 2.5 Flash-Lite candidate returned no verified bilingual answers in
four bounded tests and was not selected. Fast failures are not counted as improvement.
No silent provider fallback was added.

## Verification and remaining gates

The integrated suite passed **483 regressions**, JavaScript syntax and reproducible web
generation. Regressions cover local acknowledgments, network-voice exclusion, Stop,
runtime concurrency/failure/retry, fallback ordering and cached offline upgrades. These
use controlled stand-ins and do not prove physical behavior.

Isolated Chrome ran the actual old/new generated app with optional CDN scripts
deliberately delayed 2.5 seconds and unavailable. Home took 2,951/3,130/3,137 ms before
and 777/732/811 ms after, with four runtime requests before and zero after. This is a
controlled dependency check, not typical network or Render performance. Real inference,
live API checks, signed Android packages and CI are recorded separately for final source.

Render documents idle spin-down after 15 minutes and about one minute to wake on its
[free plan](https://render.com/docs/free#spinning-down-on-idle). This remains under the
owner's free-hosting constraint. No keep-alive automation or paid upgrade was added.
The APK's bundled shell and a cached PWA shell differ from a first uncached request to
the sleeping website. Android/TalkBack, real speech, Pi/phone camera accuracy and model
download readiness still need physical-device testing. This remains a test candidate.
