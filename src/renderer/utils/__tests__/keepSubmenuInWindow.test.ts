import { describe, expect, it } from 'vitest';
import { fitSubmenuTop } from '../keepSubmenuInWindow';

describe('fitSubmenuTop', () => {
  it('leaves a submenu that fits where it opened', () => {
    expect(fitSubmenuTop(100, 200, 800)).toBe(0);
  });

  it('lifts a submenu that would run past the bottom edge', () => {
    // item at 700, 200 tall, window 800: 104px over (4px margin)
    expect(fitSubmenuTop(700, 200, 800)).toBe(-104);
  });

  it('never lifts the submenu above the top edge', () => {
    // taller than the window: pinned 4px from the top
    expect(fitSubmenuTop(300, 1000, 800)).toBe(-296);
  });
});
