import { describe, it, expect, vi } from 'vitest';
import { WebglUpgradeQueue } from '../webglUpgradeQueue';

/** A queue with manual clocks: `fireDelay()` ends the settle wait and
 *  `fireIdle()` runs one idle period. */
function harness() {
  let delayed: (() => void) | null = null;
  const idles: Array<() => void> = [];
  const q = new WebglUpgradeQueue({
    settleMs: 600,
    delay: (cb) => { delayed = cb; return cb; },
    cancelDelay: (h) => { if (delayed === h) delayed = null; },
    idle: (cb) => { idles.push(cb); },
  });
  return {
    q,
    fireDelay: () => { const d = delayed; delayed = null; d?.(); },
    fireIdle: () => idles.shift()?.(),
    hasDelay: () => delayed !== null,
    idleCount: () => idles.length,
  };
}

describe('WebglUpgradeQueue', () => {
  it('runs nothing until the settle wait ends', () => {
    const h = harness();
    const job = vi.fn();
    h.q.enqueue(job);
    expect(h.idleCount()).toBe(0);
    h.fireDelay();
    expect(job).not.toHaveBeenCalled();
    h.fireIdle();
    expect(job).toHaveBeenCalledTimes(1);
  });

  it('runs one job per idle period, in order', () => {
    const h = harness();
    const calls: string[] = [];
    h.q.enqueue(() => calls.push('a'));
    h.q.enqueue(() => calls.push('b'));
    h.fireDelay();
    h.fireIdle();
    expect(calls).toEqual(['a']);
    h.fireIdle();
    expect(calls).toEqual(['a', 'b']);
    expect(h.q.pending).toBe(0);
  });

  it('a cancelled job never runs', () => {
    const h = harness();
    const job = vi.fn();
    const cancel = h.q.enqueue(job);
    cancel();
    h.fireDelay();
    h.fireIdle();
    expect(job).not.toHaveBeenCalled();
  });

  it('a job that throws does not stall the ones behind it', () => {
    const h = harness();
    const after = vi.fn();
    h.q.enqueue(() => { throw new Error('gpu'); });
    h.q.enqueue(after);
    h.fireDelay();
    h.fireIdle();
    h.fireIdle();
    expect(after).toHaveBeenCalledTimes(1);
  });

  it('a job queued while draining joins the running drain', () => {
    const h = harness();
    const calls: string[] = [];
    h.q.enqueue(() => calls.push('a'));
    h.fireDelay();
    h.q.enqueue(() => calls.push('b'));
    expect(h.hasDelay()).toBe(false);
    h.fireIdle();
    h.fireIdle();
    expect(calls).toEqual(['a', 'b']);
  });
});
