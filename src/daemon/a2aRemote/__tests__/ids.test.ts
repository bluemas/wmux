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
    expect(remoteTaskId('a', '')).not.toBe(remoteTaskId('', 'a'));
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
