# ASTHA sensor telemetry for an ESP32 running MicroPython.
#
# Sends one JSON object per line over the USB serial port, ten times a second:
#   {"type":"sample","v":1,"seq":12,"ms":1234,
#    "distance_cm":85.2,"distance_status":"ok",
#    "imu":{"ax":0.01,"ay":-0.02,"az":0.99,"gx":0.4,"gy":-0.1,"gz":0.0,"temp_c":29.1},"imu_status":"ok"}
# A "hello" line describes the wiring at start and whenever the I2C devices change.
# Nothing is stored on the board and nothing is sent anywhere but the USB serial port.
#
# Wiring (ESP32 DevKit):
#   HC-SR04  VCC 5V, GND, TRIG -> GPIO19, ECHO -> GPIO18 through a divider (for example
#            1 kOhm from ECHO, 2 kOhm to GND). ECHO is 5 V and would damage a 3.3 V pin.
#   MPU6050  VCC 3.3V, GND, SDA -> GPIO21, SCL -> GPIO22 (address 0x68, or 0x69 with AD0 high).
import json
import time
from machine import I2C, Pin, time_pulse_us

FIRMWARE = "astha-telemetry 1"
TRIG_PIN, ECHO_PIN = 19, 18
SDA_PIN, SCL_PIN = 21, 22
PERIOD_MS = 100             # ten samples a second; the HC-SR04 needs at least 60 ms between pings
ECHO_TIMEOUT_US = 30000     # about 5 m round trip; longer means nothing in range
MIN_CM, MAX_CM = 2.0, 400.0  # the HC-SR04's rated range
RESCAN_MS = 5000

trig = Pin(TRIG_PIN, Pin.OUT, value=0)
echo = Pin(ECHO_PIN, Pin.IN)
i2c = I2C(0, sda=Pin(SDA_PIN), scl=Pin(SCL_PIN), freq=400000)


def send(obj):
    print(json.dumps(obj))


def distance():
    """One ping. Returns (centimetres or None, status)."""
    trig.value(0)
    time.sleep_us(2)
    trig.value(1)
    time.sleep_us(10)
    trig.value(0)
    try:
        width = time_pulse_us(echo, 1, ECHO_TIMEOUT_US)
    except OSError:
        return None, "error"
    if width == -2:
        return None, "no_echo_start"    # ECHO never rose: check wiring and the 5 V supply
    if width == -1:
        return None, "out_of_range"     # nothing reflected within about 5 m
    cm = width / 58.3                    # sound at about 20 C: 343 m/s, there and back
    if cm < MIN_CM or cm > MAX_CM:
        return None, "out_of_range"
    return round(cm, 1), "ok"


class Mpu6050:
    WHO_AM_I, PWR_MGMT_1, CONFIG, GYRO_CONFIG, ACCEL_CONFIG, DATA = 0x75, 0x6B, 0x1A, 0x1B, 0x1C, 0x3B

    def __init__(self, bus):
        self.bus, self.address, self.identity = bus, None, None

    def find(self, devices):
        for address in (0x68, 0x69):
            if address in devices:
                try:
                    self.identity = self.bus.readfrom_mem(address, self.WHO_AM_I, 1)[0]
                    self.bus.writeto_mem(address, self.PWR_MGMT_1, b"\x00")    # wake, internal clock
                    self.bus.writeto_mem(address, self.CONFIG, b"\x03")        # 44 Hz low-pass
                    self.bus.writeto_mem(address, self.GYRO_CONFIG, b"\x00")   # +-250 deg/s
                    self.bus.writeto_mem(address, self.ACCEL_CONFIG, b"\x00")  # +-2 g
                    self.address = address
                    return True
                except OSError:
                    pass
        self.address = None
        return False

    def read(self):
        raw = self.bus.readfrom_mem(self.address, self.DATA, 14)

        def word(i):
            value = (raw[i] << 8) | raw[i + 1]
            return value - 65536 if value & 0x8000 else value
        return {
            "ax": round(word(0) / 16384, 3), "ay": round(word(2) / 16384, 3), "az": round(word(4) / 16384, 3),
            "temp_c": round(word(6) / 340 + 36.53, 1),
            "gx": round(word(8) / 131, 2), "gy": round(word(10) / 131, 2), "gz": round(word(12) / 131, 2),
        }


def hello(devices, imu):
    send({"type": "hello", "v": 1, "firmware": FIRMWARE,
          "hcsr04": {"trig": TRIG_PIN, "echo": ECHO_PIN},
          "i2c": {"sda": SDA_PIN, "scl": SCL_PIN, "devices": ["0x%02x" % d for d in devices]},
          "mpu6050": {"found": imu.address is not None,
                      "address": None if imu.address is None else "0x%02x" % imu.address,
                      "who_am_i": None if imu.identity is None else "0x%02x" % imu.identity},
          "period_ms": PERIOD_MS})


def main():
    imu = Mpu6050(i2c)
    devices = i2c.scan()
    imu.find(devices)
    hello(devices, imu)
    seq, last_scan = 0, time.ticks_ms()
    while True:
        began = time.ticks_ms()
        cm, status = distance()
        sample = {"type": "sample", "v": 1, "seq": seq, "ms": began, "distance_cm": cm, "distance_status": status}
        if imu.address is None:
            sample["imu"], sample["imu_status"] = None, "not_found"
        else:
            try:
                sample["imu"], sample["imu_status"] = imu.read(), "ok"
            except OSError:
                sample["imu"], sample["imu_status"] = None, "read_error"
                imu.address = None   # look for it again at the next scan
        send(sample)
        seq += 1
        # A sensor connected or fixed while running is picked up without a reset.
        if imu.address is None and time.ticks_diff(time.ticks_ms(), last_scan) >= RESCAN_MS:
            last_scan = time.ticks_ms()
            found = i2c.scan()
            located = imu.find(found)
            if found != devices or located:
                devices = found
                hello(devices, imu)
        wait = PERIOD_MS - time.ticks_diff(time.ticks_ms(), began)
        if wait > 0:
            time.sleep_ms(wait)


main()
