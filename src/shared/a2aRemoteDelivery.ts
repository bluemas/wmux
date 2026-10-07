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
} as const);

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
  return [hostName, workspaceName, paneLabel].map((p) => p.replace(/\//g, '-').trim() || '?').join('/');
}

// ─── Daemon RPC payloads ────────────────────────────────────────────────────

/** One active link, as main sees it for alias addressing and discovery. */
export interface A2aRemoteTarget {
  alias: string;
  linkId: string;
  hostId: HostId;
  /** The local pane bound to the link: the only pane that may send on it. */
  local: { workspaceId: string; paneId: string };
  remote: { workspaceId: string; paneId: string; label?: string };
  /** `link.allow.outbound`: this side may start new tasks on the link. */
  allowOutbound: boolean;
}

export interface A2aRemoteSendTaskInput {
  linkId: string;
  /** The verified sender pane (must be the link's local pane). */
  from: { workspaceId: string; name: string; paneId: string };
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

// ─── Renderer delivery result ───────────────────────────────────────────────

export type A2aRemoteHeldReason = NonNullable<A2aRemoteTaskMarkerV1['held']>;

/**
 * What the renderer answers main's bridge for one remote-task delivery.
 *   - `delivered`: written to the pinned pane (or already was: `duplicate`).
 *   - `held`: refused for a reason that must not be retried blindly — the
 *     pane is gone, or another occupant holds it now. Never re-routed.
 *   - neither: not written this time (approval prompt, person typing, no
 *     agent in the pane); the bridge may try again later.
 */
export type A2aRemoteDeliveryResult =
  | { ok: true; delivered: true; duplicate?: boolean }
  | { ok: true; delivered: false; held?: A2aRemoteHeldReason; reason?: string }
  | { ok?: false; error: string };
