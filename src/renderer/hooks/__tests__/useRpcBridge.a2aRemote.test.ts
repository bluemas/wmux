// @vitest-environment jsdom
//
// Cross-host A2A: main's RemoteA2aBridge hands a task another host sent to the
// renderer with `remoteMarker` / `remoteFrom`. It must land on exactly the
// link's pane, through the gated delivery, and HOLD (never re-route) when that
// pane is gone or another pty holds it now.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaneBranch, PaneLeaf, Surface, Workspace } from '../../../shared/types';
import { useStore } from '../../stores';
import { handleRpcMethod } from '../useRpcBridge';

const LINK = '11111111-1111-4111-8111-111111111111';
const HOST = '22222222-2222-4222-8222-222222222222';
const RT = `rt-${'a'.repeat(32)}`;
const PINNED_PTY = 'pty-pinned';
const SIBLING_PTY = 'pty-sibling';
const BODY = 'please review the diff';

function leaf(id: string, ptyId: string): PaneLeaf {
  const surface = { id: `surf-${id}`, ptyId, title: id, shell: '', cwd: '', surfaceType: 'terminal' } as Surface;
  return { id, type: 'leaf', surfaces: [surface], activeSurfaceId: surface.id };
}

function target(pinnedPty = PINNED_PTY, withPinned = true): Workspace {
  const children = [leaf('pane-sibling', SIBLING_PTY), ...(withPinned ? [leaf('pane-pinned', pinnedPty)] : [])];
  return {
    id: 'ws-target',
    name: 'Target',
    rootPane: { id: 'branch', type: 'branch', direction: 'horizontal', children } as PaneBranch,
    activePaneId: 'pane-sibling',
  } as Workspace;
}

const MARKER = { v: 1, linkId: LINK, hostId: HOST, messageId: 'msg-1', direction: 'inbound', delivered: false };

function remoteParams(o: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    workspaceId: 'ws-target',
    to: 'ws-target',
    paneId: 'pane-pinned',
    message: BODY,
    title: 'review',
    presetTaskId: RT,
    remoteFrom: { workspaceId: `remote:${LINK}`, name: 'pc-a/ws-a/claude' },
    remoteMarker: MARKER,
    gatedDelivery: true,
    execute: false,
    ...o,
  };
}

type Result = { ok?: boolean; delivered?: boolean; held?: string; reason?: string; duplicate?: boolean; error?: string; taskId?: string };

const send = async (o: Record<string, unknown> = {}): Promise<Result> =>
  (await handleRpcMethod('a2a.task.send', remoteParams(o))) as Result;

let gate: ReturnType<typeof vi.fn>;
let refusal: Record<string, unknown> | null;
let written: string[];
let onGate: (() => void) | null;

beforeEach(() => {
  vi.useFakeTimers();
  refusal = null;
  written = [];
  onGate = null;
  gate = vi.fn(async (ptyId: string) => {
    onGate?.();
    if (refusal) return refusal;
    written.push(ptyId);
    return { ok: true };
  });
  (window as unknown as { electronAPI: unknown }).electronAPI = { pty: { write: vi.fn() }, rpc: { gatedSubmit: gate } };
  const s = useStore.getState();
  // Both panes run a detected agent: a sibling fallback would have somewhere to go.
  for (const p of [PINNED_PTY, SIBLING_PTY, 'pty-new']) s.setSurfaceAgent(p, 'Claude Code', 'waiting', 'claude');
  s.hydrateAgentAlive({});
  s.hydrateCommandRunning({});
  useStore.setState({ workspaces: [target()], a2aTasks: {}, paneGate: 'ready' });
});

afterEach(() => {
  for (const p of [PINNED_PTY, SIBLING_PTY, 'pty-new']) useStore.getState().clearSurfaceAgent(p);
  vi.useRealTimers();
});

describe('remote task delivery', () => {
  it('lands on the pinned pane through the gated delivery and records the snapshot', async () => {
    const r = await send();
    expect(r).toEqual({ ok: true, delivered: true });
    expect(written).toEqual([PINNED_PTY]);
    // A live agent gets the one-line pointer naming the task, never a sibling pane.
    expect(gate).toHaveBeenCalledWith(PINNED_PTY, expect.stringContaining(RT), 'Claude Code', expect.objectContaining({ waitQuiet: true, newTask: true, taskId: RT, expectAgent: 'Claude Code' }));
    const task = useStore.getState().getTask(RT)!;
    expect(task.metadata.from).toEqual({ workspaceId: `remote:${LINK}`, name: 'pc-a/ws-a/claude' });
    expect(task.metadata.to).toMatchObject({ workspaceId: 'ws-target', paneId: 'pane-pinned', ptyId: PINNED_PTY });
    expect(task.metadata.remote).toMatchObject({ linkId: LINK, delivered: true });
    expect(task.history[0]).toMatchObject({ messageId: 'msg-1', role: 'user' });
  });

  it('a second trigger for a delivered task writes nothing', async () => {
    await send();
    expect(await send()).toEqual({ ok: true, delivered: true, duplicate: true });
    expect(written).toEqual([PINNED_PTY]);
  });

  it('a missing pane is held, stores nothing, and never falls back to the sibling agent', async () => {
    useStore.setState({ workspaces: [target(PINNED_PTY, false)] });
    expect(await send()).toEqual({ ok: true, delivered: false, held: 'pane-missing' });
    expect(gate).not.toHaveBeenCalled();
    expect(useStore.getState().getTask(RT)).toBeUndefined();
  });

  it('a retry after the pane got a new pty is held as occupant-changed', async () => {
    refusal = { ok: false, reason: 'approval_pending', detail: 'approval' };
    expect(await send()).toEqual({ ok: true, delivered: false, reason: 'approval_pending' });
    useStore.setState({ workspaces: [target('pty-new')] });
    refusal = null;
    expect(await send()).toEqual({ ok: true, delivered: false, held: 'occupant-changed' });
    expect(gate).toHaveBeenCalledTimes(1);
    expect(written).toEqual([]);
  });

  it('an occupant change during the quiet wait is held as occupant-changed', async () => {
    refusal = { ok: false, reason: 'write_failed', detail: 'pty gone' };
    onGate = () => useStore.setState({ workspaces: [target('pty-new')] });
    expect(await send()).toEqual({ ok: true, delivered: false, held: 'occupant-changed' });
    expect(written).toEqual([]);
  });

  it('a retry after a transient refusal delivers to the snapshotted pty', async () => {
    refusal = { ok: false, reason: 'user_typing', detail: 'typing' };
    await send();
    refusal = null;
    expect(await send()).toEqual({ ok: true, delivered: true });
    expect(written).toEqual([PINNED_PTY]);
  });

  it('a paste left in the composer is not pasted again', async () => {
    refusal = { ok: false, reason: 'approval_pending', detail: 'x', pasted: true, cleared: false };
    await send();
    refusal = null;
    expect(await send()).toEqual({ ok: true, delivered: false, reason: 'pasted_not_submitted' });
    expect(gate).toHaveBeenCalledTimes(1);
  });

  it('refuses a sender that is not the link remote workspace, and an id without rt- shape', async () => {
    expect((await send({ remoteFrom: { workspaceId: 'ws-target', name: 'x' } })).error).toBeDefined();
    expect((await send({ remoteFrom: { workspaceId: 'remote:other', name: 'x' } })).error).toBeDefined();
    expect((await send({ presetTaskId: 'task-123' })).error).toBeDefined();
    expect(gate).not.toHaveBeenCalled();
  });
});

describe('local sends keep their behaviour', () => {
  it('an rt- presetTaskId without a remote marker is not used as the task id', async () => {
    useStore.setState({
      workspaces: [target(), { id: 'ws-sender', name: 'Sender', rootPane: leaf('pane-s', 'pty-s'), activePaneId: 'pane-s' } as Workspace],
    });
    const r = (await handleRpcMethod('a2a.task.send', {
      workspaceId: 'ws-sender',
      to: 'ws-target',
      paneId: 'pane-pinned',
      message: BODY,
      presetTaskId: RT,
      operatorOrigin: true,
    })) as Result;
    expect(r.ok).toBe(true);
    expect(r.taskId).not.toBe(RT);
    expect(r.taskId).toMatch(/^task-/);
  });
});
