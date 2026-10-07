// @vitest-environment jsdom
//
// #1838: a clean shell exit closes its tab — behind a per-user setting, and
// never for a supervised (wmux.json `restart`) pane, whose exit is followed by
// a daemon restart under the same ptyId that closing would cancel.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createWorkspace, type PaneLeaf, type Surface } from '../../../shared/types';
import { useStore } from '../../stores';
import { useCloseTabOnShellExit } from '../useCloseTabOnShellExit';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let fireExit: (ptyId: string, exitCode: number) => void;
let listed: Array<Record<string, unknown>>;
const dispose = vi.fn();

function mount(): void {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  function Harness(): null {
    useCloseTabOnShellExit();
    return null;
  }
  act(() => {
    root.render(React.createElement(Harness));
  });
}

function seedWorkspace(): void {
  const ws = createWorkspace('Exit');
  const pane = ws.rootPane as PaneLeaf;
  const surfaces: Surface[] = ['one', 'two'].map((id) => ({
    id,
    ptyId: `pty-${id}`,
    title: id,
    shell: 'zsh',
    cwd: '/tmp',
    surfaceType: 'terminal',
  }));
  pane.surfaces = surfaces;
  pane.activeSurfaceId = surfaces[0].id;
  act(() => {
    useStore.setState((state) => {
      state.workspaces = [ws];
      state.activeWorkspaceId = ws.id;
    });
  });
}

function surfaceIds(): string[] {
  const ws = useStore.getState().workspaces[0];
  if (ws.rootPane.type !== 'leaf') throw new Error('expected leaf root');
  return ws.rootPane.surfaces.map((s) => s.id);
}

async function exit(ptyId: string, code: number): Promise<void> {
  await act(async () => {
    fireExit(ptyId, code);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  dispose.mockClear();
  listed = [];
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    pty: {
      dispose,
      list: vi.fn(async () => listed),
      onExit: (cb: (ptyId: string, exitCode: number) => void) => {
        fireExit = cb;
        return () => undefined;
      },
    },
  };
  seedWorkspace();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  act(() => {
    useStore.setState((state) => {
      state.closeTabOnShellExit = true;
      state.supervisionByPtyId = {};
    });
  });
});

describe('useCloseTabOnShellExit', () => {
  it('closes the tab on exit 0 when the setting is on', async () => {
    mount();
    await exit('pty-one', 0);
    expect(surfaceIds()).toEqual(['two']);
    expect(dispose).toHaveBeenCalledWith('pty-one');
  });

  it('keeps the tab on a non-zero exit', async () => {
    mount();
    await exit('pty-one', 1);
    expect(surfaceIds()).toEqual(['one', 'two']);
    expect(dispose).not.toHaveBeenCalled();
  });

  it('keeps the tab when the setting is off', async () => {
    act(() => {
      useStore.setState((state) => { state.closeTabOnShellExit = false; });
    });
    mount();
    await exit('pty-one', 0);
    expect(surfaceIds()).toEqual(['one', 'two']);
    expect(dispose).not.toHaveBeenCalled();
  });

  it('never closes a supervised pane on exit 0, even before the badge state has hydrated', async () => {
    // The renderer supervision slice is empty for a leaf created this session;
    // the daemon's session list is the authority.
    listed = [{ id: 'pty-one', supervision: { status: 'armed', restartCount: 0 } }];
    mount();
    await exit('pty-one', 0);
    expect(surfaceIds()).toEqual(['one', 'two']);
    expect(dispose).not.toHaveBeenCalled();
  });

  it('never closes a pane the supervision slice already marks as supervised', async () => {
    act(() => {
      useStore.setState((state) => {
        state.supervisionByPtyId = { 'pty-one': { status: 'armed', restartCount: 2 } };
      });
    });
    mount();
    await exit('pty-one', 0);
    expect(surfaceIds()).toEqual(['one', 'two']);
    expect(dispose).not.toHaveBeenCalled();
  });
});
