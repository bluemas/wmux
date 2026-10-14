import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DaemonClient } from '../../../DaemonClient';
import type { TerminalCoreRuntime } from '../../../../shared/terminalCoreSettings';
const h = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => Promise<unknown>>(),
  read: vi.fn(), write: vi.fn(), runtime: vi.fn(),
}));
vi.mock('electron', () => ({ ipcMain: {
  removeHandler: (key: string) => h.handlers.delete(key),
  handle: (key: string, fn: (...args: unknown[]) => Promise<unknown>) => h.handlers.set(key, fn),
} }));
vi.mock('../../../../shared/terminalCoreSettings', () => ({
  readTerminalEngine: h.read, writeTerminalEngine: h.write, terminalCoreRuntime: h.runtime, terminalCoreStopCommand: () => "wmux daemon stop",
}));
import { registerTerminalCoreHandlers } from '../terminalCore.handler';
import { IPC } from '../../../../shared/constants';
const node: TerminalCoreRuntime = { requested: 'node', effective: 'node', rustAvailable: true, environmentOverride: false };
const invoke = (key: string, value?: unknown) => {
  const handler = h.handlers.get(key);
  if (!handler) throw new Error('Missing handler');
  return handler(null, value);
};
beforeEach(() => { vi.clearAllMocks(); h.read.mockReturnValue('node'); h.runtime.mockReturnValue(node); });

describe('terminal engine settings IPC', () => {
  it('saves without switching the live host and clears pending on reversal', async () => {
    registerTerminalCoreHandlers();
    expect(await invoke(IPC.TERMINAL_CORE_SETTINGS_SET, 'rust')).toMatchObject({ selected: 'rust', runtime: node, restartRequired: true });
    expect(h.write).toHaveBeenCalledWith('rust');
    expect(await invoke(IPC.TERMINAL_CORE_SETTINGS_SET, 'node')).toMatchObject({ restartRequired: false });
  });
  it('reports the daemon engine rather than the app engine', async () => {
    const rpc = vi.fn().mockResolvedValue({ terminalCore: { ...node, requested: 'rust', effective: 'rust' } });
    const cleanup = registerTerminalCoreHandlers({ rpc } as unknown as DaemonClient);
    expect(await invoke(IPC.TERMINAL_CORE_SETTINGS_GET)).toMatchObject({ host: 'daemon', runtime: { effective: 'rust' }, restartRequired: true });
    expect(rpc).toHaveBeenCalledWith('daemon.ping', { includeTerminalCore: true });
    cleanup(); expect(h.handlers.size).toBe(0);
  });
  it('does not guess the backend of an old or disconnected daemon', async () => {
    const rpc = vi.fn().mockResolvedValue({ status: 'ok' });
    registerTerminalCoreHandlers({ rpc } as unknown as DaemonClient);
    expect(await invoke(IPC.TERMINAL_CORE_SETTINGS_GET)).toMatchObject({ runtime: null });
    rpc.mockRejectedValue(new Error('offline'));
    expect(await invoke(IPC.TERMINAL_CORE_SETTINGS_GET)).toMatchObject({ runtime: null });
  });
  it('rejects invalid, missing-native and overridden choices without writing', async () => {
    registerTerminalCoreHandlers();
    await expect(invoke(IPC.TERMINAL_CORE_SETTINGS_SET, 'typo')).rejects.toThrow('Invalid');
    h.runtime.mockReturnValue({ ...node, rustAvailable: false });
    await expect(invoke(IPC.TERMINAL_CORE_SETTINGS_SET, 'rust')).rejects.toThrow('unavailable');
    h.runtime.mockReturnValue({ ...node, environmentOverride: true });
    await expect(invoke(IPC.TERMINAL_CORE_SETTINGS_SET, 'node')).rejects.toThrow('overrides');
    expect(h.write).not.toHaveBeenCalled();
  });
});
