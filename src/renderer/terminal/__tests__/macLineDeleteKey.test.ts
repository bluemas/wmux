import { describe, it, expect } from 'vitest';
import { MAC_LINE_DELETE_BYTE, resolveMacLineDeleteByte } from '../macLineDeleteKey';

function key(over: Partial<KeyboardEvent> = {}) {
  return {
    key: 'Backspace',
    code: 'Backspace',
    metaKey: true,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    isComposing: false,
    ...over,
  } as KeyboardEvent;
}

describe('resolveMacLineDeleteByte', () => {
  it('maps ⌘Backspace on macOS to Ctrl+U (delete to line start)', () => {
    expect(resolveMacLineDeleteByte(key(), true)).toBe(MAC_LINE_DELETE_BYTE);
    expect(MAC_LINE_DELETE_BYTE).toBe('\x15');
  });

  it('still matches when an IME reports key as Process', () => {
    expect(resolveMacLineDeleteByte(key({ key: 'Process' }), true)).toBe('\x15');
  });

  it('leaves other platforms, plain Backspace and other chords to xterm', () => {
    expect(resolveMacLineDeleteByte(key(), false)).toBeNull();
    expect(resolveMacLineDeleteByte(key({ metaKey: false }), true)).toBeNull();
    expect(resolveMacLineDeleteByte(key({ shiftKey: true }), true)).toBeNull();
    expect(resolveMacLineDeleteByte(key({ altKey: true }), true)).toBeNull();
    expect(resolveMacLineDeleteByte(key({ ctrlKey: true }), true)).toBeNull();
    expect(resolveMacLineDeleteByte(key({ key: 'a', code: 'KeyA' }), true)).toBeNull();
  });

  it('defers to an open IME composition', () => {
    expect(resolveMacLineDeleteByte(key({ isComposing: true }), true)).toBeNull();
  });
});
