import { useEffect } from 'react';
import { useStore } from '../stores';
import { findWorkspaceSurfaceByPtyId } from '../utils/paneTraversal';
import { getWorkspaceLeafPanes } from '../../shared/paneUtils';
import { isDaemonModeActive } from '../daemon/daemonMode';

/** A pane whose exit is not the end of it: wmux restarts it, or it carries an
 *  agent recovery offer that lives on the pane. Closing would cancel either. */
function paneOutlivesExit(ptyId: string): boolean {
  const s = useStore.getState();
  return s.supervisionByPtyId[ptyId] !== undefined
    || s.resumeHintByPtyId[ptyId] !== undefined
    || s.resumeBindingByPtyId[ptyId] !== undefined
    || s.deadPaneRecoveryOfferByPtyId[ptyId] !== undefined;
}

/**
 * Close a terminal tab when its shell exits cleanly (`exit`, Ctrl+D → code 0),
 * the way other terminals do. A non-zero code or a kill signal keeps the tab so
 * the exit banner and the scrollback stay readable. node-pty reports a killed
 * process (kill -9, a crash, an OOM kill) as exit code 0 with the signal beside
 * it, so the signal is checked too. The close mirrors the tab's
 * own × button: the last tab of a pane takes the pane with it (a workspace's
 * root pane stays and is refilled with a fresh terminal).
 *
 * Off when the user turns the setting off. Supervised panes (wmux.json
 * `restart`) are never closed: the daemon restarts them under the same ptyId
 * after the exit, and dispose would cancel that restart. The renderer's
 * supervision slice is only filled by hydration and status events, so a
 * supervised leaf created this session is not in it yet — the daemon's
 * session list (dead sessions included) is asked too, and any doubt keeps
 * the tab — including a session the daemon does not list. Without a daemon
 * there is no supervision or resume offer, and an exited pty simply drops out
 * of the list, so its absence is not doubt there.
 */
export function useCloseTabOnShellExit(): void {
  useEffect(() => {
    return window.electronAPI.pty.onExit((ptyId, exitCode, signal) => {
      if (exitCode !== 0 || (typeof signal === 'number' && signal > 0)) return;
      if (!useStore.getState().closeTabOnShellExit || paneOutlivesExit(ptyId)) return;
      void window.electronAPI.pty.list({ includeDead: true }).then(
        (sessions: Array<{ id: string; supervision?: unknown; resumeAgent?: unknown; resumeBinding?: unknown }>) => {
          const session = sessions.find((s) => s.id === ptyId);
          if (!session && isDaemonModeActive()) return;
          if (session && (session.supervision || session.resumeAgent || session.resumeBinding)) return;
          if (!useStore.getState().closeTabOnShellExit || paneOutlivesExit(ptyId)) return;
          closeExitedTab(ptyId);
        },
        () => { /* unknown pane state: keep the tab */ },
      );
    });
  }, []);
}

function closeExitedTab(ptyId: string): void {
  const state = useStore.getState();
  for (const ws of state.workspaces) {
    const hit = findWorkspaceSurfaceByPtyId(ws, ptyId);
    if (!hit) continue;
    const pane = getWorkspaceLeafPanes(ws).find((leaf) => leaf.id === hit.paneId)
      ?? ws.stashedPanes?.map((e) => e?.pane).find((p) => p?.id === hit.paneId);
    const lastTab = !pane || pane.type !== 'leaf' || pane.surfaces.length <= 1;
    // The shell is already gone; dispose releases the main-side bookkeeping.
    window.electronAPI.pty.dispose(ptyId);
    state.closeSurface(hit.paneId, hit.surfaceId, ws.id);
    if (lastTab) state.closePane(hit.paneId, ws.id);
    return;
  }
}
