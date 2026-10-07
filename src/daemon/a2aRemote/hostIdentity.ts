// This host's cross-host A2A identity: a stable hostId plus the self-signed
// TLS certificate the A2A listener serves.
//
//   <dir>/host.json  { v: 1, hostId, createdAt }  — minted ONCE, never rewritten
//   <dir>/key.pem    PKCS#8 P-256 private key       — owner-only (secureWriteTokenFile)
//   <dir>/cert.pem   self-signed certificate         — public
//
// The certificate is disposable and is re-issued when missing, unreadable,
// mismatched with the key, near expiry, or no longer naming this machine's
// current hostname/IPv4s. The hostId survives every re-issue: links are bound
// to the hostId, and the fingerprint is only a property of it (contract
// `HostId`). Re-issuing changes the fingerprint joiners pinned; `created`
// tells the caller that happened.

import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { A2A_REMOTE_RECORD_V, isHostId, type CertFingerprint256, type HostId } from '../../shared/a2aRemote';
import { secureWriteTokenFile } from '../../shared/security';
import { atomicWriteJSONSync, atomicWriteTextSync } from '../util/atomicWrite';
import { generateSelfSignedCert, isSanDnsName } from './selfSignedCert';

/**
 * Long on purpose: nothing publicly trusts this certificate (joiners pin its
 * fingerprint), and every re-issue forces every joiner to re-pin.
 */
export const HOST_CERT_VALID_DAYS = 3650;
/** Re-issue when fewer than this many days of validity remain. */
export const HOST_CERT_RENEW_BEFORE_DAYS = 30;

const DAY_MS = 86_400_000;

interface HostRecordV1 {
  v: 1;
  hostId: HostId;
  createdAt: string;
}

export interface HostIdentityOptions {
  /** Directory holding host.json / cert.pem / key.pem (created if absent). */
  dir: string;
  /** This machine's name; goes in the CN and, when a valid ASCII host name, a SAN dNSName. */
  hostname: string;
  /** This machine's current LAN addresses. Only IPv4 is placed in the SAN; others are ignored. */
  ipAddresses: string[];
  now?: Date;
}

export interface HostIdentity {
  hostId: HostId;
  certPath: string;
  keyPath: string;
  fingerprint256: CertFingerprint256;
  notAfter: string;
  /** True when this call (re-)issued the certificate, i.e. the fingerprint changed. */
  created: boolean;
}

/**
 * Read host.json, or mint it when it does not exist. A host.json that exists
 * but does not parse to a valid v1 record THROWS: silently minting a new
 * hostId would invalidate every link this host has, so a human must look.
 */
function loadOrMintHostId(file: string, now: Date): HostId {
  let raw: string | null = null;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  if (raw !== null) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = null;
    }
    const rec = parsed as Partial<HostRecordV1> | null;
    if (!rec || typeof rec !== 'object' || rec.v !== A2A_REMOTE_RECORD_V || !isHostId(rec.hostId)) {
      throw new Error(`A2A host identity file is corrupt; refusing to mint a new hostId: ${file}`);
    }
    return rec.hostId;
  }
  const record: HostRecordV1 = { v: A2A_REMOTE_RECORD_V, hostId: crypto.randomUUID(), createdAt: now.toISOString() };
  atomicWriteJSONSync(file, record, { durable: true });
  return record.hostId;
}

/** Parse cert.pem + key.pem; null when either is missing, unreadable, or they do not belong together. */
function tryLoadCert(certPath: string, keyPath: string): crypto.X509Certificate | null {
  try {
    const cert = new crypto.X509Certificate(fs.readFileSync(certPath));
    const key = crypto.createPrivateKey(fs.readFileSync(keyPath));
    return cert.checkPrivateKey(key) ? cert : null;
  } catch {
    return null;
  }
}

function sanNames(cert: crypto.X509Certificate): { dns: Set<string>; ips: Set<string> } {
  const dns = new Set<string>();
  const ips = new Set<string>();
  for (const entry of (cert.subjectAltName ?? '').split(', ')) {
    if (entry.startsWith('DNS:')) dns.add(entry.slice(4).toLowerCase());
    else if (entry.startsWith('IP Address:')) ips.add(entry.slice(11));
  }
  return { dns, ips };
}

function isReusable(cert: crypto.X509Certificate, now: Date, dnsNames: string[], ips: string[]): boolean {
  const nowMs = now.getTime();
  if (Date.parse(cert.validFrom) > nowMs) return false; // clock went backwards past notBefore
  if (Date.parse(cert.validTo) - nowMs <= HOST_CERT_RENEW_BEFORE_DAYS * DAY_MS) return false;
  const san = sanNames(cert);
  return dnsNames.every((n) => san.dns.has(n)) && ips.every((ip) => san.ips.has(ip));
}

export function loadOrCreateHostIdentity(opts: HostIdentityOptions): HostIdentity {
  const now = opts.now ?? new Date();
  const dir = opts.dir;
  fs.mkdirSync(dir, { recursive: true });
  const certPath = path.join(dir, 'cert.pem');
  const keyPath = path.join(dir, 'key.pem');

  const hostId = loadOrMintHostId(path.join(dir, 'host.json'), now);

  const hostname = opts.hostname.trim();
  const dnsNames = isSanDnsName(hostname) ? [hostname.toLowerCase()] : [];
  const ips = [...new Set(opts.ipAddresses.filter((ip) => net.isIPv4(ip)))];

  const existing = tryLoadCert(certPath, keyPath);
  if (existing && isReusable(existing, now, dnsNames, ips)) {
    return {
      hostId,
      certPath,
      keyPath,
      fingerprint256: existing.fingerprint256,
      notAfter: new Date(existing.validTo).toISOString(),
      created: false,
    };
  }

  const cert = generateSelfSignedCert({
    commonName: hostname.slice(0, 64) || 'wmux',
    dnsNames,
    ipAddresses: ips,
    validDays: HOST_CERT_VALID_DAYS,
    now,
  });
  // Key first: if the cert write then fails, the key no longer matches the old
  // cert and the next call re-issues instead of serving a mismatched pair.
  secureWriteTokenFile(keyPath, cert.keyPem);
  atomicWriteTextSync(certPath, cert.certPem);
  return { hostId, certPath, keyPath, fingerprint256: cert.fingerprint256, notAfter: cert.notAfter, created: true };
}
