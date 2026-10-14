/** Build first, then compare in fresh processes. No user sessions are touched. */
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url));
const output = process.argv[2];
const verifyOnly = process.argv[3] === '--verify-only';
if (!output) throw new Error('Usage: node scripts/rust-terminal-core-bench.mjs OUTPUT.json [--verify-only]');
execFileSync('bash', ['core/wmux-term/build-native-core.sh'], { cwd: root, stdio: 'inherit' });
execFileSync(process.execPath, ['core/wmux-term/spike/native-pty.mjs'], { cwd: root, stdio: ['ignore', 'inherit', 'inherit'], timeout: 60000 });
const temp = mkdtempSync(path.join(os.tmpdir(), 'wmux-rust-core-'));
try {
  const worker = path.join(temp, 'worker.cjs');
  await build({ entryPoints: [path.join(root, 'bench/rust-terminal-core.ts')], outfile: worker, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
  const run = args => JSON.parse(execFileSync(process.execPath, ['--expose-gc', worker, ...args], {
    env: { ...process.env, WMUX_REPO_ROOT: root, WMUX_RUST_SNAPSHOT: '',
      WMUX_NATIVE_CORE: path.join(root, 'core/wmux-term/dist/native-core/index.cjs'),
      WMUX_RUST_SNAPSHOT_MODULE: path.join(root, 'core/wmux-term/dist/native-core/index.cjs') },
    encoding: 'utf8', timeout: 60000, maxBuffer: 4 * 1048576,
  }));
  const parity = run(['parity']);
  console.error(`Text parity: ${parity.passed}/${parity.total}; mismatches are adoption blockers`);
  const samples = [];
  for (const mib of verifyOnly ? [] : [1, 8]) for (const workload of ['log', 'redraw']) for (let repeat = 0; repeat < 3; repeat++) {
    // Alternate order to reduce systematic effects of machine load.
    for (const backend of repeat % 2 ? ['rust', 'xterm'] : ['xterm', 'rust']) {
      const sample = run([backend, workload, String(mib)]);
      samples.push({ repeat, mib, ...sample });
      console.error(`${backend} ${workload} ${mib}MiB ${sample.elapsedMs.toFixed(1)}ms peakRSS ${(sample.maxRssKiB / 1024).toFixed(1)}MiB`);
    }
  }
  for (const mib of [1, 8]) for (const workload of ['log', 'redraw']) {
    const hashes = new Set(samples.filter(s => s.mib === mib && s.workload === workload).map(s => s.sha256));
    if (hashes.size > 1) throw new Error(`Benchmark output mismatch: ${workload} ${mib}MiB`);
  }
  const result = { schemaVersion: 1, at: new Date().toISOString(), node: process.version, platform: process.platform, arch: process.arch,
    cpu: os.cpus()[0]?.model, commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    dirty: Boolean(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim()), parity, samples };
  writeFileSync(output, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
} finally { rmSync(temp, { recursive: true, force: true }); }
