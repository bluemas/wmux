// Whether a Claude Code session has an Agent Teams teammate still working.
//
// An in-process teammate keeps working after the lead's own turn ended (its
// Stop hook fired, the pane sits at its prompt), and none of that work reaches
// the lead's transcript: Claude Code writes it next to it, under
// `<transcript without .jsonl>/subagents/agent-<name>-<hash>.jsonl`, with a
// sibling `.meta.json` whose `taskKind` is `in_process_teammate`. Ordinary
// async subagents live in the same folder without a `taskKind`; they are not
// read here (the subagent count already covers them, from the lead's own
// transcript).
//
// A teammate counts as working when the last meaningful record of its tail
// (an `assistant` or a non-meta `user` record; `api-request*`, `attachment`
// and other bookkeeping lines are skipped) is:
//   - a reply that ended its turn (a `stop_reason` other than `tool_use`, no
//     tool call): idle, never working;
//   - otherwise, with a tool call in the tail still without its result
//     (a long Bash, say): working while the newer of that record's timestamp
//     and the file's mtime is at most PENDING_TOOL_CAP_MS old;
//   - otherwise (a tool result, a streamed partial reply, a new message to the
//     teammate): working while that age is at most FRESH_MS.
// The caps are what keep a teammate that crashed or was killed mid-call from
// pinning the pane's running state: a pending call goes stale after 30 min of
// no record and no file growth, anything else after 10 min.
//
// Cost: one readdir per scan (re-read only when the folder's mtime moves), a
// stat per transcript, the meta file once per transcript, and a bounded tail
// read (readTranscriptPage, at most TAIL_READ_BYTES) only for a transcript whose
// size or mtime changed since the last scan and that is recent enough to
// matter. An unchanged file reuses its last verdict.

import fs from 'node:fs';
import path from 'node:path';
import { readTranscriptPage, statTranscript } from './readTail';
import { parseTranscriptLine } from './parseEntry';
import { activityFromEvents } from './TranscriptActivityWatcher';
import type { TeammateInfo } from '../../shared/types';

/** A pending tool call stops counting after this long without a record or file growth. */
export const PENDING_TOOL_CAP_MS = 30 * 60_000;
/** Any other non-final record stops counting after this long. */
export const FRESH_MS = 10 * 60_000;
/** Tail read per changed transcript. Below TAIL_BYTES on purpose: a full-size
 *  window makes readTranscriptPage read a straddling oversized record whole. */
const TAIL_READ_BYTES = 192 * 1024;
/** The meta files Claude Code writes are a few hundred bytes. */
const META_MAX_BYTES = 64 * 1024;

export type TeammateTailState = 'replied' | 'pending_tool' | 'busy';

export interface TeammateTail {
  state: TeammateTailState;
  /** The last meaningful record's timestamp (ms), when it carried one. */
  at?: number;
}

const record = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {});

/**
 * What a teammate transcript's tail lines (oldest first) say. Null when no
 * meaningful record is among them (a tail of bookkeeping lines only).
 */
export function classifyTeammateTail(lines: readonly string[]): TeammateTail | null {
  const pending = new Set<string>();
  let last: { entry: Record<string, unknown>; blocks: Record<string, unknown>[] } | null = null;
  for (const line of lines) {
    // Cheap pre-filter: only conversation records matter.
    if (!line.includes('"assistant"') && !line.includes('"user"')) continue;
    let entry: Record<string, unknown>;
    try { entry = record(JSON.parse(line)); } catch { continue; }
    if (entry.type !== 'assistant' && entry.type !== 'user') continue;
    if (entry.type === 'user' && entry.isMeta === true) continue;
    const content = record(entry.message).content;
    const blocks = Array.isArray(content) ? content.map(record) : [];
    for (const block of blocks) {
      if (entry.type === 'assistant' && block.type === 'tool_use' && typeof block.id === 'string') pending.add(block.id);
      else if (entry.type === 'user' && block.type === 'tool_result' && typeof block.tool_use_id === 'string') pending.delete(block.tool_use_id);
    }
    last = { entry, blocks };
  }
  if (!last) return null;
  const stamp = typeof last.entry.timestamp === 'string' ? Date.parse(last.entry.timestamp) : NaN;
  const at = Number.isFinite(stamp) ? { at: stamp } : {};
  const stop = record(last.entry.message).stop_reason;
  const calls = last.blocks.some((b) => b.type === 'tool_use');
  if (last.entry.type === 'assistant' && !calls && typeof stop === 'string' && stop !== 'tool_use') return { state: 'replied', ...at };
  return { state: pending.size > 0 ? 'pending_tool' : 'busy', ...at };
}

/**
 * The verdict for one teammate: its tail (null: no meaningful record in it,
 * read as busy) and the file's mtime, at `now`.
 */
export function teammateWorking(tail: TeammateTail | null, mtimeMs: number, now: number): boolean {
  if (tail?.state === 'replied') return false;
  const age = now - Math.max(tail?.at ?? 0, mtimeMs);
  return age <= (tail?.state === 'pending_tool' ? PENDING_TOOL_CAP_MS : FRESH_MS);
}

/** How many tail lines the activity line is read from (the newest tool call is near the end). */
const ACTIVITY_TAIL_LINES = 40;
const SIDECHAIN = /"isSidechain"\s*:\s*true/;

interface TeammateMeta {
  teammate: boolean;
  name?: string;
  color?: string;
}

/** The meta file next to `transcript`: whether it names an in-process teammate,
 *  plus the teammate's own name and colour when it carries them; undefined
 *  while there is no meta file yet (asked again on the next scan). */
function readTeammateMeta(transcript: string): TeammateMeta | undefined {
  const meta = transcript.replace(/\.jsonl$/, '.meta.json');
  const stat = statTranscript(meta);
  if (!stat) return undefined;
  if (stat.size > META_MAX_BYTES) return { teammate: false };
  try {
    const parsed = record(JSON.parse(fs.readFileSync(meta, 'utf8')));
    const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
    return { teammate: parsed.taskKind === 'in_process_teammate', name: str(parsed.name), color: str(parsed.color) };
  } catch {
    return { teammate: false };
  }
}

/** `agent-<name>-<hash>.jsonl` → `<name>` (the name may itself hold dashes). */
function nameFromFile(file: string): string {
  const base = path.basename(file).replace(/\.jsonl$/, '').replace(/^agent-/, '');
  const cut = base.lastIndexOf('-');
  return cut > 0 ? base.slice(0, cut) : base;
}

interface FileState {
  /** Undefined until the meta file was read and named a teammate (or not). */
  teammate?: boolean;
  name?: string;
  color?: string;
  /** The activity line of the tail (a tool call in progress), '' when none. */
  activity: string;
  size: number;
  mtimeMs: number;
  tail: TeammateTail | null;
}

/** The activity line the lead's summarizer reads from a teammate's tail lines. */
function activityOf(lines: readonly string[]): string {
  // The parser collapses a sidechain record to one "Subagent thread" chip; a
  // teammate's whole transcript is sidechain, and here it is the thread read.
  const events = lines.slice(-ACTIVITY_TAIL_LINES).flatMap((line) => parseTranscriptLine(line.replace(SIDECHAIN, '"isSidechain":false'), 0));
  return activityFromEvents(events) ?? '';
}

/** The `subagents/` folder of a Claude Code session's transcript. */
export function subagentsDirFor(transcriptPath: string): string {
  return path.join(transcriptPath.replace(/\.jsonl$/, ''), 'subagents');
}

/** Scans one session's `subagents/` folder; keep one per watched transcript. */
export class TeammateScanner {
  private dirMtimeMs = -1;
  private names: string[] = [];
  private readonly files = new Map<string, FileState>();

  constructor(readonly dir: string) {}

  /** Whether at least one in-process teammate of the session works at `now`. */
  anyWorking(now: number): boolean {
    return this.list(now).some((t) => t.working);
  }

  /** The session's fresh in-process teammates at `now`, sorted by name. */
  list(now: number): TeammateInfo[] {
    this.refresh();
    const found: TeammateInfo[] = [];
    // Every file is still visited so its cache stays current.
    for (const file of this.names) {
      const info = this.check(path.join(this.dir, file), now);
      if (info) found.push(info);
    }
    return found.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  private refresh(): void {
    let mtimeMs: number;
    try {
      const st = fs.lstatSync(this.dir);
      if (!st.isDirectory()) throw new Error('not a directory');
      mtimeMs = st.mtimeMs;
    } catch {
      this.dirMtimeMs = -1;
      this.names = [];
      this.files.clear();
      return;
    }
    if (mtimeMs === this.dirMtimeMs) return;
    this.dirMtimeMs = mtimeMs;
    try {
      this.names = fs.readdirSync(this.dir).filter((n) => n.endsWith('.jsonl'));
    } catch {
      this.names = [];
    }
    const keep = new Set(this.names.map((n) => path.join(this.dir, n)));
    for (const file of [...this.files.keys()]) if (!keep.has(file)) this.files.delete(file);
  }

  private check(file: string, now: number): TeammateInfo | null {
    const stat = statTranscript(file);
    if (!stat) { this.files.delete(file); return null; }
    let state = this.files.get(file);
    if (!state) {
      state = { size: -1, mtimeMs: -1, tail: null, activity: '' };
      this.files.set(file, state);
    }
    // Too old to count whatever it says: stat only, no read.
    if (now - stat.mtimeMs > PENDING_TOOL_CAP_MS) return null;
    if (state.teammate === undefined) {
      const meta = readTeammateMeta(file);
      if (meta) {
        state.teammate = meta.teammate;
        state.name = meta.name ?? nameFromFile(file);
        state.color = meta.color;
      }
    }
    if (state.teammate !== true) return null;
    if (stat.size !== state.size || stat.mtimeMs !== state.mtimeMs) {
      const lines: string[] = [];
      const page = readTranscriptPage(file, { maxBytes: TAIL_READ_BYTES, parseLine: (line) => { lines.push(line); return []; } });
      if (!page) return null;
      state.size = stat.size;
      state.mtimeMs = stat.mtimeMs;
      state.tail = classifyTeammateTail(lines);
      state.activity = activityOf(lines);
    }
    const working = teammateWorking(state.tail, state.mtimeMs, now);
    return {
      name: state.name ?? nameFromFile(file),
      ...(state.color ? { color: state.color } : {}),
      working,
      ...(working && state.activity ? { activity: state.activity } : {}),
      at: Math.max(state.tail?.at ?? 0, state.mtimeMs),
    };
  }
}
