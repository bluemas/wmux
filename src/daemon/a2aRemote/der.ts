// Minimal ASN.1 DER encoder — just enough to build one X.509 v3 certificate
// (see selfSignedCert.ts). Encode-only by design: nothing here parses
// untrusted input; Node's X509Certificate does all parsing.

function encodeLength(len: number): Buffer {
  if (len < 0x80) return Buffer.from([len]);
  const bytes: number[] = [];
  for (let n = len; n > 0; n = Math.floor(n / 256)) bytes.unshift(n & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

/** Tag-length-value with a raw identifier octet. */
export function tlv(tag: number, content: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), encodeLength(content.length), content]);
}

export const sequence = (...items: Buffer[]): Buffer => tlv(0x30, Buffer.concat(items));
export const set = (...items: Buffer[]): Buffer => tlv(0x31, Buffer.concat(items));
export const octetString = (b: Buffer): Buffer => tlv(0x04, b);
/** DER BOOLEAN: TRUE is 0xFF. (A DEFAULT FALSE must be omitted by the caller, not encoded.) */
export const boolean = (v: boolean): Buffer => tlv(0x01, Buffer.from([v ? 0xff : 0x00]));
export const utf8String = (s: string): Buffer => tlv(0x0c, Buffer.from(s, 'utf8'));

/** BIT STRING with `unusedBits` trailing pad bits in the last octet. */
export function bitString(b: Buffer, unusedBits = 0): Buffer {
  return tlv(0x03, Buffer.concat([Buffer.from([unusedBits]), b]));
}

/**
 * INTEGER from a non-negative number or big-endian magnitude bytes. Emits the
 * minimal two's-complement form: leading zero octets stripped, one 0x00 added
 * back when the high bit would otherwise read as negative.
 */
export function integer(v: number | Buffer): Buffer {
  let bytes: Buffer;
  if (typeof v === 'number') {
    if (!Number.isSafeInteger(v) || v < 0) throw new RangeError(`unsupported INTEGER: ${v}`);
    const arr: number[] = [];
    for (let n = v; n > 0; n = Math.floor(n / 256)) arr.unshift(n & 0xff);
    bytes = Buffer.from(arr.length ? arr : [0]);
  } else {
    bytes = v;
  }
  let i = 0;
  while (i < bytes.length - 1 && bytes[i] === 0) i++;
  bytes = bytes.subarray(i);
  if (bytes.length === 0) bytes = Buffer.from([0]);
  if (bytes[0] & 0x80) bytes = Buffer.concat([Buffer.from([0]), bytes]);
  return tlv(0x02, bytes);
}

export function oid(dotted: string): Buffer {
  const arcs = dotted.split('.').map((a) => {
    if (!/^\d+$/.test(a)) throw new RangeError(`bad OID: ${dotted}`);
    return Number(a);
  });
  if (arcs.length < 2 || arcs[0] > 2 || (arcs[0] < 2 && arcs[1] > 39)) throw new RangeError(`bad OID: ${dotted}`);
  const out: number[] = [];
  const pushArc = (arc: number): void => {
    const septets = [arc & 0x7f];
    for (let n = Math.floor(arc / 128); n > 0; n = Math.floor(n / 128)) septets.unshift((n & 0x7f) | 0x80);
    out.push(...septets);
  };
  pushArc(arcs[0] * 40 + arcs[1]);
  for (const arc of arcs.slice(2)) pushArc(arc);
  return tlv(0x06, Buffer.from(out));
}

const pad2 = (n: number): string => String(n).padStart(2, '0');

function timeDigits(d: Date, fullYear: boolean): string {
  const y = d.getUTCFullYear();
  return (
    (fullYear ? String(y).padStart(4, '0') : pad2(y % 100)) +
    pad2(d.getUTCMonth() + 1) +
    pad2(d.getUTCDate()) +
    pad2(d.getUTCHours()) +
    pad2(d.getUTCMinutes()) +
    pad2(d.getUTCSeconds()) +
    'Z'
  );
}

export const utcTime = (d: Date): Buffer => tlv(0x17, Buffer.from(timeDigits(d, false), 'ascii'));
export const generalizedTime = (d: Date): Buffer => tlv(0x18, Buffer.from(timeDigits(d, true), 'ascii'));

/**
 * RFC 5280 §4.1.2.5: dates through 2049 MUST be UTCTime, 2050 onward MUST be
 * GeneralizedTime. Sub-second precision is dropped (DER forbids fractional
 * zeros and X.509 forbids fractions entirely).
 */
export function x509Time(d: Date): Buffer {
  const y = d.getUTCFullYear();
  if (y < 1950 || y > 9999) throw new RangeError(`date out of X.509 range: ${d.toISOString()}`);
  return y < 2050 ? utcTime(d) : generalizedTime(d);
}

/** EXPLICIT context tag [n] (constructed): wraps an already-encoded element. */
export const explicit = (n: number, inner: Buffer): Buffer => tlv(0xa0 | n, inner);
/** IMPLICIT context tag [n] on a primitive value: the raw content octets. */
export const implicitPrimitive = (n: number, content: Buffer): Buffer => tlv(0x80 | n, content);
