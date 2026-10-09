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

The mobile workflow reads environment secrets with the matching names, plus `ASTHA_ANDROID_KEYSTORE_BASE64` for the encoded keystore. Dispatch supplies explicit version inputs; tag builds use `v<version>` plus the environment variable `ASTHA_ANDROID_VERSION_CODE`. Base64 encoding is transport encoding, not encryption. Store its value as a GitHub Actions secret.

After web regression checks and Capacitor sync, run from `android/`:

```sh
./gradlew --no-daemon testDebugUnitTest lintDebug assembleRelease bundleRelease
```

Missing signing/version inputs must fail release tasks, including aggregate `build`; debug compilation must remain usable without production secrets. Review APK and AAB signature verification, manifest package/version/debuggable checks, ZIP alignment and generated SHA-256 hashes. Run the APK and AAB-generated APKs on actual Android devices before store submission. Automated compilation/signature checks do not prove camera, speech, haptics or accessibility work.

New/update Google Play mobile submissions require API 36 since August 31, 2026, subject to account-specific extension through November 1, 2026. [Target API rules](https://support.google.com/googleplay/android-developer/answer/11926878?hl=en). The existing source already selects API 36.

Verify every packaged native library and the generated AAB/APKs for 16 KB compatibility. The live [Android guide](https://developer.android.com/guide/practices/page-sizes) states update blocking starts February 1, 2027, while the [original announcement](https://android-developers.googleblog.com/2025/05/prepare-play-apps-for-devices-with-16kb-page-size.html) states November 1, 2025; check the app's Play Console status and require compatibility before production. AGP already exceeds 8.5.1. This does not establish compatibility of future prebuilt native dependencies or runtime performance.

Personal Play accounts created after November 13, 2023 may require at least 12 continuously opted-in closed testers for 14 days and production-access approval. [Testing requirements](https://support.google.com/googleplay/android-developer/answer/14151465?hl=en).

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
