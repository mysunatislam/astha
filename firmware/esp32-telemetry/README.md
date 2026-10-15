# ESP32 sensor telemetry (MicroPython)

`main.py` reads an HC-SR04 ultrasonic sensor and an MPU6050 motion sensor ten times a
second and prints one JSON line per reading on the USB serial port (115200 baud). The
Raspberry Pi camera server reads it with `--telemetry` and serves the newest reading at
`GET /telemetry`, behind the same pairing token, origin check and TLS as the pictures (see
[`docs/pi-camera.md`](../../docs/pi-camera.md)).

The board sends nothing anywhere but the USB cable, stores nothing, and has no Wi-Fi or
Bluetooth enabled.

## Wiring

| Sensor | Pin | ESP32 |
| --- | --- | --- |
| HC-SR04 | VCC | 5V (VIN) |
| | TRIG | GPIO19 |
| | ECHO | GPIO18 **through a divider**: 1 kΩ from ECHO, 2 kΩ to GND. ECHO is 5 V; a 3.3 V pin can be damaged without it |
| | GND | GND |
| MPU6050 | VCC | 3.3V |
| | SDA | GPIO21 |
| | SCL | GPIO22 |
| | GND | GND |

## Output

```json
{"type": "hello", "v": 1, "firmware": "astha-telemetry 1", "hcsr04": {"trig": 19, "echo": 18},
 "i2c": {"sda": 21, "scl": 22, "devices": ["0x68"]},
 "mpu6050": {"found": true, "address": "0x68", "who_am_i": "0x68"}, "period_ms": 100}
{"type": "sample", "v": 1, "seq": 12, "ms": 1234, "distance_cm": 85.2, "distance_status": "ok",
 "imu": {"ax": 0.01, "ay": -0.02, "az": 0.99, "gx": 0.4, "gy": -0.1, "gz": 0.0, "temp_c": 29.1}, "imu_status": "ok"}
```

- `distance_status`: `ok` (2–400 cm), `out_of_range` (no echo within about 5 m),
  `no_echo_start` (ECHO never rose: check wiring and 5 V), or `error`.
- `imu_status`: `ok`, `not_found` (nothing at 0x68/0x69; the board looks again every 5 s,
  so fixing the wiring needs no restart) or `read_error`.
- Acceleration is in g (±2 g range), rotation in degrees per second (±250), `temp_c` is the
  sensor chip's own temperature, not the air.
- Distance assumes sound at about 20 °C (343 m/s); at 35 °C it reads about 2.5 % short.

## Installing

1. Back up whatever firmware the board has: `esptool.py --port /dev/ttyACM0 read_flash 0 ALL backup.bin`,
   then `verify_flash 0 backup.bin`.
2. Flash MicroPython for the classic ESP32 (`ESP32_GENERIC-20241129-v1.24.1.bin` from
   micropython.org was used): `esptool.py --chip esp32 erase_flash`, then
   `esptool.py --chip esp32 write_flash -z 0x1000 ESP32_GENERIC-20241129-v1.24.1.bin`.
3. `python3 install.py /dev/ttyACM0 main.py` copies the script and restarts the board.
   It waits for the board to boot first, because opening the port resets most ESP32
   boards and `mpremote` can start talking too early.

Opening the serial port restarts the board (its USB chip drives the reset line). Readers
should open it with DTR and RTS off, and expect a boot message before the first reading.

## Status (15 October 2026)

Installed on an ESP32-D0WD-V3 (4 MB) behind a CH9102 USB bridge, on a Raspberry Pi 4.
HC-SR04: readings arrive at 10.0 per second with no gaps; accuracy at known distances is
not yet measured. MPU6050: **not detected** on GPIO21/22 (the previous firmware on this
board reported the same), so motion readings are untested. The board's previous firmware
was backed up and verified before it was replaced.
