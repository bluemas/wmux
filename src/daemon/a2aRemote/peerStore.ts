import crypto from 'node:crypto';
import path from 'node:path';
import { atomicWriteJSONSync } from '../util/atomicWrite';
import { scheduleTokenFileReHarden } from '../../shared/security';
import { DEVICE_KDF, DEVICE_SALT_BYTES, DEVICE_SECRET_BYTES, LAST_SEEN_PERSIST_MS, type DeviceKdfParams } from '../web/DeviceStore';
import { A2A_REMOTE_RECORD_V, isHostId, type A2aPeerRecordV1, type HostId } from '../../shared/a2aRemote';
import { errMsg, isIsoString, isNonEmptyString, isPlainObject, preserveCorrupt, readStoreFile, type StoreLog } from './storeFile';

/**
 * Server side of cross-host A2A pairing: the joiners this host issued a PEER
 * credential to (`peers.json`). Deliberately a different file and a different
 * class from `DeviceStore` — a peer is never a web device and never becomes a
 * `WebPrincipal`.
 *
 * Secrets are handled exactly like DeviceStore's: 32 CSPRNG bytes handed out
 * once, and only a per-peer salted scrypt output (same `DEVICE_KDF`
 * parameters, stored per record) on disk. Verification is length-independent
 * (scrypt output is fixed-length) and constant-time, with the same SHA-256
 * cache so legitimate traffic pays one derivation per daemon boot.
 *
 * Corrupt file: FAIL-CLOSED. Any invalid record rejects the whole file, the
 * store starts empty (nobody authenticates; joiners re-pair), and the original
 * is kept as `peers.json.corrupt-<ts>`.
 *
 * Write failure: `mint` rolls back and throws (a secret nothing on disk knows
 * cannot be handed out). `revoke` keeps the in-memory revocation and throws
 * (#658). `touch` is best-effort.
 */

export const PEERS_FILE = 'peers.json';

/** What `resolve` answers. Consumed STRUCTURALLY by the web server's peer resolver. */
export type PeerAuthResult =
  | { ok: true; peerId: string; hostId: string; name: string }
  | { ok: false; reason: 'unknown' | 'revoked' };

interface StoredPeer extends A2aPeerRecordV1 {
  /** Hex scrypt output; not a credential on its own. */
  secretHash: string;
  /** Hex per-peer salt. */
  salt: string;
  kdf: DeviceKdfParams;
}

interface PeersFileV1 {
  v: 1;
  peers: StoredPeer[];
}

const PEER_NAME_MAX = 64;
const UNNAMED_PEER = 'Unnamed host';
/** Same ceiling as DeviceStore: fail loudly at the call site on a parameter bump. */
const SCRYPT_MAXMEM = 64 * 1024 * 1024;
const VERIFIED_CACHE_CAP = 64;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const REJECT_UNKNOWN: PeerAuthResult = Object.freeze({ ok: false as const, reason: 'unknown' as const });
const REJECT_REVOKED: PeerAuthResult = Object.freeze({ ok: false as const, reason: 'revoked' as const });

export interface PeerStoreOptions {
  /** Directory holding the store, e.g. `<wmux data dir>/a2a/`. */
  dir: string;
  now?: () => number;
  log?: StoreLog;
  /** Test seam; defaults to `atomicWriteJSONSync`. */
  write?: (filePath: string, data: unknown) => void;
  /** Test seam; defaults to the deferred owner-only re-harden. */
  scheduleHarden?: (filePath: string) => void;
}

export class PeerStore {
  readonly filePath: string;
  private readonly now: () => number;
  private readonly log: StoreLog;
  private readonly write: (filePath: string, data: unknown) => void;
  private readonly scheduleHarden: (filePath: string) => void;
  private readonly peers = new Map<string, StoredPeer>();
  private readonly verified = new Map<string, { secretDigest: Buffer; hashHex: string }>();
  private readonly lastSeenPersistedAt = new Map<string, number>();

  constructor(opts: PeerStoreOptions) {
    this.filePath = path.join(opts.dir, PEERS_FILE);
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? ((): void => undefined);
    this.write = opts.write ?? ((p, d): void => atomicWriteJSONSync(p, d));
    this.scheduleHarden = opts.scheduleHarden ?? scheduleTokenFileReHarden;
    this.load();
  }

  /** Display view. Never carries the hash, salt or KDF parameters. */
  list(): A2aPeerRecordV1[] {
    return [...this.peers.values()].map(project);
  }

  /**
   * Issue a peer credential. Persists BEFORE returning; throws (after rolling
   * back) when the roster cannot be written.
   */
  async mint(params: { hostId: HostId; name: string }): Promise<{ peerId: string; secret: string }> {
    if (!isHostId(params.hostId)) throw new Error('peer: invalid hostId');
    const secret = crypto.randomBytes(DEVICE_SECRET_BYTES).toString('base64url');
    const salt = crypto.randomBytes(DEVICE_SALT_BYTES);
    const kdf: DeviceKdfParams = { ...DEVICE_KDF };
    let peerId = crypto.randomUUID();
    while (this.peers.has(peerId)) peerId = crypto.randomUUID();
    const at = this.now();
    const rec: StoredPeer = {
      v: A2A_REMOTE_RECORD_V,
      peerId,
      hostId: params.hostId,
      name: sanitizeName(params.name),
      createdAt: new Date(at).toISOString(),
      secretHash: derive(secret, salt, kdf).toString('hex'),
      salt: salt.toString('hex'),
      kdf,
    };
    this.peers.set(peerId, rec);
    try {
      this.persist();
    } catch (err) {
      this.peers.delete(peerId);
      throw err;
    }
    this.rememberVerified(peerId, sha256(Buffer.from(secret, 'utf8')), rec.secretHash);
    this.lastSeenPersistedAt.set(peerId, at);
    return { peerId, secret };
  }

  /**
   * Resolve a peer credential. Total; never throws.
   *   1. Unknown id → `unknown`, no derivation (a garbage id is no CPU lever).
   *   2. Revoked → `revoked` WITHOUT verifying the secret (DeviceStore rule).
   *   3. Otherwise constant-time verify; a wrong secret is `unknown`, never
   *      revealing which half of the credential was right.
   */
  async resolve(
    peerId: string,
    secret: string,
  ): Promise<{ ok: true; peerId: string; hostId: string; name: string } | { ok: false; reason: 'unknown' | 'revoked' }> {
    const rec = typeof peerId === 'string' ? this.peers.get(peerId) : undefined;
    if (!rec) return REJECT_UNKNOWN;
    if (rec.revokedAt !== undefined) return REJECT_REVOKED;
    if (typeof secret !== 'string' || !this.verify(rec, secret)) return REJECT_UNKNOWN;
    return { ok: true, peerId: rec.peerId, hostId: rec.hostId, name: rec.name };
  }

  /** Note a successful auth: always in memory, on disk at most once per `LAST_SEEN_PERSIST_MS`. */
  touch(peerId: string): void {
    const rec = this.peers.get(peerId);
    if (!rec || rec.revokedAt !== undefined) return;
    const at = this.now();
    rec.lastSeenAt = new Date(at).toISOString();
    if (at - (this.lastSeenPersistedAt.get(peerId) ?? 0) < LAST_SEEN_PERSIST_MS) return;
    this.lastSeenPersistedAt.set(peerId, at);
    try {
      this.persist();
    } catch (err) {
      // A lost timestamp costs a stale roster line, nothing more.
      this.log('warn', `[a2a-remote] could not persist lastSeenAt for peer ${peerId}: ${errMsg(err)}`);
    }
  }

  /**
   * Revoke a peer. Returns false when it is unknown or already revoked. On a
   * failed write the revocation STAYS in memory (the peer is refused until
   * restart) and the error is rethrown.
   */
  revoke(peerId: string): boolean {
    const rec = this.peers.get(peerId);
    if (!rec || rec.revokedAt !== undefined) return false;
    rec.revokedAt = new Date(this.now()).toISOString();
    this.verified.delete(peerId);
    try {
      this.persist();
    } catch (err) {
      this.log('error', `[a2a-remote] peer ${peerId} is revoked in memory but could not be persisted`);
      throw err;
    }
    return true;
  }

  // --- internals --------------------------------------------------------------

  /** Constant-time; no branch on the presented secret's length (see DeviceStore.verify). */
  private verify(rec: StoredPeer, secret: string): boolean {
    const secretBuf = Buffer.from(secret, 'utf8');
    const digest = sha256(secretBuf);
    const cached = this.verified.get(rec.peerId);
    if (cached && cached.hashHex === rec.secretHash && crypto.timingSafeEqual(digest, cached.secretDigest)) {
      return true;
    }
    let derived: Buffer;
    try {
      derived = derive(secretBuf, Buffer.from(rec.salt, 'hex'), rec.kdf);
    } catch (err) {
      this.log('warn', `[a2a-remote] peer ${rec.peerId} hash could not be derived: ${errMsg(err)}`);
      return false;
    }
    const expected = Buffer.from(rec.secretHash, 'hex');
    if (expected.length !== derived.length) return false;
    const ok = crypto.timingSafeEqual(derived, expected);
    if (ok) this.rememberVerified(rec.peerId, digest, rec.secretHash);
    return ok;
  }

  private rememberVerified(peerId: string, secretDigest: Buffer, hashHex: string): void {
    this.verified.set(peerId, { secretDigest, hashHex });
    if (this.verified.size > VERIFIED_CACHE_CAP) {
      const oldest = this.verified.keys().next();
      if (!oldest.done) this.verified.delete(oldest.value);
    }
  }

  private persist(): void {
    const file: PeersFileV1 = { v: A2A_REMOTE_RECORD_V, peers: [...this.peers.values()] };
    this.write(this.filePath, file);
    // The file holds no secret (salted scrypt outputs of 256-bit secrets), so
    // the deferred owner-only re-harden is enough — DeviceStore's reasoning.
    this.scheduleHarden(this.filePath);
  }

  private load(): void {
    const read = readStoreFile(this.filePath);
    if (read.kind === 'missing') return;
    const records = read.kind === 'parsed' ? coerceFile(read.value) : null;
    if (!records) {
      const detail = read.kind === 'corrupt' ? read.detail : 'invalid record';
      const kept = preserveCorrupt(this.filePath, this.now, this.log);
      this.log(
        'error',
        `[a2a-remote] ${PEERS_FILE} is corrupt (${detail}); no peer can authenticate until re-paired. Original kept at ${kept ?? '(could not move)'}`,
      );
      return;
    }
    for (const rec of records) this.peers.set(rec.peerId, rec);
  }
}

function project(r: StoredPeer): A2aPeerRecordV1 {
  return {
    v: 1,
    peerId: r.peerId,
    hostId: r.hostId,
    name: r.name,
    createdAt: r.createdAt,
    ...(r.lastSeenAt !== undefined ? { lastSeenAt: r.lastSeenAt } : {}),
    ...(r.revokedAt !== undefined ? { revokedAt: r.revokedAt } : {}),
  };
}

function derive(secret: string | Buffer, salt: Buffer, kdf: DeviceKdfParams): Buffer {
  return crypto.scryptSync(secret, salt, kdf.keylen, { N: kdf.N, r: kdf.r, p: kdf.p, maxmem: SCRYPT_MAXMEM });
}

function sha256(input: Buffer): Buffer {
  return crypto.createHash('sha256').update(input).digest();
}

function sanitizeName(name: unknown): string {
  const cleaned = (typeof name === 'string' ? name : '')
    // eslint-disable-next-line no-control-regex -- matching control characters is the point
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return UNNAMED_PEER;
  return cleaned.length > PEER_NAME_MAX ? cleaned.slice(0, PEER_NAME_MAX) : cleaned;
}

/** Whole-file validation (fail-closed): any record we cannot verify against rejects the file. */
function coerceFile(raw: unknown): StoredPeer[] | null {
  if (!isPlainObject(raw) || raw['v'] !== 1 || !Array.isArray(raw['peers'])) return null;
  const out: StoredPeer[] = [];
  const seen = new Set<string>();
  for (const r of raw['peers']) {
    if (!isPlainObject(r) || r['v'] !== 1) return null;
    const { peerId, hostId, name, createdAt, lastSeenAt, revokedAt, secretHash, salt } = r;
    const kdf = coerceKdf(r['kdf']);
    if (typeof peerId !== 'string' || !UUID_RE.test(peerId) || seen.has(peerId)) return null;
    if (!isHostId(hostId) || !isNonEmptyString(name) || !isIsoString(createdAt)) return null;
    if (lastSeenAt !== undefined && !isIsoString(lastSeenAt)) return null;
    if (revokedAt !== undefined && !isIsoString(revokedAt)) return null;
    if (!isHex(secretHash) || !isHex(salt) || !kdf) return null;
    seen.add(peerId);
    out.push({
      v: 1,
      peerId,
      hostId,
      name: sanitizeName(name),
      createdAt,
      ...(lastSeenAt !== undefined ? { lastSeenAt } : {}),
      ...(revokedAt !== undefined ? { revokedAt } : {}),
      secretHash,
      salt,
      kdf,
    });
  }
  return out;
}

/** Same bounds as DeviceStore: a hand-edited record must not be a CPU/memory lever. */
function coerceKdf(raw: unknown): DeviceKdfParams | null {
  if (!isPlainObject(raw) || raw['algo'] !== 'scrypt') return null;
  const N = positiveInt(raw['N']);
  const r = positiveInt(raw['r']);
  const p = positiveInt(raw['p']);
  const keylen = positiveInt(raw['keylen']);
  if (!N || !r || !p || !keylen) return null;
  if (N > 1 << 20 || r > 32 || p > 16 || keylen > 128) return null;
  return { algo: 'scrypt', N, r, p, keylen };
}

function positiveInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}

function isHex(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length % 2 === 0 && /^[0-9a-f]+$/i.test(value);
}
