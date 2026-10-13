import { describe, it, expect } from 'vitest';
import { resolveCtrlAltLetterBytes, resolveCtrlLetterByte, type CtrlLetterEventLike } from '../ctrlLetterKeys';

function ev(partial: Partial<CtrlLetterEventLike>): CtrlLetterEventLike {
  return {
    key: '',
    code: '',
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    isComposing: false,
    ...partial,
  };
}

describe('resolveCtrlLetterByte — Dvorak / logical key (#1227)', () => {
  it('emits SIGINT (0x03) from logical C even when the physical key is I', () => {
    // Dvorak: the key that types "c" sits where QWERTY I is. keyCode would be
    // 73, and xterm would emit Ctrl+I (tab). We encode from e.key instead.
    expect(resolveCtrlLetterByte(ev({ key: 'c', code: 'KeyI', ctrlKey: true }))).toBe('\x03');
  });

  it('emits Ctrl+J (LF) from logical J on the physical C key, not SIGINT', () => {
    // The IME fallback must NOT treat physical KeyC as C when the layout
    // already reported a Latin letter — that is how Dvorak J would steal copy.
    expect(resolveCtrlLetterByte(ev({ key: 'j', code: 'KeyC', ctrlKey: true }))).toBe('\n');
  });

  it('emits Ctrl+Z from logical Z', () => {
    expect(resolveCtrlLetterByte(ev({ key: 'z', code: 'KeySlash', ctrlKey: true }))).toBe('\x1a');
  });
});

describe('resolveCtrlLetterByte — IME fallback', () => {
  it('falls back to physical KeyC when the IME mangles key to Process', () => {
    expect(resolveCtrlLetterByte(ev({ key: 'Process', code: 'KeyC', ctrlKey: true }))).toBe('\x03');
  });

  it('falls back to physical KeyC when the IME reports a Hangul jamo', () => {
    expect(resolveCtrlLetterByte(ev({ key: 'ㅊ', code: 'KeyC', ctrlKey: true }))).toBe('\x03');
  });
});

describe('resolveCtrlLetterByte — guards', () => {
  it('ignores Shift/Alt/Meta and an active IME composition', () => {
    expect(resolveCtrlLetterByte(ev({ key: 'c', code: 'KeyC', ctrlKey: true, shiftKey: true }))).toBeNull();
    expect(resolveCtrlLetterByte(ev({ key: 'c', code: 'KeyC', ctrlKey: true, altKey: true }))).toBeNull();
    expect(resolveCtrlLetterByte(ev({ key: 'c', code: 'KeyC', ctrlKey: true, metaKey: true }))).toBeNull();
    expect(resolveCtrlLetterByte(ev({ key: 'c', code: 'KeyC', ctrlKey: true, isComposing: true }))).toBeNull();
  });

  it('ignores a bare C (no Ctrl) and non-letter keys', () => {
    expect(resolveCtrlLetterByte(ev({ key: 'c', code: 'KeyC' }))).toBeNull();
    expect(resolveCtrlLetterByte(ev({ key: 'Enter', code: 'Enter', ctrlKey: true }))).toBeNull();
  });
});

describe('resolveCtrlAltLetterBytes — Ctrl+Alt+letter on Windows (#2136)', () => {
  const ctrlAlt = (key: string, over: Partial<CtrlLetterEventLike> = {}) =>
    ev({ key, code: `Key${key.toUpperCase()}`, ctrlKey: true, altKey: true, ...over });

  it('writes ESC + the control byte, the form xterm sends on Linux and macOS', () => {
    expect(resolveCtrlAltLetterBytes(ctrlAlt('d'), true)).toBe('\x1b\x04');
    expect(resolveCtrlAltLetterBytes(ctrlAlt('a'), true)).toBe('\x1b\x01');
    expect(resolveCtrlAltLetterBytes(ctrlAlt('z'), true)).toBe('\x1b\x1a');
  });

  it('takes the logical letter, so Dvorak gets the letter it typed', () => {
    expect(resolveCtrlAltLetterBytes(ev({ key: 'd', code: 'KeyH', ctrlKey: true, altKey: true }), true)).toBe('\x1b\x04');
  });

  it('accepts an upper-case key (Caps Lock)', () => {
    expect(resolveCtrlAltLetterBytes(ctrlAlt('D'), true)).toBe('\x1b\x04');
  });

  it('leaves an AltGr character to xterm', () => {
    expect(resolveCtrlAltLetterBytes(ev({ key: '@', code: 'KeyQ', ctrlKey: true, altKey: true }), true)).toBeNull();
    expect(resolveCtrlAltLetterBytes(ev({ key: '€', code: 'KeyE', ctrlKey: true, altKey: true }), true)).toBeNull();
    expect(resolveCtrlAltLetterBytes(ev({ key: 'ł', code: 'KeyL', ctrlKey: true, altKey: true }), true)).toBeNull();
  });

  it('does not use the physical-key fallback (an IME or AltGr key is not a letter chord)', () => {
    expect(resolveCtrlAltLetterBytes(ev({ key: 'Process', code: 'KeyD', ctrlKey: true, altKey: true }), true)).toBeNull();
  });

  it('only acts on Windows, where xterm drops the chord', () => {
    expect(resolveCtrlAltLetterBytes(ctrlAlt('d'), false)).toBeNull();
  });

  it('declines other modifier sets and an active composition', () => {
    expect(resolveCtrlAltLetterBytes(ctrlAlt('d', { shiftKey: true }), true)).toBeNull();
    expect(resolveCtrlAltLetterBytes(ctrlAlt('d', { metaKey: true }), true)).toBeNull();
    expect(resolveCtrlAltLetterBytes(ctrlAlt('d', { isComposing: true }), true)).toBeNull();
    expect(resolveCtrlAltLetterBytes(ctrlAlt('d', { altKey: false }), true)).toBeNull();
    expect(resolveCtrlAltLetterBytes(ctrlAlt('d', { ctrlKey: false }), true)).toBeNull();
  });
});
