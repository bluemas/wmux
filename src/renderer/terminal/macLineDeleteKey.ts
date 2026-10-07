/**
 * ⌘Backspace on macOS deletes back to the start of the line.
 *
 * That is the macOS text-field convention, and what Terminal.app and iTerm2
 * send for the key. xterm.js encodes nothing for a ⌘ chord, so the key used to
 * do nothing in a pane. We write Ctrl+U (0x15), the line-kill byte that
 * readline, zsh's line editor, vim's insert mode and Claude Code all honour.
 * (zsh's default binding clears the whole line rather than only the part
 * before the cursor.)
 *
 * Matched by physical `code` as well as `key` so it survives a CJK IME
 * (`key` reads 'Process' there).
 */
export const MAC_LINE_DELETE_BYTE = '\x15';

export function resolveMacLineDeleteByte(
  e: Pick<KeyboardEvent, 'key' | 'code' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'isComposing'>,
  isMac: boolean,
): string | null {
  if (!isMac || e.isComposing) return null;
  if (!e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return null;
  if (e.key !== 'Backspace' && e.code !== 'Backspace') return null;
  return MAC_LINE_DELETE_BYTE;
}
