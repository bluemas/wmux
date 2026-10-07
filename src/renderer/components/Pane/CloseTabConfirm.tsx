import { useStore } from '../../stores';
import { useT } from '../../hooks/useT';
import { findLeaf } from '../../../shared/paneUtils';
import { destroySurfaceRemoteSession } from '../../utils/remoteSessionTeardown';
import Dialog, { DialogFooter, DialogHeader } from '../ui/Dialog';
import Button from '../ui/Button';

export interface CloseTabTarget {
  workspaceId: string;
  paneId: string;
  surfaceId: string;
}

/**
 * Close a tab the way its × does: end its PTY (and a remote session this
 * desktop minted), drop the surface, and collapse the pane when it was the
 * last tab. The root pane survives closePane and is refilled with a shell.
 */
export function closeTabNow(target: CloseTabTarget): void {
  const state = useStore.getState();
  const ws = state.workspaces.find((w) => w.id === target.workspaceId);
  const pane = ws ? findLeaf(ws.rootPane, target.paneId) : null;
  const surface = pane?.surfaces.find((s) => s.id === target.surfaceId);
  if (!pane || !surface) return;
  if (surface.ptyId) window.electronAPI.pty.dispose(surface.ptyId);
  destroySurfaceRemoteSession(surface);
  const wasLastSurface = pane.surfaces.length <= 1;
  state.closeSurface(pane.id, surface.id, target.workspaceId);
  if (wasLastSurface) state.closePane(pane.id, target.workspaceId);
}

/** The one close-tab confirm, raised by the tab × and the close-tab shortcut. */
export default function CloseTabConfirm() {
  const t = useT();
  const target = useStore((s) => s.closeTabConfirm);
  const dismiss = useStore((s) => s.dismissCloseTab);
  if (!target) return null;
  const confirm = () => {
    dismiss();
    closeTabNow(target);
  };
  return (
    <Dialog onClose={dismiss} width={360} closeOnBackdrop data-testid="close-tab-confirm">
      <DialogHeader title={t('surface.closeConfirm')} />
      <DialogFooter>
        <Button variant="secondary" size="sm" onClick={dismiss} data-close-tab-cancel>
          {t('common.cancel')}
        </Button>
        <Button variant="danger" size="sm" onClick={confirm} data-close-tab-confirm>
          {t('workspace.closeConfirmYes')}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
