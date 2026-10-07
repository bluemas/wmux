import { describe, expect, it } from 'vitest';
import {
  formatInvite,
  formatPeerCredential,
  isA2aRoute,
  looksLikePeerCredential,
  normalizeFingerprint256,
  parseInvite,
  parsePeerCredential,
} from '../a2aRemote';

const FP = Array.from({ length: 32 }, (_, i) => i.toString(16).padStart(2, '0').toUpperCase()).join(':');
const PEER_ID = '0b9a7c3e-1f2d-4c5b-8a6e-9d8c7b6a5f4e';
const SECRET = 'A'.repeat(43);

describe('a2aRemote invite', () => {
  it('round-trips and canonicalizes the fingerprint', () => {
    const raw = `wmux-a2a://DESKTOP-WIN2:7681/K7PXM4QA#sha256=${FP.toLowerCase()}`;
    const parsed = parseInvite(raw);
    expect(parsed).toEqual({ ok: true, invite: { host: 'DESKTOP-WIN2', port: 7681, code: 'K7PXM4QA', fingerprint256: FP } });
    if (parsed.ok) expect(formatInvite(parsed.invite)).toBe(`wmux-a2a://DESKTOP-WIN2:7681/K7PXM4QA#sha256=${FP}`);
  });

  it('round-trips a Windows machine name with an underscore', () => {
    const raw = `wmux-a2a://DEV_PC_01.corp.local:7681/K7PXM4QA#sha256=${FP}`;
    const parsed = parseInvite(raw);
    expect(parsed).toEqual({ ok: true, invite: { host: 'DEV_PC_01.corp.local', port: 7681, code: 'K7PXM4QA', fingerprint256: FP } });
    if (parsed.ok) expect(formatInvite(parsed.invite)).toBe(raw);
  });

  it.each([
    ['', 'empty'],
    ['https://host:7681/K7PXM4QA#sha256=' + FP, 'scheme'],
    ['wmux-a2a://bad!host:7681/K7PXM4QA#sha256=' + FP, 'host'],
    ['wmux-a2a://-dash:7681/K7PXM4QA#sha256=' + FP, 'host'],
    ['wmux-a2a://host:70000/K7PXM4QA#sha256=' + FP, 'port'],
    ['wmux-a2a://host:7681/K7PXM4Q0#sha256=' + FP, 'code'],
    ['wmux-a2a://host:7681/K7PXM4QA#sha256=ABCD', 'fingerprint'],
  ])('rejects %s as %s', (raw, error) => {
    expect(parseInvite(raw)).toEqual({ ok: false, error });
  });
});

describe('a2aRemote peer credential', () => {
  it('round-trips and never contains the device separator', () => {
    const bearer = formatPeerCredential({ peerId: PEER_ID, secret: SECRET });
    expect(bearer).not.toContain('.');
    expect(parsePeerCredential(bearer)).toEqual({ peerId: PEER_ID, secret: SECRET });
    expect(looksLikePeerCredential(bearer)).toBe(true);
  });

  it('refuses near-misses, including a device-shaped credential', () => {
    expect(parsePeerCredential(`${PEER_ID}.${SECRET}`)).toBeNull();
    expect(parsePeerCredential(`wmuxpeer~${PEER_ID}~short`)).toBeNull();
    expect(parsePeerCredential(`wmuxpeer~not-a-uuid~${SECRET}`)).toBeNull();
    expect(parsePeerCredential(`wmuxpeer~${PEER_ID}~${SECRET}~extra`)).toBeNull();
    expect(looksLikePeerCredential(`${PEER_ID}.${SECRET}`)).toBe(false);
  });
});

describe('a2aRemote helpers', () => {
  it('normalizes bare hex fingerprints and rejects wrong lengths', () => {
    expect(normalizeFingerprint256(FP.replace(/:/g, ''))).toBe(FP);
    expect(normalizeFingerprint256(FP.slice(3))).toBeNull();
  });

  it('matches only the a2a route prefix', () => {
    expect(isA2aRoute('/api/a2a/messages')).toBe(true);
    expect(isA2aRoute('/api/a2a')).toBe(false);
    expect(isA2aRoute('/api/sessions')).toBe(false);
  });
});

describe('invite alt addresses', () => {
  const FP2 = Array.from({ length: 32 }, () => 'AB').join(':');
  const base = `wmux-a2a://desk:45660/K7PXM4QA#sha256=${FP2}`;

  it('round-trips alt IPv4s and keeps the alt-less form unchanged', () => {
    const parsed = parseInvite(`${base}&alt=10.0.0.5,192.168.1.9`);
    expect(parsed).toEqual({
      ok: true,
      invite: { host: 'desk', port: 45660, code: 'K7PXM4QA', fingerprint256: FP2, alt: ['10.0.0.5', '192.168.1.9'] },
    });
    if (parsed.ok) expect(formatInvite(parsed.invite)).toBe(`${base}&alt=10.0.0.5,192.168.1.9`);
    const plain = parseInvite(base);
    expect(plain.ok && plain.invite.alt).toBeUndefined();
    if (plain.ok) expect(formatInvite({ ...plain.invite, alt: [] })).toBe(base);
  });

  it.each([
    ['&alt=', 'empty entry'],
    ['&alt=10.0.0.01', 'leading zero'],
    ['&alt=host.example', 'a name'],
    ['&alt=1.1.1.1,2.2.2.2,3.3.3.3,4.4.4.4,5.5.5.5', 'more than four'],
    ['&alt=::1', 'IPv6'],
  ])('rejects alt %s (%s)', (suffix) => {
    expect(parseInvite(`${base}${suffix}`)).toEqual({ ok: false, error: 'alt' });
  });
});
