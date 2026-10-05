/**
 * ⌘Backspace on macOS deletes the previous word.
 *
 * xterm.js encodes nothing for a ⌘ chord, so the key used to do nothing in a
 * pane. We write Ctrl+W (0x17), the word-rubout byte that readline, zsh's
 * line editor, vim's insert mode and Claude Code all honour. ESC DEL (what
 * ⌥Backspace sends) was not used: a TUI that reads ESC on its own can take it
 * as Escape.
 *
 * Matched by physical `code` as well as `key` so it survives a CJK IME
 * (`key` reads 'Process' there).
 */
export const MAC_WORD_DELETE_BYTE = '\x17';

export function resolveMacWordDeleteByte(
  e: Pick<KeyboardEvent, 'key' | 'code' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'isComposing'>,
  isMac: boolean,
): string | null {
  if (!isMac || e.isComposing) return null;
  if (!e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return null;
  if (e.key !== 'Backspace' && e.code !== 'Backspace') return null;
  return MAC_WORD_DELETE_BYTE;
}
