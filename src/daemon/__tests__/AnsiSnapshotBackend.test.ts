import { afterEach, describe, expect, it, vi } from 'vitest';
import { selectAnsiSnapshot } from '../AnsiSnapshotBackend';
import type { SnapshotRequest } from '../HeadlessSnapshot';
import { generateRustSnapshot } from '../RustSnapshot';
vi.mock('../RustSnapshot', () => ({ generateRustSnapshot: vi.fn() }));
const request = { cols: 80, rows: 24, initial: Buffer.from('hello'), budgetMs: 1000 };
const success = { ok: true as const, payload: Buffer.from('hello'), bytesIn: 5, durationMs: 1 };
afterEach(() => { vi.unstubAllEnvs(); vi.resetAllMocks(); });
describe('opt-in ANSI snapshot delivery', () => {
  it('uses Rust for an immutable request with the explicit ANSI opt-in', async () => {
    vi.stubEnv('WMUX_RUST_SNAPSHOT', 'all');
    vi.mocked(generateRustSnapshot).mockResolvedValue(success as never);
    const reference = vi.fn(); expect(await selectAnsiSnapshot(request, reference)).toMatchObject({ ...success, durationMs: expect.any(Number) });
    expect(reference).not.toHaveBeenCalled();
  });
  it.each(['\x1b[53moverline', '\x1b7saved', '\x1b]8;;https://example.com\x07link'])('retains xterm for unqualified state %s', async initial => {
    vi.stubEnv('WMUX_RUST_SNAPSHOT', 'all');
    const reference = vi.fn(async () => success);
    await selectAnsiSnapshot({ ...request, initial: Buffer.from(initial) }, reference);
    expect(generateRustSnapshot).not.toHaveBeenCalled(); expect(reference).toHaveBeenCalledOnce();
  });
  it('allows the qualified blink rendition through the native ANSI capability gate', async () => {
    vi.stubEnv('WMUX_RUST_SNAPSHOT', 'ansi');
    const initial = Buffer.from('\x1b[5mblink');
    vi.mocked(generateRustSnapshot).mockResolvedValue({ ...success, bytesIn: initial.length } as never);
    const reference = vi.fn();
    await selectAnsiSnapshot({ ...request, initial }, reference);
    expect(generateRustSnapshot).toHaveBeenCalledOnce(); expect(reference).not.toHaveBeenCalled();
  });
  it.each(['\x1b[38;5;53mcolor', '\x1b[48;2;53;55;6mcolor', '\x1b[38:2::53:55:5mcolor'])('does not confuse color operands with overline: %s', async text => {
    vi.stubEnv('WMUX_RUST_SNAPSHOT', 'ansi');
    const initial = Buffer.from(text), reference = vi.fn();
    vi.mocked(generateRustSnapshot).mockResolvedValue({ ...success, bytesIn: initial.length } as never);
    await selectAnsiSnapshot({ ...request, initial }, reference);
    expect(generateRustSnapshot).toHaveBeenCalledOnce(); expect(reference).not.toHaveBeenCalled();
  });
  it.each(['\x1b[38;2;1;2;3;53moverline', '\x1b[38;2;53mbad color'])('retains the reference for overline or malformed color: %s', async text => {
    vi.stubEnv('WMUX_RUST_SNAPSHOT', 'ansi');
    const reference = vi.fn(async () => success);
    await selectAnsiSnapshot({ ...request, initial: Buffer.from(text) }, reference);
    expect(generateRustSnapshot).not.toHaveBeenCalled(); expect(reference).toHaveBeenCalledOnce();
  });
  it('preserves the live tee for the reference', async () => {
    vi.stubEnv('WMUX_RUST_SNAPSHOT', 'all');
    const drainQueue = vi.fn(() => []), reference = vi.fn(async (req: SnapshotRequest) => { expect(req.initial).toBe(request.initial); return success; });
    await selectAnsiSnapshot({ ...request, drainQueue }, reference);
    expect(generateRustSnapshot).not.toHaveBeenCalled(); expect(drainQueue).not.toHaveBeenCalled();
  });
  it('retries unsupported wide-edge serialization with the remaining budget and original bytes', async () => {
    vi.stubEnv('WMUX_RUST_SNAPSHOT', 'all');
    vi.mocked(generateRustSnapshot).mockResolvedValue({ ok: false, reason: 'error', detail: 'unsupported-wide-edge' });
    const reference = vi.fn(async (req: SnapshotRequest) => { expect(req.initial).toBe(request.initial); return success; });
    await selectAnsiSnapshot(request, reference);
    expect(reference.mock.calls[0][0]).toMatchObject({ initial: request.initial });
    expect(reference.mock.calls[0][0].budgetMs).toBeLessThanOrEqual(1000);
  });
});
