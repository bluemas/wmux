// withoutFsync — the test-only atomicWrite wrapper that keeps fsync cost out of
// store suites. It must turn `durable` off and nothing else: a dropped option
// (validate, rotation) would let those suites pass on writes the real store
// refuses.

import { describe, it, expect, vi } from 'vitest';
import type * as AtomicWrite from '../../daemon/util/atomicWrite';
import { withoutFsync } from '../nonDurableAtomicWrite';

function fakeModule() {
  return {
    atomicWriteJSONSync: vi.fn(),
    atomicWriteJSON: vi.fn(async () => undefined),
    atomicReadJSONSync: vi.fn(),
  } as unknown as typeof AtomicWrite;
}

describe('withoutFsync', () => {
  it('forces durable off and passes every other option through, sync and async', async () => {
    const real = fakeModule();
    const mod = withoutFsync(real);
    const validate = () => true;

    mod.atomicWriteJSONSync('a.json', { x: 1 }, { durable: true, rotationEnabled: true, validate });
    await mod.atomicWriteJSON('b.json', [1], { durable: true, validate });

    expect(real.atomicWriteJSONSync).toHaveBeenCalledWith('a.json', { x: 1 }, { durable: false, rotationEnabled: true, validate });
    expect(real.atomicWriteJSON).toHaveBeenCalledWith('b.json', [1], { durable: false, validate });
  });

  it('accepts a call without options', () => {
    const real = fakeModule();
    withoutFsync(real).atomicWriteJSONSync('c.json', null);
    expect(real.atomicWriteJSONSync).toHaveBeenCalledWith('c.json', null, { durable: false });
  });

  it('leaves the rest of the module untouched', () => {
    const real = fakeModule();
    expect(withoutFsync(real).atomicReadJSONSync).toBe(real.atomicReadJSONSync);
  });
});
