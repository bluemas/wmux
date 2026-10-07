import * as os from 'os';
import { app } from 'electron';
import { tryProcessTreeCpuTimes } from '../pty/winSnapshotNative';

/**
 * CPU use of wmux and every process it started, as a percentage of the whole
 * machine (Task Manager's scale: all cores busy = 100). On Windows the trees
 * rooted at this process and at the detached daemon (which owns the PTY shells
 * and the agents inside them) are summed from cumulative process times. Other
 * platforms report the Electron processes only, from each process's
 * cumulative CPU seconds rather than `percentCPUUsage`: that figure is "since
 * the last getAppMetrics() call", and the memory chip calls getAppMetrics()
 * just before this, so it would cover a window of a few milliseconds.
 */

/** 100 ns FILETIME units per millisecond. */
const UNITS_PER_MS = 10_000n;

/**
 * Pure: CPU percentage of the whole machine from two cumulative-time samples.
 * Only processes present in both count, so one that started or exited between
 * the samples cannot spike the figure with its whole lifetime of CPU.
 */
export function cpuPercentBetween(
  prev: ReadonlyMap<number, bigint>,
  next: ReadonlyMap<number, bigint>,
  elapsedMs: number,
  cores: number,
): number {
  if (elapsedMs <= 0 || cores <= 0) return 0;
  let usedUnits = 0n;
  for (const [pid, now] of next) {
    const before = prev.get(pid);
    if (before !== undefined && now > before) usedUnits += now - before;
  }
  const usedMs = Number(usedUnits / UNITS_PER_MS);
  return Math.min(100, Math.max(0, (usedMs / elapsedMs / cores) * 100));
}

/**
 * Pure: per-process cumulative CPU time (100 ns units) from Electron's app
 * metrics. Null when any process lacks `cumulativeCPUUsage`, so a partial
 * reading never passes for a quiet one.
 */
export function cumulativeTimesFromMetrics(
  metrics: readonly Pick<Electron.ProcessMetric, 'pid' | 'cpu'>[],
): Map<number, bigint> | null {
  const times = new Map<number, bigint>();
  for (const m of metrics) {
    const seconds = m.cpu?.cumulativeCPUUsage;
    if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return null;
    times.set(m.pid, BigInt(Math.round(seconds * 1e7)));
  }
  return times;
}

let prevSample: { at: number; times: Map<number, bigint> } | null = null;

/**
 * Percentage since the previous call; null until there is a baseline (the first
 * call) or when no reading is available. Callers poll on a steady interval.
 */
export function sampleAppCpuPercent(daemonPid: number | null): number | null {
  const cores = os.cpus().length || 1;
  const times = process.platform === 'win32'
    ? tryProcessTreeCpuTimes(daemonPid ? [process.pid, daemonPid] : [process.pid])
    : cumulativeTimesFromMetrics(app.getAppMetrics());
  if (!times) return null;
  const now = Date.now();
  const before = prevSample;
  prevSample = { at: now, times };
  if (!before) return null;
  return cpuPercentBetween(before.times, times, now - before.at, cores);
}

/** Test seam: forget the baseline so the next sample starts fresh. */
export function resetAppCpuSampleForTests(): void {
  prevSample = null;
}
