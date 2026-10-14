/** C experiment: invoke the real native core against the production text path.
 * Never loaded by the daemon. ANSI replay has a separate conformance runner. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { performance, monitorEventLoopDelay } from 'node:perf_hooks';
import { generateTextSnapshot, type SnapshotRequest, type TextSnapshotOutcome, FEED_SLICE_BYTES } from '../src/daemon/HeadlessSnapshot';
import { getTextSnapshotBackendDiagnostics } from '../src/daemon/TextSnapshotBackend';

const nativePath = process.env.WMUX_NATIVE_CORE;
assert(nativePath, 'WMUX_NATIVE_CORE must select the native module');
const native = createRequire(path.resolve('package.json'))(nativePath);
const yieldLoop = () => new Promise<void>(resolve => setImmediate(resolve));

async function rustSnapshot(req: SnapshotRequest): Promise<TextSnapshotOutcome> {
  const started = performance.now();
  const term = new native.NativeTerminal(req.geometry?.start.cols ?? req.cols, req.geometry?.start.rows ?? req.rows, req.scrollback ?? 5000);
  let bytesIn = 0;
  const feed = async (bytes: Buffer) => {
    bytesIn += bytes.length;
    for (let offset = 0; offset < bytes.length; offset += FEED_SLICE_BYTES) {
      term.feed(bytes.subarray(offset, offset + FEED_SLICE_BYTES));
      await yieldLoop();
      if (performance.now() - started > (req.budgetMs ?? 4000)) return false;
    }
    return true;
  };
  try {
    let offset = 0;
    for (const change of req.geometry?.changes ?? []) {
      if (!(await feed(req.initial.subarray(offset, change.offset)))) return { ok: false, reason: 'budget' };
      offset = change.offset;
      term.resize(change.cols, change.rows);
    }
    if (!(await feed(req.initial.subarray(offset)))) return { ok: false, reason: 'budget' };
    term.resize(req.cols, req.rows);
    for (;;) {
      const chunks = req.drainQueue?.() ?? [];
      if (!chunks.length) break;
      for (const chunk of chunks) if (!(await feed(chunk))) return { ok: false, reason: 'budget' };
    }
    return { ok: true, ...term.textSnapshot(req.undimmed ?? false), bytesIn, durationMs: performance.now() - started };
  } finally { term.dispose(); }
}

function comparable(out: TextSnapshotOutcome) {
  if (!out.ok) return out;
  return { rows: out.rows, bufferType: out.bufferType, rowsBelowCursor: out.rowsBelowCursor };
}

type Fixture = { name: string; text: string; initial?: Buffer; cols?: number; rows?: number; scrollback?: number; geometry?: SnapshotRequest['geometry']; chunks?: Buffer[] };
const fixtures: Fixture[] = [
  { name: 'empty', text: '' },
  { name: 'colored-log', text: '\x1b[1;31mERROR\x1b[0m boom\r\nsecond line\r\n' },
  { name: 'soft-wrap', text: 'abcdefghijklmnopqrstuvwxy', cols: 8 },
  { name: 'exact-right-margin', text: 'abcdefgh', cols: 8 },
  { name: 'scrollback-cap', text: Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\r\n'), rows: 4, scrollback: 5 },
  { name: 'cjk-wrap', text: 'abc한글세계xyz한글', cols: 8 },
  { name: 'wide-right-edge', text: 'abcdefg한z', cols: 8 },
  { name: 'combining', text: 'abc e\u0301 한\u0301 끝', cols: 8 },
  { name: 'emoji-zwj-vs16', text: '⚠️ ❤️ ✔️ 👨‍👩‍👧 👍🏽 1️⃣ end', cols: 12 },
  { name: 'unicode-new-emoji', text: 'abc🫠XYZ🩷tail', cols: 8 },
  { name: 'dim-wide', text: 'a\x1b[2m한 dim\x1b[22m shown' },
  { name: 'cursor-overwrite', text: 'first\r\nsecond\x1b[1;2HZ\x1b[2;3H!' },
  { name: 'erase-insert-delete', text: 'abcdefgh\r\x1b[3C\x1b[2P\x1b[2@XY\x1b[K' },
  { name: 'scroll-margins', text: 'one\r\ntwo\r\nthree\r\nfour\x1b[2;4r\x1b[4;1Hnew\r\nlast', rows: 5 },
  { name: 'alt-active', text: 'normal\x1b[?1049h\x1b[Halternate\r\nprompt', rows: 4 },
  { name: 'alt-return', text: 'normal\x1b[?1049hother\x1b[?1049l' },
  { name: 'sync-complete', text: '\x1b[?2026hfirst\r\nsecond\x1b[?2026l' },
  { name: 'sync-open', text: '\x1b[?2026hfirst\r\nsecond' },
  { name: 'split-utf8-escape', text: '', chunks: Array.from(Buffer.from('한글\x1b[31m😀\x1b[0m!'), byte => Buffer.from([byte])) },
  { name: 'incomplete-utf8', text: 'ready', chunks: [Buffer.from([0xf0, 0x9f])] },
  { name: 'incomplete-csi', text: 'ready\x1b[31;' },
  { name: 'queries-no-writeback', text: 'before\x1b[c\x1b[6n\x1b]52;c;?\x07after' },
  { name: 'resize-reflow', text: 'abcdefghijklmnop\r\nnext', cols: 12, rows: 4, geometry: { start: { cols: 8, rows: 4 }, changes: [] } },
  { name: 'resize-mid-stream', text: 'abcdefghijklmnopqrstuv', cols: 12, rows: 4, geometry: { start: { cols: 8, rows: 4 }, changes: [{ offset: 12, cols: 12, rows: 4 }] } },
  { name: 'resize-narrow', text: 'abc한글0123456789\r\nlast', cols: 8, rows: 4, geometry: { start: { cols: 16, rows: 4 }, changes: [] } },
];

async function parity() {
  const results = [];
  const repoRoot = process.env.WMUX_REPO_ROOT;
  assert(repoRoot, 'WMUX_REPO_ROOT must select the corpus root');
  const corpus = path.join(repoRoot, 'core/harness/corpus');
  for (const name of readdirSync(corpus)) {
    const dir = path.join(corpus, name);
    const events = readFileSync(path.join(dir, 'events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    const initial = readFileSync(path.join(dir, 'recording.bin'));
    const start = events[0].geometry;
    const changes = events.filter(e => e.type === 'resize').map(e => ({ offset: e.byteOffset, ...e.geometry }));
    const end = changes.at(-1) ?? start;
    fixtures.push({ name: `corpus/${name}`, text: '', initial, cols: end.cols, rows: end.rows, scrollback: 5000, geometry: { start, changes } });
  }
  for (const f of fixtures) {
    const req = (): SnapshotRequest => {
      let drained = false;
      return { cols: f.cols ?? 40, rows: f.rows ?? 6, scrollback: f.scrollback ?? 100, undimmed: true,
        geometry: f.geometry, initial: f.initial ?? Buffer.from(f.text),
        drainQueue: f.chunks ? () => { if (drained) return []; drained = true; return f.chunks ?? []; } : undefined };
    };
    const xterm = comparable(await generateTextSnapshot(req()));
    const rust = comparable(await rustSnapshot(req()));
    const deliveredBefore = getTextSnapshotBackendDiagnostics().native;
    process.env.WMUX_RUST_SNAPSHOT = 'text';
    let selected;
    try { selected = comparable(await generateTextSnapshot(req())); }
    finally { process.env.WMUX_RUST_SNAPSHOT = ''; }
    assert.deepEqual(selected, xterm, `Production flag parity: ${f.name}`);
    assert.equal(getTextSnapshotBackendDiagnostics().native - deliveredBefore, f.chunks ? 0 : 1,
      `Expected native delivery for immutable input: ${f.name}`);
    let equal = true;
    try { assert.deepEqual(rust, xterm); } catch { equal = false; }
    results.push({ name: f.name, equal, ...equal ? {} : { xterm, rust } });
  }
  const term = new native.NativeTerminal(80, 24, 100);
  term.dispose(); term.dispose();
  assert.throws(() => term.feed(Buffer.from('x')), /disposed/);
  assert.throws(() => new native.NativeTerminal(0, 24, 100));
  assert.throws(() => new native.NativeTerminal(1000, 1000, 100000));
  const knownDifferences: string[] = [];
  assert.deepEqual(results.filter(r => !r.equal).map(r => r.name).sort(), knownDifferences,
    'Unexpected compatibility change: inspect and update the evidence, not just the count');
  const large = Buffer.concat([Buffer.from('x'.repeat(FEED_SLICE_BYTES - 1)), Buffer.from('한😀tail')]);
  const request = { cols: 80, rows: 24, initial: large };
  assert.deepEqual(comparable(await rustSnapshot(request)), comparable(await generateTextSnapshot(request)));
  assert.deepEqual(await rustSnapshot({ ...request, budgetMs: 0 }), { ok: false, reason: 'budget' });
  console.log(JSON.stringify({ kind: 'parity', passed: results.filter(r => r.equal).length, total: results.length, results }));
}

async function benchmark(backend: string, workload: string, mib: number) {
  const line = workload === 'redraw'
    ? '\x1b[H\x1b[2K\x1b[32mAgent working\x1b[0m 한글 😀\r\n\x1b[2Kstep 42 / 100\r\n'
    : '\x1b[32mPASS\x1b[0m build: src/example.ts 한글 😀 1234567890\r\n';
  const initial = Buffer.from(line.repeat(Math.floor(mib * 1048576 / Buffer.byteLength(line))));
  global.gc?.();
  const baseline = process.memoryUsage();
  const delay = monitorEventLoopDelay({ resolution: 1 }); delay.enable();
  await new Promise(resolve => setTimeout(resolve, 10)); delay.reset();
  const cpuStart = process.cpuUsage();
  const started = performance.now();
  const req = { cols: 120, rows: 40, scrollback: 5000, initial };
  const out = await (backend === 'rust' ? rustSnapshot(req) : generateTextSnapshot(req));
  const elapsedMs = performance.now() - started;
  const cpu = process.cpuUsage(cpuStart);
  const after = process.memoryUsage();
  await new Promise(resolve => setTimeout(resolve, 2)); delay.disable();
  global.gc?.();
  assert(out.ok);
  console.log(JSON.stringify({ kind: 'benchmark', backend, workload, bytesIn: initial.length, elapsedMs,
    cpuMs: (cpu.user + cpu.system) / 1000, baseline, after, afterGc: process.memoryUsage(),
    maxRssKiB: process.resourceUsage().maxRSS,
    eventLoop: { samples: delay.count, maxMs: delay.max / 1e6, p99Ms: delay.percentile(99) / 1e6 },
    rows: out.rows.length, sha256: createHash('sha256').update(JSON.stringify(comparable(out))).digest('hex') }));
}

async function main() {
  if (process.argv[2] === 'parity') await parity();
  else await benchmark(process.argv[2], process.argv[3], Number(process.argv[4]));
}
main().catch(e => { console.error(e); process.exitCode = 1; });
