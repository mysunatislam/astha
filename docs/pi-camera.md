# Raspberry Pi Wi-Fi camera (clip-on prototype)

The clip-on prototype is a Raspberry Pi with a NoIR camera module and a power bank. The Pi
only captures pictures and serves the newest one over the local Wi-Fi. Recognition runs on
the phone or the ASTHA server; an original Model B cannot run a modern vision model.

**Status (17 October 2026).** A real Pi camera has been paired with the live ASTHA web app
in desktop Chrome. The preview received fresh pictures and a captured frame produced a
visible bilingual answer (see [Verified on hardware](#verified-on-hardware)). Following
the user's wiring correction, distance telemetry produced valid changing measurements;
the exact target distances were unknown, so accuracy remains uncalibrated.
Android pairing, certificate trust, speech playback, battery life, NoIR colour and
detection accuracy remain unverified.

## 1. Find out what the Pi actually is

Do not assume a camera stack. Copy `tools/pi-camera-server.py` to the Pi and run:

```sh
python3 pi-camera-server.py --probe
```

It prints the board model and revision, the OS, memory, the Python version, which capture
methods are installed, and which one it would choose. Record this output with the test
results. The script needs Python 3.7 or later and nothing outside the standard library
except the camera library it selects.

| Capture method | Where it exists | Notes |
| --- | --- | --- |
| `picamera2` | Raspberry Pi OS Bullseye and later (libcamera) | Preferred when installed: `sudo apt install python3-picamera2`. |
| `picamera` | Buster, or Bullseye with the legacy camera enabled | The likely choice on an original Model B. Enable the camera in `raspi-config`. |
| `rpicam-still`, `libcamera-still`, `raspistill` | Whichever the OS ships | Fallback: one process per picture, so expect about one picture per second. |

`--backend auto` (the default) picks the first installed method in that order. Force one
with `--backend picamera`, for example, if the automatic choice misbehaves. If `--probe`
finds nothing, the camera software is not installed or the camera is not enabled; the
server refuses to start rather than guess.

## 2. Pairing and transport

- The server binds one explicit private IPv4 address, uses TLS 1.2 or later, and handles
  at most eight connections. It logs nothing: no tokens, origins, paths or pictures.
- Every request needs the pairing token as a bearer credential **and** an allowed
  `Origin`. CORS is not authentication; the token is.
- `GET /frame` returns the newest JPEG with its sequence number, age and the camera's run
  identifier. `GET /frame?after=N` waits up to one second for a newer picture. Pictures
  older than 1.5 s are refused, encoded pictures are capped at 2 MiB, and nothing is
  written to disk.
- `GET /status` returns the board, OS, capture method and resolution for the phone's
  status line. It carries no credentials.
- `GET /telemetry` (only with `--telemetry <serial port>`) returns the newest reading from
  an ESP32 running [`firmware/esp32-telemetry`](../firmware/esp32-telemetry/README.md):
  ultrasonic distance and, when the MPU6050 is found, acceleration and rotation, with its
  age. Each line from the board is checked field by field; anything else is ignored.
  Readings older than one second are refused (503). Same token, origin and TLS rules.
- Connections are kept alive so an older Pi does not pay for a TLS handshake per picture.

Create the pairing token on the Pi. It is never printed:

```sh
python3 pi-camera-server.py --generate-token /home/pi/astha-camera.token
```

Start the server with the Pi's own Wi-Fi address and certificate:

```sh
python3 pi-camera-server.py --bind 192.168.1.50 --port 8443 \
  --cert /home/pi/tls/camera-fullchain.pem --key /home/pi/tls/camera-key.pem \
  --token-file /home/pi/astha-camera.token \
  --allow-origin https://localhost \
  --tuning imx219_noir.json \
  --width 640 --height 480 --fps 4 --quality 70
```

**NoIR cameras need `--tuning`.** libcamera otherwise applies the colour tuning for the
ordinary module, and picamera2 ignores the `LIBCAMERA_RPI_TUNING_FILE` environment
variable unless the file is passed to it. `--tuning` takes the plain name of an installed
tuning file (`imx219_noir.json` for the v2 NoIR, `imx477_noir.json` for the HQ NoIR);
`--probe` lists the NoIR files present. It works with picamera2 and the `rpicam-still` /
`libcamera-still` commands; the legacy stack has no tuning files and is refused.

`https://localhost` is the Android app's origin. Add the web preview's exact origin with a
second `--allow-origin` if you test in a browser. Lower `--fps`, `--quality` or the
resolution to save bandwidth and battery; the phone rejects anything above 1280×720.

### Certificates

The phone must trust the Pi's certificate. Three workable routes:

1. A hostname with a public-CA certificate that resolves to the Pi's LAN address.
2. A private certificate authority whose root is installed on the test phone. **Debug
   builds of the Android app trust user-installed authorities; release builds do not**
   (`res/xml/network_security_config.xml`). This is the practical route for prototype
   testing and is why hardware testing uses the debug APK.
3. A managed-device trust store, for an organisation that runs one.

A bare self-signed certificate that is not installed as an authority will be refused, and
that is intended. Do not disable certificate checks, allow cleartext, or publish the
camera through a public proxy to get around it.

Keep the token file and TLS key at mode `600`. To revoke a pairing, replace the token and
restart the server. Firewall the port to the local network and never forward it on the
router.

## 3. On the phone

Open **Devices → Pair a Wi-Fi camera**, enter the address and pairing code, and choose
Connect. ASTHA speaks each change: connected, link dropped and retrying, reconnected,
or lost. The optional **Low-data mode** asks for one picture per second.

Behaviour the tests cover:

- The pairing code is cleared from the form immediately and kept only in memory.
- ASTHA becomes "connected" only after a picture is fetched, validated and decoded.
- A dropped link is retried with backoff (0.5 s, 1 s, 2 s, 4 s) for up to 45 seconds. During
  the outage no earlier picture is offered for analysis, and any answer that was being
  prepared from it is cancelled.
- A camera that restarted is accepted again; a replayed picture is not.
- A rejected pairing, a malformed picture or a failure before the first picture is final
  and is explained aloud. The phone camera remains available.
- In the background no pictures are requested. The pairing is kept in memory so that
  returning to ASTHA does not make a blind user type the code again. Closing the app ends
  the pairing.
- Only the newest picture is held. Analysis samples it when it needs one, so a slow model
  never works through a queue of old pictures.

Sending a picture from this camera to the online AI is still governed by the normal
online-processing consent.

## 4. Running it at boot (optional)

```ini
# /etc/systemd/system/astha-camera.service
[Unit]
Description=ASTHA paired camera
After=network-online.target
Wants=network-online.target

[Service]
User=pi
ExecStart=/usr/bin/python3 /home/pi/pi-camera-server.py --bind 192.168.1.50 --port 8443 \
  --cert /home/pi/tls/camera-fullchain.pem --key /home/pi/tls/camera-key.pem \
  --token-file /home/pi/astha-camera.token --allow-origin https://localhost
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
```

The address must be stable (a DHCP reservation), because the server refuses to bind
anything but the address it is given.

## Verified on hardware

### Desktop Chrome and live ASTHA, 17 October 2026

- Hardware: Raspberry Pi 4, Debian 13, IMX219 NoIR camera; fresh browser pairing with the
  live ASTHA web app was confirmed.
- Live preview: 32 distinct frame sequences in 10.044 seconds, about 3.19 pictures per
  second. The Pi source stayed active during this foreground sample.
- Description: an actual Pi-camera frame received a successful bilingual API response
  and a visible answer in about 5.5 seconds. Audio playback was not verified.
- Image quality: the picture remained blurry even when held still. Detailed view once
  labelled a ceiling as a keyboard with a 55% COCO model score. This is a false positive,
  and the model score is not a verified accuracy figure. Detection and NoIR colour
  accuracy have not been validated.
- Ultrasonic: all 31 samples with a flat book that the user placed at a reported 30 cm
  had `distance_status: out_of_range` and `distance_cm: null`; there were zero valid
  measurements. The desktop browser feed likewise produced no valid range reading.
  A connected telemetry feed therefore does not establish a working distance sensor or
  calibrated accuracy. The firmware's status combines pulse timeout and out-of-range
  results; it does not expose raw pulse width to distinguish those cases.
- A later bounded raw diagnostic recorded 20/20 samples with ECHO high before and after
  triggering (`echo_before: 1`, `echo_after: 1`) and `width_us: -1`. The input remained
  high during these observations, and no complete pulse was measured. After the user
  power-cycled the sensor USB supply, all 33 fresh telemetry samples still reported
  `out_of_range`. This does not identify a particular failed component or prove a wiring
  cause; the physical sensor, power, common ground, divider and GPIO connections still
  need inspection. No persistent firmware, wiring or flash change was made by this check.
- MPU6050 remained `not_found`. Android hardware behavior, device voice and audio output
  were not tested in this session.

Later on 17 October, the user reported incorrect wiring and the range feed recovered.
One ten-second test yielded 35 valid measurements out of 36 samples, spanning
36.1–45.9 cm (median 38 cm). With a phone held nearby, all 36 samples were valid,
spanning 9–12.5 cm (median 10 cm), with age at most 99 ms. These are actual sensor
readings and establish functional response after the wiring correction. The physical
target distances were not measured; they do not establish calibrated accuracy, a
particular component failure or a safe path. Firmware was not changed.

These observations are limited to the stated desktop tests. An app-level visibility
handler was found to disconnect the Pi when Chrome became hidden, despite the transport's
pause/resume support. The follow-up fix preserves Pi pairing while hidden, cancels
pending recognition and speech, clears stale vision and range readings, and waits for a
fresh visible frame before restarting recognition. It still stops a phone camera.
Its regression tests use simulated frames and lifecycle events;
physical background/resume behavior must be rechecked after deployment.

The Devices and Detailed views distinguish a fresh ultrasonic measurement from an
invalid/out-of-range result or missing fresh data. An invalid result or a reading older
than one second removes the previous number. A missing echo or out-of-range result
does not establish a clear or safe path. These UI and freshness rules are covered by
automated fixtures; they do not repair or validate the physical sensor.
Repeated telemetry sequence numbers do not refresh the reading's lifetime; backwards
sequences are rejected. If the ESP32 restarts its counter, disconnect and pair again
before using its measurements, because the existing protocol has no sensor-run identity.

### Pi camera and ESP32 transport, 15 October 2026

15 October 2026, over a phone hotspot, from a Windows PC acting as the client.

| Item | Result |
| --- | --- |
| Board | Raspberry Pi 4 Model B Rev 1.4, 2 GB (`b03114`) |
| OS | Debian GNU/Linux 13 (trixie), kernel 6.18.34+rpt-rpi-v8, aarch64, Python 3.13.5 |
| Camera | imx219 (v2 sensor, NoIR module), libcamera 0.7.1, picamera2; `--probe` selected picamera2 |
| Tuning | `imx219_noir.json` loaded with `--tuning`; without it the standard `imx219.json` was used |
| Power and heat | `get_throttled=0x0`, 44–45 °C idle |
| TLS | TLS 1.3 (`TLS_AES_256_GCM_SHA384`). The certificate is accepted only with the private CA; a client without it is refused |
| Refusals | No token 401, wrong token 401, wrong origin 403, no origin 403 |
| Pictures | 640×480 JPEG, quality 70, about 11 KB each; 4.04–4.09 pictures per second over one kept-alive connection for 10–15 s, no errors, pictures fresh when served |

The certificate came from a private CA made on the Pi for this test. The CA is
name-constrained to private IPv4 ranges and `.local` names, so even if its key leaked it
could not vouch for a public site. Its public certificate is what a debug build of the app
needs installed on the phone.

In the app, a paired camera whose `/status` reports `telemetry: true` is also asked for
`/telemetry` five times a second (only while the app is in front, same token), and each
fresh distance goes to `AsthaSensors`; the device line then says "distance sensor". See
[the distance sensor interface](braille-controller.md#distance-sensor-interface) for how a
measurement reaches what ASTHA says.

Sensors on the same Pi (ESP32 on USB, `--telemetry`): HC-SR04 readings at 10.0 per second
with no gaps; through `/telemetry` over TLS every reading arrived, median age 50 ms and at
most 100 ms. The MPU6050 was not detected on GPIO21/22, so motion readings are untested,
and ultrasonic accuracy at known distances has not been measured.

The later desktop web-app pairing and telemetry checks are recorded above. Still not
verified: Android pairing or telemetry, a phone trusting the CA, delay to spoken audio,
battery life and NoIR colour accuracy. The 17 October known-target test did not establish
a valid ultrasonic measurement.

## 5. Hardware checklist

Record the `--probe` output, the phone model and Android version, and the app build hash.

- [x] `--probe` output saved; the chosen capture method produces a picture. (Pi 4, 15 October 2026)
- [ ] Certificate route chosen and trusted by the test phone; a wrong certificate is refused.
- [ ] Correct pairing connects and is spoken; a wrong code is rejected and explained. (Desktop Chrome pairing confirmed 17 October; Android and speech pending.)
- [ ] Measured pictures per second and picture-to-answer delay on the target phone. (PC transport: 4.0 per second; desktop web preview: 3.19 per second; visible bilingual answer: about 5.5 seconds. Phone and spoken-answer timing pending.)
- [ ] Wi-Fi with no internet still works for on-device recognition.
- [ ] Pi unplugged, Wi-Fi dropped for 5 s, 20 s and 60 s: retry, recovery and give-up are spoken.
- [ ] Phone screen off and on: pictures stop and resume without re-entering the code.
- [ ] Phone camera works immediately after disconnecting.
- [ ] Power-bank run time and Pi temperature in the enclosure over an hour.
- [ ] NoIR colour: record how wrong colours are in daylight and indoors. Colour answers
      from this camera should stay hedged until measured.
- [ ] TalkBack reads the form, the status changes and the errors without overlap.
