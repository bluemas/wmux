import crypto from 'node:crypto';
import {
  A2A_BRAIN_ALIAS,
  A2A_REMOTE_BODY_MAX,
  A2A_REMOTE_PROTOCOL,
  type A2aLinkRecordV1,
  type A2aRemoteEnvelope,
  type A2aRemoteTaskMarkerV1,
} from '../../shared/a2aRemote';
import {
  isRemoteWorkspaceId,
  remoteAlias,
  remoteWorkspaceId,
  type A2aRemoteReplyInput,
  type A2aRemoteSendTaskInput,
  type A2aRemoteStateInput,
  type A2aRemoteTarget,
} from '../../shared/a2aRemoteDelivery';
import type { Message, Task } from '../../shared/types';
import type { A2aTaskService } from '../a2a/A2aTaskService';
import type { LinkStore } from './linkStore';
import type { OutboxStore } from './outboxStore';
import { remoteTaskId } from './ids';

/**
 * Cross-host A2A, sending side: turn a local agent's send / reply / state
 * change on a remote task into a ledger entry plus an outbox envelope. The
 * daemon's RPC handlers (wiring step) are thin parses around these.
 */

export type OutboundResult = { ok: true; taskId: string } | { ok: false; error: string };

export interface OutboundDeps {
  linkStore: Pick<LinkStore, 'get' | 'list' | 'checkMessage'>;
  taskService: Pick<A2aTaskService, 'getTask' | 'createTask' | 'appendRemoteMessage' | 'cancelTask'>;
  outbox: Pick<OutboxStore, 'enqueue'>;
  /** Display alias of a link's remote pane (see `linkAlias`). */
  aliasFor: (link: A2aLinkRecordV1) => string;
  now?: () => number;
  /** Test seam for envelope messageIds (defaults to a random UUID). */
  mintId?: () => string;
}

/**
 * `<PC name>/<workspace>/<pane>` for a link's remote pane, `<PC name>/Moa`
 * for a brain end. The workspace part is the remote workspace's name, the
 * pane part its label; each falls back to its id when the link has no name.
 */
export function linkAlias(link: A2aLinkRecordV1, hostName: string | undefined): string {
  const pc = hostName || link.remote.hostId.slice(0, 8);
  if (link.remote.kind === 'brain') return `${pc.replace(/\//g, '-').trim() || '?'}/${A2A_BRAIN_ALIAS}`;
  return remoteAlias(pc, link.remote.workspaceName || link.remote.workspaceId, link.remote.label || link.remote.paneId || '');
}

/**
 * Aliases of every ACTIVE link, unique: when two links would read the same,
 * the later one (by creation) gets `#2`, the next `#3`, so an agent's exact
 * alias names exactly one link. Inbound task senders and the send targets
 * read this one table, so discover and send always agree.
 */
export function aliasTable(links: readonly A2aLinkRecordV1[], hostName: (hostId: string) => string | undefined): Map<string, string> {
  const active = links
    .filter((l) => l.state === 'active')
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.linkId.localeCompare(b.linkId));
  const used = new Set<string>();
  const out = new Map<string, string>();
  for (const link of active) {
    const base = linkAlias(link, hostName(link.remote.hostId));
    let alias = base;
    for (let n = 2; used.has(alias); n++) alias = `${base}#${n}`;
    used.add(alias);
    out.set(link.linkId, alias);
  }
  return out;
}

/** Every ACTIVE link as an addressable target. */
export function listRemoteTargets(deps: Pick<OutboundDeps, 'linkStore' | 'aliasFor'>): A2aRemoteTarget[] {
  return deps.linkStore
    .list()
    .filter((l) => l.state === 'active')
    .map((l) => ({
      alias: deps.aliasFor(l),
      linkId: l.linkId,
      hostId: l.remote.hostId,
      kind: l.local.kind,
      local: { workspaceId: l.local.workspaceId, ...(l.local.paneId ? { paneId: l.local.paneId } : {}) },
      remote: {
        workspaceId: l.remote.workspaceId,
        ...(l.remote.paneId ? { paneId: l.remote.paneId } : {}),
        ...(l.remote.label ? { label: l.remote.label } : {}),
      },
      allowOutbound: l.allow.outbound,
    }));
}

/**
 * A new task from the link's local pane to its remote pane: an outbound ledger
 * task under the deterministic id, then a `task` envelope in the outbox. If the
 * envelope cannot be queued the task is canceled, so the ledger never shows a
 * task the peer will never get.
 */
export async function sendRemoteTask(deps: OutboundDeps, input: A2aRemoteSendTaskInput): Promise<OutboundResult> {
  const link = deps.linkStore.get(input.linkId);
  if (!link) return { ok: false, error: 'unknown-link' };
  if (link.local.kind === 'brain') {
    // Moa sends as its HQ workspace; main proved it from the commander token.
    if (link.local.workspaceId !== input.from.workspaceId || input.from.paneId !== undefined) {
      return { ok: false, error: 'forbidden: only this PC\'s Moa may send on this link' };
    }
  } else if (!input.from.paneId || link.local.workspaceId !== input.from.workspaceId || link.local.paneId !== input.from.paneId) {
    return { ok: false, error: 'forbidden: only the linked local pane may send on this link' };
  }
  const check = deps.linkStore.checkMessage(link.linkId, link.version, link.remote.hostId, 'outbound', 'task');
  if (!check.ok) return { ok: false, error: check.error };
  const sizeErr = bodyError(input.text);
  if (sizeErr) return { ok: false, error: sizeErr };

  const messageId = mint(deps);
  const taskId = remoteTaskId(link.linkId, messageId);
  const marker: A2aRemoteTaskMarkerV1 = { v: 1, linkId: link.linkId, hostId: link.remote.hostId, messageId, direction: 'outbound', kind: link.local.kind };
  const created = await deps.taskService.createTask({
    id: taskId,
    title: input.title || input.text.slice(0, 100),
    from: { ...input.from },
    to: { workspaceId: remoteWorkspaceId(link.linkId), name: deps.aliasFor(link) },
    history: [textMessage(messageId, 'user', input.text)],
    remote: marker,
  });
  if (!created.ok) return { ok: false, error: created.error };
  try {
    deps.outbox.enqueue(link.remote.hostId, envelope(deps, link, messageId, { kind: 'task', text: input.text }));
  } catch (err) {
    await deps.taskService.cancelTask({ taskId, callerWorkspaceId: input.from.workspaceId });
    return { ok: false, error: `unavailable: could not queue the task (${errText(err)})` };
  }
  return { ok: true, taskId };
}

/**
 * A reply on a remote task from its LOCAL side: appended to the ledger history,
 * then queued as a `reply` envelope.
 */
export async function sendRemoteReply(deps: OutboundDeps, input: A2aRemoteReplyInput): Promise<OutboundResult> {
  const found = remoteTaskAndLink(deps, input.taskId);
  if (!found.ok) return found;
  const { task, link } = found;
  const localSide = isRemoteWorkspaceId(task.metadata.from.workspaceId) ? 'to' : 'from';
  if (task.metadata[localSide].workspaceId !== input.workspaceId) {
    return { ok: false, error: 'forbidden: the caller is not the local party of this task' };
  }
  const check = deps.linkStore.checkMessage(link.linkId, link.version, link.remote.hostId, 'outbound', 'reply', undefined, { onThisLink: true });
  if (!check.ok) return { ok: false, error: check.error };
  const sizeErr = bodyError(input.text);
  if (sizeErr) return { ok: false, error: sizeErr };

  const messageId = mint(deps);
  const appended = await deps.taskService.appendRemoteMessage({
    taskId: task.id,
    linkId: link.linkId,
    actorWorkspaceId: input.workspaceId,
    message: textMessage(messageId, localSide === 'from' ? 'user' : 'agent', input.text),
  });
  if (!appended.ok) return { ok: false, error: appended.error };
  try {
    deps.outbox.enqueue(link.remote.hostId, envelope(deps, link, messageId, { kind: 'reply', taskId: task.id, text: input.text }));
  } catch (err) {
    return { ok: false, error: `unavailable: the reply is stored here but could not be queued (${errText(err)})` };
  }
  return { ok: true, taskId: task.id };
}

/**
 * Queue a state change the local ledger ALREADY committed on a remote task.
 * The ledger is checked: a state the task is not in is refused, so this
 * cannot be used to tell the peer something that did not happen here.
 */
/** What `sendRemoteState` needs: the ledger read, the link gate and the outbox. */
export type StateDeps = Pick<OutboundDeps, 'linkStore' | 'outbox' | 'now' | 'mintId'> & {
  taskService: Pick<A2aTaskService, 'getTask'>;
};

export function sendRemoteState(deps: StateDeps, input: A2aRemoteStateInput): OutboundResult {
  const found = remoteTaskAndLink(deps, input.taskId);
  if (!found.ok) return found;
  const { task, link } = found;
  if (task.status.state !== input.state) {
    return { ok: false, error: `bad-request: task ${task.id} is ${task.status.state}, not ${input.state}` };
  }
  const check = deps.linkStore.checkMessage(link.linkId, link.version, link.remote.hostId, 'outbound', 'state', undefined, { onThisLink: true });
  if (!check.ok) return { ok: false, error: check.error };
  const summary = input.summary?.slice(0, 2000);
  try {
    deps.outbox.enqueue(
      link.remote.hostId,
      envelope(deps, link, mint(deps), { kind: 'state', taskId: task.id, state: input.state, ...(summary ? { text: summary } : {}) }),
    );
  } catch (err) {
    return { ok: false, error: `unavailable: could not queue the state (${errText(err)})` };
  }
  return { ok: true, taskId: task.id };
}

// --- helpers --------------------------------------------------------------------

function remoteTaskAndLink(
  deps: StateDeps,
  taskId: string,
): { ok: true; task: Task; link: A2aLinkRecordV1 } | { ok: false; error: string } {
  const task = deps.taskService.getTask(taskId);
  const marker = task?.metadata.remote as A2aRemoteTaskMarkerV1 | undefined;
  if (!task || !marker || marker.v !== 1) return { ok: false, error: 'unknown-task' };
  const link = deps.linkStore.get(marker.linkId);
  if (!link) return { ok: false, error: 'unknown-link' };
  return { ok: true, task, link };
}

function envelope(
  deps: Pick<OutboundDeps, 'now'>,
  link: A2aLinkRecordV1,
  messageId: string,
  body: Pick<A2aRemoteEnvelope, 'kind' | 'taskId' | 'text' | 'state'>,
): A2aRemoteEnvelope {
  return {
    protocol: A2A_REMOTE_PROTOCOL,
    linkId: link.linkId,
    linkVersion: link.version,
    messageId,
    ...body,
    sentAt: new Date((deps.now ?? Date.now)()).toISOString(),
  };
}

function textMessage(messageId: string, role: Message['role'], text: string): Message {
  return { kind: 'message', messageId, role, parts: [{ kind: 'text', text }] };
}

function bodyError(text: string): string | null {
  if (typeof text !== 'string' || text.length === 0) return 'bad-request: empty message';
  return Buffer.byteLength(text, 'utf8') > A2A_REMOTE_BODY_MAX ? 'too-large' : null;
}

function mint(deps: Pick<OutboundDeps, 'mintId'>): string {
  return (deps.mintId ?? ((): string => crypto.randomUUID()))();
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
