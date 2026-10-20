// TranscriptActivityWatcher — the Fleet "now doing" line for agents that send
// no per-tool hook. A `wmux setup-hooks` install has no wide PostToolUse hook
// (removed for its per-tool-call cost), and Codex never had one, so those
// panes reported no tool activity at all. The agent writes every tool call to
// its own transcript anyway: this tails the APPENDED bytes of that file and
// reports the last tool's summary through the same `activity` metadata a
// PostToolUse hook would have produced.
//
// Rules, each from a way this could go wrong:
//   - A hook wins. A session whose hooks report its tools (HOOK_ACTIVITY_KINDS,
//     the same set main uses) is hook-fed until its next session start or its
//     agent's death; its watcher stops and stays off, so the two sources never
//     alternate on one row.
//   - Never revive a finished pane. An activity-only update marks the pane
//     running, so a line is sent only while the tail shows a turn in progress
//     (its newest event is a tool call or result). A batch that ends on the
//     agent's reply or a new prompt sends nothing and drops any line held back
//     by the gap; Codex's own turn-end record sends a clear.
//   - Positive liveness only. A pane is tailed while the process tracker says
//     its agent is alive, or (no attribution yet) while it has sent a live hook
//     (a prompt, a session start, a tool). After a death only a new session
//     start revives it: a late Stop from the dead agent does not. Two panes
//     bound to one transcript (a resumed session) keep only the one whose agent
//     spoke last.
//   - Appended bytes only, bounded. A watcher starts at the file's current end
//     (no history replay), reads at most READ_CAP_BYTES per tick, and skips to
//     the last JUMP_WINDOW_BYTES when it falls far behind. A replaced file (new
//     inode, or an offset that is no longer a line boundary) re-seats at the
//     end. Per-session state is a path, an inode, an offset and the last line.
//   - Lifecycle by reconcile. One unref'd timer; each tick re-derives the set
//     of sessions that should be watched and drops the rest, so an agent exit
//     or a closed pane can never leak a watcher.
//   - Subagent count (subagentCount.ts). An agent with a counter (Claude,
//     Codex) is read even while hook-fed, for the count only. A count is sent
//     on change, and a watch that ends (agent death, session start, closed
//     pane, replaced file) sends 0 if it had sent more, so a stale count never
//     sticks.
//   - Agent Teams teammates (teammateActivity.ts). A Claude watch, hook-fed or
//     not, also scans its session's subagents/ folder every TEAMMATE_POLL_MS
//     and reports the pane working on every scan that finds an in-process
//     teammate still working, so the pane reads running after the lead's turn
//     ended. Nothing is sent when none works: main's activity stamp decays on
//     its own. The scanner lives on the watch, so it ends with it.
//   - Claude background shells (subagentCount.ts `shells()`). The same scan
//     also reports the pane working while a shell it launched still works
//     (shellWorking: output written within SHELL_FRESH_MS, launch younger
//     than SHELL_MAX_AGE_MS), even after a typed prompt started a turn whose
//     Stop the bridge scopes to its own dispatches. The caps keep a dev
//     server left up from holding the pane running for good.

import fs from 'node:fs';
import type { ResumeBinding } from '../../shared/agentResume';
import type { TurnEvent } from '../../shared/transcript/turnEvents';
import { parseTranscriptLine } from './parseEntry';
import { parseCodexLineDetailed } from './parseCodexEntry';
import { isLineBoundary, readTranscriptDelta, readTranscriptPage, statTranscript } from './readTail';
import { HOOK_ACTIVITY_KINDS } from '../../shared/hooks/hookActivityKinds';
import { MAX_RAW_LEN, summarizeActivity } from '../../shared/activitySummary';
import { agentRow } from '../../shared/agentIdentity';
import { SUBAGENT_COUNTERS, type ShellEntry, type SubagentCounter } from './subagentCount';
import { TEAMMATE_SCANNERS, type TeammateScanner } from './teammateActivity';
import type { TeammateInfo } from '../../shared/types';

/** Most bytes read for one session in one tick. */
export const READ_CAP_BYTES = 256 * 1024;
/** When further behind than READ_CAP_BYTES, resume from this tail window. */
export const JUMP_WINDOW_BYTES = 64 * 1024;
const DEFAULT_POLL_MS = 1500;
/** Minimum spacing of two lines for one session (a clear is never held). */
const DEFAULT_MIN_GAP_MS = 2000;
/** How often a Claude watch scans its session's teammates. Each scan that
 *  finds one working refreshes main's 120 s activity stamp, so a refresh that
 *  lands inside main's 3 s settle guard right after a Stop is retried soon. */
export const TEAMMATE_POLL_MS = 15_000;
/** Marks a watch whose teammate list must be sent again, whatever it says. */
const RESEND_TEAMMATES = '<resend>';
/** A background shell counts as working while its output file changed this
 *  recently (as a teammate's FRESH_MS): a dev server left up goes quiet. */
export const SHELL_FRESH_MS = 10 * 60_000;
/** ...and never past this long after its launch, however much it writes. */
export const SHELL_MAX_AGE_MS = 60 * 60_000;

/** Whether a background shell still reads as working at `now`. A launch that
 *  named no output file goes by its age alone; a named file that cannot be
 *  read says it is not (the safe direction). */
export function shellWorking(shell: ShellEntry, now: number): boolean {
  if (now - shell.startedAt >= SHELL_MAX_AGE_MS) return false;
  if (!shell.outputFile) return true;
  try {
    return now - fs.statSync(shell.outputFile).mtimeMs <= SHELL_FRESH_MS;
  } catch {
    return false;
  }
}

type ParseLine = (line: string, offset: number) => TurnEvent[];

/** Hook kinds that prove an agent is running in the pane (not a turn end). */
const LIVE_HOOK_KINDS: ReadonlySet<string> = new Set(['agent.session_start', 'agent.user_prompt_submit']);

const record = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {});

/** The file a patch touches first (`*** Update File: …` / `*** Add File: …`).
 *  Inside an `exec` script the patch is a JS string, so its line breaks are a
 *  literal backslash-n and it ends at a quote. */
function patchedFile(text: string): string {
  return /\*\*\* (?:Update|Add|Delete) File: (.+?)(?:\\n|\n|["'`]|$)/.exec(text)?.[1]?.trim() ?? '';
}

/**
 * Codex names its tools differently from Claude (and current versions wrap
 * every call in one `exec` script), so the generic summary would read
 * "exec". Map a Codex call onto the Claude-shaped input summarizeActivity
 * already knows, so the line uses the same glyphs and the same caps.
 */
export function codexToolSummary(name: string, rawInput: unknown): string {
  const text = typeof rawInput === 'string' ? rawInput.slice(0, MAX_RAW_LEN) : '';
  const input = typeof rawInput === 'string' ? (() => { try { return record(JSON.parse(rawInput)); } catch { return {}; } })() : record(rawInput);
  const bash = (command: string) => summarizeActivity('Bash', { command });
  if (name === 'apply_patch') return summarizeActivity('Edit', { file_path: patchedFile(text || String(input.input ?? '')) });
  if (name === 'shell' || name === 'local_shell') {
    const argv = Array.isArray(input.command) ? input.command.filter((a): a is string => typeof a === 'string') : [];
    // `bash -lc "<script>"` → the script is the command.
    const script = argv.length >= 3 && /sh$/.test(argv[0]) && argv[1].startsWith('-') ? argv[2] : argv.join(' ');
    return script ? bash(script) : summarizeActivity(name, undefined);
  }
  if (name === 'exec_command' && typeof input.cmd === 'string') return bash(input.cmd);
  if (name === 'exec' && text) {
    // A script calling the host tools: the first call names the work.
    const patch = patchedFile(text);
    if (/tools\.apply_patch\b/.test(text) && patch) return summarizeActivity('Edit', { file_path: patch });
    const cmd = /tools\.exec_command\(\s*\{[^}]*?\bcmd\s*:\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/.exec(text)?.[1];
    if (cmd) {
      let value = cmd.slice(1, -1);
      try { value = JSON.parse(cmd.startsWith('"') ? cmd : `"${value.replace(/"/g, '\\"')}"`) as string; } catch { /* keep the raw text */ }
      return bash(value);
    }
    const tool = /tools\.([A-Za-z_][\w]*)\s*\(/.exec(text)?.[1];
    if (tool) return summarizeActivity(tool, undefined);
  }
  return summarizeActivity(name, input);
}

/** Codex lines: the shared projection, with tool summaries in Codex terms. */
function parseCodexForActivity(line: string, offset: number): TurnEvent[] {
  const events = parseCodexLineDetailed(line, offset).events;
  if (!events.some((event) => event.kind === 'tool_use')) return events;
  const payload = (() => { try { return record(record(JSON.parse(line)).payload); } catch { return {}; } })();
  const summary = codexToolSummary(String(payload.name ?? ''), payload.arguments ?? payload.input);
  return events.map((event) => (event.kind === 'tool_use' ? { ...event, argSummary: summary } : event));
}

const PARSERS: Readonly<Record<string, ParseLine>> = {
  claude: parseTranscriptLine,
  codex: parseCodexForActivity,
};

export interface TranscriptActivityDeps {
  /** Live session ids (attached or detached PTYs). */
  listSessionIds: () => string[];
  /** The session's transcript binding — the projector's own resolver. */
  getBinding: (sessionId: string) => ResumeBinding | undefined;
  /**
   * The process tracker's word on the pane's agent: true alive, false died,
   * undefined never attributed. A false is sticky until the tracker re-arms,
   * so a hook signal from the pane after the death counts as a live agent
   * (a new `claude` in the same pane).
   */
  isAgentAlive: (sessionId: string) => boolean | undefined;
  /** Report a line ('' clears) for the session. */
  emit: (sessionId: string, activity: string) => void;
  /** Report how many subagents the session's agent has running (on change). */
  emitSubagents?: (sessionId: string, count: number) => void;
  /**
   * The session's Claude Code has background work still going (an Agent
   * Teams teammate, or a background shell): a running-state refresh, sent on
   * every scan that finds some (never a turn start, never a count).
   */
  emitBackgroundWorking?: (sessionId: string) => void;
  /**
   * The session's Claude Code Agent Teams teammates (fresh ones, by name), sent
   * on every teammate scan whose list differs from the last one sent (the
   * `at` stamps do not count); an empty list when the watch ends after a
   * non-empty one, so a stale roster never sticks.
   */
  emitTeammates?: (sessionId: string, teammates: TeammateInfo[]) => void;
  teammatePollMs?: number;
  /**
   * Every complete line read from a Claude transcript, in file order, with the
   * file it came from (the API-error turn end reads it; see apiErrorTurnEnd).
   * A new watch also replays its last JUMP_WINDOW_BYTES here once, so the
   * entry of a turn that failed before the watch existed is not lost.
   */
  onClaudeLine?: (sessionId: string, path: string, line: string) => void;
  /** Lines of this session's Claude transcript were skipped unread (more was
   *  appended in one tick than READ_CAP_BYTES): what they said is unknown. */
  onClaudeGap?: (sessionId: string) => void;
  /** Runs at the end of every tick. */
  afterTick?: () => void;
  now?: () => number;
  pollMs?: number;
  minGapMs?: number;
}

interface Watch {
  path: string;
  parse: ParseLine;
  /** The file's identity when the watch started; a new one means replaced. */
  ino: number;
  offset: number;
  /** The line last sent ('' after a clear, undefined at a turn's start). */
  sent?: string;
  sentAt: number;
  /** A line held back by the gap, sent on a later tick. */
  pending?: string;
  /** Hands its Claude lines to `onClaudeLine`. */
  lines: boolean;
  /** Hook-fed: read only for `onClaudeLine`, never for the activity line. */
  linesOnly: boolean;
  /** The one-time `onClaudeLine` replay of the window before `offset` is still owed. */
  replay?: boolean;
  /** Counts the agent's running subagents from the lines `parse` reads. */
  subagents?: SubagentCounter;
  /** The count last sent (0 before any). */
  subagentsSent: number;
  /** Scans the session's subagents/ folder for working teammates (Claude). */
  teammates?: TeammateScanner;
  /** When the background scan (teammates, then shells) last ran (0 before any). */
  teammatesAt: number;
  /** The last teammate list sent, as its comparison key ('' while none was). */
  teammatesSent: string;
}

/**
 * What a batch of new transcript events says about the activity line:
 * the newest tool summary while a turn is in progress, '' when the agent's
 * own turn-end record arrived, or null when there is nothing to say.
 */
export function activityFromEvents(events: readonly TurnEvent[]): string | null {
  return readBatch(events).line;
}

/**
 * The batch's verdict: `line` as activityFromEvents, and `quiet` when the
 * newest event says no tool is running (a reply, a prompt or a turn end), so
 * a line still held back must not be sent.
 */
function readBatch(events: readonly TurnEvent[]): { line: string | null; quiet: boolean } {
  let lastTool: string | undefined;
  for (const event of events) if (event.kind === 'tool_use' && event.argSummary) lastTool = event.argSummary;
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.kind === 'meta') {
      if (event.subtype === 'turn_complete' || event.subtype === 'turn_aborted') return { line: '', quiet: true };
      continue;
    }
    if (event.kind === 'tool_use' || event.kind === 'tool_result') return { line: lastTool ?? null, quiet: false };
    // The agent's reply or a new prompt: not mid-tool, so nothing to report.
    return { line: null, quiet: true };
  }
  return { line: null, quiet: false };
}

export class TranscriptActivityWatcher {
  private readonly watches = new Map<string, Watch>();
  private readonly hookFed = new Set<string>();
  /** Newest live hook (prompt, session start, tool) and session start per pane. */
  private readonly liveHookAt = new Map<string, number>();
  private readonly sessionStartAt = new Map<string, number>();
  /** When the tracker first reported the pane's agent dead. */
  private readonly deadSince = new Map<string, number>();
  /** Monotonic stamp, so two signals in one millisecond still order. */
  private seq = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly now: () => number;

  constructor(private readonly deps: TranscriptActivityDeps) {
    this.now = deps.now ?? Date.now;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), this.deps.pollMs ?? DEFAULT_POLL_MS);
    this.timer.unref?.();
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.watches.clear();
    this.hookFed.clear();
    this.liveHookAt.clear();
    this.sessionStartAt.clear();
    this.deadSince.clear();
  }

  /** Sessions currently tailed (tests and diagnostics). */
  watchedSessions(): string[] {
    return [...this.watches.keys()];
  }

  /** Every resolved hook signal for the session. */
  noteHookSignal(sessionId: string, kind: string): void {
    const at = ++this.seq;
    if (LIVE_HOOK_KINDS.has(kind) || HOOK_ACTIVITY_KINDS.has(kind)) this.liveHookAt.set(sessionId, at);
    if (HOOK_ACTIVITY_KINDS.has(kind)) {
      this.hookFed.add(sessionId);
      // The hook owns the activity line now; the Claude lines and the
      // subagent count still matter.
      const watch = this.watches.get(sessionId);
      if (watch?.lines || watch?.subagents) {
        watch.linesOnly = true;
        watch.sent = undefined;
        watch.pending = undefined;
      } else this.dropWatch(sessionId);
    } else if (kind === 'agent.session_start') {
      this.sessionStartAt.set(sessionId, at);
      this.hookFed.delete(sessionId);
      this.dropWatch(sessionId);
    } else if (kind === 'agent.stop' || kind === 'agent.stop_failure' || kind === 'agent.user_prompt_submit') {
      // The hook cleared (or is about to replace) the line: the next tool is new.
      const watch = this.watches.get(sessionId);
      if (watch) { watch.sent = undefined; watch.pending = undefined; }
    }
  }

  /** This pane's watch reads `path` and hands its lines to `onClaudeLine`. */
  readsLines(sessionId: string, path: string): boolean {
    const watch = this.watches.get(sessionId);
    return !!watch && watch.lines && watch.path === path;
  }

  /** The pane closed or its PTY died. */
  dropSession(sessionId: string): void {
    this.dropWatch(sessionId);
    this.hookFed.delete(sessionId);
    this.liveHookAt.delete(sessionId);
    this.sessionStartAt.delete(sessionId);
    this.deadSince.delete(sessionId);
  }

  /**
   * Positive evidence that this pane's agent runs: the tracker says alive,
   * or, unattributed, a live hook from the pane. After a recorded death only
   * the tracker or a session start newer than the death counts — a late Stop
   * from the dead agent does not.
   */
  private agentAlive(id: string): boolean {
    const tracked = this.deps.isAgentAlive(id);
    if (tracked === true) {
      this.deadSince.delete(id);
      return true;
    }
    if (tracked === false && !this.deadSince.has(id)) {
      this.deadSince.set(id, ++this.seq);
      // The dead agent's hooks no longer speak for this pane.
      this.hookFed.delete(id);
    }
    const dead = this.deadSince.get(id);
    if (dead !== undefined) return (this.sessionStartAt.get(id) ?? 0) > dead;
    return this.liveHookAt.has(id);
  }

  tick(): void {
    const live = new Set(this.deps.listSessionIds());
    for (const id of [...this.hookFed]) if (!live.has(id)) this.hookFed.delete(id);
    for (const map of [this.liveHookAt, this.sessionStartAt, this.deadSince]) {
      for (const id of [...map.keys()]) if (!live.has(id)) map.delete(id);
    }
    for (const [id] of [...this.watches]) if (!live.has(id)) this.dropWatch(id);
    for (const id of live) {
      try {
        this.reconcile(id);
      } catch {
        this.dropWatch(id);
      }
    }
    this.dropSharedTranscripts();
    for (const [id, watch] of [...this.watches]) {
      try {
        this.read(id, watch);
      } catch {
        // One unreadable transcript must never stop the others.
        this.dropWatch(id);
      }
      if (this.watches.get(id) === watch) this.flushSubagents(id, watch);
      if (this.watches.get(id) === watch) this.scanBackground(id, watch);
    }
    this.deps.afterTick?.();
  }

  /** Ends a watch; a subagent count it had sent goes back to 0. */
  private dropWatch(id: string): void {
    const watch = this.watches.get(id);
    if (!watch) return;
    this.watches.delete(id);
    if (watch.subagentsSent > 0) this.deps.emitSubagents?.(id, 0);
    if (watch.teammatesSent !== '') this.deps.emitTeammates?.(id, []);
  }

  /**
   * Makes every watch send its teammate list again on the next tick, even if it
   * is unchanged. The daemon outlives the app, and a freshly subscribed app has
   * an empty roster that would otherwise only fill when a list changes.
   */
  resendTeammates(): void {
    for (const watch of this.watches.values()) {
      // A sentinel no real key equals (those are "" or JSON), so an empty list
      // still sends nothing for a pane that never had teammates.
      if (watch.teammatesSent !== '') watch.teammatesSent = RESEND_TEAMMATES;
      watch.teammatesAt = 0;
    }
  }

  private flushSubagents(id: string, watch: Watch): void {
    const count = watch.subagents?.count ?? 0;
    if (count === watch.subagentsSent) return;
    watch.subagentsSent = count;
    this.deps.emitSubagents?.(id, count);
  }

  private scanBackground(id: string, watch: Watch): void {
    if (!watch.teammates) return;
    const now = this.now();
    if (watch.teammatesAt > 0 && now - watch.teammatesAt < (this.deps.teammatePollMs ?? TEAMMATE_POLL_MS)) return;
    watch.teammatesAt = now;
    let list: TeammateInfo[] = [];
    try {
      list = watch.teammates.list(now);
    } catch {
      // An unreadable folder says nothing; the activity line is unaffected.
    }
    if (list.some((t) => t.working) || (watch.subagents?.shells?.() ?? []).some((shell) => shellWorking(shell, now))) {
      this.deps.emitBackgroundWorking?.(id);
    }
    // The roster is sent on change only; an empty one is "" so that a list
    // that never had a teammate sends nothing, and one that emptied sends [].
    const key = list.length ? JSON.stringify(list.map(({ name, color, working, activity }) => ({ name, color, working, activity }))) : '';
    if (key === watch.teammatesSent) return;
    watch.teammatesSent = key;
    this.deps.emitTeammates?.(id, list);
  }

  /** One transcript, one pane: the pane whose agent spoke last keeps it. */
  private dropSharedTranscripts(): void {
    const byPath = new Map<string, string>();
    for (const [id, watch] of this.watches) {
      const other = byPath.get(watch.path);
      if (other === undefined) { byPath.set(watch.path, id); continue; }
      const keep = (this.liveHookAt.get(id) ?? 0) > (this.liveHookAt.get(other) ?? 0) ? id : other;
      this.dropWatch(keep === id ? other : id);
      byPath.set(watch.path, keep);
    }
  }

  private reconcile(id: string): void {
    const fed = this.hookFed.has(id);
    let binding = fed || !this.agentAlive(id) ? undefined : this.deps.getBinding(id);
    // A hook-fed Claude pane is still read for its lines (an API-error turn
    // end has no hook on an install without StopFailure), and a hook-fed pane
    // whose subagents can be counted for that count; never for activity.
    if (fed && this.agentAlive(id)) {
      const own = this.deps.getBinding(id);
      if ((this.deps.onClaudeLine && agentRow(own?.agent)?.apiErrorTurnEnd) || (own && SUBAGENT_COUNTERS[own.agent])) binding = own;
    }
    const agentParse = binding ? PARSERS[binding.agent] : undefined;
    const path = binding?.transcriptPath;
    const onLine = agentRow(binding?.agent)?.apiErrorTurnEnd ? this.deps.onClaudeLine : undefined;
    const parse: ParseLine | undefined = agentParse && onLine && path
      ? (line, offset) => { onLine(id, path, line); return agentParse(line, offset); }
      : agentParse;
    const current = this.watches.get(id);
    if (!parse || !path) {
      this.dropWatch(id);
      return;
    }
    if (current && current.path === path) {
      current.linesOnly = this.hookFed.has(id);
      return;
    }
    // A watch of another file ends here: its count goes with it.
    this.dropWatch(id);
    const stat = statTranscript(path);
    if (!stat) return;
    const subagents = binding ? SUBAGENT_COUNTERS[binding.agent]?.() : undefined;
    const scanTeammates = binding && (this.deps.emitBackgroundWorking || this.deps.emitTeammates) ? TEAMMATE_SCANNERS[binding.agent] : undefined;
    const teammates = scanTeammates?.(path);
    const counted: ParseLine = subagents ? (line, offset) => { subagents.noteLine(line); return parse(line, offset); } : parse;
    // Start at the end: only what the agent writes from now on.
    this.watches.set(id, { path, parse: counted, ino: stat.ino, offset: stat.size, sentAt: 0, lines: !!onLine, linesOnly: this.hookFed.has(id), replay: !!onLine, subagents, subagentsSent: 0, teammates, teammatesAt: 0, teammatesSent: '' });
  }

  /** The one-time `onClaudeLine` replay a watch owes, if it owes one. */
  private replayLines(id: string, watch: Watch): void {
    const onLine = this.deps.onClaudeLine;
    if (!watch.replay || !onLine) return;
    watch.replay = false;
    // The replay reads only the last window, so whatever came before it (and
    // whatever was written while no watch read this file) is a gap.
    this.deps.onClaudeGap?.(id);
    const page = readTranscriptPage(watch.path, { maxBytes: JUMP_WINDOW_BYTES, parseLine: (line) => { onLine(id, watch.path, line); return []; } });
    // Go on from the last complete line the replay handed over: a line still
    // being written when the watch began is read whole once it ends, rather
    // than its tail failing the line-boundary check and being skipped.
    if (page && page.cursor.fileSize >= watch.offset) watch.offset = page.cursor.tailOffset;
  }

  private read(id: string, watch: Watch): void {
    // Here, after dropSharedTranscripts: a pane that lost a shared file is
    // recreated by every reconcile, and must not replay it every tick.
    this.replayLines(id, watch);
    const stat = statTranscript(watch.path);
    if (!stat) {
      this.dropWatch(id);
      return;
    }
    let events: TurnEvent[] = [];
    const replaced = stat.ino !== watch.ino
      || (watch.offset > 0 && watch.offset <= stat.size && !isLineBoundary(watch.path, watch.offset));
    if (replaced || stat.size < watch.offset) {
      // Rewritten, replaced or rotated: re-seat at the new end, report nothing.
      // The Claude lines of the new file are owed once, as for a new watch.
      watch.ino = stat.ino;
      watch.offset = stat.size;
      watch.pending = undefined;
      watch.subagents?.reset();
      // In this tick, before afterTick settles a pending error the new file
      // may already have moved past.
      watch.replay = watch.lines;
      this.replayLines(id, watch);
    } else if (stat.size - watch.offset > READ_CAP_BYTES) {
      if (watch.lines) this.deps.onClaudeGap?.(id);
      // Skipped lines may have started or ended subagents: count afresh from
      // the window read below.
      watch.subagents?.reset();
      const page = readTranscriptPage(watch.path, { maxBytes: JUMP_WINDOW_BYTES, parseLine: watch.parse });
      if (!page) { this.dropWatch(id); return; }
      events = page.events;
      watch.offset = page.cursor.tailOffset;
    } else if (stat.size > watch.offset) {
      const delta = readTranscriptDelta(watch.path, watch.offset, READ_CAP_BYTES, watch.parse);
      if (!delta) { this.dropWatch(id); return; }
      if (delta.reset) {
        // Rewritten under the read: like a replacement, a gap then one replay.
        watch.offset = stat.size;
        watch.subagents?.reset();
        watch.replay = watch.lines;
        this.replayLines(id, watch);
      } else {
        events = delta.events;
        watch.offset = delta.cursor.tailOffset;
      }
    }
    if (watch.linesOnly) return;
    if (events.some((event) => event.kind === 'user_text')) watch.sent = undefined;
    const { line, quiet } = readBatch(events);
    // A turn that moved past its tools must not have a held-back line sent
    // later: nothing (an interrupt sends no Stop) would ever clear it.
    if (quiet) watch.pending = undefined;
    if (line !== null) watch.pending = line;
    this.flush(id, watch);
  }

  private flush(id: string, watch: Watch): void {
    const next = watch.pending;
    if (next === undefined) return;
    if (next === watch.sent) { watch.pending = undefined; return; }
    const now = this.now();
    if (next !== '' && now - watch.sentAt < (this.deps.minGapMs ?? DEFAULT_MIN_GAP_MS)) return;
    watch.pending = undefined;
    // A clear for a line never sent is noise.
    if (next === '' && !watch.sent) { watch.sent = ''; return; }
    watch.sent = next;
    watch.sentAt = now;
    this.deps.emit(id, next);
  }
}
