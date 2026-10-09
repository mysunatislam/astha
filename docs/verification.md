# ASTHA verification and delivery

Date: 9 October 2026. These are release candidate checks, not production approval.

The source repository is mysunatislam/astha; the requested astha-live repository contains generated static assets. Both candidates use a separate local production/stabilize-2026-10-09 branch. No main branch, hosting, store account or production database was changed.

## Recorded checks

| Check | Result | Limit |
| --- | --- | --- |
| Original web build and existing agent client/server suites | Passed | Simulated agent behavior; no visual accuracy proof. |
| Final npm run check | Passed: 79 regressions plus both existing suites | Reproducible generation (two runs), all JS/generated inline syntax, isolated HTTP/database and mocked frontend/provider/storage tests. |
| Root/server locked dependency installs | npm ci passed | Local runtime Node 24.13.0. |
| Root and server npm audit | 0 reported advisories each | Checked 9 October; excludes CDN/model/native SDK assets and future advisories. |
| Workflow YAML and whitespace | Parsed with PyYAML 6.0.3; git diff --check passes | Hosted GitHub jobs have not run. |
| Capacitor Android sync | Passed with final web assets | Actual installer-exclusion hook also passed with a disposable archive fixture; Android/iOS fixture tests pass. |
| Android testDebugUnitTest lintDebug assembleDebug | Passed | Existing unit suite has 1 arithmetic test. Lint: 0 errors, 15 warnings. No device instrumentation; authorized ADB discovery found zero attached test devices. |
| assembleRelease bundleRelease without credentials | Expected rejection at validateReleaseInputs | No signed release APK or AAB produced. |
| Browser local note / reload / sign-out | Observed note saved locally, persisted after reload, and absent in fresh guest | Synthetic fixture; no real user data or cloud provider result. |
| Browser interface/voice languages | English UI switch/persistence retained Bangla voice selection; Bangla UI restored | Complete translation and physical Bangla synthesis unverified. |
| Browser model initialization | Quantized YOLO failed with unsupported ConvInteger(10); existing COCO-SSD fallback initialized | Only initialization observed; actual detector output/accuracy and offline cold reopen unverified. |
| iOS / IPA / TestFlight | Not run | Windows host; macOS/Xcode and owner signing/account credentials needed. |
| Docker / paid hosting / production monitoring | Not run/deployed | Docker unavailable; hosting, ingress, storage/backup and alert gates remain open. |

Local versions: Node 24.13.0, Python 3.12.14, Java 21.0.9, Gradle 8.14.3, Android API/build-tools 36. Workflows pin Node 24.21.0, Python 3.11.9, Ubuntu 24.04, explicit Android SDK packages and Xcode 26.3. Those hosted environments remain unverified.

The final Android ZIP must contain the exact generated index.html, backend.js, config.js and sw.js and no archived downloads/astha.apk; checksums are supplied with the debug artifact. This debug APK is for verification and cannot be presented as the Google Play release.

## Reproduce checks

From the source checkout, with the specified runtimes available:

```text
npm ci
npm ci --prefix server
npm run check
npm audit --audit-level=moderate
npm audit --prefix server --audit-level=moderate
npx cap sync android
cd android
gradlew testDebugUnitTest lintDebug assembleDebug
```

Use ./gradlew on macOS/Linux and gradlew.bat on Windows. Set JAVA_HOME, ANDROID_HOME and ASTHA_PYTHON for local tool locations when necessary. Signed release commands require the external version/signing inputs in native-release.md; never use the exposed historical key. The hosted native workflow produces reviewed artifacts and does not publish a GitHub Release or submit to a store.

## Review and resume

The bundle prerequisites are source base decb73e57edc33d1776074560806a609d096fdaf and distribution base 48162d5318f9dd7680ba1d465eabfc4fa339ce7b. Fetch the appropriate original repository first, verify its corresponding bundle, then fetch the bundled production/stabilize-2026-10-09 ref into a new review branch. Do not force-reset an existing checkout. The snapshot ZIP is a convenience copy of the final source, with no node_modules, keystores, databases, archived APK or Git history.

Review source-audit-and-release-plan.md for priorities, every finding's files/root cause/minimal fix/status, and all seven release workstreams. native-release.md contains owner signing and store gates. Provider/JWT/signing credential recovery, persistent HTTPS backend configuration, unsupported model/runtime work, full privacy/deletion policy and bilingual accessibility/device tests remain release blockers.

GitHub integration rejected branch creation with HTTP 403 (Resource not accessible by integration). Remote push status is recorded in delivery-status.md. Local branches/bundles remain usable even when that integration lacks repository write permission.

![Bangla UI, explicit offline mode and safety disclosure](browser-verification.jpg)

