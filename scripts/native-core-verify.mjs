import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url));
if (!process.argv.includes('--skip-build')) execFileSync(process.execPath, ['scripts/build-native-terminal.mjs'], { cwd: root, stdio: 'inherit' });
// Keep the worker under the repo so Windows can resolve node-pty's DLL assets.
const dir = mkdtempSync(path.join(root, '.native-core-verify-'));
try {
  const worker = path.join(dir, 'verify.cjs');
  await build({ entryPoints: [path.join(root, 'bench/native-core-verify.ts')], outfile: worker, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
  // Eight hours of two-second memory samples exceed execFileSync's default
  // 1 MiB stdout limit; retain the completed report without truncating it.
  const result = execFileSync(process.execPath, [worker], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 16 * 1024 * 1024, timeout: (process.platform === 'win32' ? 900000 : 600000) + Number(process.env.WMUX_NATIVE_SOAK_MS ?? 0),
    env: { ...process.env, WMUX_TERMINAL_CORE_MODULE: path.join(root, 'core/wmux-term/dist/native-core/index.cjs') } });
  process.stdout.write(result);
  const report = process.argv.find(arg => arg.startsWith('--report='))?.slice('--report='.length);
  if (report) writeFileSync(path.resolve(report), result, { flag: 'wx' });
} finally { rmSync(dir, { recursive: true, force: true }); }
