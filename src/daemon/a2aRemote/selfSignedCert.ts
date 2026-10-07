// Self-signed ECDSA P-256 server certificate for the cross-host A2A listener,
// built with node:crypto and a hand-rolled DER encoder (no dependencies).
// Nothing publicly trusts this certificate: joiners pin its SHA-256
// fingerprint out of band (the invite string), so the SAN set only has to be
// well-formed, not authoritative.

import crypto from 'node:crypto';
import net from 'node:net';
import type { CertFingerprint256 } from '../../shared/a2aRemote';
import {
  bitString,
  boolean,
  explicit,
  implicitPrimitive,
  integer,
  octetString,
  oid,
  sequence,
  set,
  utf8String,
  x509Time,
} from './der';

export interface SelfSignedCertOptions {
  /** Subject and issuer CN. 1..64 characters, counted by code point (RFC 5280 ub-common-name). */
  commonName: string;
  /** SAN dNSName entries (ASCII host names). */
  dnsNames: string[];
  /** SAN iPAddress entries — canonical IPv4 dotted quads only (4-byte form). */
  ipAddresses: string[];
  /** Validity length in whole days from `now`. */
  validDays: number;
  now?: Date;
}

export interface SelfSignedCert {
  certPem: string;
  /** PKCS#8 PEM of the P-256 private key. Secret — persist owner-only. */
  keyPem: string;
  fingerprint256: CertFingerprint256;
  /** ISO timestamp, second precision, exactly as encoded in the certificate. */
  notAfter: string;
}

const DAY_MS = 86_400_000;

const OID_ECDSA_WITH_SHA256 = '1.2.840.10045.4.3.2';
const OID_COMMON_NAME = '2.5.4.3';
const OID_SUBJECT_KEY_ID = '2.5.29.14';
const OID_KEY_USAGE = '2.5.29.15';
const OID_SUBJECT_ALT_NAME = '2.5.29.17';
const OID_BASIC_CONSTRAINTS = '2.5.29.19';
const OID_EXT_KEY_USAGE = '2.5.29.37';
const OID_KP_SERVER_AUTH = '1.3.6.1.5.5.7.3.1';

const DNS_NAME_RE = /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;

/** True iff `name` can go in a SAN dNSName (an ASCII LDH host name). */
export function isSanDnsName(name: string): boolean {
  return DNS_NAME_RE.test(name);
}

function extension(extnId: string, critical: boolean, value: Buffer): Buffer {
  // DER: a DEFAULT FALSE `critical` is omitted, never encoded.
  return critical
    ? sequence(oid(extnId), boolean(true), octetString(value))
    : sequence(oid(extnId), octetString(value));
}

function ipv4Bytes(ip: string): Buffer {
  const octets = ip.split('.').map(Number);
  // Canonical dotted quad only: '010.1.2.3' is ambiguous (octal in some parsers).
  if (!net.isIPv4(ip) || octets.join('.') !== ip) throw new RangeError(`SAN iPAddress must be a canonical IPv4: ${JSON.stringify(ip)}`);
  return Buffer.from(octets);
}

/** Upper-case colon-separated SHA-256 of the DER, i.e. `X509Certificate.fingerprint256` form. */
function fingerprintOf(der: Buffer): CertFingerprint256 {
  const hex = crypto.createHash('sha256').update(der).digest('hex').toUpperCase();
  return hex.replace(/(..)(?!$)/g, '$1:');
}

function toPem(der: Buffer): string {
  const body = der.toString('base64').replace(/.{64}(?!$)/g, '$&\n');
  return `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----\n`;
}

export function generateSelfSignedCert(opts: SelfSignedCertOptions): SelfSignedCert {
  const { commonName, dnsNames, ipAddresses, validDays } = opts;
  const cnLength = Array.from(commonName).length; // characters, not UTF-16 units
  if (cnLength < 1 || cnLength > 64) throw new RangeError(`commonName must be 1..64 characters (got ${cnLength})`);
  if (!Number.isInteger(validDays) || validDays < 1) throw new RangeError(`validDays must be a positive integer: ${validDays}`);
  for (const name of dnsNames) {
    if (!isSanDnsName(name)) throw new RangeError(`SAN dNSName is not an ASCII host name: ${JSON.stringify(name)}`);
  }
  const ipBytes = ipAddresses.map(ipv4Bytes);

  // Second precision so the returned notAfter equals the encoded one.
  const nowMs = Math.floor((opts.now ?? new Date()).getTime() / 1000) * 1000;
  const notBefore = new Date(nowMs - DAY_MS);
  const notAfter = new Date(nowMs + validDays * DAY_MS);

  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  // The SPKI BIT STRING content for an EC key is the uncompressed point 04||X||Y.
  const jwk = publicKey.export({ format: 'jwk' });
  const ecPoint = Buffer.concat([
    Buffer.from([0x04]),
    Buffer.from(jwk.x as string, 'base64url'),
    Buffer.from(jwk.y as string, 'base64url'),
  ]);

  // 16 random bytes, high bit cleared (positive) and the next bit set so the
  // leading octet is never 0x00 (keeps the INTEGER minimal at 16 octets).
  const serial = crypto.randomBytes(16);
  serial[0] = (serial[0] & 0x7f) | 0x40;

  const sigAlg = sequence(oid(OID_ECDSA_WITH_SHA256)); // no parameters for ECDSA
  const name = sequence(set(sequence(oid(OID_COMMON_NAME), utf8String(commonName))));

  const sanEntries = [
    ...dnsNames.map((n) => implicitPrimitive(2, Buffer.from(n, 'ascii'))),
    ...ipBytes.map((b) => implicitPrimitive(7, b)),
  ];
  const extensions = [
    extension(OID_BASIC_CONSTRAINTS, true, sequence()), // cA DEFAULT FALSE -> empty SEQUENCE
    extension(OID_KEY_USAGE, true, bitString(Buffer.from([0x80]), 7)), // digitalSignature (bit 0)
    extension(OID_EXT_KEY_USAGE, false, sequence(oid(OID_KP_SERVER_AUTH))),
    // RFC 5280: an empty SAN is invalid, so omit the extension entirely.
    ...(sanEntries.length ? [extension(OID_SUBJECT_ALT_NAME, false, sequence(...sanEntries))] : []),
    extension(OID_SUBJECT_KEY_ID, false, octetString(crypto.createHash('sha1').update(ecPoint).digest())),
  ];

  const tbs = sequence(
    explicit(0, integer(2)), // v3
    integer(serial),
    sigAlg,
    name,
    sequence(x509Time(notBefore), x509Time(notAfter)),
    name,
    spki,
    explicit(3, sequence(...extensions)),
  );
  const signature = crypto.sign('sha256', tbs, privateKey); // DER ECDSA-Sig-Value
  const certDer = sequence(tbs, sigAlg, bitString(signature));

  return {
    certPem: toPem(certDer),
    keyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
    fingerprint256: fingerprintOf(certDer),
    notAfter: notAfter.toISOString(),
  };
}
