import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteJSONSync } from '../util/atomicWrite';
import { reHardenTokenFileAcl, type HardenOutcome } from '../../shared/security';
import {
  A2A_REMOTE_RECORD_V,
  formatPeerCredential,
  isHostId,
  normalizeFingerprint256,
  parsePeerCredential,
  type A2aRemoteHostRecordV1,
  type CertFingerprint256,
  type HostId,
  type PeerCredential,
} from '../../shared/a2aRemote';
import { errMsg, isIsoString, isNonEmptyString, isPlainObject, preserveCorrupt, readStoreFile, type StoreLog } from './storeFile';

/**
 * Joiner side of cross-host A2A pairing: the server hosts this machine paired
 * with, plus the peer credential each one issued (`remote-hosts.json`).
 *
 * The credential is a PLAINTEXT bearer, so it lives in a separate `secrets`
 * field of the same file — one atomic write, no two-file all-or-nothing — and
 * the file gets the LanLink peer store's fail-closed treatment: after every
 * write the owner-only ACL is applied SYNCHRONOUSLY, and on Windows a failed
 * harden unlinks the file and throws rather than leave a bearer
 * broad-readable. `get` / `list` never carry the secret; only `credentialFor`
 * does.
 *
 * Corrupt file: FAIL-CLOSED. Any invalid record rejects the whole file; the
 * store starts empty (no credential is presented anywhere; re-pair) and the
 * original is kept as `remote-hosts.json.corrupt-<ts>`.
 *
 * Write failure: `add` / `updateAddresses` / `updateFingerprint` roll memory
 * back and throw. `remove` keeps the in-memory removal and throws (#658: a
 * removal that un-happens on a disk error would keep presenting a credential
 * the operator meant to drop).
 */

export const REMOTE_HOSTS_FILE = 'remote-hosts.json';

interface RemoteHostsFileV1 {
  v: 1;
  hosts: A2aRemoteHostRecordV1[];
  /** hostId -> peer secret. The peerId lives on the host record. */
  secrets: Record<string, string>;
}

/** What `add` takes; the store stamps `v` and `createdAt`. */
export type NewRemoteHost = Omit<A2aRemoteHostRecordV1, 'v' | 'createdAt' | 'lastSeenAt'>;

const IPV4_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Machine names first (company DNS survives DHCP), then IPv4s, each group in
 * the given order; trimmed, empty entries dropped, duplicates removed
 * case-insensitively.
 */
export function orderAddresses(addresses: readonly string[]): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  const ips: string[] = [];
  for (const raw of addresses) {
    if (typeof raw !== 'string') continue;
    const a = raw.trim();
    const key = a.toLowerCase();
    if (!a || seen.has(key)) continue;
    seen.add(key);
    (IPV4_RE.test(a) ? ips : names).push(a);
  }
  return [...names, ...ips];
}

export interface RemoteHostStoreOptions {
  /** Directory holding the store, e.g. `<wmux data dir>/a2a/`. */
  dir: string;
  now?: () => number;
  log?: StoreLog;
  /** Test seam; defaults to `atomicWriteJSONSync`. */
  write?: (filePath: string, data: unknown) => void;
  /** Test seam; defaults to the synchronous `reHardenTokenFileAcl`. */
  reHarden?: (filePath: string) => HardenOutcome;
  /** Test seam; defaults to `process.platform === 'win32'`. */
  win32?: boolean;
}

export class RemoteHostStore {
  readonly filePath: string;
  private readonly now: () => number;
  private readonly log: StoreLog;
  private readonly write: (filePath: string, data: unknown) => void;
  private readonly reHarden: (filePath: string) => HardenOutcome;
  private readonly win32: boolean;
  private readonly hosts = new Map<HostId, A2aRemoteHostRecordV1>();
  private readonly secrets = new Map<HostId, string>();

  constructor(opts: RemoteHostStoreOptions) {
    this.filePath = path.join(opts.dir, REMOTE_HOSTS_FILE);
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? ((): void => undefined);
    this.write = opts.write ?? ((p, d): void => atomicWriteJSONSync(p, d));
    this.reHarden = opts.reHarden ?? reHardenTokenFileAcl;
    this.win32 = opts.win32 ?? process.platform === 'win32';
    this.load();
  }

  get(hostId: HostId): A2aRemoteHostRecordV1 | undefined {
    const rec = this.hosts.get(hostId);
    return rec ? structuredClone(rec) : undefined;
  }

  /** Display view. Never carries a secret. */
  list(): A2aRemoteHostRecordV1[] {
    return [...this.hosts.values()].map((r) => structuredClone(r));
  }

  /** The credential to present to `hostId`, or null when not paired. */
  credentialFor(hostId: HostId): PeerCredential | null {
    const rec = this.hosts.get(hostId);
    const secret = this.secrets.get(hostId);
    return rec && secret ? { peerId: rec.peerId, secret } : null;
  }

  /** Record a pairing. Re-pairing with a known hostId replaces it. */
  add(input: NewRemoteHost, credential: PeerCredential): A2aRemoteHostRecordV1 {
    const rec = buildRecord(input, new Date(this.now()).toISOString());
    if (typeof rec === 'string') throw new Error(`remote host: ${rec}`);
    if (!credential || credential.peerId !== rec.peerId || !parsePeerCredential(formatPeerCredential(credential))) {
      throw new Error('remote host: invalid credential');
    }
    this.mutate(rec.hostId, () => {
      this.hosts.set(rec.hostId, rec);
      this.secrets.set(rec.hostId, credential.secret);
    });
    return structuredClone(rec);
  }

  updateAddresses(hostId: HostId, addresses: string[]): A2aRemoteHostRecordV1 {
    const rec = this.require(hostId);
    const ordered = orderAddresses(addresses);
    if (ordered.length === 0) throw new Error('remote host: no usable address');
    const next = { ...rec, addresses: ordered };
    this.mutate(hostId, () => this.hosts.set(hostId, next));
    return structuredClone(next);
  }

  /** Re-pin after a certificate rotation. hostId (and so every link) is unchanged. */
  updateFingerprint(hostId: HostId, fingerprint: string): A2aRemoteHostRecordV1 {
    const rec = this.require(hostId);
    const fp: CertFingerprint256 | null = normalizeFingerprint256(fingerprint);
    if (!fp) throw new Error('remote host: invalid fingerprint');
    const next = { ...rec, fingerprint256: fp };
    this.mutate(hostId, () => this.hosts.set(hostId, next));
    return structuredClone(next);
  }

  /** Forget a host and its credential. Returns false when unknown. */
  remove(hostId: HostId): boolean {
    if (!this.hosts.has(hostId)) return false;
    this.hosts.delete(hostId);
    this.secrets.delete(hostId);
    try {
      this.persist();
    } catch (err) {
      this.log('error', `[a2a-remote] remote host ${hostId} is removed in memory but could not be persisted`);
      throw err;
    }
    return true;
  }

  // --- internals --------------------------------------------------------------

  private require(hostId: HostId): A2aRemoteHostRecordV1 {
    const rec = this.hosts.get(hostId);
    if (!rec) throw new Error(`remote host ${hostId}: unknown host`);
    return rec;
  }

  /** Apply `change` for one host; restore that host's record and secret if the write fails. */
  private mutate(hostId: HostId, change: () => void): void {
    const prevRec = this.hosts.get(hostId);
    const prevSecret = this.secrets.get(hostId);
    change();
    try {
      this.persist();
    } catch (err) {
      if (prevRec) this.hosts.set(hostId, prevRec);
      else this.hosts.delete(hostId);
      if (prevSecret !== undefined) this.secrets.set(hostId, prevSecret);
      else this.secrets.delete(hostId);
      throw err;
    }
  }

  private persist(): void {
    const file: RemoteHostsFileV1 = {
      v: A2A_REMOTE_RECORD_V,
      hosts: [...this.hosts.values()],
      secrets: Object.fromEntries(this.secrets),
    };
    this.write(this.filePath, file);
    // Same discipline as the LanLink peer store: a bearer must never sit
    // broad-readable, so harden synchronously and fail closed on Windows.
    // ('unchanged' is a verified owner-only claim; only 'failed' is fatal.)
    const outcome = this.reHarden(this.filePath);
    if (this.win32 && outcome === 'failed') {
      try {
        fs.unlinkSync(this.filePath);
      } catch (unlinkErr) {
        this.log('error', `[a2a-remote] could not remove an un-hardened ${REMOTE_HOSTS_FILE}: ${errMsg(unlinkErr)}`);
      }
      throw new Error(`${REMOTE_HOSTS_FILE}: could not apply owner-only ACL — refusing to persist credentials`);
    }
    // The write rotated the previous generation to `.bak`. This store never
    // reads it, and it may still hold a bearer the operator just removed.
    try {
      fs.rmSync(`${this.filePath}.bak`, { force: true });
    } catch (err) {
      this.log('warn', `[a2a-remote] could not remove ${REMOTE_HOSTS_FILE}.bak: ${errMsg(err)}`);
    }
  }

  private load(): void {
    const read = readStoreFile(this.filePath);
    if (read.kind === 'missing') return;
    const parsed = read.kind === 'parsed' ? coerceFile(read.value) : null;
    if (!parsed) {
      const detail = read.kind === 'corrupt' ? read.detail : 'invalid record';
      const kept = preserveCorrupt(this.filePath, this.now, this.log);
      this.log(
        'error',
        `[a2a-remote] ${REMOTE_HOSTS_FILE} is corrupt (${detail}); no remote host is paired until re-paired. Original kept at ${kept ?? '(could not move)'}`,
      );
      return;
    }
    for (const rec of parsed.hosts) this.hosts.set(rec.hostId, rec);
    for (const [hostId, secret] of Object.entries(parsed.secrets)) this.secrets.set(hostId, secret);
  }
}

/** A clean record, or a string naming what is wrong. */
function buildRecord(input: NewRemoteHost, createdAt: string): A2aRemoteHostRecordV1 | string {
  if (!isPlainObject(input)) return 'invalid record';
  if (!isHostId(input.hostId)) return 'invalid hostId';
  if (!isNonEmptyString(input.name)) return 'invalid name';
  if (!Array.isArray(input.addresses)) return 'invalid addresses';
  const addresses = orderAddresses(input.addresses);
  if (addresses.length === 0) return 'no usable address';
  if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535) return 'invalid port';
  const fingerprint256 = normalizeFingerprint256(input.fingerprint256);
  if (!fingerprint256) return 'invalid fingerprint';
  if (typeof input.peerId !== 'string' || !UUID_RE.test(input.peerId)) return 'invalid peerId';
  return {
    v: A2A_REMOTE_RECORD_V,
    hostId: input.hostId,
    name: input.name,
    addresses,
    port: input.port,
    fingerprint256,
    peerId: input.peerId,
    createdAt,
  };
}

/** Whole-file validation (fail-closed): every host needs a valid record AND a valid secret. */
function coerceFile(raw: unknown): { hosts: A2aRemoteHostRecordV1[]; secrets: Record<string, string> } | null {
  if (!isPlainObject(raw) || raw['v'] !== 1 || !Array.isArray(raw['hosts']) || !isPlainObject(raw['secrets'])) return null;
  const secretsIn = raw['secrets'];
  const hosts: A2aRemoteHostRecordV1[] = [];
  const secrets: Record<string, string> = {};
  for (const r of raw['hosts']) {
    if (!isPlainObject(r) || r['v'] !== 1 || !isIsoString(r['createdAt'])) return null;
    const rec = buildRecord(r as unknown as NewRemoteHost, r['createdAt']);
    if (typeof rec === 'string' || Object.hasOwn(secrets, rec.hostId)) return null;
    const lastSeenAt = r['lastSeenAt'];
    if (lastSeenAt !== undefined) {
      if (!isIsoString(lastSeenAt)) return null;
      rec.lastSeenAt = lastSeenAt;
    }
    const secret = Object.hasOwn(secretsIn, rec.hostId) ? secretsIn[rec.hostId] : undefined;
    if (typeof secret !== 'string' || !parsePeerCredential(formatPeerCredential({ peerId: rec.peerId, secret }))) return null;
    secrets[rec.hostId] = secret;
    hosts.push(rec);
  }
  // A secret with no host record is something we cannot account for.
  if (Object.keys(secretsIn).length !== hosts.length) return null;
  return { hosts, secrets };
}
