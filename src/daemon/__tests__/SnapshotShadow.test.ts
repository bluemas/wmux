import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateRustSnapshot } from '../RustSnapshot';
import { withSnapshotShadow, getSnapshotShadowDiagnostics } from '../SnapshotShadow';
import type { TextSnapshotOutcome } from '../HeadlessSnapshot';

vi.mock('../RustSnapshot', () => ({ generateRustSnapshot: vi.fn() }));
const native = vi.mocked(generateRustSnapshot);
const request = { cols: 80, rows: 24, initial: Buffer.from('hello') };
const reference: TextSnapshotOutcome = { ok: true, rows: [{ text: 'hello', wrapped: false }], bufferType: 'normal', rowsBelowCursor: 0, bytesIn: 5, durationMs: 1 };
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

describe('native snapshot shadow isolation', () => {
  it('does not call the native loader when disabled', async () => {
    vi.stubEnv('WMUX_RUST_SNAPSHOT', '');
    const run = vi.fn(async () => reference);
    expect(await withSnapshotShadow(request, 'text', run)).toBe(reference);
    expect(native).not.toHaveBeenCalled();
  });

  it('keeps the exact xterm outcome when native loading fails', async () => {
    vi.stubEnv('WMUX_RUST_SNAPSHOT', 'shadow');
    native.mockRejectedValueOnce(new Error('native unavailable'));
    const before = getSnapshotShadowDiagnostics().errors;
    expect(await withSnapshotShadow(request, 'text', async () => reference)).toBe(reference);
    expect(getSnapshotShadowDiagnostics().errors).toBe(before + 1);
  });

  it('records a mismatch without replacing user-visible content', async () => {
    vi.stubEnv('WMUX_RUST_SNAPSHOT', 'shadow');
    native.mockResolvedValueOnce({ ...reference, rows: [{ text: 'incorrect', wrapped: false }] });
    const before = getSnapshotShadowDiagnostics().mismatched;
    expect(await withSnapshotShadow(request, 'text', async () => reference)).toBe(reference);
    expect(getSnapshotShadowDiagnostics().mismatched).toBe(before + 1);
  });

  it('replays captured tee chunks without draining the live source twice', async () => {
    vi.stubEnv('WMUX_RUST_SNAPSHOT', 'shadow');
    const chunk = Buffer.from(' next');
    const drain = vi.fn().mockReturnValueOnce([chunk]).mockReturnValue([]);
    native.mockImplementationOnce(async captured => {
      expect(captured.drainQueue?.()).toEqual([chunk]);
      expect(captured.drainQueue?.()).toEqual([]);
      return reference;
    });
    const before = getSnapshotShadowDiagnostics().matched;
    expect(await withSnapshotShadow({ ...request, drainQueue: drain }, 'text', async captured => {
      expect(captured.drainQueue?.()).toEqual([chunk]);
      expect(captured.drainQueue?.()).toEqual([]);
      return reference;
    })).toBe(reference);
    expect(drain).toHaveBeenCalledTimes(2);
    expect(getSnapshotShadowDiagnostics().matched).toBe(before + 1);
  });

  it('bounds retained tee bytes and skips native work on overflow', async () => {
    vi.stubEnv('WMUX_RUST_SNAPSHOT', 'shadow');
    const chunk = Buffer.alloc(8 * 1024 * 1024);
    const before = getSnapshotShadowDiagnostics().skipped;
    expect(await withSnapshotShadow({ ...request, drainQueue: () => [chunk] }, 'text', async captured => {
      captured.drainQueue?.(); return reference;
    })).toBe(reference);
    expect(native).not.toHaveBeenCalled();
    expect(getSnapshotShadowDiagnostics().skipped).toBe(before + 1);
  });
});
