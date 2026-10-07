import { useStore } from '../stores';
import { t } from '../i18n';
import {
  UNBOUND_SHORTCUTS,
  displayCombo,
  rebindProblem,
  shortcutDescription,
  type ShortcutActionId,
} from '../../shared/keymap';
import { currentShortcutBindings, shortcutPlatform } from './shortcutBindings';

/**
 * Rebinding a built-in from anywhere — Settings → Shortcuts and the command
 * palette both go through here, so the two can never disagree on what a key
 * may be moved to, or on how a refusal reads.
 */

/** The user-facing name of `action` (its Settings → Shortcuts label). */
export function describeShortcut(action: ShortcutActionId): string {
  const { key, vars } = shortcutDescription(action);
  return t(key as Parameters<typeof t>[0], vars);
}

/** Why `combo` cannot run `action`, as a sentence — or null when it can. */
export function rebindProblemText(action: ShortcutActionId, combo: string): string | null {
  const platform = shortcutPlatform();
  const problem = rebindProblem(
    action, combo, currentShortcutBindings(), platform, useStore.getState().prefixConfig.key,
  );
  if (!problem) return null;
  const shown = displayCombo(combo, platform);
  switch (problem.kind) {
    case 'needsModifier': return t('settings.sc.needsModifier');
    case 'clipboard': return t('settings.sc.reservedKey', { combo: shown });
    case 'prefix': return t('settings.sc.prefixConflict', { combo: shown });
    case 'taken': return t('settings.sc.conflict', { name: describeShortcut(problem.by) });
  }
}

/** True for actions that ship with no key (see UNBOUND_SHORTCUTS). */
export function isUnboundByDefault(action: ShortcutActionId): boolean {
  return UNBOUND_SHORTCUTS.some((e) => e.action === action);
}

/**
 * Take the key off `action`. A built-in with a default is switched off (a
 * `null` override, so the key reaches the pane); an action that ships with no
 * key just loses its override, which leaves it unbound the same way.
 */
export function clearShortcut(action: ShortcutActionId): void {
  const state = useStore.getState();
  if (isUnboundByDefault(action)) state.resetShortcut(action);
  else state.setShortcutOverride(action, null);
}

/** The combo `action` runs on right now, in concrete form, or null if none. */
export function boundCombo(action: ShortcutActionId): string | null {
  return currentShortcutBindings().find((b) => b.action === action)?.combo ?? null;
}
