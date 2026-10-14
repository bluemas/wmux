/** Real PTYs, isolated fixture children only. Run after build-native-core.sh. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
const require = createRequire(import.meta.url);
const { NativePty, NativeTerminal, NativeRing } = require('../dist/native-core/index.cjs');
const cwd = mkdtempSync(path.join(os.tmpdir(), 'wmux-native-pty-'));
const owned = new Set();
const spawn = (command, args) => {
  const pty = new NativePty(command, args, cwd, 80, 24);
  owned.add(pty);
  return pty;
};
async function collect(pty, until = () => false, timeout = 10000) {
  const start = performance.now();
  const chunks = [];
  for (;;) {
    const { data, eof, error } = pty.read();
    assert(!error, error);
    chunks.push(data);
    const output = Buffer.concat(chunks);
    if (until(output) || eof) return output;
    assert(performance.now() - start < timeout, 'PTY read deadline exceeded');
    await sleep(2);
  }
}
async function wait(pty) {
  const start = performance.now();
  for (;;) {
    const code = pty.tryWait();
    if (code != null) return code;
    assert(performance.now() - start < 5000, 'PTY child exit deadline exceeded');
    await sleep(5);
  }
}
function close(pty) { pty.close(); pty.close(); owned.delete(pty); }
try {
  const capacity = 300001;
  const ring = new NativeRing(capacity);
  let oracle = Buffer.alloc(0);
  for (const n of [65536, 1, 65535, 131072, 37857, 19, 400003, 70001, 0]) {
    const bytes = Buffer.from(Array.from({ length: n }, (_, i) => (i + n) % 251));
    ring.write(bytes); oracle = Buffer.concat([oracle, bytes]).subarray(-capacity);
    assert.deepEqual(ring.readAll(), oracle);
    assert.equal(ring.size, oracle.length);
    assert(ring.allocatedBytes <= capacity);
  }
  ring.dispose(); ring.dispose();
  assert.equal(ring.allocatedBytes, 0);
  assert.throws(() => ring.write(Buffer.from('x')), /disposed/);
  const pty = spawn('/bin/sh', ['-c', 'stty -echo; printf "READY\\n"; read value; stty size; printf "VALUE:%s\\n" "$value"; exit 7']);
  const first = await collect(pty, b => b.includes('READY'));
  pty.resize(100, 33);
  pty.write(Buffer.from('한글😀\n'));
  const rest = await collect(pty);
  assert.equal(await wait(pty), 7);
  const output = Buffer.concat([first, rest]);
  assert.match(output.toString(), /33 100/);
  assert.match(output.toString(), /VALUE:한글😀/);
  const terminal = new NativeTerminal(100, 33, 100);
  const history = new NativeRing(8192); history.write(output);
  terminal.feed(history.readAll());
  assert(terminal.textSnapshot(false).rows.some(r => r.text === 'VALUE:한글😀'));
  terminal.dispose(); history.dispose(); close(pty);

  // Stop consuming longer than it takes to fill the 256 KiB bounded queue.
  // Resuming must deliver every byte without deadlock or truncation.
  const flood = spawn(process.execPath, ['-e', 'process.stdout.write("x".repeat(2*1024*1024),()=>process.exit(0))']);
  await sleep(200);
  const floodBytes = await collect(flood);
  assert.equal(floodBytes.length, 2 * 1024 * 1024);
  assert(floodBytes.every(byte => byte === 120));
  assert.equal(await wait(flood), 0); close(flood);

  const killed = spawn('/bin/sh', ['-c', 'exec sleep 60']);
  const killedPid = killed.pid;
  await killed.kill(); await wait(killed); close(killed);
  assert.throws(() => process.kill(killedPid, 0), /ESRCH/);

  const closed = spawn('/bin/sh', ['-c', 'exec sleep 60']);
  const closedPid = closed.pid; close(closed);
  for (let i = 0; i < 100; i++) {
    try { process.kill(closedPid, 0); } catch (e) { if (e.code === 'ESRCH') break; throw e; }
    await sleep(10);
  }
  assert.throws(() => process.kill(closedPid, 0), /ESRCH/);

  for (let i = 0; i < 20; i++) {
    const quick = spawn('/bin/sh', ['-c', 'printf done']);
    assert.equal((await collect(quick)).toString(), 'done');
    assert.equal(await wait(quick), 0); close(quick);
  }
  assert.throws(() => spawn('/definitely/missing/wmux-command', []));
  console.log(JSON.stringify({ ok: true, checks: ['ring-growth-wrap', 'spawn', 'utf8-input-output', 'resize', 'exit-code', 'pty-ring-grid', '2MiB-backpressure', 'kill-reap', 'close-reap', '20-lifecycles', 'spawn-error'] }));
} finally {
  for (const pty of owned) pty.close();
  rmSync(cwd, { recursive: true, force: true });
}
