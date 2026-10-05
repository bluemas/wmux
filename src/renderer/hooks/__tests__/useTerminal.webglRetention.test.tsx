// @vitest-environment jsdom
//
// A hidden terminal keeps its WebGL context. Rebuilding the renderer on reveal
// (context + synchronous shader compile, ~225 ms per terminal measured) runs
// inside the workspace switch's input task, so a pane hidden longer than the
// old 5 s release timer painted only after it. Hiding must not dispose the
// addon, and revealing must not build a second one.
// Mounts the REAL useTerminal against a real xterm under jsdom, with a stub
// WebGL addon that counts constructions and disposals.

import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { act, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const webgl = vi.hoisted(() => ({ created: 0, disposed: 0 }));
vi.mock('@xterm/addon-webgl', () => ({
  WebglAddon: class {
    constructor() { webgl.created += 1; }
    activate() { /* stub: xterm keeps its DOM renderer */ }
    onContextLoss() { return { dispose: () => undefined }; }
    dispose() { webgl.disposed += 1; }
  },
}));

const unsub = () => () => undefined;

beforeAll(() => {
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      platform: 'linux',
      windowsBuildNumber: null,
      pty: {
        onData: unsub, onExit: unsub, onFlushComplete: unsub, onRestarted: unsub,
        resize: vi.fn(async () => undefined),
        setViewerVisibility: vi.fn(),
        write: vi.fn(async () => undefined),
        list: vi.fn(async () => []),
        reconnect: vi.fn(async () => ({ success: true })),
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
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => 800 });
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => 600 });
  (document as unknown as { fonts: unknown }).fonts ??= {
    ready: Promise.resolve(),
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
});

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(() => {
  vi.useRealTimers();
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

// The first case pays for importing the whole hook under jsdom.
describe('useTerminal WebGL retention', { timeout: 60_000 }, () => {
  it('keeps the WebGL addon across a long hide and reuses it on reveal', async () => {
    const { useTerminal } = await import('../useTerminal');
    function Harness({ visible }: { visible: boolean }) {
      const ref = useRef<HTMLDivElement>(null);
      useTerminal(ref, { ptyId: 'p-webgl', isVisible: visible });
      return <div ref={ref} style={{ width: 800, height: 600 }} />;
    }
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => { root!.render(<Harness visible />); });
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
    // Mount builds the addon, then fonts.ready rebuilds it once for the atlas.
    // Count from that settled state.
    const created = webgl.created;
    const disposed = webgl.disposed;
    expect(created).toBeGreaterThan(0);

    // Hidden far longer than any grace period a release timer could use.
    vi.useFakeTimers();
    await act(async () => { root!.render(<Harness visible={false} />); });
    await act(async () => { vi.advanceTimersByTime(60_000); });
    expect(webgl.disposed).toBe(disposed);
    vi.useRealTimers();

    await act(async () => { root!.render(<Harness visible />); });
    expect(webgl.created).toBe(created);
    expect(webgl.disposed).toBe(disposed);

    // Unmount still gives the context back.
    act(() => root!.unmount());
    root = null;
    expect(webgl.disposed).toBe(disposed + 1);
  });
});
