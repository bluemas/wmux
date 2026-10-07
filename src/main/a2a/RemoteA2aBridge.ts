import { isRemoteTaskId, type A2aRemoteTaskMarkerV1 } from '../../shared/a2aRemote';
import {
  A2A_REMOTE_INBOUND_EVENT,
  A2A_REMOTE_RPC,
  type A2aRemoteDeliveryResult,
  type A2aRemoteHeldReason,
} from '../../shared/a2aRemoteDelivery';
import { GATED_DELIVERY_DEADLINE_MARGIN_MS, GATED_NEW_TASK_SEND_MAIN_TIMEOUT_MS } from '../../shared/freshContext';
import type { Task } from '../../shared/types';

/**
 * Cross-host A2A, receiving side in main: hand every inbound remote task the
 * daemon holds (undelivered) to the renderer for the gated delivery into its
 * linked pane, then record the outcome in the daemon ledger.
 *
 * Triggers: the daemon's `a2a.remote.inbound` broadcast, (re)connection to the
 * daemon, and a periodic backstop — so a lost broadcast only delays a task by
 * one backstop period. Each trigger PULLS `listRemotePending`; the broadcast
 * carries no payload this code trusts.
 *
 * At most one delivery per task is in flight, a task the renderer delivered is
 * marked before it can be handed over again (and the renderer itself answers
 * `duplicate` for a task it already delivered), and a task held as
 * `occupant-changed` is never retried automatically: the pane now holds a
 * different agent than the one the task was aimed at.
 *
 * This is a main-internal call straight to the renderer, NOT through the pipe
 * router: no operator origin is stamped, so the renderer's approval gate and
 * quiet hold apply. LanLink's RemoteInboxBridge is deliberately not reused —
 * it avoids the A2A path on purpose.
 */

export const REMOTE_BRIDGE_BACKSTOP_MS = 5_000;
/** Retry delay after a delivery that did not land (doubles up to the max). */
export const REMOTE_BRIDGE_RETRY_MIN_MS = 10_000;
export const REMOTE_BRIDGE_RETRY_MAX_MS = 5 * 60_000;

export interface RemoteA2aBridgeDeps {
  /** Daemon RPC (DaemonClient.rpc in the wiring step). */
  daemonRpc: (method: string, params: Record<string, unknown>) => Promise<unknown>;
  /** The renderer bridge (`sendToRenderer(getWindow, …)`). */
  sendToRenderer: (method: string, params: Record<string, unknown>, opts?: { timeoutMs?: number }) => Promise<unknown>;
  /** Subscribe to daemon broadcasts; returns an unsubscribe. */
  onDaemonEvent: (listener: (event: { type?: unknown; [key: string]: unknown }) => void) => () => void;
  backstopMs?: number;
  now?: () => number;
  log?: (level: 'info' | 'warn', msg: string) => void;
}

type Mark = { delivered: true } | { held: A2aRemoteHeldReason };

export class RemoteA2aBridge {
  private readonly deps: RemoteA2aBridgeDeps;
  private readonly now: () => number;
  private readonly inFlight = new Set<string>();
  /** A mark the daemon did not take yet: retried before anything else, never re-delivered. */
  private readonly pendingMarks = new Map<string, Mark>();
  private readonly retry = new Map<string, { at: number; delayMs: number }>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private unsubscribe: (() => void) | null = null;
  private running: Promise<void> | null = null;
  private rerun = false;

  constructor(deps: RemoteA2aBridgeDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
  }

  start(): void {
    if (this.timer) return;
    this.unsubscribe = this.deps.onDaemonEvent((event) => {
      if (event?.type === A2A_REMOTE_INBOUND_EVENT) void this.trigger();
    });
    this.timer = setInterval(() => void this.trigger(), this.deps.backstopMs ?? REMOTE_BRIDGE_BACKSTOP_MS);
    void this.trigger();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  /** The daemon connection (re)opened: pull at once. */
  onConnected(): void {
    void this.trigger();
  }

  /** Pull and hand over. Concurrent triggers coalesce into one follow-up pull. */
  trigger(): Promise<void> {
    if (this.running) {
      this.rerun = true;
      return this.running;
    }
    this.running = (async () => {
      do {
        this.rerun = false;
        await this.pullOnce();
      } while (this.rerun);
    })().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  /** Test/diagnostic view: ids with a delivery in flight. */
  get inFlightIds(): string[] {
    return [...this.inFlight];
  }

  private async pullOnce(): Promise<void> {
    let res: unknown;
    try {
      res = await this.deps.daemonRpc(A2A_REMOTE_RPC.pending, {});
    } catch {
      return; // daemon down: the next trigger retries
    }
    const tasks = isRecord(res) && Array.isArray(res.tasks) ? (res.tasks as Task[]) : [];
    // Forget state for tasks the daemon no longer lists (delivered, ended).
    const listed = new Set(tasks.map((t) => t?.id));
    for (const id of this.retry.keys()) if (!listed.has(id)) this.retry.delete(id);
    for (const id of this.pendingMarks.keys()) if (!listed.has(id)) this.pendingMarks.delete(id);
    for (const task of tasks) {
      if (!task || typeof task.id !== 'string' || !isRemoteTaskId(task.id)) continue;
      if (this.inFlight.has(task.id)) continue;
      const pendingMark = this.pendingMarks.get(task.id);
      if (pendingMark) {
        void this.mark(task.id, pendingMark);
        continue;
      }
      const marker = task.metadata?.remote as A2aRemoteTaskMarkerV1 | undefined;
      if (!marker || marker.direction !== 'inbound' || marker.delivered === true) continue;
      if (marker.held === 'occupant-changed') continue;
      const wait = this.retry.get(task.id);
      if (wait && wait.at > this.now()) continue;
      this.inFlight.add(task.id);
      void this.deliver(task, marker).finally(() => this.inFlight.delete(task.id));
    }
  }

  private async deliver(task: Task, marker: A2aRemoteTaskMarkerV1): Promise<void> {
    const first = task.history[0]?.parts.find((p) => p.kind === 'text');
    const message = first && first.kind === 'text' ? first.text : '';
    let res: unknown;
    try {
      res = await this.deps.sendToRenderer(
        'a2a.task.send',
        {
          workspaceId: task.metadata.to.workspaceId,
          to: task.metadata.to.workspaceId,
          ...(task.metadata.to.paneId ? { paneId: task.metadata.to.paneId } : {}),
          title: task.metadata.title,
          message,
          presetTaskId: task.id,
          remoteFrom: { workspaceId: task.metadata.from.workspaceId, name: task.metadata.from.name },
          remoteMarker: marker,
          gatedDelivery: true,
          execute: false,
          // Stamped here because this call skips the router, which stamps it
          // for every other gated new task: nothing is written after it.
          deliveryDeadlineAt: this.now() + GATED_NEW_TASK_SEND_MAIN_TIMEOUT_MS - GATED_DELIVERY_DEADLINE_MARGIN_MS,
        },
        { timeoutMs: GATED_NEW_TASK_SEND_MAIN_TIMEOUT_MS },
      );
    } catch (err) {
      this.backoff(task.id);
      this.deps.log?.('warn', `[a2a-remote] delivery of ${task.id} failed: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    const result = res as A2aRemoteDeliveryResult;
    if (isRecord(result) && result.ok === true && result.delivered === true) {
      this.retry.delete(task.id);
      await this.mark(task.id, { delivered: true });
      return;
    }
    this.backoff(task.id);
    if (isRecord(result) && result.ok === true && result.delivered === false && result.held) {
      if (marker.held !== result.held) await this.mark(task.id, { held: result.held });
      return;
    }
    if (isRecord(result) && 'error' in result && typeof result.error === 'string') {
      this.deps.log?.('warn', `[a2a-remote] renderer refused ${task.id}: ${result.error}`);
    }
  }

  private async mark(taskId: string, mark: Mark): Promise<void> {
    this.pendingMarks.set(taskId, mark);
    try {
      const res = await this.deps.daemonRpc(A2A_REMOTE_RPC.mark, { taskId, ...mark });
      if (isRecord(res) && res.ok === true) {
        this.pendingMarks.delete(taskId);
        if ('delivered' in mark) this.retry.delete(taskId);
        return;
      }
      // A refusal (e.g. the task ended meanwhile) will not change on retry.
      if (isRecord(res) && typeof res.error === 'string') this.pendingMarks.delete(taskId);
    } catch {
      // daemon unreachable: kept in pendingMarks, retried on the next pull
    }
  }

  private backoff(taskId: string): void {
    const prev = this.retry.get(taskId);
    const delayMs = prev ? Math.min(prev.delayMs * 2, REMOTE_BRIDGE_RETRY_MAX_MS) : REMOTE_BRIDGE_RETRY_MIN_MS;
    this.retry.set(taskId, { at: this.now() + delayMs, delayMs });
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}
