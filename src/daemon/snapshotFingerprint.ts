/** Semantic fingerprint for shadow comparisons. Never contains terminal text. */
import { createHash } from 'node:crypto';
import { Terminal } from '@xterm/headless';
import { applyUnicodeWidthModel } from '../shared/terminalUnicode';
import { XTERM_60_VT_EXTENSIONS } from '../shared/terminal/replyParity';

export function snapshotTestTerminal(cols: number, rows: number, scrollback = 5000): Terminal {
  const terminal = new Terminal({ cols, rows, scrollback, allowProposedApi: true, logLevel: 'off', vtExtensions: { ...XTERM_60_VT_EXTENSIONS } });
  applyUnicodeWidthModel(terminal);
  return terminal;
}

export function terminalFingerprint(terminal: Terminal): string {
  const hash = createHash('sha256');
  hash.update(JSON.stringify({ cols: terminal.cols, rows: terminal.rows, active: terminal.buffer.active.type, modes: terminal.modes }));
  for (const buffer of [terminal.buffer.normal, terminal.buffer.alternate]) {
    // An inactive, never-created alternate grid has no meaningful content.
    if (buffer.type === 'alternate' && terminal.buffer.active.type !== 'alternate') continue;
    hash.update(JSON.stringify([buffer.type, buffer.baseY, buffer.cursorX, buffer.cursorY]));
    for (let y = 0; y < buffer.length; y++) {
      const line = buffer.getLine(y);
      if (!line) throw new Error('Missing snapshot row');
      hash.update(JSON.stringify([line.isWrapped]));
      for (let x = 0; x < terminal.cols; x++) {
        const c = line.getCell(x);
        if (!c) throw new Error('Missing snapshot cell');
        hash.update(JSON.stringify([c.getChars() || ' ', c.getWidth(), c.getFgColor(), c.getBgColor(),
          c.isFgRGB(), c.isBgRGB(), c.isFgPalette(), c.isBgPalette(), c.isBold(), c.isDim(), c.isItalic(),
          c.isUnderline(), c.isBlink(), c.isInverse(), c.isInvisible(), c.isStrikethrough(), c.isOverline()]));
      }
    }
  }
  return hash.digest('hex');
}

export async function writeTerminal(terminal: Terminal, bytes: string | Uint8Array): Promise<void> {
  await new Promise<void>(resolve => terminal.write(bytes, resolve));
}
