# Terminal core baseline and Rust decision

Run the production TypeScript ring and on-demand snapshot paths in isolated
Node processes on macOS, Linux or Windows:

```sh
node scripts/terminal-core-bench.mjs --json out/terminal-core.json
node scripts/terminal-core-bench.mjs --sessions 1,50 --mib 8 --runs 3 --json out/terminal-core-8mib.json
```

Create the output directory first. Existing result files are never overwritten.
Defaults: 1/10/30/50 rings, approximately 1 MiB per ring, three independent
processes per workload and session count. The two synthetic workloads are
colored log lines and cursor-home redraws, both including Korean and emoji.
Inputs round down to complete chunks; the report records actual byte counts.
The worker bundles the current source, so no daemon rebuild is necessary.
It never attaches to or changes running sessions.

## Interpretation

- Production does **not** retain a headless xterm per session. HeadlessSnapshot
  constructs and disposes one terminal per request; a global queue serializes
  requests. Replacing a presumed persistent mirror is not a valid rationale
  for rewriting this daemon.
- The session count measures retained rings, not live PTYs, renderers or AI
  agent processes. Rings have the production 8 MiB ceiling. A populated
  50-session set approaching that ceiling retains 400 MiB of ring storage
  regardless of implementation language.
- `writeMs` covers interleaved 16 KiB writes and growth. `snapshotMs` includes
  copying one ring and one production snapshot (120 columns, 40 rows, 5,000
  scrollback lines, production time budget). It is not the latency of revealing
  all sessions or of painting a renderer.
- `eventLoop` observes the snapshot interval with a 1 ms histogram. Its p99 is
  based on a small number of samples, not an application input-latency p99.
  `cpuMs` includes writes, explicit GC, sampling waits and the snapshot.
- Memory fields are point samples, **not peak memory**. Explicit GC before
  the baseline and after writes distinguishes retained storage from garbage;
  this differs from a live daemon's GC schedule. RSS and external/heap/array
  buffer counters overlap and must not be summed.
- Snapshot hashes allow checking reproducibility and before/after output
  equivalence. They do not replace terminal conformance or recorded TUI tests.
  Any snapshot fallback fails the run rather than reporting a fast success.
- Samples start in fresh processes with no warmup. These are cold module/JIT
  measurements, not steady-state parser throughput. Synthetic inputs and the
  absence of OS PTYs, IPC and rendering limit conclusions about user latency.

## Local experiment, 2026-10-13

Apple M5, macOS arm64, Node v24.15.0; three samples per cell. Compared the same
harness before and after removing the intermediate `readAll()` allocation in
`RingBuffer.ensureCapacity`. Values below are medians in milliseconds:

| Workload | Sessions | Writes before | Writes after | Snapshot before | Snapshot after |
| --- | ---: | ---: | ---: | ---: | ---: |
| Log | 1 | 0.30 | 0.22 | 50.43 | 50.84 |
| Log | 10 | 3.00 | 2.49 | 50.44 | 50.53 |
| Log | 30 | 6.69 | 4.86 | 50.35 | 50.75 |
| Log | 50 | 10.20 | 7.09 | 50.74 | 50.67 |
| Redraw | 1 | 0.32 | 0.21 | 33.98 | 33.37 |
| Redraw | 10 | 3.19 | 2.45 | 33.57 | 33.45 |
| Redraw | 30 | 6.62 | 4.50 | 33.32 | 33.66 |
| Redraw | 50 | 12.21 | 7.12 | 33.48 | 33.09 |

All corresponding snapshot hashes matched across repetitions and versions.
Retained ring allocation stayed at 1 MiB per session. Direct copying removes
temporary history allocations during growth; it does not reduce the ring's
capacity, change retention policy or speed up terminal parsing. These small
local samples are descriptive, not a CI threshold or an app-wide speedup claim.

The modified implementation also completed 8 MiB workloads at 1 and 50
sessions (three runs each). At 50 sessions, one snapshot took a median 174 ms
for logs and 208 ms for redraws; rings retained 400 MiB. All snapshots succeeded.

A separate 64 KiB feed-slice experiment increased the 1 MiB log snapshot time
from roughly 50 ms to 63 ms while only modestly reducing the observed event-loop
maximum. It was rejected; production retains 256 KiB slices.

## Next decision

Keep Electron and the existing terminal engine for now. Use `wmux doctor
--performance --json` for on-demand live process/ring/queue attribution, and
the existing packaged-app performance harness for real input/frame latency.
Before Rust work, capture representative TUI/reflow histories and establish
equivalent snapshot correctness, memory and end-to-end timings. The existing
Rust mini-grid throughput is not comparable to this full snapshot pipeline.
Only a measured remaining bottleneck should determine the next migration scope.

## Installed-app check, 2026-10-13

Measured installed **wmux 4.3.0**, separately from the modified source tree.
An isolated suffix, app profile, daemon and shell history were used; the normal
instance was only queried for diagnostic counters. The recording kit verified
the isolated app's PID/start time and CDP ownership before renderer access.
All test apps and daemons were stopped with the kit's recorded-PID cleanup.

Real zsh PTYs ran finite Node producers, each attempting 40,000 bytes every
100 ms and honoring stdout backpressure (up to 400 KB/s per producer). Hidden
workspaces remained mounted. The focused terminal received 60 keyboard events
per stage. Timing started at its renderer keydown, matched the echoed character
only from the primed focused PTY, and recorded the next animation frame. This
is real keyboard/IPC/daemon/PTY round-trip timing, but the frame measurement is
an rAF approximation, not a verified GPU presentation timestamp.

| Hidden producers | Mounted terminals | Echo p50 / p95 / max (ms) | Next-frame p95 (ms) | rAF p50 / p95 (ms) | Dropped inputs |
| ---: | ---: | --- | ---: | --- | ---: |
| 0 | 1 | 1.1 / 2.3 / 2.6 | 23.2 | 16.7 / 18.1 | 0 / 60 |
| 8 | 9 | 0.8 / 1.4 / 1.6 | 8.7 | 16.7 / 18.2 | 0 / 60 |
| 30 | 31 | 0.6 / 2.0 / 3.0 | 8.2 | 16.7 / 18.1 | 0 / 60 |

Idle was measured first; later stages benefiting from warmup does **not** imply
load makes the application faster. This is a short local run with 60 samples
per stage, not a p99 study or a sustained soak test. A prior independent run
also completed idle/8-producer stages with no input drops (echo p95 1.0/1.1 ms),
then hit the production PTY creation rate limit. The complete run spaced and
retried creation requests without changing that limit.

The complete run observed daemon RSS of 107/150/261 MiB and Electron working
sets of 721/781/897 MiB at 0/8/30 producers. These counters overlap differently
across platforms and are not heap sizes. At 30 producers, retained history
contained 48 MiB, rings allocated 76 MiB, and the sampled socket/resync queues
were empty. The scenario grows incrementally, so histories and allocations
from the earlier stage remain; it is not a per-session linear memory model.

The existing user instance's separate point sample contained 27 sessions:
app process RSS about 292 MiB, daemon 189 MiB, workload descendants 1,478 MiB,
and separate browser descendants 1,075 MiB. RSS omits swapped/compressed pages
and may double-count shared pages. This is process attribution, not a claim
that these numbers equal physical memory pressure or all possible savings.

Raw measurements and the local driver are in `out/terminal-core-review/`:
`live-result.json` (partial first run), `live-result-r2.json` (complete run),
`existing-instance-memory.json`, and `live.mjs`. They contain numeric counters
and synthetic keystrokes, not the user's terminal contents.

**Decision:** this workload did not expose an input or frame-cadence bottleneck
that justifies a Rust rewrite. Much of the observed user-instance RSS belonged
to workloads and separate browser processes. Keep the existing stack; investigate
actual slow reveals, resize/reflow and long-duration memory growth separately
if those are the user's symptoms. This check neither tests those paths nor
compares against a feature-equivalent Rust implementation.
