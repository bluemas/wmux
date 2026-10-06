/**
 * Matching for the Settings → Keyboard shortcuts search field.
 *
 * macOS shows modifiers as symbols (⌘K, ⌥…), so a query typed in words —
 * "cmd k", "option", "control" — would never match. Both sides are folded to
 * one spelling per modifier (⌘/cmd/command → cmd, ⌥/alt/option/opt → alt,
 * ⌃/ctrl/control → ctrl, ⇧/shift → shift), then compared case-insensitively
 * with spaces and '+' ignored, so "ctrl n", "ctrl+n" and "ctrln" all find
 * Ctrl+N.
 */

const MODIFIER_SYMBOLS: Record<string, string> = { '⌘': 'cmd', '⌥': 'alt', '⌃': 'ctrl', '⇧': 'shift' };
const MODIFIER_WORDS: Record<string, string> = {
  cmd: 'cmd', command: 'cmd',
  alt: 'alt', option: 'alt', opt: 'alt',
  ctrl: 'ctrl', control: 'ctrl',
  shift: 'shift',
};

const squash = (text: string): string => text.toLowerCase().replace(/[\s+]/g, '');

/** Modifier symbols and whole-word aliases folded to one spelling, then squashed. */
export function foldShortcutText(text: string): string {
  const spelled = text.replace(/[⌘⌥⌃⇧]/g, (sym) => ` ${MODIFIER_SYMBOLS[sym]} `);
  return squash(spelled.split(/[\s+]+/).map((word) => MODIFIER_WORDS[word.toLowerCase()] ?? word).join(' '));
}

/** Whether a shortcut row (its action name and displayed keys) matches the query. */
export function matchesShortcutQuery(query: string, description: string, keys: string): boolean {
  const plain = squash(query);
  if (!plain) return true;
  return squash(description).includes(plain)
    || squash(keys).includes(plain)
    || foldShortcutText(keys).includes(foldShortcutText(query));
}
