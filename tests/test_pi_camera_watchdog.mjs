import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

test('Pi capture watchdog recovers stale capture independently and respects healthy frames and shutdown', () => {
  const script = String.raw`
import contextlib, importlib.util, io, threading, unittest
spec = importlib.util.spec_from_file_location('pi_camera', 'tools/pi-camera-server.py')
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
JPEG = b'\xff\xd8fixture-picture\xff\xd9'

class Clock:
    def __init__(self, now=0.0): self.now = now
    def __call__(self): return self.now

class Steps:
    """Deterministic Event-compatible driver, with no real timeout or process exit."""
    def __init__(self, clock, steps):
        self.clock, self.steps, self.stopped = clock, list(steps), False
    def wait(self, _interval):
        if self.stopped: return True
        if not self.steps: self.stopped = True; return True
        when, action = self.steps.pop(0)
        self.clock.now = when
        if action: action()
        return self.stopped
    def is_set(self): return self.stopped
    def set(self): self.stopped = True

def watch(frames, clock, steps):
    stopped, exits, messages = Steps(clock, steps), [], io.StringIO()
    with contextlib.redirect_stdout(messages):
        m.watch_capture(frames, stopped, exit_process=exits.append, clock=clock)
    return stopped, exits, messages.getvalue()

class WatchdogTests(unittest.TestCase):
    def test_no_first_picture_gets_full_startup_grace_and_exits_once(self):
        clock = Clock(100.0); frames = m.Frames(clock)
        stopped, exits, message = watch(frames, clock, [(129.999, None), (130.0, None), (140.0, None)])
        self.assertEqual(exits, [75]); self.assertEqual(clock(), 130.0)
        self.assertEqual(len(stopped.steps), 1)
        self.assertIn('exiting so the service can restart', message)

    def test_latest_valid_picture_resets_deadline(self):
        clock = Clock(); frames = m.Frames(clock)
        steps = [(29.0, lambda: frames.put(JPEG)), (58.999, None), (59.0, None)]
        _, exits, _ = watch(frames, clock, steps)
        self.assertEqual(exits, [75]); self.assertEqual(clock(), 59.0)
        self.assertEqual(frames.sequence, 1)

    def test_healthy_capture_never_exits_across_many_deadlines(self):
        clock = Clock(); frames = m.Frames(clock)
        steps = [(float(at), lambda: frames.put(JPEG)) for at in range(5, 126, 5)]
        stopped, exits, message = watch(frames, clock, steps)
        self.assertTrue(stopped.is_set()); self.assertEqual(exits, []); self.assertEqual(message, '')
        self.assertEqual(frames.sequence, 25)

    def test_invalid_pictures_do_not_extend_the_deadline(self):
        clock = Clock(); frames = m.Frames(clock)
        invalid = [b'', b'not-jpeg', b'\xff\xd8' + b'x' * m.MAX_BYTES]
        steps = [(10.0, lambda: frames.put(JPEG))]
        steps += [(20.0 + i, lambda data=data: frames.put(data)) for i, data in enumerate(invalid)]
        steps += [(39.999, None), (40.0, None)]
        _, exits, _ = watch(frames, clock, steps)
        self.assertEqual(exits, [75]); self.assertEqual(frames.sequence, 1); self.assertEqual(frames.at, 10.0)

    def test_existing_picture_must_cross_exact_monotonic_boundary(self):
        clock = Clock(1000.0); frames = m.Frames(clock); frames.put(JPEG)
        _, exits, _ = watch(frames, clock, [(1029.999, None)])
        self.assertEqual(exits, [])
        clock.now = 1000.0
        _, exits, _ = watch(frames, clock, [(1030.0, None)])
        self.assertEqual(exits, [75])

    def test_normal_shutdown_at_deadline_does_not_exit(self):
        clock = Clock(); frames = m.Frames(clock); exits = []
        stopped = Steps(clock, [])
        stopped.steps = [(30.0, stopped.set)]
        m.watch_capture(frames, stopped, exit_process=exits.append, clock=clock)
        self.assertEqual(exits, [])

    def test_failed_diagnostic_does_not_prevent_recovery(self):
        class BrokenOutput:
            def write(self, _message): raise BrokenPipeError('fixture output closed')
            def flush(self): pass
        clock = Clock(); frames = m.Frames(clock); stopped = Steps(clock, [(30.0, None)]); exits = []
        with contextlib.redirect_stdout(BrokenOutput()), self.assertRaises(BrokenPipeError):
            m.watch_capture(frames, stopped, exit_process=exits.append, clock=clock)
        self.assertEqual(exits, [75])

    def test_capture_worker_can_be_blocked_without_blocking_watchdog(self):
        entered, release, stopped = threading.Event(), threading.Event(), threading.Event()
        class BlockedSource:
            def capture(self): entered.set(); release.wait(); return JPEG
        clock = Clock(); frames = m.Frames(clock)
        worker = threading.Thread(target=m.capture_loop, args=(BlockedSource(), frames, stopped, 4), daemon=True)
        worker.start()
        try:
            self.assertTrue(entered.wait(2), 'fixture capture worker did not start')
            self.assertTrue(worker.is_alive()); self.assertEqual(frames.sequence, 0)
            _, exits, _ = watch(frames, clock, [(29.0, None), (30.0, None)])
            self.assertEqual(exits, [75]); self.assertTrue(worker.is_alive())
        finally:
            stopped.set(); release.set(); worker.join(timeout=2)
        self.assertFalse(worker.is_alive())

unittest.main()
`;
  const result = spawnSync(process.env.ASTHA_PYTHON || 'python', ['-B', '-c', script], { encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.match(result.stderr, /Ran 8 tests/);
  assert.match(result.stderr, /\bOK\b/);
});
