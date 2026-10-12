import type * as AtomicWrite from '../daemon/util/atomicWrite';

type AtomicWriteModule = typeof AtomicWrite;

/**
 * The atomicWrite module with `durable` forced off: the same files, the same
 * temp-file-and-rename sequence and the same rotation, minus the fsync.
 *
 * TEST-ONLY. For suites that check what a store writes, not whether it
 * survives a power cut. On windows-latest each fsync+rename cost 100-800 ms in
 * the CI timeline, so a case with a few dozen durable writes ran past 5 s.
 * Use it as a `vi.mock` factory (import it inside the factory: `vi.mock` is
 * hoisted above the file's imports):
 *
 *   vi.mock('<relative path>/daemon/util/atomicWrite', async (importOriginal) => {
 *     const { withoutFsync } = await import('<relative path>/test-utils/nonDurableAtomicWrite');
 *     return withoutFsync(await importOriginal());
 *   });
 */
export function withoutFsync(real: AtomicWriteModule): AtomicWriteModule {
  return {
    ...real,
    atomicWriteJSONSync: (file, data, opts) => real.atomicWriteJSONSync(file, data, { ...opts, durable: false }),
    atomicWriteJSON: (file, data, opts) => real.atomicWriteJSON(file, data, { ...opts, durable: false }),
  };
}
