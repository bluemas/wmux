/** Opt in with WMUX_TEST_WSL=1 and optionally WMUX_TEST_WSL_DISTRO.
 * A fake login writes only to temporary account directories; no vendor CLI,
 * user configuration, credentials or daily daemon is used.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { buildWslInjection } from '../wslIntegration';

const enabled = process.platform === 'win32' && process.env.WMUX_TEST_WSL === '1';

describe.runIf(enabled)('WSL account-home transport', () => {
  it.each(['CODEX_HOME', 'CLAUDE_CONFIG_DIR'])('leaves an ordinary pane on its Linux %s', (key) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-wsl-ordinary-'));
    const wsl = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'wsl.exe');
    const distroArgs = process.env.WMUX_TEST_WSL_DISTRO ? ['-d', process.env.WMUX_TEST_WSL_DISTRO] : [];
    const env = { SystemRoot: process.env.SystemRoot ?? 'C:\\Windows', PATH: process.env.PATH ?? '', WMUX_SHELL_INTEGRATION: '0' };
    const execute = (args: string[]) => execFileSync(wsl, [...distroArgs, '--exec', ...args], {
      env, encoding: 'utf8', timeout: 30_000, windowsHide: true,
    });
    try {
      const [distribution, user] = execute(['/bin/sh', '-c', 'printf "%s\\0%s" "$WSL_DISTRO_NAME" "$(id -un)"']).split('\0');
      const initialCommand = `printf '%s' "\${${key}-}"`;
      const baseline = execute(['/bin/sh', '-c', initialCommand]);
      const cwd = execute(['wslpath', '-u', dir]).trim();
      const injected = buildWslInjection({
        target: { distribution, user }, cwd, integrationDir: dir,
        env: { ...env, [key]: dir }, bashInit: '', execCommand: initialCommand, mcpEntryPath: null,
      });
      expect(execFileSync(wsl, injected.args, { env: injected.env, encoding: 'utf8', timeout: 30_000, windowsHide: true })).toBe(baseline);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }, 60_000);

  it.each([
    ['CODEX_HOME', 'auth.json', 'windows'],
    ['CLAUDE_CONFIG_DIR', '.credentials.json', 'windows'],
    ['CODEX_HOME', 'auth.json', 'linux'],
    ['CLAUDE_CONFIG_DIR', '.credentials.json', 'linux'],
  ])('keeps the %s login writer and Windows reader on the same %s fixture (%s path)', (key, file, style) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wmux account it's-"));
    const wsl = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'wsl.exe');
    const distroArgs = process.env.WMUX_TEST_WSL_DISTRO ? ['-d', process.env.WMUX_TEST_WSL_DISTRO] : [];
    const execute = (args: string[]) => execFileSync(wsl, [...distroArgs, '--exec', ...args], {
      encoding: 'utf8', timeout: 30_000, windowsHide: true,
    });
    try {
      const [distribution, user] = execute(['/bin/sh', '-c', 'printf "%s\\0%s" "$WSL_DISTRO_NAME" "$(id -un)"']).split('\0');
      const selected = path.join(dir, 'selected');
      const other = path.join(dir, 'other');
      fs.mkdirSync(selected);
      fs.mkdirSync(other);
      fs.writeFileSync(path.join(other, file), 'other account');
      const linuxDir = execute(['wslpath', '-u', dir]).trim();
      const linuxSelected = `${linuxDir}/selected`;
      // Only fixed variable/file names enter shell source. Paths are env data.
      const initialCommand = `set -eu; printf '%s' "$${key}"; printf '{"fixture":true}' > "$${key}/${file}"`;
      const injected = buildWslInjection({
        target: { distribution, user }, cwd: linuxDir, integrationDir: dir,
        wslAccountLoginEnvKey: key === 'CODEX_HOME' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR',
        env: {
          SystemRoot: process.env.SystemRoot ?? 'C:\\Windows',
          PATH: process.env.PATH ?? '',
          [key]: style === 'windows' ? selected : linuxSelected,
          WMUX_SHELL_INTEGRATION: '0',
        },
        bashInit: '', execCommand: initialCommand, mcpEntryPath: null,
      });
      const receivedHome = execFileSync(wsl, injected.args, {
        env: injected.env, encoding: 'utf8', timeout: 30_000, windowsHide: true,
      });
      expect(receivedHome).toBe(linuxSelected);
      expect(JSON.parse(fs.readFileSync(path.join(selected, file), 'utf8'))).toEqual({ fixture: true });
      expect(fs.readFileSync(path.join(other, file), 'utf8')).toBe('other account');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
