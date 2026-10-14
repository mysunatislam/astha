# Six-key Braille controller and distance sensor: software design

**No Braille controller has been built.** A distance sensor now exists: an HC-SR04 on an
ESP32 beside the Pi camera (see [firmware/esp32-telemetry](../firmware/esp32-telemetry/README.md)).
This describes the software that is in place and exactly which parts have and have not been
exercised.

| Part | State |
| --- | --- |
| Chord decoding, command map, letter entry (`tools/braille.js`) | Tested in `tests/test_braille.mjs` |
| Keyboard practice transport | Tested, and usable in a browser from **Devices** |
| Bluetooth transport | Written against the planned firmware contract; has only met a stand-in device |
| ESP32 firmware for the Braille keys | Not written (the sensor firmware is a separate script) |
| Android Bluetooth transport | Not written. The Android WebView has no Web Bluetooth, so the app needs a native transport |
| Bangla Braille table | Not written. It must be reviewed by a Braille reader first |
| Range-sensor interface (`tools/sensors.js`) | Fed by the Pi camera link's `/telemetry` readings; tested with stand-ins, not yet on a phone |

## Layers

```
transport  ->  key masks  ->  chord decoder  ->  command map or text entry  ->  ASTHA action
```

A **transport** has one job: report which of the six keys are down, as a number where dot
*n* is bit *n − 1*. It implements `{ name, start(onKeys, onStatus), stop() }`. Everything
after it is shared. Adding the real controller means adding a transport.

The **decoder** treats keys pressed together or rolled as one chord and enters it when the
last key is released. A key that never reports its release is discarded after five
seconds so the controller cannot lock up.

A chord is then either a **command** or, in typing mode, a **character**.

## Default commands

All six keys always stop ASTHA; it is the easiest chord to find in a hurry.

| Dots | Letter | Action |
| --- | --- | --- |
| 1 2 3 4 5 6 | full cell | Stop speaking and cancel |
| 1 2 3 | l | Listen for my question |
| 1 4 5 | d | Describe surroundings |
| 1 2 3 5 | r | Read text |
| 1 2 4 | f | Find my things |
| 1 | a | Repeat the last answer |
| 1 4 | c | Turn the camera on or off |
| 1 2 5 | h | Go to the home page |
| 1 3 4 | m | Change what ASTHA focuses on (only the modes kept in Personal setup) |
| 2 3 4 5 | t | Turn Braille typing on or off |

`AsthaBraille.setMapping({...})` replaces the map and stores it on the device. A map is
rejected if it names an unknown command, uses a chord outside 1–63, or leaves Stop
unreachable. There is no settings screen for remapping yet.

**Typing mode** enters uncontracted English letters into the request field. Dots 3 6 is a
space, dots 4 5 6 deletes, and all six keys send the request and leave typing mode.

An unassigned chord is explained aloud at most once every four seconds.

## Planned Bluetooth contract

The firmware does not exist; these values are the contract the transport is written to
and can change before any controller ships.

- Service `a57a0001-6b72-4c1e-9d2a-415354484101`
- Characteristic `a57a0002-6b72-4c1e-9d2a-415354484101`, notify. Byte 0 is the key mask
  (bit 0 = dot 1 … bit 5 = dot 6). Later bytes are reserved.
- Pairing uses the platform chooser, filtered to the service. Nothing is paired silently.
- When the link drops, held keys are released, and reconnection is tried five times with
  backoff (0.5 s to 8 s) before reporting failure. Each state is spoken.

Before hardware testing: choose the BLE security level (bonding with encryption is the
intended minimum, since a controller can start the camera), debounce in firmware, decide
battery reporting, and write the native Android transport.

## Keyboard practice

**Devices → Start keyboard practice** maps `F D S` to dots 1 2 3 and `J K L` to dots 4 5 6.
It ignores keys typed into a text field, key repeats, and anything with Ctrl, Alt or the
command key, and releases held keys when the window loses focus. The status line always
says that no controller is connected.

## Distance sensor interface

`AsthaSensors.report(channel, metres, source)` is what a future transport will call.
Readings outside 0.02–8 m are rejected and a reading older than one second is ignored.
`AsthaSensors.fuse(estimate, channel)` returns the measurement when there is a fresh one,
and otherwise the vision pipeline's guess **marked as an estimate**.

The paired Pi camera link calls `report('front', metres, 'ultrasonic')` for each fresh
HC-SR04 reading, dated by the reading's own age, and clears the readings when the camera
disconnects. Perception (`tools/perceive.js`) then gives the measurement to the object in
the middle of a Pi-camera picture, but only if that object's own size estimate roughly
agrees (half to double); otherwise the echo is treated as "something straight ahead". A
measured distance is spoken as a number and called measured ("measured at 85 centimetres",
"সেন্সরে মাপা ৮৫ সেন্টিমিটার দূরে"); estimates stay "about". The phone's own camera never
uses the sensor, because it does not share its point of view.

This assumes the sensor is mounted beside the Pi camera and points the same way. Its beam
(about 15°) is taken to be the middle fifth of the picture across and the middle third down;
a different mount needs `ULTRASONIC_BEAM` changed.
