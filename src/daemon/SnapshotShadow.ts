/** Experimental observation only: always return the original xterm outcome.
 * No protocol change, raw terminal data logging, or native default selection. */
import type { SnapshotRequest, SnapshotOutcome, TextSnapshotOutcome } from './HeadlessSnapshot';
import { generateRustSnapshot } from './RustSnapshot';
import { snapshotTestTerminal, terminalFingerprint, writeTerminal } from './snapshotFingerprint';

type Outcome = SnapshotOutcome | TextSnapshotOutcome;
export interface SnapshotShadowDiagnostics {
  compared: number;
  matched: number;
  mismatched: number;
  skipped: number;
  errors: number;
  last?: { kind: 'text' | 'ansi'; status: 'matched' | 'mismatched' | 'skipped' | 'error'; nativeMs: number };
}
const diagnostics: SnapshotShadowDiagnostics = { compared: 0, matched: 0, mismatched: 0, skipped: 0, errors: 0 };
export function getSnapshotShadowDiagnostics(): SnapshotShadowDiagnostics {
  return { ...diagnostics, last: diagnostics.last && { ...diagnostics.last } };
}

export async function withSnapshotShadow<T extends Outcome>(req: SnapshotRequest, kind: 'text' | 'ansi', run: (req: SnapshotRequest) => Promise<T>): Promise<T> {
  if (process.env.WMUX_RUST_SNAPSHOT !== 'shadow') return run(req);
  // Limit observation costs; the native grid also enforces an allocation bound.
  if (req.initial.length > 8 * 1024 * 1024 || req.cols * (req.rows + (req.scrollback ?? 5000)) > 1_000_000) {
    diagnostics.skipped++; return run(req);
  }
  const drained: Buffer[] = [];
  let capturedBytes = req.initial.length;
  let overflow = false;
  const sourceDrain = req.drainQueue;
  const reference = await run({ ...req, drainQueue: sourceDrain && (() => {
    const chunks = sourceDrain();
    for (const chunk of chunks) {
      capturedBytes += chunk.length;
      if (capturedBytes > 8 * 1024 * 1024) { overflow = true; drained.length = 0; }
      else if (!overflow) drained.push(chunk);
    }
    return chunks;
  }) });
  if (!reference.ok || overflow) { diagnostics.skipped++; return reference; }
  const started = performance.now();
  try {
    let consumed = false;
    const captured: SnapshotRequest = { ...req, drainQueue: () => {
      if (consumed) return []; consumed = true; return drained;
    } };
    const native = kind === 'text' ? await generateRustSnapshot(captured, 'text') : await generateRustSnapshot(captured, 'ansi');
    if (!native.ok) {
      const status = native.reason === 'error' ? 'error' : 'skipped';
      if (status === 'error') diagnostics.errors++; else diagnostics.skipped++;
      diagnostics.last = { kind, status, nativeMs: performance.now() - started };
      return reference;
    }
    let matched = false;
    if ('rows' in native && 'rows' in reference) {
      matched = JSON.stringify([native.rows, native.bufferType, native.rowsBelowCursor, native.bytesIn]) ===
        JSON.stringify([reference.rows, reference.bufferType, reference.rowsBelowCursor, reference.bytesIn]);
    } else if ('payload' in native && 'payload' in reference) {
      const scrollback = Math.max(0, Math.min(100000, Math.floor(req.scrollback ?? 5000)));
      const a = snapshotTestTerminal(req.cols, req.rows, scrollback);
      const b = snapshotTestTerminal(req.cols, req.rows, scrollback);
      try {
        await writeTerminal(a, reference.payload); await writeTerminal(b, native.payload);
        matched = terminalFingerprint(a) === terminalFingerprint(b);
        // Also probe wrap-pending / active SGR / incomplete parser state.
        await writeTerminal(a, '\x1b[?2026lZ한\r\n'); await writeTerminal(b, '\x1b[?2026lZ한\r\n');
        matched &&= terminalFingerprint(a) === terminalFingerprint(b);
      } finally { a.dispose(); b.dispose(); }
    }
    diagnostics.compared++;
    if (matched) diagnostics.matched++; else diagnostics.mismatched++;
    diagnostics.last = { kind, status: matched ? 'matched' : 'mismatched', nativeMs: native.durationMs };
  } catch {
    diagnostics.errors++;
    diagnostics.last = { kind, status: 'error', nativeMs: performance.now() - started };
  }
  return reference;
}
