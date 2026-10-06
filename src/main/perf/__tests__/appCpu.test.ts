import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getAppMetrics: () => [] } }));

import { cpuPercentBetween, sampleAppCpuPercent } from '../appCpu';
import { tryProcessTreeCpuTimes } from '../../pty/winSnapshotNative';

const UNITS_PER_SECOND = 10_000_000n; // 100 ns FILETIME units

describe('cpuPercentBetween', () => {
  it('reports percent of the whole machine', () => {
    // One core fully busy for 1 s on a 4-core machine → 25%.
    const prev = new Map([[1, 0n]]);
    const next = new Map([[1, UNITS_PER_SECOND]]);
    expect(cpuPercentBetween(prev, next, 1000, 4)).toBeCloseTo(25, 5);
  });

  it('sums every process present in both samples', () => {
    const prev = new Map([[1, 0n], [2, 0n]]);
    const next = new Map([[1, UNITS_PER_SECOND / 2n], [2, UNITS_PER_SECOND / 2n]]);
    expect(cpuPercentBetween(prev, next, 1000, 2)).toBeCloseTo(50, 5);
  });

  it('ignores a process that appeared or exited between the samples', () => {
    const prev = new Map([[1, 0n], [3, 5n * UNITS_PER_SECOND]]);
    const next = new Map([[1, 0n], [2, 9n * UNITS_PER_SECOND]]);
    expect(cpuPercentBetween(prev, next, 1000, 2)).toBe(0);
  });

  it('is 0 for a zero interval and never exceeds 100', () => {
    const prev = new Map([[1, 0n]]);
    const next = new Map([[1, 100n * UNITS_PER_SECOND]]);
    expect(cpuPercentBetween(prev, next, 0, 2)).toBe(0);
    expect(cpuPercentBetween(prev, next, 1000, 1)).toBe(100);
  });
});

describe.skipIf(process.platform !== 'win32')('native process-tree CPU times (Windows)', () => {
  it('reads this process and its first sample has no baseline', () => {
    const times = tryProcessTreeCpuTimes([process.pid]);
    expect(times).not.toBeNull();
    expect(times!.has(process.pid)).toBe(true);
    expect(times!.get(process.pid)!).toBeGreaterThan(0n);
    expect(sampleAppCpuPercent(null)).toBeNull();
    expect(typeof sampleAppCpuPercent(null)).toBe('number');
  });
});
