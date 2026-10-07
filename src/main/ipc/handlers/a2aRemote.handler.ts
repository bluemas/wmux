import { ipcMain } from 'electron';
import { IPC } from '../../../shared/constants';
import { wrapHandler } from '../wrapHandler';
import type { DaemonClient } from '../../DaemonClient';

/**
 * Cross-host A2A — Settings ↔ daemon control-plane IPC. Thin pass-throughs
 * to the daemon's `a2a.remote.*` control-pipe RPCs (lanlink.handler.ts
 * precedent): every renderer-supplied value is re-validated daemon-side.
 * Daemon-mode only; without a DaemonClient the Settings section shows itself
 * as unavailable.
 */
export function registerA2aRemoteHandlers(daemonClient: DaemonClient): () => void {
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');
  const handlers: Array<[string, (...args: unknown[]) => Promise<unknown>]> = [
    [IPC.A2A_REMOTE_STATUS, () => daemonClient.a2aRemoteStatus()],
    [
      IPC.A2A_REMOTE_CONFIGURE,
      (patch) => daemonClient.a2aRemoteConfigure((patch ?? {}) as { enabled?: boolean; port?: number }),
    ],
    [IPC.A2A_REMOTE_PAIR_BEGIN, () => daemonClient.a2aRemotePairBegin()],
    [IPC.A2A_REMOTE_PAIR_CANCEL, () => daemonClient.a2aRemotePairCancel()],
    [IPC.A2A_REMOTE_PAIR_STATUS, () => daemonClient.a2aRemotePairStatus()],
    [IPC.A2A_REMOTE_JOIN, (invite) => daemonClient.a2aRemoteJoin(str(invite))],
    [IPC.A2A_REMOTE_HOSTS_LIST, () => daemonClient.a2aRemoteHostsList()],
    [IPC.A2A_REMOTE_HOSTS_REMOVE, (hostId) => daemonClient.a2aRemoteHostsRemove(str(hostId))],
    [IPC.A2A_REMOTE_PEERS_LIST, () => daemonClient.a2aRemotePeersList()],
    [IPC.A2A_REMOTE_PEERS_REVOKE, (peerId) => daemonClient.a2aRemotePeersRevoke(str(peerId))],
  ];
  for (const [channel, fn] of handlers) {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, wrapHandler(channel, (_event, ...args: unknown[]) => fn(...args)));
  }
  return () => {
    for (const [channel] of handlers) ipcMain.removeHandler(channel);
  };
}
