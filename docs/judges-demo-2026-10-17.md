# GP FutureMakers demo runbook (17 October 2026)

Branch `release/judges-demo-2026-10-17` = person-hazard fix + current-evidence obstacle rules
+ "Which AI is working" panel + recoloured logo (light and dark) + "Remember this ASTHA
kit". The setup-review report records the current automated checks. These features were verified in automated tests and
headless Chrome only; they have not yet been verified on the Pi or a phone (see
[clipcam-connectivity.md](clipcam-connectivity.md#8-acceptance-tests-simulated-and-hardware)).

## Before the judges arrive

1. Same network for laptop, phone and Pi (the hotspot used in testing). Do not change the
   Pi's network or wiring.
2. Pi: camera server running with telemetry. For identity proof and recovery after an
   address change, install the current camera script and a boot service using
   `--bind-interface wlan0`. Check that service is enabled and serving fresh frames.
3. Laptop: open the web preview in Chrome. If this build is deployed, pair once in Devices
   with **Remember** ticked. Then close and reopen the tab: ASTHA should say "Your ASTHA
   ClipCam is connected" without asking for the code. If it does not, re-pair once and
   carry on; do not debug in front of the judges.
4. Open Detailed view and check "Which AI is working": pictures from the ClipCam (live),
   boxes from the on-device detector, online descriptions allowed.
5. Place one clearly visible laptop or phone for the memory demo, and a flat board at a
   measured distance for the ultrasonic demo.

## Live sequence (about 3 minutes)

1. Open ASTHA on the laptop. It finds the paired ClipCam by itself and says so.
2. Show the live preview and the Detailed view: "The boxes come from this device. The
   description comes from the online AI only when it is allowed, and the panel shows when
   it answered and how long it took."
3. "ASTHA, describe my surroundings." The online answer arrives in about 5 to 6 seconds in
   earlier tests. A person standing in view is described as a person, not as a danger.
4. Distance: hold the board in front of the ultrasonic sensor; read the live centimetres in
   Devices. Say it is uncalibrated.
5. Memory: with automatic memory switched on, show the laptop/phone, then ask "where did I
   last see my phone?" ASTHA gives the time and image position and says it cannot confirm
   where the phone is now.
6. Reconnection: only after checking the camera service starts at boot, demonstrate a
   controlled service restart. ASTHA should report the interruption and reconnect without
   the code. Do not unplug the Pi to demonstrate unverified boot behavior. A network change
   also requires both devices to join the same reachable network.
7. Android: show the app as a separate interface (voice, phone camera, settings). Do not
   claim ClipCam pairing on Android: it has not been tested on a phone, and only the debug
   build trusts the Pi's private certificate.

## If something fails

| Problem | Say / do |
| --- | --- |
| Online AI slow or down | The panel shows "This device answered … because the online request failed". Explain the on-device fallback; describe again later. |
| ClipCam not found | ASTHA says so and keeps looking; use the phone/laptop camera for the rest. |
| Pi needs re-pairing | Pair once in Devices (code from the kit's private file); tick Remember. |
| Distance shows "out of range" | That is the sensor saying it has no valid echo; it is never shown as a clear path. |

## What not to claim

- That ASTHA guarantees a safe route, replaces a white cane, or verifies collision avoidance.
- That the camera stays connected across unrelated Wi-Fi networks today (the production
  design in clipcam-connectivity.md section 6 is not built yet).
- That Android ClipCam pairing, TalkBack, battery life or NoIR colour accuracy are verified.
- That ultrasonic distances are calibrated.
