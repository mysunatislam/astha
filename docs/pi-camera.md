# Raspberry Pi Wi-Fi camera (clip-on prototype)

The clip-on prototype is a Raspberry Pi with a NoIR camera module and a power bank. The Pi
only captures pictures and serves the newest one over the local Wi-Fi. Recognition runs on
the phone or the ASTHA server; an original Model B cannot run a modern vision model.

**Status.** The phone side and the Pi's HTTP handler are covered by automated tests using
stand-ins. Nothing in this document has been run on a Raspberry Pi. The board revision,
operating system, camera stack, certificate trust on the phone, frame rate, battery life
and NoIR image quality are all unverified until someone completes the checklist at the end.

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
  --width 640 --height 480 --fps 4 --quality 70
```

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

## 5. Hardware checklist (all pending)

Record the `--probe` output, the phone model and Android version, and the app build hash.

- [ ] `--probe` output saved; the chosen capture method produces a picture.
- [ ] Certificate route chosen and trusted by the test phone; a wrong certificate is refused.
- [ ] Correct pairing connects and is spoken; a wrong code is rejected and explained.
- [ ] Measured pictures per second and picture-to-answer delay at the chosen settings.
- [ ] Wi-Fi with no internet still works for on-device recognition.
- [ ] Pi unplugged, Wi-Fi dropped for 5 s, 20 s and 60 s: retry, recovery and give-up are spoken.
- [ ] Phone screen off and on: pictures stop and resume without re-entering the code.
- [ ] Phone camera works immediately after disconnecting.
- [ ] Power-bank run time and Pi temperature in the enclosure over an hour.
- [ ] NoIR colour: record how wrong colours are in daylight and indoors. Colour answers
      from this camera should stay hedged until measured.
- [ ] TalkBack reads the form, the status changes and the errors without overlap.
