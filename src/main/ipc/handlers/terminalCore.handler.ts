import { ipcMain } from 'electron';
import { IPC } from '../../../shared/constants';
import {
  readTerminalEngine, writeTerminalEngine, terminalCoreRuntime, terminalCoreStopCommand,
  type TerminalCoreRuntime, type TerminalCoreSettings,
} from '../../../shared/terminalCoreSettings';
import type { DaemonClient } from '../../DaemonClient';
import { wrapHandler } from '../wrapHandler';

export function registerTerminalCoreHandlers(daemonClient?: DaemonClient): () => void {
  const status = async (): Promise<TerminalCoreSettings> => {
    const local = terminalCoreRuntime();
    let runtime: TerminalCoreRuntime | null = local;
    if (daemonClient) {
      try {
        const ping = await daemonClient.rpc('daemon.ping', { includeTerminalCore: true }) as {
          terminalCore?: TerminalCoreRuntime;
        };
        // Older daemons do not report their backend. Never guess from main's env.
        runtime = ping.terminalCore ?? null;
      } catch {
        runtime = null;
      }
    }
    const selected = readTerminalEngine();
    return {
      selected, runtime,
      rustAvailable: local.rustAvailable && (runtime?.rustAvailable ?? true),
      environmentOverride: local.environmentOverride || (runtime?.environmentOverride ?? false),
      restartRequired: runtime === null || selected !== runtime.requested,
      host: daemonClient ? 'daemon' : 'app',
      stopCommand: terminalCoreStopCommand(),
    };
  };
  ipcMain.removeHandler(IPC.TERMINAL_CORE_SETTINGS_GET);
  ipcMain.removeHandler(IPC.TERMINAL_CORE_SETTINGS_SET);
  ipcMain.handle(IPC.TERMINAL_CORE_SETTINGS_GET, wrapHandler(IPC.TERMINAL_CORE_SETTINGS_GET, status));
  ipcMain.handle(IPC.TERMINAL_CORE_SETTINGS_SET, wrapHandler(IPC.TERMINAL_CORE_SETTINGS_SET, async (_event, engine: unknown) => {
    if (engine !== 'node' && engine !== 'rust') throw new Error('Invalid terminal engine');
    const current = await status();
    if (current.environmentOverride) throw new Error('WMUX_TERMINAL_CORE overrides the saved terminal engine');
    if (engine === 'rust' && !current.rustAvailable) throw new Error('The Rust terminal module is unavailable in this build');
    writeTerminalEngine(engine);
    return { ...current, selected: engine, restartRequired: current.runtime === null || engine !== current.runtime.requested };
  }));
  return () => {
    ipcMain.removeHandler(IPC.TERMINAL_CORE_SETTINGS_GET);
    ipcMain.removeHandler(IPC.TERMINAL_CORE_SETTINGS_SET);
  };
}
