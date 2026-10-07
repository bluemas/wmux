import { describe, expect, it } from 'vitest';
import { parseInvite } from '../../../shared/a2aRemote';
import { A2A_PAIR_MAX_ATTEMPTS, A2A_PAIR_TTL_MS, PairingSlot, inviteHost, mintPairCode } from '../pairing';

const FP = Array.from({ length: 32 }, () => 'AB').join(':');

describe('PairingSlot', () => {
  it('mints codes the invite grammar accepts', () => {
    for (let i = 0; i < 50; i++) expect(mintPairCode()).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
  });

  it('begin returns a parseable invite with a 10 minute deadline', () => {
    let now = 1_000;
    const slot = new PairingSlot({ now: () => now, mintCode: () => 'ABCDEFGH' });
    const r = slot.begin({ host: 'desk-pc', port: 45660, fingerprint256: FP });
    expect(parseInvite(r.invite)).toEqual({
      ok: true,
      invite: { host: 'desk-pc', port: 45660, code: 'ABCDEFGH', fingerprint256: FP },
    });
    expect(r.expiresAt).toBe(1_000 + A2A_PAIR_TTL_MS);
    now += A2A_PAIR_TTL_MS;
    expect(slot.status().active).toBe(false);
    expect(slot.check('ABCDEFGH')).toEqual({ ok: false, reason: 'expired' });
  });

  it('burns the code after five wrong attempts', () => {
    const slot = new PairingSlot({ mintCode: () => 'ABCDEFGH' });
    slot.begin({ host: 'h', port: 1, fingerprint256: FP });
    for (let i = 1; i <= A2A_PAIR_MAX_ATTEMPTS; i++) {
      expect(slot.check('ZZZZZZZZ')).toEqual({ ok: false, reason: 'invalid-code' });
    }
    expect(slot.check('ABCDEFGH')).toEqual({ ok: false, reason: 'expired' });
  });

  it('accepts lower case, is single use after consume, and cancel clears it', () => {
    const slot = new PairingSlot({ mintCode: () => 'ABCDEFGH' });
    slot.begin({ host: 'h', port: 1, fingerprint256: FP });
    expect(slot.check(' abcdefgh ')).toEqual({ ok: true });
    slot.consume();
    expect(slot.check('ABCDEFGH')).toEqual({ ok: false, reason: 'expired' });
    slot.begin({ host: 'h', port: 1, fingerprint256: FP });
    slot.cancel();
    expect(slot.status()).toEqual({ active: false, expiresAt: null, attemptsLeft: 0 });
  });
});

describe('inviteHost', () => {
  it('prefers a valid machine name, falls back to the first IPv4', () => {
    expect(inviteHost('DESKTOP-AB12', ['10.0.0.5'])).toBe('DESKTOP-AB12');
    expect(inviteHost('My PC', ['10.0.0.5', '10.0.0.6'])).toBe('10.0.0.5');
    expect(inviteHost('', [])).toBeNull();
  });
});
