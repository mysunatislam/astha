#!/usr/bin/env python3
"""Paired HTTPS JPEG camera for a Raspberry Pi. No cloud or account credentials are used.

The Pi only captures and serves its newest picture; recognition runs on the phone or the
ASTHA server. Run with --probe first: it reports the board, operating system and which
camera stacks are installed, and names the capture method this script would use.
Written for Python 3.7+ so it also runs on the legacy OS images an original Model B needs.
"""
import argparse
import hmac
import importlib.util
import io
import ipaddress
import json
import os
from pathlib import Path
import platform
import re
import secrets
import shutil
import socketserver
import ssl
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import parse_qs, urlsplit

MAX_BYTES = 2 * 1024 * 1024
MAX_AGE_MS = 1500
MAX_SEQUENCE = 9007199254740991
# The phone rejects anything larger, so a bigger capture would only waste the link.
MAX_WIDTH, MAX_HEIGHT = 1280, 720
LIBRARIES = ('picamera2', 'picamera')
COMMANDS = ('rpicam-still', 'libcamera-still', 'raspistill')
BACKENDS = LIBRARIES + COMMANDS
# libcamera colour tuning. A NoIR camera needs its own file (imx219_noir.json for the v2 NoIR);
# picamera2 ignores the environment variable unless the file is passed to it.
TUNING_NAME = re.compile(r'[A-Za-z0-9_-][A-Za-z0-9_.-]{0,63}\.json')
TUNING_DIRS = ('/usr/share/libcamera/ipa/rpi/vc4', '/usr/share/libcamera/ipa/rpi/pisp',
               '/usr/local/share/libcamera/ipa/rpi/vc4', '/usr/local/share/libcamera/ipa/rpi/pisp')


class Frames:
    def __init__(self):
        self.condition = threading.Condition()
        self.jpeg = None
        self.at = 0
        self.sequence = 0

    def put(self, jpeg):
        if not jpeg or len(jpeg) > MAX_BYTES or not jpeg.startswith(b'\xff\xd8'):
            return
        with self.condition:
            self.jpeg = jpeg
            self.at = time.monotonic()
            self.sequence += 1
            self.condition.notify_all()

    def get(self, after=0):
        with self.condition:
            self.condition.wait_for(lambda: self.sequence > after, timeout=1)
            age = int((time.monotonic() - self.at) * 1000)
            if not self.jpeg or self.sequence <= after or age > MAX_AGE_MS:
                return None
            return self.jpeg, self.sequence, max(0, age)


TELEMETRY_MAX_AGE_MS = 1000
TELEMETRY_LINE_LIMIT = 1024
DISTANCE_STATUSES = ('ok', 'out_of_range', 'no_echo_start', 'error')
IMU_STATUSES = ('ok', 'not_found', 'read_error')
IMU_LIMITS = {'ax': 20.0, 'ay': 20.0, 'az': 20.0, 'gx': 2500.0, 'gy': 2500.0, 'gz': 2500.0, 'temp_c': 125.0}


def number(value, limit):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and value == value and abs(value) <= limit


def telemetry_sample(line):
    """A sample from firmware/esp32-telemetry, checked field by field, or None. Unknown fields are dropped."""
    if len(line) > TELEMETRY_LINE_LIMIT:
        return None
    try:
        value = json.loads(line.decode('utf-8') if isinstance(line, bytes) else line)
    except (ValueError, UnicodeError):
        return None
    if not isinstance(value, dict) or value.get('type') != 'sample' or value.get('v') != 1:
        return None
    seq, distance, status = value.get('seq'), value.get('distance_cm'), value.get('distance_status')
    imu, imu_status = value.get('imu'), value.get('imu_status')
    if not (isinstance(seq, int) and not isinstance(seq, bool) and 0 <= seq <= MAX_SEQUENCE):
        return None
    if status not in DISTANCE_STATUSES or imu_status not in IMU_STATUSES:
        return None
    if (status == 'ok' and not (number(distance, 500) and distance >= 0)) or (status != 'ok' and distance is not None):
        return None
    sample = {'seq': seq, 'distance_cm': distance, 'distance_status': status, 'imu': None, 'imu_status': imu_status}
    if imu_status == 'ok':
        if not isinstance(imu, dict) or not all(number(imu.get(key), limit) for key, limit in IMU_LIMITS.items()):
            return None
        sample['imu'] = {key: imu[key] for key in IMU_LIMITS}
    elif imu is not None:
        return None
    return sample


class Telemetry:
    """The newest sample from the ESP32 on a USB serial port. Nothing is stored or logged."""

    def __init__(self):
        self.lock = threading.Lock()
        self.sample = None
        self.at = 0
        self.received = 0

    def put(self, sample):
        with self.lock:
            self.sample, self.at = sample, time.monotonic()
            self.received += 1

    def latest(self):
        with self.lock:
            age = int((time.monotonic() - self.at) * 1000)
            if not self.sample or age > TELEMETRY_MAX_AGE_MS:
                return None
            return dict(self.sample, age_ms=max(0, age))


def telemetry_loop(open_port, telemetry, stopped):
    """Read lines for as long as the server runs, reopening the port if the board is unplugged."""
    while not stopped.is_set():
        try:
            port = open_port()
        except Exception:
            stopped.wait(2)
            continue
        try:
            pending = b''
            while not stopped.is_set():
                # Wait for one byte, then take whatever else has arrived: waiting for a full
                # buffer would hold readings back by a third of a second.
                chunk = port.read(1)
                if not chunk:
                    continue
                pending += chunk + port.read(min(4096, getattr(port, 'in_waiting', 0) or 0))
                *lines, pending = pending.split(b'\n')
                if len(pending) > TELEMETRY_LINE_LIMIT:
                    pending = b''   # a line that never ends is noise, not telemetry
                for line in lines:
                    sample = telemetry_sample(line.strip())
                    if sample:
                        telemetry.put(sample)
        except Exception:
            stopped.wait(1)
        finally:
            try:
                port.close()
            except Exception:
                pass


def serial_opener(path):
    def open_port():
        import serial   # pyserial, only needed with --telemetry
        port = serial.Serial()
        port.port, port.baudrate, port.timeout = path, 115200, 0.5
        port.dtr = False   # DTR and RTS asserted hold many ESP32 boards in reset
        port.rts = False
        port.open()
        return port
    return open_port


def read_text(path, limit=4096):
    try:
        with open(path, 'rb') as handle:
            return handle.read(limit).replace(b'\x00', b'').decode('utf-8', 'replace').strip()
    except OSError:
        return ''


def describe_board():
    """Board, OS and memory as the system reports them. Nothing here is assumed."""
    model = read_text('/proc/device-tree/model', 256)
    revision = ''
    for line in read_text('/proc/cpuinfo', 16384).splitlines():
        name, _, value = line.partition(':')
        if name.strip().lower() == 'revision':
            revision = value.strip()
        elif name.strip().lower() == 'model' and not model:
            model = value.strip()
    os_name = ''
    for line in read_text('/etc/os-release').splitlines():
        if line.startswith('PRETTY_NAME='):
            os_name = line.split('=', 1)[1].strip().strip('"')
    memory_mb = 0
    for line in read_text('/proc/meminfo').splitlines():
        if line.startswith('MemTotal:'):
            memory_mb = int(re.sub(r'[^0-9]', '', line) or 0) // 1024
    return {'model': model or 'unknown', 'revision': revision or 'unknown',
            'os': os_name or platform.platform(), 'machine': platform.machine(),
            'python': platform.python_version(), 'memory_mb': memory_mb}


def available_backends():
    """Capture methods that are installed, best first. Importability is checked without importing."""
    found = []
    for name in LIBRARIES:
        try:
            if importlib.util.find_spec(name) is not None:
                found.append(name)
        except (ImportError, ValueError):
            pass
    return found + [tool for tool in COMMANDS if shutil.which(tool)]


def choose_backend(requested, available):
    if requested != 'auto':
        return requested if requested in available else None
    return available[0] if available else None


def tuning_path(name, directories=TUNING_DIRS):
    """The installed libcamera tuning file with this plain name, or None. Never a path."""
    if not name or not TUNING_NAME.fullmatch(name):
        return None
    for directory in directories:
        path = os.path.join(directory, name)
        if os.path.isfile(path):
            return path
    return None


def noir_tunings(directories=TUNING_DIRS):
    found = set()
    for directory in directories:
        try:
            found.update(name for name in os.listdir(directory) if name.endswith('_noir.json'))
        except OSError:
            pass
    return sorted(found)


class Picamera2Source:
    """libcamera stack: Raspberry Pi OS Bullseye and later."""
    name = 'picamera2'

    def __init__(self, width, height, quality, settle_ms, tuning=None):
        from picamera2 import Picamera2
        self.camera = Picamera2(tuning=tuning) if tuning else Picamera2()
        self.camera.configure(self.camera.create_video_configuration(main={'size': (width, height), 'format': 'RGB888'}))
        try:
            self.camera.options['quality'] = quality
        except Exception:
            pass

    def start(self):
        self.camera.start()

    def capture(self):
        output = io.BytesIO()
        self.camera.capture_file(output, format='jpeg')
        return output.getvalue()

    def stop(self):
        self.camera.stop()
        self.camera.close()


class LegacyPicameraSource:
    """Legacy camera stack: Buster, or Bullseye with the legacy camera enabled."""
    name = 'picamera'

    def __init__(self, width, height, quality, settle_ms):
        import picamera
        self.camera = picamera.PiCamera(resolution=(width, height))
        self.quality = quality
        self.settle = settle_ms / 1000.0

    def start(self):
        time.sleep(max(self.settle, 1.0))  # exposure and white balance need a moment

    def capture(self):
        output = io.BytesIO()
        self.camera.capture(output, format='jpeg', use_video_port=True, quality=self.quality)
        return output.getvalue()

    def stop(self):
        self.camera.close()


class CommandSource:
    """One still per call through the installed camera command. Slow, but needs no library."""

    def __init__(self, tool, width, height, quality, settle_ms, tuning=None):
        self.name = tool
        settle = str(max(1, int(settle_ms)))
        if tool == 'raspistill':
            self.command = [tool, '-n', '-t', settle, '-w', str(width), '-h', str(height), '-q', str(quality), '-o', '-']
        else:
            self.command = [tool, '-n', '-t', settle, '--width', str(width), '--height', str(height), '-q', str(quality)]
            self.command += (['--tuning-file', tuning] if tuning else []) + ['-o', '-']

    def start(self):
        pass

    def capture(self):
        result = subprocess.run(self.command, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=15)
        return result.stdout if result.returncode == 0 else b''

    def stop(self):
        pass


def open_source(backend, width, height, quality, settle_ms, tuning=None):
    if backend == 'picamera2':
        return Picamera2Source(width, height, quality, settle_ms, tuning)
    if backend == 'picamera':
        return LegacyPicameraSource(width, height, quality, settle_ms)
    return CommandSource(backend, width, height, quality, settle_ms, tuning)


def make_handler(frames, token, origins, info=None, telemetry=None):
    info = dict(info or {})
    paths = ('/frame', '/status', '/telemetry') if telemetry else ('/frame', '/status')
    run = str(info.pop('run', '') or secrets.token_urlsafe(8))
    status_body = json.dumps(info, sort_keys=True).encode('utf-8')

    class Handler(BaseHTTPRequestHandler):
        protocol_version = 'HTTP/1.1'

        def setup(self):
            super().setup()
            self.connection.settimeout(5)

        def log_message(self, *args):
            pass  # Never log tokens, origins, frame contents or request paths.

        def reply(self, status, body=b'', extra=None):
            self.send_response(status)
            self.send_header('Cache-Control', 'no-store')
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.send_header('Content-Length', str(len(body)))
            # One TLS handshake per picture is costly on an older Pi, so a paired client
            # keeps its connection. Anything refused is closed at once.
            if status >= 400 and status != 503:
                self.send_header('Connection', 'close')
                self.close_connection = True
            origin = self.headers.get('Origin')
            if origin in origins:
                self.send_header('Access-Control-Allow-Origin', origin)
                self.send_header('Vary', 'Origin')
                self.send_header('Access-Control-Expose-Headers', 'X-Astha-Frame-Sequence,X-Astha-Frame-Age-Ms,X-Astha-Camera-Run')
            for key, value in (extra or {}).items():
                self.send_header(key, str(value))
            self.end_headers()
            if body:
                self.wfile.write(body)

        def do_OPTIONS(self):
            if self.headers.get('Origin') not in origins or urlsplit(self.path).path not in paths:
                self.reply(403)
                return
            requested = {v.strip().lower() for v in self.headers.get('Access-Control-Request-Headers', '').split(',') if v.strip()}
            if self.headers.get('Access-Control-Request-Method') != 'GET' or not requested <= {'authorization', 'accept'}:
                self.reply(403)
                return
            extra = {'Access-Control-Allow-Methods': 'GET', 'Access-Control-Allow-Headers': 'Authorization,Accept', 'Access-Control-Max-Age': '60'}
            if self.headers.get('Access-Control-Request-Private-Network') == 'true':
                extra['Access-Control-Allow-Private-Network'] = 'true'
            self.reply(204, extra=extra)

        def do_GET(self):
            if self.headers.get('Origin') not in origins:
                self.reply(403)
                return
            authorization = self.headers.get('Authorization', '')
            if len(authorization) > 160 or not hmac.compare_digest(authorization.encode(), ('Bearer ' + token).encode()):
                self.reply(401)
                return
            parsed = urlsplit(self.path)
            if parsed.path == '/status' and not parsed.query and not parsed.fragment:
                self.reply(200, status_body, {'Content-Type': 'application/json'})
                return
            if telemetry and parsed.path == '/telemetry' and not parsed.query and not parsed.fragment:
                sample = telemetry.latest()
                if not sample:
                    self.reply(503)   # nothing from the sensors within the last second
                    return
                self.reply(200, json.dumps(sample, sort_keys=True).encode('utf-8'), {'Content-Type': 'application/json'})
                return
            query = parse_qs(parsed.query, keep_blank_values=True)
            if parsed.path != '/frame' or parsed.fragment or set(query) - {'after'} or ('after' in query and (len(query['after']) != 1 or not re.fullmatch(r'[0-9]{1,16}', query['after'][0]))):
                self.reply(400)
                return
            after = int(query.get('after', ['0'])[0])
            if after > MAX_SEQUENCE:
                self.reply(400)
                return
            frame = frames.get(after)
            if not frame:
                self.reply(503)
                return
            jpeg, sequence, age = frame
            self.reply(200, jpeg, {'Content-Type': 'image/jpeg', 'X-Astha-Frame-Sequence': sequence, 'X-Astha-Frame-Age-Ms': age, 'X-Astha-Camera-Run': run})
    return Handler


class CameraServer(socketserver.ThreadingMixIn, HTTPServer):
    daemon_threads = True
    request_queue_size = 8

    def __init__(self, *args, **kwargs):
        self.slots = threading.BoundedSemaphore(8)
        super().__init__(*args, **kwargs)

    def process_request(self, request, client_address):
        if not self.slots.acquire(blocking=False):
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except Exception:
            self.slots.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self.slots.release()

    def handle_error(self, request, client_address):
        pass  # A disconnected frame client must not produce request/credential logs.


def capture_loop(source, frames, stopped, fps):
    """Keep only the newest picture. A failed capture leaves a stale frame, which /frame refuses."""
    interval = 1.0 / fps
    while not stopped.is_set():
        began = time.monotonic()
        try:
            frames.put(source.capture())
        except Exception:
            stopped.wait(0.5)
        stopped.wait(max(0.0, interval - (time.monotonic() - began)))


def probe(requested):
    board = describe_board()
    available = available_backends()
    report = dict(board, installed=available, selected=choose_backend(requested, available), noir_tuning=noir_tunings())
    vcgencmd = shutil.which('vcgencmd')
    if vcgencmd:
        try:
            result = subprocess.run([vcgencmd, 'get_camera'], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=5)
            report['legacy_camera'] = result.stdout.decode('ascii', 'replace').strip()
        except (OSError, subprocess.SubprocessError):
            pass
    print(json.dumps(report, indent=2, sort_keys=True))
    if not report['selected']:
        print('No usable camera stack was found. Install python3-picamera2 (Bullseye or later) or '
              'python3-picamera with the legacy camera enabled, then run --probe again.')
    elif report['selected'] in COMMANDS:
        print('Only a camera command is installed. It works, but expect about one picture per second.')


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--probe', action='store_true', help='Report the board, OS and installed camera stacks, then exit.')
    parser.add_argument('--generate-token', type=Path, help='Create a new private pairing file and exit; never print the token.')
    parser.add_argument('--bind', help='Explicit private IPv4 address on the Pi Wi-Fi interface.')
    parser.add_argument('--port', type=int, default=8443)
    parser.add_argument('--cert', type=Path)
    parser.add_argument('--key', type=Path)
    parser.add_argument('--token-file', type=Path)
    parser.add_argument('--allow-origin', action='append', default=[])
    parser.add_argument('--backend', choices=('auto',) + BACKENDS, default='auto', help='Capture method; auto picks the best one installed.')
    parser.add_argument('--width', type=int, default=640)
    parser.add_argument('--height', type=int, default=480)
    parser.add_argument('--fps', type=float, default=4.0, help='Pictures per second to offer (0.2 to 15). Lower saves bandwidth and battery.')
    parser.add_argument('--quality', type=int, default=70, help='JPEG quality 20 to 95.')
    parser.add_argument('--settle-ms', type=int, default=300, help='Exposure settling time for the command and legacy backends.')
    parser.add_argument('--tuning', help='libcamera tuning file name, for example imx219_noir.json for a NoIR camera. --probe lists the NoIR files installed.')
    parser.add_argument('--telemetry', type=Path, help='USB serial port of an ESP32 running firmware/esp32-telemetry; serves its newest reading at /telemetry. Needs pyserial.')
    args = parser.parse_args()
    if args.probe:
        probe(args.backend)
        return
    if args.generate_token:
        descriptor = os.open(str(args.generate_token), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, 'w', encoding='ascii') as output:
            output.write(secrets.token_urlsafe(32) + '\n')
        print('Private pairing file created.')
        return
    try:
        address = ipaddress.ip_address(args.bind or '')
        private_networks = [ipaddress.ip_network(value) for value in ('10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16')]
        if address.version != 4 or not any(address in network for network in private_networks) or not 1 <= args.port <= 65535:
            raise ValueError()
        if not args.cert or not args.key or not args.token_file or not args.allow_origin:
            raise ValueError()
        if args.token_file.stat().st_mode & 0o077 or args.key.stat().st_mode & 0o077:
            raise ValueError()
        token = args.token_file.read_text(encoding='ascii').strip()
        if not re.fullmatch(r'[A-Za-z0-9_-]{43,128}', token):
            raise ValueError()
        origins = set()
        for origin in args.allow_origin:
            parsed = urlsplit(origin)
            if parsed.scheme not in ('https', 'capacitor') or not parsed.netloc or parsed.path or parsed.query or parsed.fragment or parsed.username or parsed.password:
                raise ValueError()
            origins.add(origin)
    except (ValueError, OSError, UnicodeError):
        parser.error('Provide an explicit private bind address, HTTPS certificate/key, private token file (chmod 600), and exact trusted origins.')
    if not (160 <= args.width <= MAX_WIDTH and 120 <= args.height <= MAX_HEIGHT and 0.2 <= args.fps <= 15 and 20 <= args.quality <= 95 and 1 <= args.settle_ms <= 5000):
        parser.error('Use a width of 160 to 1280, a height of 120 to 720, 0.2 to 15 pictures per second and quality 20 to 95.')
    backend = choose_backend(args.backend, available_backends())
    if not backend:
        parser.error('The requested camera stack is not installed. Run with --probe to see what this Pi provides.')
    tuning = None
    if args.tuning:
        tuning = tuning_path(args.tuning)
        if not tuning or backend in ('picamera', 'raspistill'):
            parser.error('Give the name of an installed libcamera tuning file (see --probe); the legacy camera stack has none.')
    if args.telemetry and importlib.util.find_spec('serial') is None:
        parser.error('--telemetry needs pyserial: sudo apt install python3-serial')
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.minimum_version = ssl.TLSVersion.TLSv1_2
    context.load_cert_chain(str(args.cert), str(args.key))
    source = open_source(backend, args.width, args.height, args.quality, args.settle_ms, tuning)
    board = describe_board()
    info = {'model': board['model'], 'os': board['os'], 'backend': source.name, 'width': args.width, 'height': args.height, 'fps': args.fps}
    if tuning:
        info['tuning'] = args.tuning
    telemetry = Telemetry() if args.telemetry else None
    info['telemetry'] = bool(telemetry)
    frames = Frames()
    stopped = threading.Event()
    source.start()
    server = CameraServer((str(address), args.port), make_handler(frames, token, origins, info, telemetry))
    server.socket = context.wrap_socket(server.socket, server_side=True, do_handshake_on_connect=False)
    worker = threading.Thread(target=capture_loop, args=(source, frames, stopped, args.fps), daemon=True)
    worker.start()
    if telemetry:
        threading.Thread(target=telemetry_loop, args=(serial_opener(str(args.telemetry)), telemetry, stopped), daemon=True).start()
    print('Paired HTTPS camera listening on the configured local interface using ' + source.name + '.')
    try:
        server.serve_forever(poll_interval=0.25)
    except KeyboardInterrupt:
        pass
    finally:
        stopped.set()
        server.server_close()
        worker.join(timeout=2)
        source.stop()


if __name__ == '__main__':
    main()
