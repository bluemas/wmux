import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url));
execFileSync('bash', ['core/wmux-term/build-native-core.sh'], { cwd: root, stdio: 'inherit' });
const dir = mkdtempSync(path.join(os.tmpdir(), 'wmux-ansi-parity-'));
try {
  const worker = path.join(dir, 'worker.cjs');
  await build({ entryPoints: [path.join(root, 'bench/rust-snapshot-parity.ts')], outfile: worker, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
  const result = execFileSync(process.execPath, [worker], { cwd: root, encoding: 'utf8', timeout: 60000,
    env: { ...process.env, WMUX_RUST_SNAPSHOT_MODULE: path.join(root, 'core/wmux-term/dist/native-core/index.cjs') } });
  if (process.argv[2]) writeFileSync(process.argv[2], result, { flag: 'wx' });
  else console.log(result);
  const parsed = JSON.parse(result);
  console.error(`ANSI checks: ${parsed.passed}/${parsed.total}; native supported: ${parsed.supported}, remaining case requires raw replay`);
  if (parsed.passed !== parsed.total) process.exitCode = 1;
} finally { rmSync(dir, { recursive: true, force: true }); }
