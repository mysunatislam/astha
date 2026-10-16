# ASTHA ClipCam: one-time pairing, automatic reconnection and moving between networks

Status, 17 October 2026. Everything in sections 1 to 4 is implemented and covered by
simulated tests (fake Pis, fake network, fake timers, a fake IndexedDB, a software key in
place of Android Keystore). None of it has yet been run against the real Pi, over real TLS,
or on an Android phone. Section 8 lists exactly what still needs hardware.

## 1. What the user does

1. Once: Devices → Pair a Wi-Fi camera. Enter the ClipCam's address
   (`https://hemovasc-pi.local:8443` for the demo kit) and its private pairing code, leave
   **Remember this ClipCam** ticked, choose Connect.
2. After that: nothing. When ASTHA opens, it looks for the ClipCam and says
   "Your ASTHA ClipCam is connected." The code is never asked for again.

Voice, in English or Bangla, from anywhere in the app:

| Say | ASTHA does |
| --- | --- |
| "ASTHA, connect to my camera" / "reconnect my device" / "ক্যামেরা সংযোগ করো" | Looks for the ClipCam now, switching from the phone camera if it was on |
| "Is my ClipCam connected?" / "আমার ক্লিপক্যাম কি সংযুক্ত?" | Says whether it is connected and whether the picture is live |
| "Disconnect my camera" / "ক্যামেরা বিচ্ছিন্ন করো" | Disconnects and stops automatic reconnection until asked again |
| "Forget this camera" / "ক্যামেরা ভুলে যাও" | Asks for a spoken yes, then removes the sealed code |

The Devices page has the same actions as large buttons ("Your ASTHA ClipCam" card), a
status line that screen readers announce, and a "Reconnect automatically" switch.

## 2. How the same ClipCam is found again

Order of addresses tried on each attempt:

1. The paired address, normally the Pi's `.local` name.
2. `https://<name>.local:<port>`, if the ClipCam reported its host name.
3. Addresses that have worked before, newest first (at most four). An address is a hint,
   never the camera's identity.

Before the pairing code is sent to any address, an updated camera script must prove it
already holds the code: ASTHA sends a fresh random challenge to `/hello`, and the Pi replies
with an HMAC-SHA256 of it keyed by the code. A different device cannot produce that, so it
never receives the code. The Pi's identity (`device_id`) is derived from the code, so it
survives reboots and address changes and changes only when the code is replaced.

| Situation | What happens |
| --- | --- |
| App closed and reopened | Starts looking at once; connects silently except "Your ASTHA ClipCam is connected." |
| Pi reboots or Wi-Fi drops for under 45 s | The existing transport retries (0.5 s, 1 s, 2 s, then every 4 s). ASTHA says once that the link dropped and once that it is back. |
| Longer outage | ASTHA says once: "The ClipCam connection was lost. The phone camera is still available. Astha will keep looking while it is open." Then it retries quietly every 3, 6, 12, 20 and then 30 s. |
| Wi-Fi comes back (`online` event) or ASTHA returns to the screen | Looks immediately instead of waiting for the next retry. |
| Pi gets a new address on the same network | Found again by its `.local` name; the working address is remembered as a fallback. If the name cannot resolve, typing just the new address (code left empty) reuses the sealed code. |
| A different device answers at the old address | It never receives the code. ASTHA says once that the device could not prove it is the paired ClipCam, and keeps the pairing. |
| The code was replaced on the Pi (revocation) | A refusal from the ClipCam's own name, or during a live session, makes ASTHA forget the pairing and say so. It is never retried. A refusal from an unproven old address does not erase anything. |
| The phone camera or a photo is in use | Automatic reconnection never takes over a source the user chose. |
| ClipCam answers but its camera sends no fresh frames | Said once: "Your ClipCam answered, but its camera is not sending fresh pictures." |

No old picture is ever presented as live: during any interruption the preview is cleared,
`getFrame()` returns nothing, pending answers built on the old frame are cancelled, and the
distance reading is withdrawn.

Battery level: the Pi does not report one, so ASTHA has no battery state to announce yet.

### Older camera script

The Pi running for the demo uses the script from before this change. That is fine: it
answers `/hello` with 401, so ASTHA recognises it through its TLS certificate alone (signed
by the kit's private CA for `hemovasc-pi.local` and its IP). Updating the script later adds
the identity proof; no re-pairing is needed for that.

## 3. Where the pairing code is kept

| Where ASTHA runs | Storage | Protection |
| --- | --- | --- |
| Android app | `CameraPairingVault`: AES-256-GCM with a key generated inside Android Keystore (`astha_camera_pairing_v1`), record in app-private storage | Key never leaves the Keystore and cannot be exported; app-private storage is excluded from backups (`allowBackup=false` plus explicit rules). A lost key (device reset) makes the record unreadable; ASTHA then removes it and asks for one new pairing. |
| Browser (laptop demo) | `paired-camera-store.js`: IndexedDB record sealed by a non-extractable WebCrypto AES-GCM key | Keeps the code out of `localStorage`, source, logs and URLs, and out of reach of other sites. Not hardware-protected: code running in the same origin, or someone with this browser profile's files, could use it. The app says this on the Devices card. |

Each record is bound to one ASTHA profile on the device. The code is never spoken, shown,
logged, uploaded, put in a URL or included in diagnostics; a test checks speech, captions,
console output, page text, request URLs and diagnostics for it.

## 4. Android: what works in the foreground and in the background

| Capability | Foreground (ASTHA on screen) | Background or phone locked |
| --- | --- | --- |
| Camera frames from the ClipCam | Yes | No. Requests stop; the session is paused, not ended. |
| Automatic search and retries | Yes | No timers run; searching resumes when ASTHA returns. |
| Reconnect after returning | Immediate search, fresh frame required before anything is analysed | n/a |
| Ultrasonic distance | Yes, while the picture link is live | No |
| Sealed pairing code | Read from Keystore when needed | Stays sealed |
| Message reading (existing feature) | Yes | Yes, only after its own explicit consent (unchanged) |

Background camera processing would need a foreground service with a visible notification,
the camera's privacy implications and Android's battery limits; it is deliberately not done.
None of the Android-specific behaviour above has been tested on a phone yet.

## 5. Moving between Wi-Fi networks: what is true today

The demo connection is ordinary local Wi-Fi: the laptop or phone and the Pi on the same
network. A remembered identity cannot create a network path. If the user's phone joins the
classroom Wi-Fi and the ClipCam is on a corridor network, or the institution isolates
clients from each other, there is no route between them, and `.local` names do not cross
networks. ASTHA will keep saying the ClipCam is not found and keep the phone camera
available; it will not pretend to be connected.

For the demo: keep the laptop, phone and Pi on one network (the hotspot used in testing),
and do not change the Pi's network before the demo.

## 6. Production design: a personal link that does not depend on public Wi-Fi

Goal: pair once; afterwards the phone and ClipCam find each other anywhere, with the camera
on a private local link and online AI over the phone's mobile data.

| Option | How | Fit |
| --- | --- | --- |
| A. ClipCam's own Wi-Fi | The ClipCam runs a WPA3 access point. The phone joins it with Android's `WifiNetworkSpecifier` (Android 10+), which keeps mobile data as the default route; camera traffic is bound to the local network, cloud calls to mobile data. Alternative: the phone opens a `LocalOnlyHotspot` and hands its random credentials to the ClipCam over BLE. | Good bandwidth (several frames per second), works without any building Wi-Fi. Needs per-network socket binding in the app, a one-time system approval, and testing across phone models (some cannot keep Wi-Fi client and hotspot at once). |
| B. Wi-Fi Direct | Android Wi-Fi P2P group with the Pi. | Not recommended: per-connection user dialogs, group-owner negotiation and reconnection are unreliable across devices, and groups are often torn down with the screen off. |
| C. BLE-assisted | BLE for discovery, presence, provisioning (sending Wi-Fi credentials), battery and health; frames stay on Wi-Fi (A). Android `CompanionDeviceManager` gives an OS-approved, one-time association that also allows background presence detection. | Low energy, reliable presence and recovery. BLE is not the camera transport and is not used for frames. |

Recommendation: **C + A**. One-time association through `CompanionDeviceManager`, a per-device
key pair generated on the ClipCam and pinned by the phone at pairing (replacing the private-CA
step), BLE for "is my ClipCam here, what is its battery, which local link to use", and the
ClipCam's own WPA3 link for frames. Internet for online AI stays on mobile data, so the
camera link never depends on an institution's Wi-Fi. When no link is possible, ASTHA says so
and uses the phone camera. This is a design; none of it is built yet.

## 7. Short answer for the judges

> "If a blind user moves between different Wi-Fi networks, how will ASTHA automatically
> remain connected to the wearable camera?"

Today's prototype pairs the camera once and then reconnects by itself, whenever the phone
or laptop and the ClipCam share a network. That covers an app restart, a Pi reboot, a
dropped Wi-Fi link and a new address on the same network. The code is sealed on the device,
and the camera must prove its identity before it receives the code. It cannot reach the
camera across two separate networks, because no network path exists between them.

The production kit removes that dependency. Phone and ClipCam are paired once at the system
level and talk over their own private link: Bluetooth Low Energy to find each other, and
the ClipCam's own encrypted Wi-Fi for the pictures. Online AI goes over the phone's mobile
data. So the camera does not depend on whatever public Wi-Fi the user is near. When no link
is possible, ASTHA says so and uses the phone's camera.

## 8. Acceptance tests: simulated and hardware

| # | Test | Simulated (automated) | Real hardware |
| --- | --- | --- | --- |
| 1 | Pair once and remember securely | Yes | Pending |
| 2 | Close and reopen, restored when reachable | Yes | Pending |
| 3 | Pi restart, automatic reconnection | Yes | Pending |
| 4 | New Pi address on a reachable network | Yes (`.local` name and typed address) | Pending; needs mDNS working on the client |
| 5 | Wi-Fi interrupted, recovered without the code | Yes | Pending |
| 6 | Wrong device cannot impersonate | Yes (needs the updated Pi script for the proof) | Pending |
| 7 | Revoked code prevents reconnection | Yes | Pending |
| 8 | Old frame never announced as live | Yes | Pending |
| 9 | Live camera, online AI and ultrasonic together | Earlier sessions only (desktop Chrome, 17 Oct) | Re-run before the demo |
| 10 | Automatic memory respects consent | Yes (existing tests) | Pending |
| 11 | People in view are not hazards | Yes | Pending |
| 12 | Screen reader access to connection settings | Markup and live regions only | TalkBack pending |
| 13 | Theme unchanged after the logo | Headless Chrome, all five themes | n/a |
| 14 | No credentials in builds, logs or commits | Secret scan of diffs, speech, logs, URLs and diagnostics | n/a |

## 9. Blurry pictures: how to find the cause

The IMX219 NoIR v2 is a fixed-focus module whose lens is set at the factory for roughly a
metre to infinity; close objects are expected to be soft, and the lens can be turned only
with the small focus tool, carefully. Software cannot fix an out-of-focus lens. With the
camera server stopped, the updated script measures instead of guessing:

```sh
python3 pi-camera-server.py --focus-probe 20 --focus-sample before.jpg --tuning imx219_noir.json
```

It prints, per picture, libcamera's `FocusFoM` (sharpness measure, higher is sharper for
the same scene), `ExposureTime` (µs), `AnalogueGain`, `Lux` and JPEG size, then a summary.

1. Point at a printed page at the distance the ClipCam will see (about 40 to 60 cm) in steady
   light. Run the probe: this is the baseline.
2. Clean the lens and run again.
3. Exposure above about 20 000 µs indoors means hand movement will blur; try
   `--exposure short` (more noise, less blur).
4. Try `--quality 85` and compare JPEG size and sharpness; the demo runs at 70.
5. Only if `FocusFoM` stays low on a still target: adjust the lens a small step with the
   focus tool, re-run, and keep the setting with the highest median `FocusFoM`.
6. Keep `before.jpg` and `after.jpg` for a side-by-side comparison.

None of these options changes the running server unless passed explicitly.

## 10. Ultrasonic sensor: calibration before relying on distances

The ESP32 → USB → Pi telemetry path is unchanged. The app already rejects readings older
than one second, treats `out_of_range` and `no_echo_start` as "distance unknown", never
shows a stale number, and converts centimetres to metres once. To calibrate, place a flat
board at 30, 50, 100 and 150 cm (tape-measured), record 30 samples at each, and compare the
median with the tape. Until that is done, distances are uncalibrated. No GPIO or firmware
change is needed for this.
