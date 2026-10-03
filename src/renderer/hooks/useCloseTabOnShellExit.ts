import { useEffect } from 'react';
import { useStore } from '../stores';
import { findWorkspaceSurfaceByPtyId } from '../utils/paneTraversal';
import { getWorkspaceLeafPanes } from '../../shared/paneUtils';

/**
 * Close a terminal tab when its shell exits cleanly (`exit`, Ctrl+D → code 0),
 * the way other terminals do. A non-zero code or a kill signal keeps the tab so
 * the exit banner and the scrollback stay readable. The close mirrors the tab's
 * own × button: the last tab of a pane takes the pane with it (a workspace's
 * root pane stays and is refilled with a fresh terminal).
 */
export function useCloseTabOnShellExit(): void {
  useEffect(() => {
    return window.electronAPI.pty.onExit((ptyId, exitCode) => {
      if (exitCode !== 0) return;
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
    });
  }, []);
}
