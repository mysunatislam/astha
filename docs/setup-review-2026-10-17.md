# Review of Claude's spatial update and demo setup

Claude's stage 1/2 commits (`4d09d52`, `0be7a8a`) are ancestors of the existing live
`a47ad96` build. The newer local judges' branch additionally contains the remembered-kit,
logo and person-observation fixes. The pasted stage-2 note describes its earlier state;
it is not evidence that the current live deployment lacks that code.

## Issues found and smallest fixes

| Files | Root cause | Fix and verification |
| --- | --- | --- |
| `tools/perceive.js`, `tools/spatial.js` | A busy depth model could return a previous picture's map; sensor echoes received after inference could be attached to earlier detections. | Require this picture's depth result, separate current forward range from image-associated readings, and reject stale object associations. Regression fixtures exercise busy inference, changed echoes and cancellation. |
| `tools/spatial.js`, `tools/offline.js` | A sector estimate could name an unrelated object; missing or tied depth could sound like an empty direction; generic distance routing swallowed spatial questions. | Omit unsupported names, report uncertainty, and route spatial questions before generic distance questions. Both English and Bangla wording are tested. |
| `tools/camera-kit.js`, `tools/pi-camera-ui.js` | Disconnect changed runtime state only; delayed asynchronous pairing could save after disconnect, replacement pairing or privacy entry. A missing profile used a shared fallback. | Persist explicit disable requests, guard operations by generation/profile/privacy, require an explicit local profile, and require camera identity proof before sending credentials to another address. Lifecycle tests cover delayed operations and reopening. |
| `web/paired-camera-store.js`, `web/native-device.js`, `android/app/src/main/java/com/astha/companion/CameraPairingVault.java`, `AsthaNativePlugin.java` | A native save could commit just before cancellation, and removal did not report failed persistence. | Compensate only the canceled encrypted write, preserving newer writes; propagate failed removal. Node bridge fixtures and JVM vault tests cover these cases. |
| `tools/account.js` | Account deletion omitted the local camera vault. | Cancel pending pairing, await erasure for the captured profile, and report incomplete local cleanup honestly. Account-switch and erase-failure fixtures are included. |
| `docs/judges-demo-2026-10-17.md`, Pi startup configuration | The runbook suggested a reboot demonstration without an installed boot service. | Enable a service under the existing Pi user with `--bind-interface wlan0`; check startup and controlled restart before demonstrating recovery. |

## Hardware observations during setup

The final combined check passed 603/603 Node regressions, JavaScript syntax validation
and two identical generated builds. Eight focused JVM camera-vault tests also passed.
The full Android build and live browser evidence are recorded separately with the
delivered candidate; the checks above do not establish physical phone behavior.

The Pi was on a different Wi-Fi network. After the user joined it to the laptop's hotspot,
SSH discovery succeeded. No camera process or boot service was running. The reviewed
camera server was installed with the existing token and certificate, and its systemd
service was enabled. It binds the current private address and exits for a supervisor
restart when that address changes. No provider credential was copied to the Pi.

Verified HTTPS requests returned fresh camera frames and a correct challenge-response
identity proof. A ten-second range sample contained 32 distinct valid readings from 36
requests, spanning 48.4–50.7 cm with reported age at most 95 ms. This establishes a working
feed, not calibrated accuracy. A current Pi frame returned a bilingual online description
in 5.9 seconds. These are individual observations, not speed or accuracy guarantees.

## Limits to explain to judges

The depth output is relative. Fitting it using object-size guesses and a sensor reading
is experimental; focal length, object-size priors and rigid sensor/camera alignment have
not been calibrated. This is not validated metric reconstruction or navigation. A missing
echo or unknown image distance does not establish a clear path.

The prototype reconnects when the paired kit is reachable on a provisioned local network.
It cannot join arbitrary unknown Wi-Fi networks by remembering an IP address. A future kit
can use one-time device association, BLE discovery/provisioning and a dedicated local
Wi-Fi link for pictures. Android's [companion-device APIs](https://developer.android.com/develop/connectivity/bluetooth/companion-device-pairing)
support association/presence but do not create the transport connection. Its
[Wi-Fi network request API](https://developer.android.com/develop/connectivity/wifi/wifi-bootstrap)
provides local connectivity, not internet. Routing camera traffic separately from cloud
traffic and testing phone compatibility remain implementation work.

Android phone runtime, TalkBack, release-build Pi certificate trust, battery life, physical
Wi-Fi roaming and known-distance calibration remain pending. The free Render service can
still have an idle wake-up delay; no paid hosting change is included.
