// @vitest-environment jsdom
//
// A pane in a hidden workspace must not resize its PTY. Under display:none the
// container's computed width/height read back as the declared "100%", which
// FitAddon parses as 100px and turns into a ~11x5 proposal that clears the
// geometry floor. On app start every pane reattaches to the daemon, so every
// background pane's PTY was shrunk to that size, and an agent resumed there
// (Claude Code on its alternate screen) drew a 10-column frame that later
// left stale rows on reveal. The mount-time resize likewise sent xterm's
// unfitted 80x24 default.
// Mounts the REAL useTerminal against a real xterm under jsdom.

import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { act, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { FitAddon } from '@xterm/addon-fit';
import { setDaemonModeActive } from '../../daemon/daemonMode';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// No WebGL under jsdom: the hook's own fallback (DOM renderer) takes over.
vi.mock('@xterm/addon-webgl', () => ({
  WebglAddon: class { constructor() { throw new Error('no WebGL in jsdom'); } },
}));

const resize = vi.fn(async () => undefined);
const reconnect = vi.fn(async () => ({ success: true }));
const unsub = () => () => undefined;
// Laid-out size of every element; 0 models a display:none workspace.
let layoutSize = 0;

beforeAll(() => {
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      platform: 'linux',
      windowsBuildNumber: null,
      pty: {
        onData: unsub, onExit: unsub, onFlushComplete: unsub, onRestarted: unsub,
        resize, reconnect,
        setViewerVisibility: vi.fn(),
        write: vi.fn(async () => undefined),
        list: vi.fn(async () => []),
      },
      daemon: { onConnected: unsub },
      shell: { openPath: vi.fn(async () => ({ ok: true })) },
    },
  });
  Object.defineProperty(window, 'clipboardAPI', {
    configurable: true,
    value: { writeText: vi.fn(async () => undefined), readText: vi.fn(async () => '') },
  });
  window.matchMedia ??= ((q: string) => ({
    matches: false, media: q, onchange: null,
    addEventListener: () => undefined, removeEventListener: () => undefined,
    addListener: () => undefined, removeListener: () => undefined, dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
  globalThis.ResizeObserver ??= class { observe() { /* inert */ } unobserve() { /* inert */ } disconnect() { /* inert */ } } as unknown as typeof ResizeObserver;
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => layoutSize });
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => layoutSize });
  (document as unknown as { fonts: unknown }).fonts ??= {
    ready: Promise.resolve(),
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
});

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  resize.mockClear();
  reconnect.mockClear();
  setDaemonModeActive(false);
});

async function mount(ptyId: string, visible: boolean) {
  const { useTerminal } = await import('../useTerminal');
  function Harness() {
    const ref = useRef<HTMLDivElement>(null);
    useTerminal(ref, { ptyId, isVisible: visible });
    return <div ref={ref} style={{ width: '100%', height: '100%' }} />;
  }
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(<Harness />); });
  await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
}

// The first case pays for importing the whole hook under jsdom.
describe('useTerminal geometry of a hidden pane', { timeout: 60_000 }, () => {
  it('sends no PTY size from a hidden container on mount or daemon reattach', async () => {
    // What FitAddon proposes from a display:none container ("100%" -> 100px).
    const propose = vi.spyOn(FitAddon.prototype, 'proposeDimensions').mockReturnValue({ cols: 11, rows: 5 });
    try {
      layoutSize = 0;
      setDaemonModeActive(true);
      await mount('p-hidden', false);
      expect(reconnect).toHaveBeenCalledWith('p-hidden');
      expect(resize.mock.calls).toEqual([]);
    } finally {
      propose.mockRestore();
    }
  });

  it('a laid-out pane still sends its fitted size on reattach', async () => {
    const propose = vi.spyOn(FitAddon.prototype, 'proposeDimensions').mockReturnValue({ cols: 90, rows: 20 });
    try {
      layoutSize = 800;
      setDaemonModeActive(true);
      await mount('p-shown', true);
      expect(reconnect).toHaveBeenCalledWith('p-shown');
      expect(resize).toHaveBeenCalledWith('p-shown', 90, 20);
    } finally {
      propose.mockRestore();
    }
  });
});
