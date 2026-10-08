// === Cross-host A2A — local delivery layer (daemon <-> main <-> renderer) ===
//
// The wire contract between hosts is `a2aRemote.ts`. This file pins the
// shapes that stay INSIDE one host: the daemon RPCs main calls, the event the
// daemon broadcasts when a remote task lands, the synthetic workspace id a
// remote pane is represented by in the task ledger, and what the renderer
// answers for a remote-task delivery.
//
// Pure module: no node:* imports (the renderer imports it).

import type { A2aRemoteTaskMarkerV1, HostId } from './a2aRemote';
import type { Task, TaskState } from './types';

/**
 * Daemon RPC method names for the delivery layer. Registered in the daemon's
 * RPC table by the wiring step; every handler is a thin parse around the
 * functions in `src/daemon/a2aRemote/{inbound,outbound}.ts` and
 * `A2aTaskService`.
 */
export const A2A_REMOTE_RPC = Object.freeze({
  /** → `{ tasks: Task[] }` — `A2aTaskService.listRemotePending()`. */
  pending: 'a2a.remote.pending',
  /** `{ taskId, delivered?: true, held?: reason }` → `{ ok: true } | { ok: false, error }`. */
  mark: 'a2a.remote.mark',
  /** → `{ targets: A2aRemoteTarget[] }` — every ACTIVE link, as an addressable alias. */
  targets: 'a2a.remote.targets',
  /** `A2aRemoteSendTaskInput` → `{ ok: true, taskId } | { ok: false, error }`. */
  sendTask: 'a2a.remote.sendTask',
  /** `A2aRemoteReplyInput` → `{ ok: true, taskId } | { ok: false, error }`. */
  reply: 'a2a.remote.reply',
  /** `A2aRemoteStateInput` → `{ ok: true } | { ok: false, error }`. */
  state: 'a2a.remote.state',
  /** → `{ tasks: Task[] }` — `A2aTaskService.listRemoteHeld()` (for a person to decide). */
  held: 'a2a.remote.held',
  /** `{ taskId, reason }` → `{ ok: true } | { ok: false, error }` — `rejectHeld`. */
  rejectHeld: 'a2a.remote.rejectHeld',
} as const);

/**
 * Renderer method main's RemoteA2aBridge calls for one reply/state item the
 * peer sent (`{ task, messageId, resnapshot? }` → `A2aRemoteDeliveryResult`).
 * Never registered on the pipe router: only main calls it.
 */
export const A2A_REMOTE_NOTIFY_METHOD = 'a2a.remote.notify';

/** Daemon broadcast when an inbound remote task was written to the ledger. */
export const A2A_REMOTE_INBOUND_EVENT = 'a2a.remote.inbound';

export interface A2aRemoteInboundEvent {
  type: typeof A2A_REMOTE_INBOUND_EVENT;
  taskId: string;
}

// ─── Synthetic workspace id ─────────────────────────────────────────────────

/**
 * A remote pane appears in the task ledger as workspace `remote:<linkId>`.
 * Local workspace ids are `ws-…`, so the two never collide, and the ordinary
 * "only the receiver workspace moves a task" rule applies to the peer as is.
 */
export const REMOTE_WORKSPACE_PREFIX = 'remote:';

export function remoteWorkspaceId(linkId: string): string {
  return REMOTE_WORKSPACE_PREFIX + linkId;
}

export function isRemoteWorkspaceId(v: unknown): v is string {
  return typeof v === 'string' && v.startsWith(REMOTE_WORKSPACE_PREFIX) && v.length > REMOTE_WORKSPACE_PREFIX.length;
}

/**
 * The address an agent uses for a remote pane: `<PC name>/<workspace>/<pane>`.
 * A '/' inside a part becomes '-', so the alias always splits into exactly
 * three parts and one part can never impersonate two.
 */
export function remoteAlias(hostName: string, workspaceName: string, paneLabel: string): string {
  return [hostName, workspaceName, paneLabel].map((p) => aliasPart(p)).join('/');
}

/**
 * One alias part: printable characters only (letters, marks, digits,
 * punctuation, symbols, plain spaces), '/' as '-', bounded. A remote name
 * can never carry a control character or an escape into an agent's prompt.
 */
export function aliasPart(raw: string): string {
  const kept = [...raw].filter((ch) => /[\p{L}\p{M}\p{N}\p{P}\p{S} ]/u.test(ch)).join('');
  return kept.replace(/\//g, '-').replace(/ {2,}/g, ' ').trim().slice(0, 64) || '?';
}

/**
 * Text a peer sent, made safe to paste into a terminal: ESC-introduced
 * sequences (CSI, OSC — e.g. OSC 52 clipboard writes —, DCS/SOS/PM/APC and
 * any other ESC pair, including the bracketed-paste end `ESC[201~`) are
 * removed, CR becomes a newline (no overwritten-line forgery), and every
 * other C0/C1 control and DEL is dropped. `\n` and `\t` stay. Applied where
 * the text is received AND again right before a pane write.
 */
export function sanitizeRemoteText(raw: string): string {
  return raw
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\|$)/g, '')
    .replace(/\x1b[PX^_][\s\S]*?(?:\x1b\\|$)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]?/g, '')
    .replace(/\x9b[0-?]*[ -/]*[@-~]?/g, '')
    .replace(/\x9d[\s\S]*?(?:\x07|\x9c|$)/g, '')
    .replace(/\x1b[\s\S]?/g, '')
    .replace(/\r\n?/g, '\n')
    // eslint-disable-next-line no-control-regex -- stripping controls is the point
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
}

// ─── Daemon RPC payloads ────────────────────────────────────────────────────

/** One active link, as main sees it for alias addressing and discovery. */
export interface A2aRemoteTarget {
  alias: string;
  linkId: string;
  hostId: HostId;
  /** The local pane bound to the link: the only pane that may send on it. */
  local: { workspaceId: string; paneId?: string };
  /** A brain (Moa) end has no `paneId`. */
  remote: { workspaceId: string; paneId?: string; label?: string };
  /** `link.allow.outbound`: this side may start new tasks on the link. */
  allowOutbound: boolean;
}

export interface A2aRemoteSendTaskInput {
  linkId: string;
  /** The verified sender pane (must be the link's local pane) and its pty now. */
  from: { workspaceId: string; name: string; paneId: string; ptyId?: string };
  title: string;
  text: string;
}

export interface A2aRemoteReplyInput {
  taskId: string;
  /** The caller's workspace: must be the task's LOCAL side. */
  workspaceId: string;
  text: string;
}

export interface A2aRemoteStateInput {
  taskId: string;
  state: 'working' | 'input-required' | 'completed' | 'failed' | 'canceled';
  /** Free text for the peer's ledger (e.g. the evidence summary). */
  summary?: string;
}

// ─── Delivery state on the ledger marker ─────────────────────────────────────

export type A2aRemoteHeldReason = NonNullable<A2aRemoteTaskMarkerV1['held']>;

/**
 * One message the peer sent into an existing task (a reply, or a state
 * change), owed a delivery to our local pane: replies are written to the
 * pane, states are announced on the event bus. Exactly once per `messageId`.
 */
export interface A2aRemoteInboxItem {
  messageId: string;
  kind: 'reply' | 'state';
  delivered?: boolean;
  held?: A2aRemoteHeldReason;
  /** When it was first held (the 24 h hold TTL counts from here). */
  heldAt?: string;
  note?: 'pasted-not-submitted';
  /** main started a paste and has not confirmed it yet. */
  attempted?: boolean;
}

/**
 * What the daemon keeps under `Task.metadata.remote`: the v1 contract marker
 * plus local delivery bookkeeping (never sent over the wire).
 */
export type A2aRemoteTaskState = A2aRemoteTaskMarkerV1 & {
  /** Inbound task: main started a paste and has not confirmed it yet. */
  attempted?: boolean;
  /** The last task state exchanged with the peer (sent, or applied from it). */
  stateSync?: TaskState;
  /** Our own replies on this task already queued for the peer (messageIds). */
  sent?: string[];
  /** Inbound task: its paste stayed in the composer; counted as delivered. */
  note?: 'pasted-not-submitted';
  /** Inbound task: when it was first held. */
  heldAt?: string;
  inbox?: A2aRemoteInboxItem[];
};

/** A hold older than this is rejected automatically (`held-expired`). */
export const A2A_REMOTE_HOLD_TTL_MS = 24 * 60 * 60 * 1000;

/** The local side of a remote task: the party whose workspace is not `remote:`. */
export function localSideOf(task: Pick<Task, 'metadata'>): 'from' | 'to' {
  return isRemoteWorkspaceId(task.metadata.from.workspaceId) ? 'to' : 'from';
}

// ─── Renderer delivery result ───────────────────────────────────────────────

/**
 * What the renderer answers main's bridge for one remote-task delivery.
 *   - `delivered`: written to the pinned pane (or already was: `duplicate`).
 *   - `held`: refused for a reason that must not be retried blindly — the
 *     pane is gone, or another occupant holds it now. Never re-routed.
 *   - neither: not written this time (approval prompt, person typing, no
 *     agent in the pane); the bridge may try again later.
 */
export type A2aRemoteDeliveryResult =
  | { ok: true; delivered: true; duplicate?: boolean; ptyId?: string; note?: 'pasted-not-submitted' }
  | { ok: true; delivered: false; held?: A2aRemoteHeldReason; reason?: string }
  | { ok?: false; error: string };
