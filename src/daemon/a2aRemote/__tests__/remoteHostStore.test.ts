import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { atomicWriteJSONSync } from '../../util/atomicWrite';
import {
  REMOTE_HOSTS_FILE,
  RemoteHostStore,
  orderAddresses,
  type NewRemoteHost,
  type RemoteHostStoreOptions,
} from '../remoteHostStore';

const HOST = '11111111-1111-4111-8111-111111111111';
const HOST2 = '22222222-2222-4222-8222-222222222222';
const PEER = '33333333-3333-4333-8333-333333333333';
const PEER2 = '44444444-4444-4444-8444-444444444444';
const SECRET = 'A'.repeat(43);
const SECRET2 = 'b'.repeat(43);
const FP = Array.from({ length: 32 }, () => 'AB').join(':');
const FP2 = Array.from({ length: 32 }, () => 'cd').join('');

let dir: string;
let fail = false;
const clock = 1_700_000_000_000;
const flakyWrite = (p: string, d: unknown): void => {
  if (fail) throw new Error('disk full');
  atomicWriteJSONSync(p, d);
};
const make = (o: Partial<RemoteHostStoreOptions> = {}): RemoteHostStore =>
  new RemoteHostStore({ dir, now: () => clock, write: flakyWrite, reHarden: () => 'hardened', ...o });

const host = (o: Partial<NewRemoteHost> = {}): NewRemoteHost => ({
  hostId: HOST,
  name: 'DESK-PC',
  addresses: ['10.0.0.5', 'DESK-PC'],
  port: 7443,
  fingerprint256: FP,
  peerId: PEER,
  ...o,
});

beforeEach(() => {
  fail = false;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-rhosts-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('orderAddresses', () => {
  it('puts machine names first, then IPv4s, and dedupes case-insensitively', () => {
    expect(orderAddresses(['10.0.0.5', 'desk-pc', ' DESK-PC ', '10.0.0.5', '', '10.0.0.9', 'desk.corp'])).toEqual([
      'desk-pc',
      'desk.corp',
      '10.0.0.5',
      '10.0.0.9',
    ]);
  });
});

describe('RemoteHostStore', () => {
  it('add stores the record (names first) and the credential separately', () => {
    const s = make();
    const rec = s.add(host(), { peerId: PEER, secret: SECRET });
    expect(rec).toMatchObject({ v: 1, hostId: HOST, addresses: ['DESK-PC', '10.0.0.5'], createdAt: new Date(clock).toISOString() });
    expect(s.credentialFor(HOST)).toEqual({ peerId: PEER, secret: SECRET });
    expect(s.credentialFor(HOST2)).toBeNull();
  });

  it('list and get never carry the secret', () => {
    const s = make();
    s.add(host(), { peerId: PEER, secret: SECRET });
    expect(JSON.stringify(s.list())).not.toContain(SECRET);
    expect(JSON.stringify(s.get(HOST))).not.toContain(SECRET);
  });

  it('round-trips through a new instance', () => {
    const s = make();
    s.add(host(), { peerId: PEER, secret: SECRET });
    s.add(host({ hostId: HOST2, peerId: PEER2, name: 'LAB' }), { peerId: PEER2, secret: SECRET2 });
    const raw = JSON.parse(fs.readFileSync(path.join(dir, REMOTE_HOSTS_FILE), 'utf-8'));
    expect(raw.v).toBe(1);
    const t = make();
    expect(t.list()).toEqual(s.list());
    expect(t.credentialFor(HOST2)).toEqual({ peerId: PEER2, secret: SECRET2 });
  });

  it('refuses a credential whose peerId does not match, or a malformed secret', () => {
    const s = make();
    expect(() => s.add(host(), { peerId: PEER2, secret: SECRET })).toThrow(/credential/);
    expect(() => s.add(host(), { peerId: PEER, secret: 'short' })).toThrow(/credential/);
    expect(() => s.add(host({ fingerprint256: 'nope' }), { peerId: PEER, secret: SECRET })).toThrow(/fingerprint/);
    expect(s.list()).toEqual([]);
  });

  it('updateAddresses reorders and dedupes; updateFingerprint keeps the hostId', () => {
    const s = make();
    s.add(host(), { peerId: PEER, secret: SECRET });
    expect(s.updateAddresses(HOST, ['10.0.0.7', 'desk-pc', 'DESK-PC']).addresses).toEqual(['desk-pc', '10.0.0.7']);
    const updated = s.updateFingerprint(HOST, FP2);
    expect(updated.hostId).toBe(HOST);
    expect(updated.fingerprint256).toBe(FP2.toUpperCase().match(/.{2}/g)?.join(':'));
    expect(make().get(HOST)?.fingerprint256).toBe(updated.fingerprint256);
    expect(() => s.updateFingerprint(HOST, 'bad')).toThrow();
    expect(() => s.updateAddresses(HOST2, ['x'])).toThrow(/unknown/);
  });

  it('remove forgets the record and the credential', () => {
    const s = make();
    s.add(host(), { peerId: PEER, secret: SECRET });
    expect(s.remove(HOST)).toBe(true);
    expect(s.remove(HOST)).toBe(false);
    const t = make();
    expect(t.get(HOST)).toBeUndefined();
    expect(t.credentialFor(HOST)).toBeNull();
  });

  it('add / updates roll back on a failed write', () => {
    const s = make();
    s.add(host(), { peerId: PEER, secret: SECRET });
    fail = true;
    expect(() => s.add(host({ hostId: HOST2, peerId: PEER2 }), { peerId: PEER2, secret: SECRET2 })).toThrow('disk full');
    expect(s.get(HOST2)).toBeUndefined();
    expect(s.credentialFor(HOST2)).toBeNull();
    // Re-pair over an existing host: old record AND old secret come back.
    expect(() => s.add(host({ peerId: PEER2 }), { peerId: PEER2, secret: SECRET2 })).toThrow();
    expect(s.credentialFor(HOST)).toEqual({ peerId: PEER, secret: SECRET });
    expect(() => s.updateAddresses(HOST, ['other'])).toThrow();
    expect(s.get(HOST)?.addresses).toEqual(['DESK-PC', '10.0.0.5']);
    expect(() => s.updateFingerprint(HOST, FP2)).toThrow();
    expect(s.get(HOST)?.fingerprint256).toBe(FP);
  });

  it('remove keeps its in-memory effect on a failed write', () => {
    const s = make();
    s.add(host(), { peerId: PEER, secret: SECRET });
    fail = true;
    expect(() => s.remove(HOST)).toThrow('disk full');
    expect(s.credentialFor(HOST)).toBeNull();
  });

  it('hardens synchronously after every write; a failed harden on win32 unlinks and throws', () => {
    const reHarden = vi.fn((): 'hardened' | 'failed' => 'hardened');
    const s = make({ reHarden, win32: true });
    s.add(host(), { peerId: PEER, secret: SECRET });
    const file = path.join(dir, REMOTE_HOSTS_FILE);
    expect(reHarden).toHaveBeenCalledWith(file);
    reHarden.mockReturnValue('failed');
    expect(() => s.add(host({ hostId: HOST2, peerId: PEER2 }), { peerId: PEER2, secret: SECRET2 })).toThrow(/owner-only/);
    expect(fs.existsSync(file)).toBe(false);
    expect(s.get(HOST2)).toBeUndefined();
  });

  it('a failed harden off win32 is not fatal (0600 is already set by the write)', () => {
    const s = make({ reHarden: () => 'failed', win32: false });
    expect(() => s.add(host(), { peerId: PEER, secret: SECRET })).not.toThrow();
  });

  it('writes the file owner-only on POSIX', () => {
    if (process.platform === 'win32') return;
    const s = make({ reHarden: undefined });
    s.add(host(), { peerId: PEER, secret: SECRET });
    expect(fs.statSync(path.join(dir, REMOTE_HOSTS_FILE)).mode & 0o777).toBe(0o600);
  });

  describe('corrupt file is fail-closed', () => {
    const corruptWith = (mutate: (raw: Record<string, unknown>) => void): RemoteHostStore => {
      const s = make();
      s.add(host(), { peerId: PEER, secret: SECRET });
      s.add(host({ hostId: HOST2, peerId: PEER2 }), { peerId: PEER2, secret: SECRET2 });
      const file = path.join(dir, REMOTE_HOSTS_FILE);
      const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
      mutate(raw);
      fs.writeFileSync(file, JSON.stringify(raw));
      return make({ log: vi.fn() });
    };

    it('malformed JSON: no host, no credential, original kept, error logged', () => {
      const file = path.join(dir, REMOTE_HOSTS_FILE);
      fs.writeFileSync(file, '{"v":1,');
      const log = vi.fn();
      const s = make({ log });
      expect(s.list()).toEqual([]);
      expect(fs.existsSync(`${file}.corrupt-${clock}`)).toBe(true);
      expect(log).toHaveBeenCalledWith('error', expect.stringContaining('corrupt'));
    });

    it('a host whose secret is missing rejects every host (no .bak resurrection)', () => {
      const s = corruptWith((raw) => {
        delete (raw.secrets as Record<string, string>)[HOST2];
      });
      expect(s.list()).toEqual([]);
      expect(s.credentialFor(HOST)).toBeNull();
    });

    it('an orphan secret rejects the file', () => {
      const s = corruptWith((raw) => {
        (raw.secrets as Record<string, string>)['55555555-5555-4555-8555-555555555555'] = SECRET;
      });
      expect(s.credentialFor(HOST)).toBeNull();
    });

    it('a bad fingerprint on one host rejects the file', () => {
      const s = corruptWith((raw) => {
        (raw.hosts as Array<Record<string, unknown>>)[1].fingerprint256 = 'zz';
      });
      expect(s.credentialFor(HOST)).toBeNull();
    });
  });
});
