import { describe, expect, it } from 'vitest';
import { isAltF4Held } from '../altF4';

describe('isAltF4Held', () => {
  it('is false when the keys are not held (and never throws, on any platform)', () => {
    expect(isAltF4Held()).toBe(false);
  });
});
