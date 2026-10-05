import { describe, it, expect } from 'vitest';
import { MAC_WORD_DELETE_BYTE, resolveMacWordDeleteByte } from '../macWordDeleteKey';

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

describe('resolveMacWordDeleteByte', () => {
  it('maps ⌘Backspace on macOS to Ctrl+W', () => {
    expect(resolveMacWordDeleteByte(key(), true)).toBe(MAC_WORD_DELETE_BYTE);
    expect(MAC_WORD_DELETE_BYTE).toBe('\x17');
  });

  it('still matches when an IME reports key as Process', () => {
    expect(resolveMacWordDeleteByte(key({ key: 'Process' }), true)).toBe('\x17');
  });

  it('leaves other platforms, plain Backspace and other chords to xterm', () => {
    expect(resolveMacWordDeleteByte(key(), false)).toBeNull();
    expect(resolveMacWordDeleteByte(key({ metaKey: false }), true)).toBeNull();
    expect(resolveMacWordDeleteByte(key({ shiftKey: true }), true)).toBeNull();
    expect(resolveMacWordDeleteByte(key({ altKey: true }), true)).toBeNull();
    expect(resolveMacWordDeleteByte(key({ ctrlKey: true }), true)).toBeNull();
    expect(resolveMacWordDeleteByte(key({ key: 'a', code: 'KeyA' }), true)).toBeNull();
  });

  it('defers to an open IME composition', () => {
    expect(resolveMacWordDeleteByte(key({ isComposing: true }), true)).toBeNull();
  });
});
