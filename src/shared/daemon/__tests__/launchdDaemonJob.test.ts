import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  buildDaemonLaunchdPlist,
  filterEnvForLaunchd,
  launchdBaseLabel,
  parseLaunchctlList,
  pruneStaleDaemonJobs,
  startDaemonViaLaunchd,
  LaunchdUnavailableError,
  type LaunchdRuntime,
} from '../launchdDaemonJob';

describe('launchdBaseLabel', () => {
  it('derives the label from the data suffix so dev and prod never share jobs', () => {
    expect(launchdBaseLabel('')).toBe('com.wmux.daemon');
    expect(launchdBaseLabel('-dev')).toBe('com.wmux.daemon-dev');
    expect(launchdBaseLabel('-a b/c')).toBe('com.wmux.daemon-a-b-c');
  });
});

describe('filterEnvForLaunchd', () => {
  it('keeps the spawn env, drops undefined, launchd-owned and non-plist-safe values', () => {
    const out = filterEnvForLaunchd({
      PATH: '/usr/bin:/bin',
      HOME: '/Users/x',
      ELECTRON_RUN_AS_NODE: '1',
      WMUX_SPAWNED_BY_VERSION: '1.2.3',
      UNSET: undefined,
      XPC_SERVICE_NAME: 'application.com.wmux.app',
      XPC_FLAGS: '0x0',
      BAD: 'a\u0001b',
      CR: 'a\rb',
      MULTI: 'line1\nline2',
    });
    expect(out).toEqual({
      PATH: '/usr/bin:/bin',
      HOME: '/Users/x',
      ELECTRON_RUN_AS_NODE: '1',
      WMUX_SPAWNED_BY_VERSION: '1.2.3',
      MULTI: 'line1\nline2',
    });
  });
});

describe('buildDaemonLaunchdPlist', () => {
  const xml = buildDaemonLaunchdPlist({
    label: 'com.wmux.daemon.abc',
    programArguments: ['/Applications/wmux.app/Contents/MacOS/wmux', '/x/daemon-bundle/index.js'],
    env: { ELECTRON_RUN_AS_NODE: '1', WEIRD: 'a & <b> "c"' },
  });

  it('carries label, program arguments and env', () => {
    expect(xml).toContain('<key>Label</key>\n\t<string>com.wmux.daemon.abc</string>');
    expect(xml).toMatch(
      /<key>ProgramArguments<\/key>\n\t<array>\n\t\t<string>\/Applications\/wmux.app\/Contents\/MacOS\/wmux<\/string>\n\t\t<string>\/x\/daemon-bundle\/index.js<\/string>\n\t<\/array>/,
    );
    expect(xml).toContain('<key>ELECTRON_RUN_AS_NODE</key>\n\t\t<string>1</string>');
    expect(xml).toContain('<string>a &amp; &lt;b&gt; &quot;c&quot;</string>');
  });

  it('starts once, never respawns, is interactive and keeps stdio closed', () => {
    expect(xml).toContain('<key>RunAtLoad</key>\n\t<true/>');
    expect(xml).toContain('<key>KeepAlive</key>\n\t<false/>');
    expect(xml).toContain('<key>AbandonProcessGroup</key>\n\t<true/>');
    expect(xml).toContain('<key>ProcessType</key>\n\t<string>Interactive</string>');
    expect(xml).toContain('<key>StandardOutPath</key>\n\t<string>/dev/null</string>');
    expect(xml).toContain('<key>StandardErrorPath</key>\n\t<string>/dev/null</string>');
  });

  it.runIf(process.platform === 'darwin')('is a valid plist (plutil -lint)', async () => {
    const { execFileSync } = await vi.importActual<typeof import('child_process')>('child_process');
    const f = path.join(os.tmpdir(), `wmux-plist-lint-${process.pid}.plist`);
    fs.writeFileSync(f, xml);
    try {
      expect(execFileSync('/usr/bin/plutil', ['-lint', f], { encoding: 'utf-8' })).toMatch(/OK/);
    } finally {
      fs.rmSync(f, { force: true });
    }
  });
});

describe('parseLaunchctlList', () => {
  it('parses pid, status and label, with - for none', () => {
    const m = parseLaunchctlList('PID\tStatus\tLabel\n123\t0\tcom.a\n-\t3\tcom.b\n-\t-15\tcom.c\n');
    expect(m.get('com.a')).toEqual({ pid: 123, status: 0 });
    expect(m.get('com.b')).toEqual({ pid: null, status: 3 });
    expect(m.get('com.c')).toEqual({ pid: null, status: -15 });
    expect(m.has('Label')).toBe(false);
  });
});

/** Scripted launchctl: `list` answers come from `listOutputs` in order (last one repeats). */
function fakeRuntime(opts: {
  listOutputs?: string[];
  failBootstrap?: boolean;
  alive?: (pid: number) => boolean;
}): LaunchdRuntime & { calls: string[][] } {
  const calls: string[][] = [];
  let listIdx = 0;
  const outputs = opts.listOutputs ?? [''];
  return {
    calls,
    uid: 501,
    log: () => undefined,
    sleep: () => Promise.resolve(),
    isPidAlive: opts.alive ?? (() => true),
    runLaunchctl: async (args) => {
      calls.push(args);
      if (args[0] === 'bootstrap' && opts.failBootstrap) throw new Error('Bootstrap failed: 125: Domain does not support specified action');
      if (args[0] === 'list') {
        const out = outputs[Math.min(listIdx, outputs.length - 1)];
        listIdx++;
        return out;
      }
      return '';
    },
  };
}

describe('startDaemonViaLaunchd / pruneStaleDaemonJobs', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-launchd-test-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); vi.useRealTimers(); });

  const base = 'com.wmux.daemon-t';
  const startOpts = () => ({
    baseLabel: base,
    plistDir: dir,
    programArguments: ['/bin/node', '/x/index.js'],
    env: { A: '1' },
  });

  it('prunes only jobs of this instance that are not running, never a live one', async () => {
    fs.writeFileSync(path.join(dir, `${base}.dead.plist`), '');
    fs.writeFileSync(path.join(dir, `${base}.orphan.plist`), '');
    fs.writeFileSync(path.join(dir, `${base}.live.plist`), '');
    const rt = fakeRuntime({
      listOutputs: [`-\t0\t${base}.dead\n77\t0\t${base}.live\n-\t0\tcom.wmux.daemon.other\n-\t0\tcom.wmux.daemon-t2.x\n`],
    });
    await pruneStaleDaemonJobs(base, dir, rt);
    const bootouts = rt.calls.filter((c) => c[0] === 'bootout').map((c) => c[1]);
    expect(bootouts).toEqual([`gui/501/${base}.dead`]);
    expect(fs.readdirSync(dir).sort()).toEqual([`${base}.live.plist`]);
  });

  it('bootstraps a plist in the gui domain and returns the job pid', async () => {
    let label = '';
    let plist = '';
    const rt = fakeRuntime({});
    rt.runLaunchctl = async (args) => {
      rt.calls.push(args);
      if (args[0] === 'bootstrap') {
        label = path.basename(args[2], '.plist');
        plist = fs.readFileSync(args[2], 'utf-8');
      }
      if (args[0] === 'list') return label ? `4321\t0\t${label}\n` : '';
      return '';
    };
    const job = await startDaemonViaLaunchd(startOpts(), rt);
    job.dispose();
    const boot = rt.calls.find((c) => c[0] === 'bootstrap');
    if (!boot) throw new Error('no bootstrap call');
    expect(boot[1]).toBe('gui/501');
    expect(job.label.startsWith(`${base}.`)).toBe(true);
    expect(job.pid).toBe(4321);
    // The loaded job does not need the file; the env it carries is not left on disk.
    expect(fs.existsSync(boot[2])).toBe(false);
    expect(fs.readdirSync(dir)).toEqual([]);
    expect(plist).toContain(`<string>${job.label}</string>`);
    expect(plist).toContain('<string>/x/index.js</string>');
    expect(plist).toContain('<key>A</key>');
  });

  it('rejects with LaunchdUnavailableError (safe to fall back) when bootstrap fails', async () => {
    const rt = fakeRuntime({ failBootstrap: true });
    await expect(startDaemonViaLaunchd(startOpts(), rt)).rejects.toBeInstanceOf(LaunchdUnavailableError);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('reports an exit that happened before the pid was observed', async () => {
    let label = '';
    const rt = fakeRuntime({});
    rt.runLaunchctl = async (args) => {
      if (args[0] === 'bootstrap') label = path.basename(args[2], '.plist');
      if (args[0] === 'list') return label ? `-\t3\t${label}\n` : '';
      return '';
    };
    const job = await startDaemonViaLaunchd(startOpts(), rt);
    expect(job.pid).toBeNull();
    expect(job.isAlive()).toBe(false);
    const code = await new Promise((r) => job.onExit(r));
    expect(code).toBe(3);
  });

  it('watches the pid and reports the exit status launchd recorded', async () => {
    vi.useFakeTimers();
    let label = '';
    let alive = true;
    const rt = fakeRuntime({ alive: () => alive });
    rt.runLaunchctl = async (args) => {
      if (args[0] === 'bootstrap') label = path.basename(args[2], '.plist');
      if (args[0] === 'list') return label ? (alive ? `55\t0\t${label}\n` : `-\t1\t${label}\n`) : '';
      return '';
    };
    const job = await startDaemonViaLaunchd(startOpts(), rt);
    const exited = new Promise((r) => job.onExit(r));
    expect(job.isAlive()).toBe(true);
    alive = false;
    await vi.advanceTimersByTimeAsync(300);
    expect(await exited).toBe(1);
    expect(job.isAlive()).toBe(false);
  });
});
