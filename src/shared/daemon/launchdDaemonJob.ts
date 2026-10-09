import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';

/**
 * macOS: start the daemon as a per-user launchd job instead of a child of the
 * launching process.
 *
 * Why: a `spawn(..., { detached: true })` child is still a *subordinate* of the
 * app as far as LaunchServices is concerned (responsibility / ASN lineage, not
 * the process group). When a foreground app quits, loginwindow asks Background
 * Task Management whether the app may keep background processes; for an
 * unsigned bundle BTM cannot answer (`BTMErrorDomain -98`) and loginwindow
 * schedules every subordinate for termination — the daemon got SIGTERM on each
 * plain Quit and took every hosted session with it. A process launchd starts
 * for a job in the user's `gui/<uid>` domain is nobody's subordinate (its
 * parent is launchd, pid 1), so quitting the app leaves it alone.
 *
 * Mechanism choices:
 * - `launchctl bootstrap gui/<uid> <plist>` with KeepAlive=false and
 *   RunAtLoad=true: one-shot start, no respawn after an intentional
 *   `daemon.shutdown`, exact env via EnvironmentVariables.
 * - Not `launchctl submit`: it implies KeepAlive (launchd would respawn the
 *   daemon after a full shutdown) and cannot pass an environment.
 * - Not `launchctl asuser`: it only switches the bootstrap context; the
 *   process would still be our child and subordinate.
 * - Not SMAppService: requires a signed app with an embedded agent plist.
 * - The plist lives in the wmux data dir, NOT ~/Library/LaunchAgents, so the
 *   daemon never auto-starts at login.
 *
 * Labels are unique per start (`<base>.<id>`): a fixed label could only be
 * re-used after `bootout`, and booting out a job whose daemon is still alive
 * (pid file lost, split-brain yield path) would SIGTERM that live daemon.
 * Jobs that are no longer running are pruned before each start; a running
 * one is never touched.
 */

/** Base label; the data suffix (`-dev`, test suffixes) keeps instances apart. */
export function launchdBaseLabel(dataSuffix: string): string {
  return `com.wmux.daemon${dataSuffix.replace(/[^A-Za-z0-9.-]/g, '-')}`;
}

/**
 * Variables launchd manages for each job itself — inheriting the launching
 * app's values would mislabel the daemon's own job.
 */
const LAUNCHD_OWNED_ENV = new Set(['XPC_SERVICE_NAME', 'XPC_FLAGS']);

// XML 1.0 `Char` minus CR (a literal CR in element content is normalised to LF
// by the parser, so the value would not round-trip).
// eslint-disable-next-line no-control-regex
const XML_UNSAFE = /[^\t\n -퟿-�\u{10000}-\u{10FFFF}]/u;

/**
 * The spawn env, made launchd-safe: undefined values and launchd-owned keys
 * dropped, and any variable that cannot be expressed in a plist skipped.
 */
export function filterEnvForLaunchd(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || LAUNCHD_OWNED_ENV.has(key)) continue;
    if (!key || XML_UNSAFE.test(key) || XML_UNSAFE.test(value)) continue;
    out[key] = value;
  }
  return out;
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export interface DaemonJobSpec {
  label: string;
  programArguments: string[];
  env: Record<string, string>;
}

export function buildDaemonLaunchdPlist(spec: DaemonJobSpec): string {
  const str = (s: string) => `<string>${xmlEscape(s)}</string>`;
  const envEntries = Object.keys(spec.env)
    .sort()
    .map((k) => `\t\t<key>${xmlEscape(k)}</key>\n\t\t${str(spec.env[k])}`)
    .join('\n');
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    `\t<key>Label</key>\n\t${str(spec.label)}`,
    `\t<key>ProgramArguments</key>\n\t<array>\n${spec.programArguments.map((a) => `\t\t${str(a)}`).join('\n')}\n\t</array>`,
    `\t<key>EnvironmentVariables</key>\n\t<dict>\n${envEntries}\n\t</dict>`,
    // Start once, now; never respawn — a full shutdown must stay shut down,
    // and a crash is handled by the app's own respawn controller.
    '\t<key>RunAtLoad</key>\n\t<true/>',
    '\t<key>KeepAlive</key>\n\t<false/>',
    // The daemon's PTY shells and agents live in their own process groups, but
    // never let launchd reap anything left behind when the daemon exits.
    '\t<key>AbandonProcessGroup</key>\n\t<true/>',
    // Hosts interactive shells — opt out of background throttling.
    '\t<key>ProcessType</key>\n\t<string>Interactive</string>',
    // Matches the previous `stdio: 'ignore'`; the daemon writes its own logs.
    '\t<key>StandardOutPath</key>\n\t<string>/dev/null</string>',
    '\t<key>StandardErrorPath</key>\n\t<string>/dev/null</string>',
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

export interface LaunchctlListEntry {
  pid: number | null;
  /** Last exit status; negative is the terminating signal. */
  status: number | null;
}

/** Parse `launchctl list` (`PID\tStatus\tLabel`, `-` for none). */
export function parseLaunchctlList(stdout: string): Map<string, LaunchctlListEntry> {
  const out = new Map<string, LaunchctlListEntry>();
  for (const line of stdout.split('\n')) {
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    const [pidCol, statusCol, label] = parts;
    if (!label || label === 'Label') continue;
    const pid = /^\d+$/.test(pidCol) ? Number(pidCol) : null;
    const status = /^-?\d+$/.test(statusCol) ? Number(statusCol) : null;
    out.set(label.trim(), { pid, status });
  }
  return out;
}

/** launchd itself could not run the job — the caller may fall back to spawn. */
export class LaunchdUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LaunchdUnavailableError';
  }
}

export interface LaunchdDaemonHandle {
  label: string;
  /** null when the job already exited before its pid could be observed. */
  pid: number | null;
  isAlive(): boolean;
  /** Fires once with the exit code (null for a signal death). */
  onExit(cb: (code: number | null) => void): void;
  /** Stop watching for exit. Does not touch the job or the daemon. */
  dispose(): void;
}

export interface LaunchdRuntime {
  runLaunchctl(args: string[]): Promise<string>;
  isPidAlive(pid: number): boolean;
  sleep(ms: number): Promise<void>;
  uid: number;
  log(...args: unknown[]): void;
}

const LAUNCHCTL = '/bin/launchctl';

export const defaultLaunchdRuntime = (log: (...args: unknown[]) => void): LaunchdRuntime => ({
  runLaunchctl: (args) =>
    new Promise((resolve, reject) => {
      execFile(LAUNCHCTL, args, { encoding: 'utf-8', timeout: 10_000 }, (err, stdout, stderr) => {
        if (err) reject(new Error(`launchctl ${args[0]} failed: ${(stderr || err.message).trim()}`));
        else resolve(stdout);
      });
    }),
  isPidAlive: (pid) => {
    try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
  },
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  uid: process.getuid ? process.getuid() : -1,
  log,
});

const PID_WAIT_MS = 5_000;
const PID_POLL_MS = 25;
const EXIT_POLL_MS = 250;

/**
 * Boot out (and delete the plist of) every job of this instance that is not
 * running. Never touches a job with a live pid. Best-effort, never throws.
 */
export async function pruneStaleDaemonJobs(baseLabel: string, plistDir: string, rt: LaunchdRuntime): Promise<void> {
  const prefix = `${baseLabel}.`;
  let jobs: Map<string, LaunchctlListEntry>;
  try { jobs = parseLaunchctlList(await rt.runLaunchctl(['list'])); } catch { return; }
  const labels = new Set<string>();
  for (const label of jobs.keys()) if (label.startsWith(prefix)) labels.add(label);
  try {
    for (const f of fs.readdirSync(plistDir)) {
      if (f.startsWith(prefix) && f.endsWith('.plist')) labels.add(f.slice(0, -'.plist'.length));
    }
  } catch { /* no dir yet */ }
  for (const label of labels) {
    const job = jobs.get(label);
    if (job && job.pid !== null) continue;
    if (job) {
      try { await rt.runLaunchctl(['bootout', `gui/${rt.uid}/${label}`]); } catch { /* already gone */ }
    }
    try { fs.unlinkSync(path.join(plistDir, `${label}.plist`)); } catch { /* not ours / gone */ }
  }
}

/**
 * Start the daemon as a launchd job and return a handle mirroring the bits
 * of ChildProcess the launcher uses (pid, liveness, exit code).
 *
 * Rejects with LaunchdUnavailableError only when the job could not be loaded
 * (no launchctl, no GUI domain, write failure) — nothing was started, so the
 * caller may safely fall back to a plain spawn. Once bootstrap has succeeded
 * any failure is a plain Error: falling back then could start a second daemon.
 */
export async function startDaemonViaLaunchd(
  opts: { baseLabel: string; plistDir: string; programArguments: string[]; env: Record<string, string | undefined> },
  rt: LaunchdRuntime,
): Promise<LaunchdDaemonHandle> {
  if (rt.uid < 0) throw new LaunchdUnavailableError('no uid on this platform');
  await pruneStaleDaemonJobs(opts.baseLabel, opts.plistDir, rt);

  const label = `${opts.baseLabel}.${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
  const plistPath = path.join(opts.plistDir, `${label}.plist`);
  try {
    fs.mkdirSync(opts.plistDir, { recursive: true });
    fs.writeFileSync(
      plistPath,
      buildDaemonLaunchdPlist({ label, programArguments: opts.programArguments, env: filterEnvForLaunchd(opts.env) }),
      { mode: 0o600 },
    );
  } catch (e) {
    throw new LaunchdUnavailableError(`could not write ${plistPath}: ${e instanceof Error ? e.message : String(e)}`);
  }
  try {
    await rt.runLaunchctl(['bootstrap', `gui/${rt.uid}`, plistPath]);
  } catch (e) {
    try { fs.unlinkSync(plistPath); } catch { /* ignore */ }
    throw new LaunchdUnavailableError(e instanceof Error ? e.message : String(e));
  }
  rt.log(`[launcher] launchd job ${label} bootstrapped (${plistPath})`);

  // RunAtLoad starts the process asynchronously; wait for its pid.
  let pid: number | null = null;
  let earlyExit: number | null | undefined;
  const deadline = Date.now() + PID_WAIT_MS;
  for (;;) {
    let entry: LaunchctlListEntry | undefined;
    try { entry = parseLaunchctlList(await rt.runLaunchctl(['list'])).get(label); } catch { entry = undefined; }
    if (entry?.pid != null) { pid = entry.pid; break; }
    // Not running but has an exit status → it already ran and exited.
    if (entry && entry.pid === null && entry.status !== null && entry.status !== 0) {
      earlyExit = entry.status < 0 ? null : entry.status;
      break;
    }
    if (Date.now() >= deadline) {
      throw new Error(`launchd job ${label} was loaded but its daemon pid never appeared`);
    }
    await rt.sleep(PID_POLL_MS);
  }

  const exitListeners: Array<(code: number | null) => void> = [];
  let exited = earlyExit !== undefined;
  let exitCode: number | null = earlyExit ?? null;
  let timer: ReturnType<typeof setInterval> | null = null;
  const fire = () => { for (const cb of exitListeners.splice(0)) cb(exitCode); };

  if (!exited && pid !== null) {
    const watchedPid = pid;
    let checking = false;
    timer = setInterval(() => {
      if (checking || rt.isPidAlive(watchedPid)) return;
      checking = true;
      if (timer) { clearInterval(timer); timer = null; }
      void rt.runLaunchctl(['list']).then(
        (out) => {
          const s = parseLaunchctlList(out).get(label)?.status ?? null;
          exitCode = s === null || s < 0 ? null : s;
        },
        () => { exitCode = null; },
      ).finally(() => { exited = true; fire(); });
    }, EXIT_POLL_MS);
    timer.unref?.();
  }

  return {
    label,
    pid,
    isAlive: () => !exited && pid !== null && rt.isPidAlive(pid),
    onExit: (cb) => {
      if (exited) cb(exitCode);
      else exitListeners.push(cb);
    },
    dispose: () => {
      if (timer) { clearInterval(timer); timer = null; }
      exitListeners.length = 0;
    },
  };
}
