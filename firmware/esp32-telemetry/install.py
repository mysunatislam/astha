#!/usr/bin/env python3
"""Copy main.py onto an ESP32 running MicroPython, over USB serial, then restart it.

Opening the port resets most ESP32 boards (the USB chip's DTR/RTS lines drive EN), and
mpremote can start talking before MicroPython has booted. This waits for the prompt first.
Usage: python3 install.py /dev/ttyACM0 main.py
"""
import sys
import time

import serial

port_name, source = sys.argv[1], sys.argv[2]
code = open(source, encoding='utf-8').read()


def read_until(port, marker, seconds):
    data, end = b'', time.time() + seconds
    while time.time() < end:
        data += port.read(256)
        if marker in data:
            return data
    raise SystemExit('Timed out waiting for %r; got %r' % (marker, data[-200:]))


port = serial.Serial()
port.port, port.baudrate, port.timeout = port_name, 115200, 0.2
port.dtr = False                      # DTR and RTS asserted hold some boards in reset
port.rts = False
port.open()
time.sleep(2.5)                       # let the board finish the reset that opening caused
port.write(b'\r\x03\x03')             # stop main.py if it is running
time.sleep(0.3)
port.reset_input_buffer()
port.write(b'\r\x01')                 # raw REPL
read_until(port, b'raw REPL; CTRL-B to exit\r\n>', 5)
command = "f = open('main.py', 'w')\nf.write(%r)\nf.close()\nprint('written', len(%r))\n" % (code, code)
data = command.encode('utf-8')
for offset in range(0, len(data), 256):   # small pieces: the raw REPL has no flow control
    port.write(data[offset:offset + 256])
    time.sleep(0.01)
port.write(b'\x04')
reply = read_until(port, b'\x04>', 10)
output, _, error = reply.partition(b'\x04')
print(output.replace(b'OK', b'', 1).decode('utf-8', 'replace').strip())
if error.strip(b'\x04>').strip():
    raise SystemExit('Board reported an error: ' + error.decode('utf-8', 'replace'))
port.write(b'\x02')                   # back to the normal REPL
time.sleep(0.2)
port.write(b'\x04')                   # soft reset: main.py starts
port.close()
print('restarted')
