# Native release preparation

Status: source/configuration draft. Android artifacts and iOS simulator compilation must be run before either is described as verified. An unsigned simulator build is not an IPA and cannot be installed through TestFlight.

## Existing configuration

ASTHA wraps the existing JavaScript PWA with Capacitor 8.5.2. Retain the existing application ID `com.astha.companion`. Android currently uses API 36, minSdk 24, AGP 8.13.0, Gradle 8.14.3 and Java 21. The iOS project uses Swift Package Manager with Capacitor pinned to 8.5.2, SceneDelegate, and deployment target iOS 15.0. These settings match [Capacitor 8 requirements](https://capacitorjs.com/docs/updating/8-0); the repository's release text claiming iOS 14 support is incorrect.

## Signing incident and Android builds

The source repository contains an Android keystore and plaintext signing credentials. Treat that key as exposed. Removing a file from the current branch does not remove its history or make the old key safe. The account owner must determine whether it is an unpublished key, an upload key eligible for reset, or an existing app signing key requiring Google Play's supported key-upgrade process. Preserve the existing package ID and installed-app update path; do not replace a published app's signing identity arbitrarily. [Google Play signing documentation](https://developer.android.com/studio/publish/app-signing).

Supply these variables for every release build. Their values must never be printed or committed:

| Variable | Purpose |
| --- | --- |
| ASTHA_ANDROID_KEYSTORE_PATH | Absolute path to the replacement or approved upload keystore, outside tracked source |
| ASTHA_ANDROID_KEYSTORE_PASSWORD | Keystore password |
| ASTHA_ANDROID_KEY_ALIAS | Upload-key alias |
| ASTHA_ANDROID_KEY_PASSWORD | Private-key password |
| ASTHA_VERSION_CODE | Unused positive integer, at most 2100000000, greater than the production build |
| ASTHA_VERSION_NAME | User-facing version in major.minor.patch form |
| ASTHA_MOBILE_API_ORIGIN | Exact public HTTPS ASTHA backend origin, without credentials, paths or query strings |

The mobile workflow reads environment secrets with the matching names, plus `ASTHA_ANDROID_KEYSTORE_BASE64` for the encoded keystore. Dispatch supplies explicit version inputs; tag builds use `v<version>` plus the environment variable `ASTHA_ANDROID_VERSION_CODE`. Base64 encoding is transport encoding, not encryption. Store its value as a GitHub Actions secret.

On October 13, 2026, the owner confirmed that `com.astha.companion` has never been published
on Google Play. A new private signing identity can therefore replace the exposed repository
key for the first release. Keep the new keystore and its password in a protected backup;
future direct APK updates need the same identity. An installation signed with the old/debug
key cannot be updated by the new key. Export needed local notes before removing an old install.
When enrolling in Play App Signing, decide whether to import this app signing key to preserve
the direct-install update path or use a distinct Google-managed identity. The upload key and
the app signing key serve different purposes; no Play enrollment is performed by a local build.

### Connecting the bundled Android app

Set `ASTHA_MOBILE_API_ORIGIN` before `npx cap sync android`. The existing copy hook writes
the origin only into the generated Android `config.js`; hosted `web/config.js` remains
same-origin. Release builds reject missing or stale copied backend configuration. Workflow
dispatch takes `api_origin`; tag builds read the environment variable of the same name as
the build setting. The selected preview is `https://astha-preview.onrender.com`.

The bundled app uses `https://localhost`, so ordinary browser fetch cannot rely on the
backend's cross-site `SameSite=Lax` cookie. `web/native-api.js` uses the existing Capacitor
HTTP plugin for only the configured Android backend's `/api/` routes, preserving its native
cookie jar. Provider keys remain on the server. Global fetch patching and the document.cookie
patch remain disabled. Native logging is disabled to avoid cookie values in Capacitor logs.
Other fetches, including model downloads and the website, retain browser transport.

The adapter preserves JSON and binary speech responses, rejects redirects, supplies native
timeouts and rejects cancelled callers. Capacitor does not cancel native IO when JavaScript
aborts, so session operations are serialized and abandoned sign-ins are logged out before
later requests proceed. A failed cleanup retains the existing pending-logout marker for retry.
Controlled tests verify this logic, not Android WebView cookie behavior. The signed APK must
still be tested for guest startup, sign-in, restart, sign-out, interrupted sign-in, speech,
camera, consent and offline use on a device. See the [Capacitor HTTP API](https://capacitorjs.com/docs/apis/http).

After web regression checks and Capacitor sync, run from `android/`:

```sh
./gradlew --no-daemon testDebugUnitTest lintDebug assembleRelease bundleRelease
```

Missing signing/version inputs must fail release tasks, including aggregate `build`; debug compilation must remain usable without production secrets. Review APK and AAB signature verification, manifest package/version/debuggable checks, ZIP alignment and generated SHA-256 hashes. Run the APK and AAB-generated APKs on actual Android devices before store submission. Automated compilation/signature checks do not prove camera, speech, haptics or accessibility work.

New/update Google Play mobile submissions require API 36 since August 31, 2026, subject to account-specific extension through November 1, 2026. [Target API rules](https://support.google.com/googleplay/android-developer/answer/11926878?hl=en). The existing source already selects API 36.

Verify every packaged native library and the generated AAB/APKs for 16 KB compatibility. The live [Android guide](https://developer.android.com/guide/practices/page-sizes) states update blocking starts February 1, 2027, while the [original announcement](https://android-developers.googleblog.com/2025/05/prepare-play-apps-for-devices-with-16kb-page-size.html) states November 1, 2025; check the app's Play Console status and require compatibility before production. AGP already exceeds 8.5.1. This does not establish compatibility of future prebuilt native dependencies or runtime performance.

Personal Play accounts created after November 13, 2023 may require at least 12 continuously opted-in closed testers for 14 days and production-access approval. [Testing requirements](https://support.google.com/googleplay/android-developer/answer/14151465?hl=en).

## Debug APK, release APK and Play bundle

These are three different things and only the first exists for this revision.

| Artifact | Signed with | Use | State |
| --- | --- | --- | --- |
| Debug APK (`app-debug.apk`) | The Android debug key on the build machine | Installing on a test phone by hand. Debuggable; trusts tester-installed certificates so a Pi camera on a private CA can be paired. Never distribute it. | Built locally from this branch; see the pull request for its hash. Not installed on any device. |
| Release APK (`app-release.apk`) | The private release key | Direct installation outside Google Play | Not built. Needs the signing inputs below and the owner's authorization. |
| Android App Bundle (`app-release.aab`) | The upload key | Upload to Google Play only; it cannot be installed directly | Not built. `com.astha.companion` has never been published. |

A phone that has the debug APK installed cannot be updated by a release APK: the
signatures differ, so the debug build must be uninstalled first, which removes its local data.

Building the debug APK needs no secrets:

```sh
python tools/build.py
ASTHA_MOBILE_API_ORIGIN=https://astha-preview.onrender.com npx cap sync android
cd android && ./gradlew testDebugUnitTest lintDebug assembleDebug
# android/app/build/outputs/apk/debug/app-debug.apk
```

The backend named in `ASTHA_MOBILE_API_ORIGIN` must be running a revision compatible with
the app. An older backend without `/api/preferences` still works: the setup answers stay
on the phone and are uploaded once the backend has the route.

## Native capabilities added for the Android app

The Android WebView has no speech recognition and no speech synthesis, so the app
supplies both through a small local Capacitor plugin, `AsthaNative`
(`android/app/src/main/java/com/astha/companion/`), exposed to the page by
`web/native-device.js`. In a browser that file defines nothing.

| Capability | Android API | Permission | Notes |
| --- | --- | --- | --- |
| Device voice | `TextToSpeech` | none | Fallback when the server voice is unreachable, and the immediate voice for hazard alerts. Accepts Bangla as Bangladesh, India or plain `bn`, whichever is installed. When the phone has none, ASTHA speaks English and says why; installing a Bangla voice in Android's text-to-speech settings, or allowing online processing, restores Bangla. |
| Speech recognition | `SpeechRecognizer`, one request at a time | `RECORD_AUDIO`, asked at first use | The recognizer may send audio to its provider (usually Google). It is therefore blocked in Privacy mode, like the browser recognizer. Hands-free wake-word listening is not implemented. |
| Reading other apps | `AccessibilityService` | The user enables it in Android settings | Described below. |
| Announcing and answering messages | `NotificationListenerService`, the notification's own `RemoteInput` reply action | The user enables notification access in Android settings | Described below and in the [release review](voice-first-release-review.md#messages-the-personal-agent-android). |
| Messages with the phone locked | Foreground service, type `microphone`; `TextToSpeech`; `SpeechRecognizer` | `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_MICROPHONE`; `RECORD_AUDIO` and, on Android 13+, `POST_NOTIFICATIONS`, asked when the user turns it on | Off by default. Started only while ASTHA is on screen, always with a notification and a Turn off button; `START_NOT_STICKY`, no boot receiver. |
| Opening an app, sharing text | `getLaunchIntentForPackage`, `ACTION_SEND` through the system chooser | none | Each request is confirmed aloud first. The app is found by its launcher name, on the phone; the list of installed apps is not sent anywhere. Messages go to Android's share menu, where the user picks the app and the person and presses send. There is no SMS, call or contacts permission, and a test fails if `ACTION_SENDTO`, `SmsManager` or a fixed target package appears. |

The page's recognizer is stopped whenever the app leaves the foreground. The only thing
that listens while ASTHA is not on screen is the locked-phone message assistant, when the
user has turned it on, and only for a few seconds right after it has asked a question.

### Reading other apps: what it can and cannot do

- It is off by default. The user first agrees inside ASTHA (Devices), where the
  explanation is shown and spoken, and then enables "Astha screen reading" in Android's
  Accessibility settings, where Android shows its own warning. Either step alone does nothing.
- Turning it off in ASTHA calls `disableSelf()`, which switches the Android service off too.
- On request ("what is on my screen") it reads the visible text of the app in front, up
  to 400 elements and 6000 characters, and says when there was more.
- It can press Back or Home on request. That is the complete list of actions.
- It does not subscribe to what the user does: accessibility events are ignored. It
  stores nothing, logs nothing, and never reads a password field or anything inside one.
- It cannot tap, type, paste, perform gestures, filter keys, take screenshots or send
  messages. `tests/test_native_device.mjs` fails if those powers are added to the service
  configuration or source.

Text read from another app is spoken on the phone. If the user then asks the online AI
about it, the normal online-processing consent applies.

### Messages: what it can and cannot do

- Off by default; in-app consent first, then Android's notification access settings.
- Only conversation notifications are considered (category message, or a reply action
  that accepts free text). ASTHA's own notifications, ongoing ones and group summaries are
  ignored. Up to 20 are held in memory so a reply can reach its conversation; withdrawing
  consent clears them.
- A reply is sent through that notification's own reply action, after the words have been
  read back and the user said yes. The spoken rules live in `MessageCommands.java` and are
  unit tested: at the confirm step anything but a clear yes means "do not send".
- It cannot start a conversation, pick a recipient, read the message history, mark as read,
  delete, call or text. `tests/test_native_device.mjs` fails if logging, file output,
  network calls, SMS APIs, a sticky restart or a boot receiver appear in this code.

Operating other apps (tapping, typing) is **not implemented**. It would need a confirmation
step before every consequential action and its own review.

**Google Play.** The microphone foreground service needs Play's foreground-service
declaration (with a short video of the feature), and notification access is reviewed for
a core purpose. Both are the owner's to complete at submission.

**Google Play.** An app that declares an AccessibilityService must complete Play's
accessibility declaration and show a prominent in-app disclosure before enabling it. The
in-app explanation exists; the declaration and Play's review are the owner's to do at
submission time. This is not legal advice.

## iOS feasibility and TestFlight gate

The existing iOS project is suitable for compilation checks; no rebuild is required. The workflow selects macOS 15 with Xcode 26.3 and performs an unsigned simulator build. This produces compiler diagnostics, not a signed device archive. Existing English camera, microphone and speech permission descriptions need Bangla localization and testing with VoiceOver. Native privacy manifests are not present in source: inspect the resolved SDK/archive privacy report and declare actual data collection/required-reason APIs; do not invent reason codes for unused plugins. [Capacitor privacy guidance](https://capacitorjs.com/docs/ios/privacy-manifest).

A signed IPA/TestFlight deployment remains pending the following account material and verification:

1. Apple Developer Program membership and App Store Connect access; confirm ownership of the registered bundle ID and app record.
2. A distribution certificate plus private key and an App Store Connect provisioning profile for that explicit App ID, or account-authorized automatic signing. Keep them in protected CI secrets and a temporary keychain. [Apple provisioning guide](https://developer.apple.com/help/account/provisioning-profiles/create-an-app-store-provisioning-profile/).
3. App Store Connect API key/issuer/key ID for a scoped upload process, unique build number, app version, export options, encryption declarations and truthful App Privacy/age rating/test metadata.
4. On macOS, resolve the locked Swift package, archive the existing Xcode project for `generic/platform=iOS`, validate/export with `xcodebuild -exportArchive`, and verify signing, embedded profile and archived privacy report before upload. Capture dSYMs and toolchain versions.
5. Upload with Apple's supported App Store Connect tooling; wait for processing and confirm the actual build is available. Test on physical iPhone/iPad, including permission denial, interruptions, background/resume, cold start, model caching, Bangla/English voice availability, VoiceOver and large text. Then distribute internally and submit the first external beta for review.

Since April 28, 2026, App Store Connect uploads require Xcode 26+ and iOS 26 SDK+. The deployment target requirement is iOS 13+ since September 9, 2026; ASTHA's iOS 15 target is compatible. SDK version and deployment target are separate settings. [Apple requirements](https://developer.apple.com/news/upcoming-requirements/?id=02032026a).

TestFlight builds last 90 days; Apple supports up to 100 internal and 10000 external testers, and the first external beta requires review. [TestFlight overview](https://developer.apple.com/help/app-store-connect/test-a-beta-version/testflight-overview/). No upload or deployment has been performed by this draft.

## Reproducibility and remaining release gates

The workflow pins Node 24.21.0, Python 3.11.9, Android build tools 36.0.0, command-line tools 12266719 and Xcode 26.3. It uses only `npm ci`; a failed locked install must not fall back to a different dependency graph. Gradle distribution verification uses the official 8.14.3 all-ZIP SHA-256 from [Gradle checksums](https://gradle.org/release-checksums/). Workflow actions now use verified immutable commit SHAs. Hosted runner images remain movable; record actual tool versions and verify Xcode 26.3 availability in the first macOS run.

The existing mobile run failed Android SDK setup because the deprecated `tools` package is unavailable, and iOS sync because Node 20 is below Capacitor's minimum. The draft installs explicit Android packages and a compatible Node release. [Failed mobile run](https://github.com/mysunatislam/astha/actions/runs/35529106692).

GitHub Pages currently fails because the source repository has no enabled GitHub Actions Pages site. Configure the repository's Pages setting when selecting the production frontend host; code changes alone do not resolve that account setting. [Failed Pages run](https://github.com/mysunatislam/astha/actions/runs/36495743047).

Release transport is HTTPS only; explicit cleartext and mixed-content allowances are removed. Android backup is disabled while sensitive WebView storage is reviewed, and the unused entire-external-storage FileProvider path is removed. Verify configured API URLs remain HTTPS and that denied permissions are explained accessibly. Offline mode, API fallback, local voice availability and model downloads need device evidence before release claims are made. No production or GitHub Release publication occurs in this workflow.

## Local evidence

Final Android sync/debug unit test/lint/assemble passed on Windows with API 36/Java 21/Gradle 8.14.3. Lint reported 0 errors and 15 warnings; the existing arithmetic unit test is not a camera or accessibility test. Credential-free release commands failed at the explicit signing/version guard as intended. The archived installer exclusion hook passed through a real Android copy; Android/iOS fixture checks also pass. No signed APK/AAB, IPA, device instrumentation or store upload is claimed. See [verification.md](verification.md).
