import type { SnapshotOutcome, SnapshotRequest } from './HeadlessSnapshot';
import { generateRustSnapshot } from './RustSnapshot';
import { withSnapshotShadow } from './SnapshotShadow';
import { nativeSnapshotEligible } from './TextSnapshotBackend';

/** Immutable attach/dead-session requests can safely retry their original
 * bytes. Live tees stay with xterm because their drain callback is destructive. */
export async function selectAnsiSnapshot(req: SnapshotRequest,
  reference: (req: SnapshotRequest) => Promise<SnapshotOutcome>): Promise<SnapshotOutcome> {
  // ANSI delivery has its own opt-in until private parser-state restoration
  // is fully qualified. Combined PTY/ring/text alone leaves it on xterm.
  const mode = process.env.WMUX_RUST_SNAPSHOT;
  if (mode !== 'all' && mode !== 'ansi') return withSnapshotShadow(req, 'ansi', reference);
  if (req.drainQueue || req.nativeSource || !nativeSnapshotEligible(req) || hasUnqualifiedState(req.initial)) return reference(req);
  const budget = req.budgetMs ?? 4000;
  if (!Number.isFinite(budget) || budget < 0) return reference(req);
  if (budget === 0) return { ok: false, reason: 'budget' };
  const started = performance.now();
  try {
    const native = await generateRustSnapshot({ ...req, budgetMs: budget / 2 }, 'ansi');
    if (native.ok && Buffer.isBuffer(native.payload) && native.bytesIn === req.initial.length) {
      if (performance.now() - started > budget) return { ok: false, reason: 'budget' };
      return { ...native, durationMs: performance.now() - started };
    }
  } catch { /* Retry only the intact immutable request. */ }
  const remaining = budget - (performance.now() - started);
  if (remaining <= 0) return { ok: false, reason: 'budget' };
  const fallback = await reference({ ...req, budgetMs: remaining });
  return fallback.ok ? { ...fallback, durationMs: performance.now() - started } : fallback;
}

/** Refuse unqualified state. SGR color values are operands, not attributes:
 * RGB red=53 must not be mistaken for the unsupported overline command. */
function hasUnqualifiedState(bytes: Buffer): boolean {
  const text = bytes.toString('utf8');
  /* eslint-disable no-control-regex -- These patterns recognize terminal controls. */
  if (/\x1b\]|[\x0e\x0f]/.test(text) || /\x1b(?:[78H()*+]|\[[0-?]*[ -/]*[suqg])/.test(text)) return true;
  for (const match of text.matchAll(/\x1b\[([0-9;:]*)m/g)) {
    const params = match[1].split(';');
    for (let index = 0; index < params.length; index++) {
      const parts = params[index].split(':');
      const attribute = Number(parts[0]);
      if (attribute === 53 || attribute === 55) return true;
      if ([38, 48, 58].includes(attribute) && parts.length === 1) {
        const mode = Number(params[index + 1]);
        const operands = mode === 5 ? 2 : mode === 2 ? 4 : 0;
        // Malformed or mixed color syntax stays on the reference path.
        if (!operands || index + operands >= params.length ||
            params.slice(index + 1, index + operands + 1).some(value => !/^\d+$/.test(value))) return true;
        index += operands;
      }
    }
  }
  /* eslint-enable no-control-regex */
  return false;
}
