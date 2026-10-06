import { describe, expect, it } from 'vitest';
import { isAltF4Held, isAltF4KeyDown, type AltF4Input } from '../altF4';

describe('isAltF4Held', () => {
  it('is false when the keys are not held (and never throws, on any platform)', () => {
    expect(isAltF4Held()).toBe(false);
  });
});

describe('isAltF4KeyDown', () => {
  const press = (over: Partial<AltF4Input> = {}): AltF4Input => ({
    type: 'keyDown', key: 'F4', alt: true, control: false, meta: false, isAutoRepeat: false, ...over,
  });

  it('is true for a fresh Alt+F4 key-down', () => {
    expect(isAltF4KeyDown(press())).toBe(true);
  });

  it('is false for the key-up, a repeat, or F4 without Alt', () => {
    expect(isAltF4KeyDown(press({ type: 'keyUp' }))).toBe(false);
    expect(isAltF4KeyDown(press({ isAutoRepeat: true }))).toBe(false);
    expect(isAltF4KeyDown(press({ alt: false }))).toBe(false);
  });

  it('is false for other keys and for Ctrl/Win combinations', () => {
    expect(isAltF4KeyDown(press({ key: 'F5' }))).toBe(false);
    expect(isAltF4KeyDown(press({ control: true }))).toBe(false);
    expect(isAltF4KeyDown(press({ meta: true }))).toBe(false);
  });
});
