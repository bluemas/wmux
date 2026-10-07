import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { A2aRemoteTaskMarkerV1 } from '../../../shared/a2aRemote';
import type { A2aRemoteDeliveryResult } from '../../../shared/a2aRemoteDelivery';
import type { Task } from '../../../shared/types';
import { REMOTE_BRIDGE_RETRY_MIN_MS, RemoteA2aBridge } from '../RemoteA2aBridge';

const LINK = '11111111-1111-4111-8111-111111111111';
const HOST = '22222222-2222-4222-8222-222222222222';
const id = (n: number): string => `rt-${String(n).padStart(32, '0')}`;

function remoteTask(n: number): Task {
  const marker: A2aRemoteTaskMarkerV1 = { v: 1, linkId: LINK, hostId: HOST, messageId: `m${n}`, direction: 'inbound', delivered: false };
  return {
    kind: 'task',
    id: id(n),
    status: { state: 'submitted', timestamp: '2026-10-07T00:00:00.000Z' },
    history: [{ kind: 'message', messageId: `m${n}`, role: 'user', parts: [{ kind: 'text', text: `body ${n}` }] }],
    artifacts: [],
    metadata: {
      title: `t${n}`,
      from: { workspaceId: `remote:${LINK}`, name: 'pc-a/ws/claude' },
      to: { workspaceId: 'ws-b', name: 'B', paneId: 'pane-b' },
      createdAt: '2026-10-07T00:00:00.000Z',
      updatedAt: '2026-10-07T00:00:00.000Z',
      remote: marker,
    },
  };
}

/** The daemon side: its ledger, listRemotePending and remote.mark. */
class FakeDaemon {
  tasks = new Map<string, Task>();
  marks: Array<Record<string, unknown>> = [];
  failMarks = 0;
  async rpc(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (method === 'a2a.remote.pending') {
      return { tasks: [...this.tasks.values()].filter((t) => (t.metadata.remote as A2aRemoteTaskMarkerV1).delivered !== true).map((t) => structuredClone(t)) };
    }
    if (method === 'a2a.remote.mark') {
      if (this.failMarks > 0) {
        this.failMarks -= 1;
        throw new Error('pipe closed');
      }
      this.marks.push(params);
      const marker = this.tasks.get(params.taskId as string)!.metadata.remote as A2aRemoteTaskMarkerV1;
      if (params.delivered === true) {
        marker.delivered = true;
        delete marker.held;
      } else marker.held = params.held as A2aRemoteTaskMarkerV1['held'];
      return { ok: true };
    }
    throw new Error(`unexpected ${method}`);
  }
}

let daemon: FakeDaemon;
let renderer: ReturnType<typeof vi.fn<(m: string, p: Record<string, unknown>) => Promise<unknown>>>;
let answer: (p: Record<string, unknown>) => A2aRemoteDeliveryResult | Promise<A2aRemoteDeliveryResult>;
let listener: ((e: { type?: unknown; [key: string]: unknown }) => void) | null;
let bridge: RemoteA2aBridge;

beforeEach(() => {
  vi.useFakeTimers();
  daemon = new FakeDaemon();
  answer = () => ({ ok: true, delivered: true });
  renderer = vi.fn(async (_m: string, p: Record<string, unknown>) => answer(p));
  listener = null;
  bridge = new RemoteA2aBridge({
    daemonRpc: (m, p) => daemon.rpc(m, p),
    sendToRenderer: (m, p) => renderer(m, p),
    onDaemonEvent: (l) => {
      listener = l;
      return () => { listener = null; };
    },
  });
});
afterEach(() => {
  bridge.stop();
  vi.useRealTimers();
});

const settle = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(0);
};

describe('RemoteA2aBridge', () => {
  it('hands the task to the renderer as a gated, message-only remote send', async () => {
    daemon.tasks.set(id(1), remoteTask(1));
    bridge.start();
    await settle();
    expect(renderer).toHaveBeenCalledTimes(1);
    const [method, params] = renderer.mock.calls[0];
    expect(method).toBe('a2a.task.send');
    expect(params).toMatchObject({
      to: 'ws-b',
      paneId: 'pane-b',
      message: 'body 1',
      presetTaskId: id(1),
      remoteFrom: { workspaceId: `remote:${LINK}`, name: 'pc-a/ws/claude' },
      remoteMarker: { linkId: LINK, direction: 'inbound' },
      gatedDelivery: true,
      execute: false,
    });
    expect(typeof params.deliveryDeadlineAt).toBe('number');
    expect(params).not.toHaveProperty('operatorOrigin');
    expect(daemon.marks).toEqual([{ taskId: id(1), delivered: true }]);
  });

  it('a task whose broadcast was lost is picked up by the backstop', async () => {
    bridge.start();
    await settle();
    daemon.tasks.set(id(2), remoteTask(2)); // no broadcast
    expect(renderer).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(renderer).toHaveBeenCalledTimes(1);
    expect(daemon.marks).toEqual([{ taskId: id(2), delivered: true }]);
  });

  it('the broadcast triggers a pull at once', async () => {
    bridge.start();
    await settle();
    daemon.tasks.set(id(3), remoteTask(3));
    listener?.({ type: 'a2a.remote.inbound', taskId: id(3) });
    await settle();
    expect(renderer).toHaveBeenCalledTimes(1);
  });

  it('delivers exactly once across overlapping triggers and later pulls', async () => {
    daemon.tasks.set(id(4), remoteTask(4));
    let release!: () => void;
    answer = () => new Promise((r) => { release = () => r({ ok: true, delivered: true }); });
    bridge.start();
    await settle();
    listener?.({ type: 'a2a.remote.inbound' });
    bridge.onConnected();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(renderer).toHaveBeenCalledTimes(1);
    release();
    await settle();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(renderer).toHaveBeenCalledTimes(1);
    expect(daemon.marks).toEqual([{ taskId: id(4), delivered: true }]);
  });

  it('a lost delivered-mark is retried without handing the task over again', async () => {
    daemon.tasks.set(id(5), remoteTask(5));
    daemon.failMarks = 1;
    bridge.start();
    await settle();
    expect(daemon.marks).toEqual([]);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(renderer).toHaveBeenCalledTimes(1);
    expect(daemon.marks).toEqual([{ taskId: id(5), delivered: true }]);
  });

  it('records a hold; pane-missing is retried later, occupant-changed never', async () => {
    daemon.tasks.set(id(6), remoteTask(6));
    daemon.tasks.set(id(7), remoteTask(7));
    answer = (p) => ({ ok: true, delivered: false, held: p.presetTaskId === id(6) ? 'pane-missing' : 'occupant-changed' });
    bridge.start();
    await settle();
    expect(daemon.marks).toEqual([
      { taskId: id(6), held: 'pane-missing' },
      { taskId: id(7), held: 'occupant-changed' },
    ]);
    answer = () => ({ ok: true, delivered: true });
    await vi.advanceTimersByTimeAsync(REMOTE_BRIDGE_RETRY_MIN_MS + 5_000);
    expect(renderer.mock.calls.map(([, p]) => p.presetTaskId)).toEqual([id(6), id(7), id(6)]);
    expect(daemon.marks.at(-1)).toEqual({ taskId: id(6), delivered: true });
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(renderer.mock.calls.filter(([, p]) => p.presetTaskId === id(7))).toHaveLength(1);
  });

  it('a same-reason hold is not marked twice, and a transient miss backs off', async () => {
    daemon.tasks.set(id(8), remoteTask(8));
    answer = () => ({ ok: true, delivered: false, held: 'pane-missing' });
    bridge.start();
    await settle();
    await vi.advanceTimersByTimeAsync(REMOTE_BRIDGE_RETRY_MIN_MS + 5_000);
    expect(renderer).toHaveBeenCalledTimes(2);
    expect(daemon.marks).toEqual([{ taskId: id(8), held: 'pane-missing' }]);
  });

  it('ignores other daemon events and stops cleanly', async () => {
    bridge.start();
    await settle();
    daemon.tasks.set(id(9), remoteTask(9));
    listener?.({ type: 'lanlink.remote.received' });
    await settle();
    expect(renderer).not.toHaveBeenCalled();
    bridge.stop();
    expect(listener).toBeNull();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(renderer).not.toHaveBeenCalled();
  });
});
