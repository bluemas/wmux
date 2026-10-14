/** Isolated production-path measurement; invoked by terminal-core-bench.mjs. */
import { performance, monitorEventLoopDelay } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { RingBuffer } from '../src/daemon/RingBuffer';
import { generateSnapshot } from '../src/daemon/HeadlessSnapshot';

async function main() {
  const count = Number(process.argv[2]);
  const inputBytes = Number(process.argv[3]);
  const workload = process.argv[4];
  // Complete UTF-8/ANSI records, repeated into independently owned rings.
  const line = workload === 'redraw'
    ? '\x1b[H\x1b[2K\x1b[32mAgent working\x1b[0m 한글 😀\r\n\x1b[2Kstep 42 / 100\r\n'
    : '\x1b[32mPASS\x1b[0m build: src/example.ts 한글 😀 1234567890\r\n';
  const record = Buffer.from(line);
  const chunk = Buffer.from(line.repeat(Math.max(1, Math.floor(Math.min(16384, inputBytes) / record.length))));
  const chunks = Math.max(1, Math.floor(inputBytes / chunk.length));
  const capacity = 8 * 1024 * 1024;
  global.gc?.();
  const baseline = process.memoryUsage();
  const rings = Array.from({ length: count }, () => new RingBuffer(capacity));
  const cpuStart = process.cpuUsage();
  const writeStart = performance.now();
  for (let n = 0; n < chunks; n++) for (const ring of rings) ring.write(chunk);
  const writeMs = performance.now() - writeStart;
  const afterWrite = process.memoryUsage();
  global.gc?.();
  const retained = process.memoryUsage();
  // One reveal, not N concurrent mirrors: production serializes snapshots.
  const delay = monitorEventLoopDelay({ resolution: 1 });
  delay.enable();
  await new Promise(resolve => setTimeout(resolve, 10));
  delay.reset();
  const snapshotStart = performance.now();
  const initial = rings[0].readAll();
  const copyMs = performance.now() - snapshotStart;
  const outcome = await generateSnapshot({ cols: 120, rows: 40, scrollback: 5000, initial });
  const snapshotMs = performance.now() - snapshotStart;
  await new Promise(resolve => setTimeout(resolve, 2));
  delay.disable();
  const afterSnapshot = process.memoryUsage();
  const cpu = process.cpuUsage(cpuStart);
  const result = {
    sessions: count, workload, requestedBytesPerSession: inputBytes,
    actualBytesPerSession: chunks * chunk.length, capacityBytesPerSession: capacity,
    ringStoredBytes: rings.reduce((n, r) => n + r.size, 0),
    ringAllocatedBytes: rings.reduce((n, r) => n + r.allocatedBytes, 0),
    writeMs, copyMs, snapshotMs, cpuMs: (cpu.user + cpu.system) / 1000,
    eventLoop: { samples: delay.count, p99Ms: delay.percentile(99) / 1e6, maxMs: delay.max / 1e6 },
    memory: { baseline, afterWrite, retained, afterSnapshot },
    snapshot: outcome.ok ? {
      ok: true, bytesIn: outcome.bytesIn, bytesOut: outcome.payload.length,
      sha256: createHash('sha256').update(outcome.payload).digest('hex'),
    } : outcome,
  };
  console.log(JSON.stringify(result));
  if (!outcome.ok) process.exitCode = 1;
}
main().catch(error => { console.error(error); process.exitCode = 1; });
