# Real bot and worker memory measurement — 2026-10-13

## Result

Running bots and their workers materially increases memory use. In this local
test, SDK bot subprocesses exited after their turns, while interactive worker
CLIs and their MCP subprocesses stayed resident after their responses ended.
The factory's explicit stop-all operation reclaimed the worker processes.

These are sampled process-tree RSS sums on macOS arm64 / Apple M5. The table
excludes the Electron application and terminal daemon; it includes the relevant
agent subprocesses, their MCP children, and a few MiB of shells.

| Scenario | Observed agent/worker RSS | Evidence |
| --- | ---: | --- |
| One SDK bot responding | 435 MiB peak | Run A, `one-bot` |
| Three SDK bots responding | 1,045 MiB peak | Run A, `three-bots` |
| Three SDK bots plus three live PTY worker CLIs | 2,309 MiB combined peak | Run C, `bots-and-workers-overlap` |
| Worker responses ended, SDK bots idle | 1,193 MiB median worker RSS | Run C, 14 samples over approximately 15 seconds |
| Explicit stop-all settled | Approximately 3 MiB shells; no agent CLI/MCP descendants | Run C, final stop-all samples |

The combined peak is a sum at **one sampling instant**, not the sum of two
independently observed maxima. Three SDK `claude` processes and three worker
`claude` processes overlapped in 13 samples spanning 12.74 seconds. In that peak
sample, bot children used 927 MiB and worker descendants 1,382 MiB. Electron
used another 431 MiB and the daemon 79 MiB, making the sampled whole instance
approximately 2,819 MiB. These figures are descriptive, not capacity guarantees.

## Build and workload

- Fresh isolated package from `factory/5.0` commit `91d1f956e`, built in a
  detached temporary worktree. This is the bots development branch, unlike
  the earlier installed-4.3.0 output-generator test.
- Three real `claude-sdk` bots: lead, triage and maintainer. Each requested
  `claude-opus-5-5` with low effort. Worker terminal headers reported Opus 5.5
  with high effort, using the product's normal default worker launch.
- Bots produced roughly 650-word algorithm explanations, with delegation
  prohibited except for the explicitly requested fan-out stage.
- The lead called the actual `fanout_start` tool with the default preset to
  create three worker workspaces and git worktrees. Workers read three small
  fixture files, ran `npm test` (5,000 JSON round-trip assertions), and explained
  the result. No source changes, commits, pushes, GitHub actions or nested agent
  launches were requested.
- The SDK bots were explicitly woken again while the three worker CLIs were
  alive in Run C, so the combined measurement observes actual overlap rather
  than estimating it by adding measurements from separate phases.
- Each run used its own app profile, data suffix, daemon and shell history.
  The normal user instance and its sessions were not modified.

## Collection and completion criteria

The local driver sampled `ps` approximately once per second, following the
recorded application and daemon PID trees. Electron helpers belong to `app`;
other application descendants to `botChildren`; daemon descendants to
`workers`. Previously observed descendants that became reparented were also
tracked through shutdown. Command arguments and credentials were not collected.

Wakes were observed through the factory's persisted queue. Run C waited for
all three worker workspaces to report `agentStatus: complete`, captured their
terminal screens, waited for the extra SDK bot wakes to finish successfully,
and observed another approximately 15 seconds before calling
`factory.stopAll`. The result was `workersStopped: 3`, `botsInterrupted: 0`.
It then waited another 15 seconds, disabled the factory, and shut down the
isolated app and daemon using the recording kit's PID/start-time checks.

**A worker's completed response is not a completed task record.** The task
ledger still said `working` after the terminal responses ended. A captured
worker reported that it could not locate its task ID for the completion report.
Stop-all subsequently marked those tasks cancelled. Thus this measures the
resident cost of completed interactive responses, not a successful automatic
task-finalization/close path. Completion identity/reporting deserves a separate
investigation before any automatic idle-worker reclamation policy is enabled.

## Runs and retained evidence

All evidence is local under `out/` (git-ignored):

- `out/bot-memory-review/result.json`: Run A, baseline, registered-only,
  one-bot and three-bot stages, fan-out, and explicit stop. Its initial worker
  wait was fixed-duration; do not treat `after-worker-tasks` in this run as
  proof of natural completion.
- `out/bot-memory-review-natural/result.json`: Run B, natural worker response
  completion and screen capture. Three extra SDK wakes were injected late in
  the post-completion interval and interrupted by stop-all; this run is not
  the controlled overlap baseline. They are recorded separately in
  `overlap-wakes.json`.
- `out/bot-memory-review-overlap/result.json`: Run C, controlled concurrent
  bots/workers, successful response completion, residency and stop-all.
- The drivers are `out/bot-memory-review/run.mjs`, `run-natural.mjs` and
  `run-overlap.mjs`. Task ledgers are retained beside each result file.

## Limits and implications

- RSS excludes swapped/compressed pages and may double-count shared pages.
  Sampling can miss brief peaks. The user's other applications remained open,
  so absolute RSS is affected by system pressure and process warmup.
- This is a short process-lifecycle test, not a long-duration leak test, a
  large repository/build test, or a measure of local LLM inference memory.
- Worker CLIs loaded the user's normal MCP configuration, including additional
  Node/npm MCP processes. Their cost is included. A minimal configuration may
  consume less memory; a larger workload/context may consume more.
- Registration alone did not launch SDK bot subprocesses. Bot response
  completion ended the SDK/MCP descendants in the observed one/three-bot stages.
- A Rust PTY/snapshot N-API module does not remove these separate Claude and
  MCP processes. Its savings must be measured independently. For team-mode
  footprint, first investigate worker completion reporting, safe idle process
  release/resume, and an aggregate concurrency budget covering bots and workers.
