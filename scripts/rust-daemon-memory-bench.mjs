#!/usr/bin/env node
/** Isolated real-daemon RPC comparison: text-only, combined core or output-path A/B. */
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const root = path.resolve(import.meta.dirname, '..');
const output = path.resolve(process.argv[2] || '');
assert(process.argv[2], 'Usage: node scripts/rust-daemon-memory-bench.mjs OUTPUT.json [--smoke]');
assert(!fs.existsSync(output), 'Choose a new report filename');
assert(process.platform === 'darwin', 'This runner currently uses macOS RSS units');
const smoke = process.argv.includes('--smoke');
const outputCompare = process.argv.includes('--output-compare');
const combined = process.argv.includes('--terminal-core') || outputCompare;
const runDir = fs.mkdtempSync(path.join(root, 'out/rust-daemon-memory-'));
const nativeModule = path.join(root, 'core/wmux-term/dist/native-core/index.cjs');
assert(fs.existsSync(nativeModule), 'Build core/wmux-term/build-native-core.sh first');
const legacyOutputModule = path.join(runDir, 'legacy-output.cjs');
if (outputCompare) fs.writeFileSync(legacyOutputModule,
  `const native = require(${JSON.stringify(nativeModule)}); native.NativeTransport.prototype.readChunk = undefined; module.exports = native;\n`);
// npm's local prebuild may lack the helper's execute bit. Use a private copy,
// leaving dependencies used by the user's running checkout untouched.
const privatePty = path.join(runDir, 'node_modules/node-pty');
fs.mkdirSync(path.dirname(privatePty), { recursive: true });
fs.cpSync(path.join(root, 'node_modules/node-pty'), privatePty, { recursive: true });
fs.chmodSync(path.join(privatePty, `prebuilds/darwin-${process.arch}/spawn-helper`), 0o755);
const producer = path.join(runDir, 'producer.cjs');
fs.writeFileSync(producer, `#!${process.execPath}
const fs = require('node:fs');
const line = Buffer.from('\\x1b[32mPASS\\x1b[0m build src/example.ts 한글 😀 1234567890\\r\\n');
const chunk = Buffer.concat(Array(128).fill(line));
const bytes = Number(process.env.WMUX_BENCH_MIB) * 1048576;
for(let n=0; n<Math.floor(bytes/chunk.length); n++) fs.writeSync(1,chunk);
fs.writeSync(1, '\\r\\nWMUX_BENCH_READY\\r\\n');
fs.writeFileSync(process.env.WMUX_BENCH_DONE, 'ready');
setInterval(()=>{},1000);
`, { mode: 0o700 });

await build({ stdin: { contents: `
  import './src/daemon/index';
  import { getTextSnapshotBackendDiagnostics } from './src/daemon/TextSnapshotBackend';
  const outputCopies = { retainedViaJsBytes: 0, retainedNativeBytes: 0, deliveredJsBytes: 0 };
  if (${outputCompare}) {
    const native = require(process.env.WMUX_TERMINAL_CORE_MODULE);
    for (const [prototype, method, counter] of [
      [native.NativeRing.prototype, 'write', 'retainedViaJsBytes'],
      [native.NativeRing.prototype, 'writeChunk', 'retainedNativeBytes'],
      [native.NativeOutputChunk.prototype, 'readBytes', 'deliveredJsBytes'],
    ]) {
      const original = prototype[method];
      prototype[method] = function(value) {
        outputCopies[counter] += method === 'readBytes' ? this.byteLength : value.byteLength;
        return original.call(this, value);
      };
    }
  }
  setInterval(() => { if (process.connected) process.send({ type: 'memory', at: Date.now(), ...process.memoryUsage(),
    maxRssKiB: process.resourceUsage().maxRSS, textBackend: getTextSnapshotBackendDiagnostics(), ...(${outputCompare} ? { outputCopies } : {}) }); }, 20).unref();
`, resolveDir: root, sourcefile: 'memory-bench-entry.ts', loader: 'ts' },
  outfile: path.join(runDir, 'daemon.cjs'), bundle: true, platform: 'node', format: 'cjs',
  external: ['node-pty', 'koffi'], logLevel: 'silent' });

async function waitUntil(check, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (!check()) { assert(Date.now() < deadline, 'Timed out waiting for isolated fixture'); await sleep(50); }
}
function connect(pipe, token) {
  const socket = net.connect(pipe);
  // Socket chunks can split a Korean/emoji character. Decode incrementally.
  socket.setEncoding('utf8');
  let buffer = '', sequence = 0;
  const pending = new Map();
  socket.on('data', data => {
    buffer += data.toString();
    for (;;) {
      const end = buffer.indexOf('\n'); if (end < 0) break;
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      if (!line) continue;
      const message = JSON.parse(line), job = pending.get(message.id);
      if (job) { pending.delete(message.id); clearTimeout(job.timer); message.ok ? job.resolve(message.result) : job.reject(new Error(JSON.stringify(message.error))); }
    }
  });
  const rejectAll = err => { for (const job of pending.values()) { clearTimeout(job.timer); job.reject(err); } pending.clear(); };
  socket.on('error', rejectAll);
  socket.on('close', () => rejectAll(new Error('Daemon socket closed')));
  return { socket, rpc(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = `bench-${++sequence}`;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`RPC timeout: ${method}`)); }, 20000);
      pending.set(id, { resolve, reject, timer });
      socket.write(JSON.stringify({ id, method, params, token }) + '\n');
    });
  }};
}
function childRss(pids) {
  const rows = execFileSync('ps', ['-axo', 'pid=,ppid=,rss='], { encoding: 'utf8' }).trim().split('\n').map(s => s.trim().split(/\s+/).map(Number));
  const found = new Set(pids);
  for (let changed = true; changed;) { changed = false; for (const [pid, ppid] of rows) if (found.has(ppid) && !found.has(pid)) { found.add(pid); changed = true; } }
  return rows.filter(([pid]) => found.has(pid)).map(([pid, ppid, rssKiB]) => ({ pid, ppid, rssKiB }));
}
async function run(backend, sessions, mib, repeat) {
  const suffix = `-rust-mem-${randomUUID().slice(0, 8)}`;
  const dataDir = path.join(os.homedir(), `.wmux${suffix}`);
  fs.mkdirSync(dataDir, { mode: 0o700 });
  const pipe = path.join(dataDir, 'daemon.sock'), token = randomUUID();
  fs.writeFileSync(path.join(dataDir, 'daemon-auth-token'), token, { mode: 0o600 });
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({ version: 1,
    daemon: { pipeName: pipe, logLevel: 'error', autoStart: true, idleShutdownMinutes: 5, snapshotIntervalSec: 600 },
    session: { defaultShell: '/bin/sh', defaultCols: 120, defaultRows: 40, bufferSizeMb: 8, bufferMaxMb: 64, deadSessionTtlHours: 24, deadSessionDumpBuffer: false } }));
  const log = fs.openSync(path.join(runDir, `${backend}-${sessions}-${mib}-${repeat}.log`), 'wx');
  const child = spawn(process.execPath, [path.join(runDir, 'daemon.cjs')], { cwd: root,
    env: { ...process.env, WMUX_DATA_SUFFIX: suffix, WMUX_TERMINAL_CORE: combined && backend !== 'xterm' ? 'rust' : 'node', WMUX_TERMINAL_CORE_MODULE: backend === 'rust-legacy-output' ? legacyOutputModule : backend === 'rust-missing' ? path.join(runDir, 'missing.cjs') : nativeModule, WMUX_RUST_SNAPSHOT: backend === 'xterm' ? '' : 'text', WMUX_RUST_SNAPSHOT_MODULE: backend === 'rust-missing' ? path.join(runDir, 'missing.cjs') : nativeModule },
    stdio: ['ignore', log, log, 'ipc'] });
  fs.closeSync(log);
  let phase = 'boot', client;
  const memory = [], owned = [], rounds = [];
  child.on('message', m => { if (m.type === 'memory') memory.push({ phase, ...m }); });
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  try {
    await waitUntil(() => { assert(child.exitCode === null, 'Daemon exited during startup; see benchmark log'); return fs.existsSync(path.join(dataDir, 'daemon-pipe')); });
    client = connect(fs.readFileSync(path.join(dataDir, 'daemon-pipe'), 'utf8').trim(), token);
    await client.rpc('daemon.ping');
    phase = 'empty'; await sleep(1000);
    phase = 'fill';
    for (let i = 0; i < sessions; i++) {
      const done = path.join(dataDir, `producer-${i}.done`);
      const id = `bench-${i}`;
      const session = await client.rpc('daemon.createSession', { id, cmd: producer, cwd: runDir,
        env: { WMUX_BENCH_MIB: String(mib), WMUX_BENCH_DONE: done }, cols: 120, rows: 40 });
      owned.push({ id, pid: session.pid });
      await waitUntil(() => fs.existsSync(done));
    }
    await sleep(1000);
    phase = 'buffered-idle'; await sleep(1000);
    const workloadProcesses = childRss(owned.map(p => p.pid));
    phase = 'snapshots';
    for (let round = 0; round < 10; round++) {
      const started = performance.now();
      const hashes = await Promise.all(owned.map(async ({ id }) => {
        const result = await client.rpc('daemon.readSessionText', { id, scrollback: 5000 });
        assert.equal(result.mode, 'rows');
        assert(result.rows.some(row => JSON.stringify(row).includes('WMUX_BENCH_READY')), 'PTY output was not fully ingested');
        if (round === 0 || round === 9) fs.writeFileSync(path.join(runDir, `${backend}-${sessions}-${mib}-${repeat}-${id}-round-${round}-text.json`), JSON.stringify(result));
        return createHash('sha256').update(JSON.stringify(result)).digest('hex');
      }));
      rounds.push({ elapsedMs: performance.now() - started, hashes });
      await sleep(50);
    }
    phase = 'settled'; await sleep(2000);
    const backendDiagnostics = memory.at(-1)?.textBackend;
    assert(backendDiagnostics, 'Missing daemon diagnostics');
    assert.equal(backendDiagnostics.native, backend.startsWith('rust') && backend !== 'rust-missing' ? sessions * 10 : 0);
    if (outputCompare) {
      const copies = memory.at(-1).outputCopies;
      assert(copies);
      if (backend === 'rust') { assert(copies.retainedNativeBytes > 0); assert.equal(copies.retainedViaJsBytes, 0); assert.equal(copies.deliveredJsBytes, 0); }
      else { assert(copies.retainedViaJsBytes > 0); assert.equal(copies.retainedNativeBytes, 0); }
    }
    assert.equal(backendDiagnostics.fallbacks, backend === 'rust-missing' ? 1 : 0);
    assert.equal(backendDiagnostics.circuitOpen, backend === 'rust-missing');
    phase = 'destroyed';
    for (const { id } of owned) await client.rpc('daemon.destroySession', { id });
    await sleep(1000);
    const remaining = childRss(owned.map(p => p.pid));
    assert.equal(remaining.length, 0, 'Fixture processes survived session destruction');
    await client.rpc('daemon.shutdown'); client.socket.destroy();
    const exit = await Promise.race([exited, sleep(5000).then(() => { throw new Error('Daemon did not exit'); })]);
    return { backend, sessions, mibPerSession: mib, repeat, memory, rounds, workloadProcesses, backendDiagnostics, remaining, exit };
  } finally {
    if (client && !client.socket.destroyed && child.exitCode === null && child.signalCode === null) {
      for (const { id } of owned) {
        try { await client.rpc('daemon.destroySession', { id }); } catch { /* Shutdown below is the backstop. */ }
      }
    }
    client?.socket.destroy();
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await Promise.race([exited, sleep(5000)]); }
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
    // Keep failed-run state for diagnosis; successful shutdown has already
    // reaped fixture processes. No existing profile is ever removed.
    if (!childRss(owned.map(p => p.pid)).length) fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

const report = { schemaVersion: 1, at: new Date().toISOString(), node: process.version, cpu: os.cpus()[0]?.model,
  commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  scope: outputCompare ? 'Real Rust daemon; legacy JS output path vs native chunks; detached synthetic sessions, no LLM or renderer' : combined ? 'Real bundled daemon; combined Rust PTY/ring/text; synthetic workload; no LLM or renderer' : 'Real bundled daemon; text backend only; synthetic workload; no LLM or renderer', runDir, samples: [] };
try {
  for (const [sessions, mib] of smoke ? [[1, 1], [6, 1]] : [[1, 1], [6, 1], [6, 8]]) {
    for (let repeat = 0; repeat < (smoke ? 1 : 3); repeat++) {
      for (const backend of outputCompare ? (repeat % 2 ? ['rust', 'rust-legacy-output'] : ['rust-legacy-output', 'rust']) : smoke ? ['xterm', 'rust', 'rust-missing'] : repeat % 2 ? ['rust', 'xterm'] : ['xterm', 'rust']) {
        const sample = await run(backend, sessions, mib, repeat);
        report.samples.push(sample);
        console.error(`${backend}: ${sessions} sessions × ${mib} MiB, repeat ${repeat + 1}, RPC rounds ${sample.rounds.map(r => Math.round(r.elapsedMs)).join(',')} ms`);
      }
    }
    const hashes = new Set(report.samples.filter(s => s.sessions === sessions && s.mibPerSession === mib).flatMap(s => s.rounds.flatMap(r => r.hashes)));
    assert.equal(hashes.size, 1, 'Daemon output mismatch across backends/sessions/rounds');
  }
  report.ok = true;
} catch (err) { report.ok = false; report.error = String(err?.stack ?? err); process.exitCode = 1; }
fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
if (!report.ok) console.error(report.error);
