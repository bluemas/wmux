// @vitest-environment jsdom
//
// The close-tab shortcut asks before it kills the tab: a declined prompt
// leaves the tab and its PTY alone, an accepted one closes it as before.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useKeyboard } from '../useKeyboard';
import { useStore } from '../../stores';
import type { Workspace } from '../../../shared/types';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let dispose: ReturnType<typeof vi.fn>;

function pressCloseTab(): void {
  act(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ctrlKey: true, key: 'w', code: 'KeyW' }));
  });
}

function surfaceIds(): string[] {
  const ws = useStore.getState().workspaces.find((w) => w.id === 'ws-c');
  return ws && ws.rootPane.type === 'leaf' ? ws.rootPane.surfaces.map((s) => s.id) : [];
}

beforeEach(() => {
  dispose = vi.fn();
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    platform: 'win32',
    window: { hide: vi.fn() },
    pty: { dispose, create: vi.fn(), write: vi.fn() },
  };
  const ws: Workspace = {
    id: 'ws-c',
    name: 'close',
    activePaneId: 'p-c',
    rootPane: {
      id: 'p-c',
      type: 'leaf',
      activeSurfaceId: 's-2',
      surfaces: [
        { id: 's-1', ptyId: 'pty-1', title: 'one', shell: 'zsh', cwd: '/tmp', surfaceType: 'terminal' },
        { id: 's-2', ptyId: 'pty-2', title: 'two', shell: 'zsh', cwd: '/tmp', surfaceType: 'terminal' },
      ],
    },
  };
  act(() => {
    useStore.setState({ workspaces: [ws], activeWorkspaceId: 'ws-c' });
    useStore.getState().setPrefixMode(false);
    useStore.getState().setAppRoute('workspaces');
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  function Harness(): null {
    useKeyboard();
    return null;
  }
  act(() => root.render(React.createElement(Harness)));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

describe('close-tab shortcut confirmation', () => {
  it('keeps the tab and its PTY when the prompt is declined', () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    pressCloseTab();
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(dispose).not.toHaveBeenCalled();
    expect(surfaceIds()).toEqual(['s-1', 's-2']);
  });

  it('closes the tab when the prompt is accepted', () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    pressCloseTab();
    expect(dispose).toHaveBeenCalledWith('pty-2');
    expect(surfaceIds()).toEqual(['s-1']);
  });
});
