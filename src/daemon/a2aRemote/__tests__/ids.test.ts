import { describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import { isRemoteTaskId } from '../../../shared/a2aRemote';
import { remoteTaskId } from '../ids';

describe('remoteTaskId', () => {
  it('is deterministic and matches the contract predicate', () => {
    const a = remoteTaskId('link-1', 'msg-1');
    expect(a).toBe(remoteTaskId('link-1', 'msg-1'));
    expect(isRemoteTaskId(a)).toBe(true);
    const expected = crypto.createHash('sha256').update('link-1\0msg-1').digest('hex').slice(0, 32);
    expect(a).toBe(`rt-${expected}`);
  });

  it('separates the two halves so a shifted boundary is a different task', () => {
    expect(remoteTaskId('ab', 'c')).not.toBe(remoteTaskId('a', 'bc'));
  });

  it('refuses a NUL inside either part, which would collide across the separator', () => {
    // Unchecked, both of these hash the bytes "a\0b\0c".
    expect(() => remoteTaskId('a\0b', 'c')).toThrow(TypeError);
    expect(() => remoteTaskId('a', 'b\0c')).toThrow(TypeError);
  });

  it('refuses empty and oversized parts', () => {
    expect(() => remoteTaskId('', 'm')).toThrow(TypeError);
    expect(() => remoteTaskId('l', '')).toThrow(TypeError);
    expect(() => remoteTaskId('l'.repeat(257), 'm')).toThrow(TypeError);
    expect(isRemoteTaskId(remoteTaskId('l'.repeat(256), 'm'.repeat(256)))).toBe(true);
  });

  it('differs per link and per message', () => {
    const ids = new Set([
      remoteTaskId('link-1', 'msg-1'),
      remoteTaskId('link-1', 'msg-2'),
      remoteTaskId('link-2', 'msg-1'),
    ]);
    expect(ids.size).toBe(3);
  });

  it('hashes UTF-8, not UTF-16 code units', () => {
    const expected = crypto.createHash('sha256').update(Buffer.from('l\0한', 'utf8')).digest('hex').slice(0, 32);
    expect(remoteTaskId('l', '한')).toBe(`rt-${expected}`);
  });
});
