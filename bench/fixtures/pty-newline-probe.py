"""POSIX control for PTY newline expansion, independent of Rust and node-pty."""
import argparse
import errno
import json
import os
from pathlib import Path
import shutil
import subprocess
import time

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--mode', choices=['cooked', 'raw'], default='cooked')
parser.add_argument('--seconds', type=float, default=10)
parser.add_argument('--report', type=Path, required=True)
args = parser.parse_args()
if os.name != 'posix':
    parser.error('This diagnostic requires POSIX openpty')
node = shutil.which('node')
if not node:
    parser.error('node must be on PATH')
fixture = Path(__file__).with_name('native-pty-child.cjs').resolve()
count = 10000
expected = (''.join(f'ROW{i:06}|한글🙂|' + ('x' * 30) + '\r\n' for i in range(count)) + 'FINAL-OUTPUT\r\n').encode()
started = time.monotonic()
cycles = 0
mismatch = None
while time.monotonic() - started < args.seconds:
    master, slave = os.openpty()
    try:
        child = subprocess.Popen([node, str(fixture), 'output-raw' if args.mode == 'raw' else 'output', str(count)],
                                 stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
    except BaseException:
        os.close(master)
        raise
    finally:
        os.close(slave)
    chunks = []
    try:
        while True:
            try:
                data = os.read(master, 4096)
            except OSError as error:
                if error.errno == errno.EIO:
                    break
                raise
            if not data:
                break
            chunks.append(data)
            time.sleep(0.001)  # Keep the output queue under backpressure.
        child.wait(timeout=10)
    finally:
        os.close(master)
        if child.poll() is None:
            child.kill()
            child.wait()
    assert child.returncode == 7, child.returncode
    actual = b''.join(chunks)
    cycles += 1
    if actual != expected:
        index = next((i for i, (a, b) in enumerate(zip(actual, expected)) if a != b), min(len(actual), len(expected)))
        mismatch = {'cycle': cycles, 'index': index, 'actualBytes': len(actual), 'expectedBytes': len(expected),
                    'actualWindow': actual[max(0, index - 80):index + 80].decode(errors='replace'),
                    'expectedWindow': expected[max(0, index - 80):index + 80].decode(errors='replace')}
        break
report = {'backend': 'Python os.openpty + subprocess; no Rust or node-pty', 'mode': args.mode,
          'cycles': cycles, 'elapsedSeconds': time.monotonic() - started, 'mismatch': mismatch}
args.report.parent.mkdir(parents=True, exist_ok=True)
args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
print(json.dumps(report, ensure_ascii=False))
if args.mode == 'raw' and mismatch:
    raise SystemExit(1)
