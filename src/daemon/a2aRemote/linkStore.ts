import crypto from 'node:crypto';
import path from 'node:path';
import { atomicWriteJSONSync } from '../util/atomicWrite';
import { scheduleTokenFileReHarden } from '../../shared/security';
import {
  A2A_REMOTE_RECORD_V,
  isA2aRemoteMessageKind,
  isHostId,
  type A2aLinkProposeRequest,
  type A2aLinkRecordV1,
  type A2aLinkState,
  type A2aRemoteErrorCode,
  type A2aRemoteMessageKind,
  type HostId,
} from '../../shared/a2aRemote';
import { isIsoString, isNonEmptyString, isPlainObject, preserveCorrupt, readStoreFile, type StoreLog } from './storeFile';

/**
 * Layer 3 of cross-host A2A: one local pane <-> one remote pane (`links.json`),
 * stored from THIS host's perspective.
 *
 * Transitions (anything else throws):
 *
 *   (none)        --proposeOut-------> proposed-out
 *   (none)        --receiveProposal--> proposed-in
 *   proposed-in   --accept-----------> active        (version + 1)
 *   proposed-out  --applyRemoteAccept> active        (version := the remote's, must be newer)
 *   proposed-*|active --revoke-------> revoked       (terminal, version + 1)
 *   proposed-*|active --markBroken---> broken        (terminal, version + 1)
 *
 * At most one non-terminal link per (local pane, remote host, remote pane).
 *
 * Corrupt file: start empty (no link carries traffic) and keep the original as
 * `links.json.corrupt-<ts>`.
 *
 * Write failure: every op rolls memory back and throws, EXCEPT `revoke` and
 * `markBroken`, which keep the in-memory terminal state (#658: a revocation
 * that silently un-happens on a disk error is worse than one that is only
 * lost on restart) and still throw so the caller can surface it.
 */

export const LINKS_FILE = 'links.json';

type EndedReason = NonNullable<A2aLinkRecordV1['endedReason']>;
export type BrokenReason = Extract<EndedReason, 'pane-closed' | 'pane-moved' | 'workspace-gone'>;

/** What a caller supplies for a new link; the store stamps v/state/version/timestamps. */
export type NewLinkInput = Pick<A2aLinkRecordV1, 'local' | 'remote' | 'allow'>;

export type LinkCheckResult =
  | { ok: true; link: A2aLinkRecordV1 }
  | {
      ok: false;
      error: Extract<A2aRemoteErrorCode, 'unknown-link' | 'link-not-active' | 'stale-link-version' | 'direction-not-allowed' | 'forbidden'>;
    };

const TERMINAL: ReadonlySet<A2aLinkState> = new Set(['revoked', 'broken']);
const BROKEN_REASONS: ReadonlySet<string> = new Set(['pane-closed', 'pane-moved', 'workspace-gone']);
const STATES: ReadonlySet<string> = new Set(['proposed-out', 'proposed-in', 'active', 'revoked', 'broken']);
const ENDED_REASONS: ReadonlySet<string> = new Set(['revoked-local', 'revoked-remote', ...BROKEN_REASONS]);

/**
 * Turn an incoming `A2aLinkProposeRequest` from `hostId` into THIS side's
 * perspective: the proposer's `to` is our local pane, its `from` is the remote
 * pane, and its directions flip (its outbound is our inbound).
 */
export function linkFromProposal(hostId: HostId, req: A2aLinkProposeRequest): NewLinkInput & { linkId: string } {
  return {
    linkId: req.linkId,
    local: { workspaceId: req.to.workspaceId, paneId: req.to.paneId },
    remote: {
      hostId,
      workspaceId: req.from.workspaceId,
      paneId: req.from.paneId,
      ...(req.from.label !== undefined ? { label: req.from.label } : {}),
    },
    allow: { outbound: req.allow.inbound, inbound: req.allow.outbound },
  };
}

export interface LinkStoreOptions {
  /** Directory holding the store, e.g. `<wmux data dir>/a2a/`. */
  dir: string;
  now?: () => number;
  log?: StoreLog;
  /** Test seam; defaults to `atomicWriteJSONSync`. */
  write?: (filePath: string, data: unknown) => void;
  /** Test seam; defaults to the deferred owner-only re-harden. */
  scheduleHarden?: (filePath: string) => void;
  /** Test seam for `proposeOut` link ids. */
  mintId?: () => string;
}

export class LinkStore {
  readonly filePath: string;
  private readonly now: () => number;
  private readonly log: StoreLog;
  private readonly write: (filePath: string, data: unknown) => void;
  private readonly scheduleHarden: (filePath: string) => void;
  private readonly mintId: () => string;
  private readonly links = new Map<string, A2aLinkRecordV1>();

  constructor(opts: LinkStoreOptions) {
    this.filePath = path.join(opts.dir, LINKS_FILE);
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? ((): void => undefined);
    this.write = opts.write ?? ((p, d): void => atomicWriteJSONSync(p, d));
    this.scheduleHarden = opts.scheduleHarden ?? scheduleTokenFileReHarden;
    this.mintId = opts.mintId ?? ((): string => crypto.randomUUID());
    this.load();
  }

  // --- reads ------------------------------------------------------------------

  get(linkId: string): A2aLinkRecordV1 | undefined {
    const rec = this.links.get(linkId);
    return rec ? structuredClone(rec) : undefined;
  }

  list(): A2aLinkRecordV1[] {
    return [...this.links.values()].map((r) => structuredClone(r));
  }

  listByHost(hostId: HostId): A2aLinkRecordV1[] {
    return this.list().filter((r) => r.remote.hostId === hostId);
  }

  /** Every ACTIVE link on a local pane (a pane may link to several remote panes). */
  findActiveByLocalPane(workspaceId: string, paneId: string): A2aLinkRecordV1[] {
    return this.list().filter(
      (r) => r.state === 'active' && r.local.workspaceId === workspaceId && r.local.paneId === paneId,
    );
  }

  /** Every ACTIVE link to one remote pane (it may link to several local panes). */
  findActiveByRemote(hostId: HostId, workspaceId: string, paneId: string): A2aLinkRecordV1[] {
    return this.list().filter(
      (r) =>
        r.state === 'active' &&
        r.remote.hostId === hostId &&
        r.remote.workspaceId === workspaceId &&
        r.remote.paneId === paneId,
    );
  }

  // --- transitions ------------------------------------------------------------

  /** This side proposes; mints the linkId. */
  proposeOut(input: NewLinkInput): A2aLinkRecordV1 {
    let linkId = this.mintId();
    while (this.links.has(linkId)) linkId = this.mintId();
    return this.create(linkId, input, 'proposed-out');
  }

  /** The other side proposed. A duplicate linkId (in any state) is refused. */
  receiveProposal(input: NewLinkInput & { linkId: string }): A2aLinkRecordV1 {
    if (!isNonEmptyString(input.linkId)) throw new Error('link: invalid linkId');
    if (this.links.has(input.linkId)) throw new Error(`link ${input.linkId}: duplicate linkId`);
    return this.create(input.linkId, input, 'proposed-in');
  }

  /** Our human accepted a `proposed-in` link. */
  accept(linkId: string): A2aLinkRecordV1 {
    const rec = this.require(linkId, ['proposed-in'], 'accept');
    return this.commit(rec, { state: 'active', version: rec.version + 1 }, true);
  }

  /** The other side's human accepted our `proposed-out` link at `version`. */
  applyRemoteAccept(linkId: string, version: number): A2aLinkRecordV1 {
    const rec = this.require(linkId, ['proposed-out'], 'applyRemoteAccept');
    if (!Number.isInteger(version) || version <= rec.version) {
      throw new Error(`link ${linkId}: remote accept version ${version} is not newer than ${rec.version}`);
    }
    return this.commit(rec, { state: 'active', version }, true);
  }

  revoke(linkId: string, side: 'local' | 'remote'): A2aLinkRecordV1 {
    const rec = this.require(linkId, ['proposed-out', 'proposed-in', 'active'], 'revoke');
    const endedReason: EndedReason = side === 'local' ? 'revoked-local' : 'revoked-remote';
    return this.commit(rec, { state: 'revoked', version: rec.version + 1, endedReason }, false);
  }

  markBroken(linkId: string, reason: BrokenReason): A2aLinkRecordV1 {
    if (!BROKEN_REASONS.has(reason)) throw new Error(`link ${linkId}: invalid broken reason`);
    const rec = this.require(linkId, ['proposed-out', 'proposed-in', 'active'], 'markBroken');
    return this.commit(rec, { state: 'broken', version: rec.version + 1, endedReason: reason }, false);
  }

  // --- delivery gate ----------------------------------------------------------

  /**
   * May a message on `linkId` pass? `hostId` is the AUTHENTICATED peer host
   * (inbound) or the host we are about to send to (outbound). Check order is
   * deliberate: an unknown link, then a host that does not own the link
   * (`forbidden`, before anything about the link's state leaks), then state,
   * version and direction.
   *
   *   - `task`: needs an active link at exactly this version, and the
   *     direction flag (`allow.inbound` for a received task, `allow.outbound`
   *     for one we send).
   *   - `reply` / `state`: active link at this version, any direction. Whether
   *     the task they name exists is the caller's `unknown-task` check — this
   *     store does not track tasks.
   *   - `link` (lifecycle notice): only unknown-link / forbidden / terminal are
   *     checked. A remote ACCEPT arrives while we are still `proposed-out` and
   *     names the NEW version, so the state and version gates would reject the
   *     very notice that activates the link; `applyRemoteAccept` / `revoke`
   *     validate it instead.
   */
  checkMessage(
    linkId: string,
    version: number,
    hostId: HostId,
    direction: 'inbound' | 'outbound',
    kind: A2aRemoteMessageKind,
  ): LinkCheckResult {
    const rec = this.links.get(linkId);
    if (!rec) return { ok: false, error: 'unknown-link' };
    if (rec.remote.hostId !== hostId) return { ok: false, error: 'forbidden' };
    if (!isA2aRemoteMessageKind(kind)) return { ok: false, error: 'forbidden' };
    if (kind === 'link') {
      if (TERMINAL.has(rec.state)) return { ok: false, error: 'link-not-active' };
      return { ok: true, link: structuredClone(rec) };
    }
    if (rec.state !== 'active') return { ok: false, error: 'link-not-active' };
    if (version !== rec.version) return { ok: false, error: 'stale-link-version' };
    if (kind === 'task' && !(direction === 'inbound' ? rec.allow.inbound : rec.allow.outbound)) {
      return { ok: false, error: 'direction-not-allowed' };
    }
    return { ok: true, link: structuredClone(rec) };
  }

  // --- internals --------------------------------------------------------------

  private create(linkId: string, input: NewLinkInput, state: 'proposed-out' | 'proposed-in'): A2aLinkRecordV1 {
    const shape = validateNewLink(input);
    if (shape) throw new Error(`link ${linkId}: ${shape}`);
    const clash = [...this.links.values()].find(
      (r) =>
        !TERMINAL.has(r.state) &&
        r.local.workspaceId === input.local.workspaceId &&
        r.local.paneId === input.local.paneId &&
        r.remote.hostId === input.remote.hostId &&
        r.remote.workspaceId === input.remote.workspaceId &&
        r.remote.paneId === input.remote.paneId,
    );
    if (clash) throw new Error(`link ${linkId}: pane pair already linked by ${clash.linkId} (${clash.state})`);

    const at = new Date(this.now()).toISOString();
    const rec: A2aLinkRecordV1 = {
      v: A2A_REMOTE_RECORD_V,
      linkId,
      version: 1,
      state,
      local: { workspaceId: input.local.workspaceId, paneId: input.local.paneId },
      remote: {
        hostId: input.remote.hostId,
        workspaceId: input.remote.workspaceId,
        paneId: input.remote.paneId,
        ...(input.remote.label !== undefined ? { label: input.remote.label } : {}),
      },
      allow: { outbound: input.allow.outbound, inbound: input.allow.inbound },
      createdAt: at,
      updatedAt: at,
    };
    this.links.set(linkId, rec);
    try {
      this.persist();
    } catch (err) {
      this.links.delete(linkId);
      throw err;
    }
    return structuredClone(rec);
  }

  private require(linkId: string, from: A2aLinkState[], op: string): A2aLinkRecordV1 {
    const rec = this.links.get(linkId);
    if (!rec) throw new Error(`link ${linkId}: unknown link`);
    if (!from.includes(rec.state)) throw new Error(`link ${linkId}: ${op} not allowed from ${rec.state}`);
    return rec;
  }

  /** Apply `patch`; on a failed write roll back only when `rollback` is true. */
  private commit(
    rec: A2aLinkRecordV1,
    patch: Pick<A2aLinkRecordV1, 'state' | 'version'> & { endedReason?: EndedReason },
    rollback: boolean,
  ): A2aLinkRecordV1 {
    const next: A2aLinkRecordV1 = { ...rec, ...patch, updatedAt: new Date(this.now()).toISOString() };
    this.links.set(rec.linkId, next);
    try {
      this.persist();
    } catch (err) {
      if (rollback) this.links.set(rec.linkId, rec);
      else this.log('error', `[a2a-remote] link ${rec.linkId} is ${next.state} in memory but could not be persisted`);
      throw err;
    }
    return structuredClone(next);
  }

  private persist(): void {
    this.write(this.filePath, { v: A2A_REMOTE_RECORD_V, links: [...this.links.values()] });
    this.scheduleHarden(this.filePath);
  }

  private load(): void {
    const read = readStoreFile(this.filePath);
    if (read.kind === 'missing') return;
    const records = read.kind === 'parsed' ? coerceFile(read.value) : null;
    if (!records) {
      const detail = read.kind === 'corrupt' ? read.detail : 'invalid shape';
      const kept = preserveCorrupt(this.filePath, this.now, this.log);
      this.log('warn', `[a2a-remote] ${LINKS_FILE} is corrupt (${detail}); starting with no links. Original kept at ${kept ?? '(could not move)'}`);
      return;
    }
    for (const rec of records) this.links.set(rec.linkId, rec);
  }
}

/** Null when well-formed, else what is wrong. */
function validateNewLink(input: NewLinkInput): string | null {
  if (!isPlainObject(input.local) || !isNonEmptyString(input.local.workspaceId) || !isNonEmptyString(input.local.paneId)) {
    return 'invalid local pane';
  }
  const remote: unknown = input.remote;
  if (
    !isPlainObject(remote) ||
    !isHostId(remote['hostId']) ||
    !isNonEmptyString(remote['workspaceId']) ||
    !isNonEmptyString(remote['paneId']) ||
    (remote['label'] !== undefined && typeof remote['label'] !== 'string')
  ) {
    return 'invalid remote pane';
  }
  if (!isPlainObject(input.allow) || typeof input.allow.outbound !== 'boolean' || typeof input.allow.inbound !== 'boolean') {
    return 'invalid allow flags';
  }
  return null;
}

/** Whole-file validation: any bad record rejects the file. */
function coerceFile(raw: unknown): A2aLinkRecordV1[] | null {
  if (!isPlainObject(raw) || raw['v'] !== 1 || !Array.isArray(raw['links'])) return null;
  const out: A2aLinkRecordV1[] = [];
  const seen = new Set<string>();
  for (const r of raw['links']) {
    if (!isPlainObject(r) || r['v'] !== 1 || !isNonEmptyString(r['linkId']) || seen.has(r['linkId'])) return null;
    const version = r['version'];
    const state = r['state'];
    if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) return null;
    if (typeof state !== 'string' || !STATES.has(state)) return null;
    if (!isIsoString(r['createdAt']) || !isIsoString(r['updatedAt'])) return null;
    const endedReason = r['endedReason'];
    if (endedReason !== undefined && (typeof endedReason !== 'string' || !ENDED_REASONS.has(endedReason))) return null;
    const input = r as unknown as NewLinkInput;
    if (validateNewLink(input)) return null;
    const rec: A2aLinkRecordV1 = {
      v: 1,
      linkId: r['linkId'],
      version,
      state: state as A2aLinkState,
      local: { workspaceId: input.local.workspaceId, paneId: input.local.paneId },
      remote: {
        hostId: input.remote.hostId,
        workspaceId: input.remote.workspaceId,
        paneId: input.remote.paneId,
        ...(input.remote.label !== undefined ? { label: input.remote.label } : {}),
      },
      allow: { outbound: input.allow.outbound, inbound: input.allow.inbound },
      createdAt: r['createdAt'],
      updatedAt: r['updatedAt'],
      ...(endedReason !== undefined ? { endedReason: endedReason as EndedReason } : {}),
    };
    seen.add(rec.linkId);
    out.push(rec);
  }
  return out;
}
