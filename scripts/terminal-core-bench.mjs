/** Fresh process per sample; never connects to the user's running daemon. */
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('node scripts/terminal-core-bench.mjs [--sessions 1,10,30,50] [--mib 1] [--runs 3] [--json FILE]');
  process.exit(0);
}
const opts = {};
for (let i = 0; i < args.length; i += 2) {
  if (!['--sessions', '--mib', '--runs', '--json'].includes(args[i]) || !args[i + 1]) throw new Error('Invalid option; see --help');
  opts[args[i]] = args[i + 1];
}
const counts = (opts['--sessions'] ?? '1,10,30,50').split(',').map(Number);
const mib = Number(opts['--mib'] ?? 1);
const runs = Number(opts['--runs'] ?? 3);
if (counts.some(n => !Number.isInteger(n) || n < 1 || n > 50) ||
    !Number.isFinite(mib) || mib < 0.01 || mib > 8 || !Number.isInteger(runs) || runs < 1 || runs > 10) {
  throw new Error('Expected sessions 1..50, MiB 0.01..8, runs 1..10');
}
const temp = mkdtempSync(path.join(os.tmpdir(), 'wmux-terminal-bench-'));
try {
  const worker = path.join(temp, 'worker.cjs');
  await build({ entryPoints: [path.join(root, 'bench/terminal-core.ts')], outfile: worker, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
  const samples = [];
  for (const workload of ['log', 'redraw']) for (const count of counts) for (let run = 0; run < runs; run++) {
    const sample = JSON.parse(execFileSync(process.execPath, ['--expose-gc', worker, String(count), String(Math.floor(mib * 1024 * 1024)), workload], { encoding: 'utf8', timeout: 60000, maxBuffer: 1024 * 1024 }));
    samples.push({ run, ...sample });
    console.error(`${workload} sessions=${count} run=${run + 1}: writes=${sample.writeMs.toFixed(1)}ms snapshot=${sample.snapshotMs.toFixed(1)}ms loop-max=${sample.eventLoop.maxMs.toFixed(1)}ms rings=${(sample.ringAllocatedBytes / 1048576).toFixed(1)}MiB`);
  }
  const result = { schemaVersion: 1, commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), dirty: Boolean(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim()), node: process.version, platform: process.platform, arch: process.arch, cpu: os.cpus()[0]?.model, at: new Date().toISOString(), samples };
  const json = JSON.stringify(result, null, 2) + '\n';
  if (opts['--json']) writeFileSync(opts['--json'], json, { flag: 'wx' });
  else process.stdout.write(json);
} finally {
  rmSync(temp, { recursive: true, force: true });
}
