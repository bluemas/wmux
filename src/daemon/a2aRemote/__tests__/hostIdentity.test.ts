import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HOST_CERT_RENEW_BEFORE_DAYS, HOST_CERT_VALID_DAYS, loadOrCreateHostIdentity } from '../hostIdentity';
import { isHostId } from '../../../shared/a2aRemote';

const T0 = new Date('2026-10-07T00:00:00Z');
const DAY_MS = 86_400_000;

let dir: string;

beforeEach(() => {
  dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-hostid-')), 'a2a');
});

afterEach(() => {
  fs.rmSync(path.dirname(dir), { recursive: true, force: true });
});

const load = (over: Partial<Parameters<typeof loadOrCreateHostIdentity>[0]> = {}) =>
  loadOrCreateHostIdentity({ dir, hostname: 'DevBox', ipAddresses: ['10.0.0.5'], now: T0, ...over });

const hostJson = () => path.join(dir, 'host.json');

describe('loadOrCreateHostIdentity', () => {
  it('fails closed on a corrupt host.json: throws, leaves the file in place, mints nothing', () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(hostJson(), '{"v":1,"hostId":');
    expect(() => load()).toThrow(/corrupt/);
    expect(fs.readFileSync(hostJson(), 'utf8')).toBe('{"v":1,"hostId":');
    expect(fs.existsSync(path.join(dir, 'cert.pem'))).toBe(false);

    // Well-formed JSON with the wrong shape is just as corrupt.
    for (const bad of ['{"v":2,"hostId":"8f14e45f-ceea-4e67-a0e8-7a3b1a3b2c4d"}', '{"v":1,"hostId":"not-a-uuid"}', 'null']) {
      fs.writeFileSync(hostJson(), bad);
      expect(() => load()).toThrow(/corrupt/);
      expect(fs.readFileSync(hostJson(), 'utf8')).toBe(bad);
    }
  });

  it('refuses to mint a hostId when host.json is gone but the cert/key remain', () => {
    const a = load();
    const certBefore = fs.readFileSync(a.certPath, 'utf8');
    fs.unlinkSync(hostJson());
    expect(() => load()).toThrow(/missing/);
    expect(fs.existsSync(hostJson())).toBe(false);
    expect(fs.readFileSync(a.certPath, 'utf8')).toBe(certBefore);
  });

  it('creates host.json, key and certificate on first run', () => {
    const id = load();
    expect(id.created).toBe(true);
    expect(isHostId(id.hostId)).toBe(true);

    const rec = JSON.parse(fs.readFileSync(hostJson(), 'utf8'));
    expect(rec).toEqual({ v: 1, hostId: id.hostId, createdAt: T0.toISOString() });

    const x = new crypto.X509Certificate(fs.readFileSync(id.certPath));
    expect(x.fingerprint256).toBe(id.fingerprint256);
    expect(x.subject).toBe('CN=DevBox');
    expect(x.subjectAltName).toBe('DNS:devbox, IP Address:10.0.0.5');
    expect(x.checkPrivateKey(crypto.createPrivateKey(fs.readFileSync(id.keyPath)))).toBe(true);
    expect(id.notAfter).toBe(new Date(T0.getTime() + HOST_CERT_VALID_DAYS * DAY_MS).toISOString());
  });

  it('reuses everything on the next call', () => {
    const a = load();
    const b = load({ now: new Date(T0.getTime() + 100 * DAY_MS), hostname: 'devbox' });
    expect(b).toEqual({ ...a, created: false });
  });

  it('re-issues near expiry and keeps the hostId', () => {
    const a = load();
    const stillFine = load({ now: new Date(T0.getTime() + (HOST_CERT_VALID_DAYS - HOST_CERT_RENEW_BEFORE_DAYS - 1) * DAY_MS) });
    expect(stillFine.created).toBe(false);

    const later = new Date(T0.getTime() + (HOST_CERT_VALID_DAYS - HOST_CERT_RENEW_BEFORE_DAYS + 1) * DAY_MS);
    const b = load({ now: later });
    expect(b.created).toBe(true);
    expect(b.hostId).toBe(a.hostId);
    expect(b.fingerprint256).not.toBe(a.fingerprint256);
    expect(JSON.parse(fs.readFileSync(hostJson(), 'utf8')).createdAt).toBe(T0.toISOString());
  });

  it('re-issues when the hostname or an IPv4 is no longer in the SAN, keeping the hostId', () => {
    const a = load();
    const renamed = load({ hostname: 'newbox' });
    expect(renamed.created).toBe(true);
    expect(renamed.hostId).toBe(a.hostId);
    expect(new crypto.X509Certificate(fs.readFileSync(renamed.certPath)).subjectAltName).toBe(
      'DNS:newbox, IP Address:10.0.0.5',
    );

    const moved = load({ hostname: 'newbox', ipAddresses: ['10.0.0.5', '192.168.1.9'] });
    expect(moved.created).toBe(true);
    expect(moved.hostId).toBe(a.hostId);

    // Losing an address is not a mismatch; IPv6 and duplicates are ignored.
    const subset = load({ hostname: 'newbox', ipAddresses: ['192.168.1.9', 'fe80::1', '192.168.1.9'] });
    expect(subset.created).toBe(false);
    expect(subset.fingerprint256).toBe(moved.fingerprint256);
  });

  it('re-issues when the key or certificate is missing, corrupt, or mismatched', () => {
    const a = load();
    fs.writeFileSync(a.certPath, 'garbage');
    const b = load();
    expect(b.created).toBe(true);
    expect(b.hostId).toBe(a.hostId);

    fs.unlinkSync(b.keyPath);
    const c = load();
    expect(c.created).toBe(true);

    // A key from some other pair (e.g. a torn write) must not be served.
    const other = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    fs.writeFileSync(c.keyPath, other.privateKey.export({ type: 'pkcs8', format: 'pem' }));
    const d = load();
    expect(d.created).toBe(true);
    expect(d.hostId).toBe(a.hostId);
    expect(load().created).toBe(false);
  });

  it('omits a hostname that is not a valid SAN dNSName but still issues a certificate', () => {
    const id = load({ hostname: '개발_PC', ipAddresses: [] });
    const x = new crypto.X509Certificate(fs.readFileSync(id.certPath));
    expect(x.subject).toBe('CN=개발_PC');
    expect(x.subjectAltName).toBeUndefined();
    expect(load({ hostname: '개발_PC', ipAddresses: [] }).created).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('writes the private key owner-only (0600)', () => {
    const id = load();
    expect(fs.statSync(id.keyPath).mode & 0o777).toBe(0o600);
    // A loosened key is repaired on re-issue.
    fs.chmodSync(id.keyPath, 0o644);
    load({ hostname: 'elsewhere' });
    expect(fs.statSync(id.keyPath).mode & 0o777).toBe(0o600);
  });
});
