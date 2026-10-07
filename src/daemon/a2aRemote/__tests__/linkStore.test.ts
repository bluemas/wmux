import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { A2aLinkState, A2aRemoteMessageKind } from '../../../shared/a2aRemote';
import { atomicWriteJSONSync } from '../../util/atomicWrite';
import { LINKS_FILE, LinkStore, linkFromProposal, type LinkStoreOptions, type NewLinkInput } from '../linkStore';

const HOST = '11111111-1111-4111-8111-111111111111';
const HOST2 = '22222222-2222-4222-8222-222222222222';

let dir: string;
let fail = false;
let clock = 1_700_000_000_000;
const flakyWrite = (p: string, d: unknown): void => {
  if (fail) throw new Error('disk full');
  atomicWriteJSONSync(p, d);
};
const make = (o: Partial<LinkStoreOptions> = {}): LinkStore =>
  new LinkStore({ dir, now: () => clock, scheduleHarden: () => undefined, write: flakyWrite, ...o });

const input = (o: Partial<NewLinkInput> = {}): NewLinkInput => ({
  local: { workspaceId: 'ws1', paneId: 'p1' },
  remote: { hostId: HOST, workspaceId: 'rws', paneId: 'rp', label: 'remote claude' },
  allow: { outbound: true, inbound: false },
  ...o,
});

beforeEach(() => {
  fail = false;
  clock = 1_700_000_000_000;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-links-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Build a link in `state` and return its id. */
function linkIn(s: LinkStore, state: A2aLinkState, o: Partial<NewLinkInput> = {}): string {
  if (state === 'proposed-out') return s.proposeOut(input(o)).linkId;
  const id = `in-${Math.random().toString(36).slice(2)}`;
  s.receiveProposal({ ...input(o), linkId: id });
  if (state === 'proposed-in') return id;
  s.accept(id);
  if (state === 'active') return id;
  if (state === 'revoked') s.revoke(id, 'local');
  else s.markBroken(id, 'pane-closed');
  return id;
}

describe('LinkStore transitions', () => {
  it('proposeOut / receiveProposal stamp v, version 1 and the state', () => {
    const s = make({ mintId: () => 'L1' });
    const out = s.proposeOut(input());
    expect(out).toMatchObject({ v: 1, linkId: 'L1', version: 1, state: 'proposed-out' });
    const inn = s.receiveProposal({ ...input({ local: { workspaceId: 'ws2', paneId: 'p2' } }), linkId: 'L2' });
    expect(inn).toMatchObject({ v: 1, linkId: 'L2', version: 1, state: 'proposed-in' });
    expect(inn.createdAt).toBe(new Date(clock).toISOString());
  });

  it('receiveProposal refuses a duplicate linkId in any state', () => {
    const s = make();
    const id = linkIn(s, 'revoked');
    expect(() => s.receiveProposal({ ...input({ local: { workspaceId: 'x', paneId: 'y' } }), linkId: id })).toThrow(/duplicate/);
  });

  it('accept: proposed-in -> active, version + 1', () => {
    const s = make();
    const id = linkIn(s, 'proposed-in');
    expect(s.accept(id)).toMatchObject({ state: 'active', version: 2 });
  });

  it('applyRemoteAccept: proposed-out -> active at the remote version; must be newer', () => {
    const s = make();
    const id = linkIn(s, 'proposed-out');
    expect(() => s.applyRemoteAccept(id, 1)).toThrow(/not newer/);
    expect(s.applyRemoteAccept(id, 2)).toMatchObject({ state: 'active', version: 2 });
  });

  it('revoke records the side; markBroken records the reason; both bump the version', () => {
    const s = make();
    const a = linkIn(s, 'active');
    expect(s.revoke(a, 'remote')).toMatchObject({ state: 'revoked', endedReason: 'revoked-remote', version: 3 });
    const b = linkIn(s, 'proposed-out', { local: { workspaceId: 'ws9', paneId: 'p9' } });
    expect(s.revoke(b, 'local')).toMatchObject({ state: 'revoked', endedReason: 'revoked-local', version: 2 });
    const c = linkIn(s, 'proposed-in', { local: { workspaceId: 'ws8', paneId: 'p8' } });
    expect(s.markBroken(c, 'workspace-gone')).toMatchObject({ state: 'broken', endedReason: 'workspace-gone' });
  });

  // The full table: every op from every state.
  const ALL: A2aLinkState[] = ['proposed-out', 'proposed-in', 'active', 'revoked', 'broken'];
  const ops: Record<string, { allowed: A2aLinkState[]; run: (s: LinkStore, id: string) => unknown }> = {
    accept: { allowed: ['proposed-in'], run: (s, id) => s.accept(id) },
    applyRemoteAccept: { allowed: ['proposed-out'], run: (s, id) => s.applyRemoteAccept(id, 10) },
    revoke: { allowed: ['proposed-out', 'proposed-in', 'active'], run: (s, id) => s.revoke(id, 'local') },
    markBroken: { allowed: ['proposed-out', 'proposed-in', 'active'], run: (s, id) => s.markBroken(id, 'pane-moved') },
  };
  for (const [op, { allowed, run }] of Object.entries(ops)) {
    for (const from of ALL) {
      const ok = allowed.includes(from);
      it(`${op} from ${from} ${ok ? 'is allowed' : 'throws'}`, () => {
        const s = make();
        const id = linkIn(s, from);
        if (ok) expect(() => run(s, id)).not.toThrow();
        else {
          const before = s.get(id);
          expect(() => run(s, id)).toThrow(/not allowed/);
          expect(s.get(id)).toEqual(before);
        }
      });
    }
  }

  it('ops on an unknown link throw', () => {
    const s = make();
    expect(() => s.accept('nope')).toThrow(/unknown/);
    expect(() => s.revoke('nope', 'local')).toThrow(/unknown/);
  });

  it('at most one non-terminal link per (local pane, remote host, remote pane)', () => {
    const s = make();
    const id = linkIn(s, 'proposed-out');
    expect(() => s.proposeOut(input())).toThrow(/already linked/);
    expect(() => s.receiveProposal({ ...input(), linkId: 'other' })).toThrow(/already linked/);
    // A different remote host or pane is a different triple.
    expect(() => s.proposeOut(input({ remote: { hostId: HOST2, workspaceId: 'rws', paneId: 'rp' } }))).not.toThrow();
    expect(() => s.proposeOut(input({ remote: { hostId: HOST, workspaceId: 'rws', paneId: 'rp2' } }))).not.toThrow();
    // Once terminal, the triple is free again.
    s.revoke(id, 'local');
    expect(() => s.proposeOut(input())).not.toThrow();
  });

  it('rejects malformed input', () => {
    const s = make();
    expect(() => s.proposeOut(input({ remote: { hostId: 'nope', workspaceId: 'a', paneId: 'b' } }))).toThrow(/remote/);
    expect(() => s.proposeOut(input({ local: { workspaceId: '', paneId: 'b' } }))).toThrow(/local/);
    expect(() => s.markBroken(linkIn(s, 'active'), 'revoked-local' as never)).toThrow(/reason/);
  });
});

describe('LinkStore queries', () => {
  it('listByHost and findActive* return every matching link', () => {
    const s = make();
    const a = linkIn(s, 'active');
    const b = linkIn(s, 'active', { remote: { hostId: HOST2, workspaceId: 'rws', paneId: 'rp' } });
    linkIn(s, 'proposed-in', { remote: { hostId: HOST, workspaceId: 'rws', paneId: 'other' } });
    expect(s.listByHost(HOST)).toHaveLength(2);
    expect(s.findActiveByLocalPane('ws1', 'p1').map((r) => r.linkId).sort()).toEqual([a, b].sort());
    expect(s.findActiveByRemote(HOST, 'rws', 'rp').map((r) => r.linkId)).toEqual([a]);
    expect(s.findActiveByRemote(HOST, 'rws', 'other')).toEqual([]);
  });

  it('returned records are copies', () => {
    const s = make();
    const id = linkIn(s, 'active');
    const got = s.get(id);
    if (got) got.allow.inbound = true;
    expect(s.get(id)?.allow.inbound).toBe(false);
  });
});

describe('LinkStore.checkMessage', () => {
  type Row = [label: string, state: A2aLinkState, allow: NewLinkInput['allow'], args: { v?: number; host?: string; dir: 'inbound' | 'outbound'; kind: A2aRemoteMessageKind }, expected: string];
  const both = { outbound: true, inbound: true };
  const outOnly = { outbound: true, inbound: false };
  const inOnly = { outbound: false, inbound: true };
  const none = { outbound: false, inbound: false };
  // Active links from linkIn() are at version 2.
  const rows: Row[] = [
    ['inbound task, inbound allowed', 'active', inOnly, { dir: 'inbound', kind: 'task' }, 'ok'],
    ['inbound task, inbound denied', 'active', outOnly, { dir: 'inbound', kind: 'task' }, 'direction-not-allowed'],
    ['outbound task, outbound allowed', 'active', outOnly, { dir: 'outbound', kind: 'task' }, 'ok'],
    ['outbound task, outbound denied', 'active', inOnly, { dir: 'outbound', kind: 'task' }, 'direction-not-allowed'],
    ['inbound reply, no direction', 'active', none, { dir: 'inbound', kind: 'reply' }, 'ok'],
    ['outbound reply, no direction', 'active', none, { dir: 'outbound', kind: 'reply' }, 'ok'],
    ['inbound state, no direction', 'active', none, { dir: 'inbound', kind: 'state' }, 'ok'],
    ['outbound state, no direction', 'active', none, { dir: 'outbound', kind: 'state' }, 'ok'],
    ['older version', 'active', both, { v: 1, dir: 'inbound', kind: 'reply' }, 'stale-link-version'],
    ['newer version', 'active', both, { v: 3, dir: 'inbound', kind: 'task' }, 'stale-link-version'],
    ['wrong host', 'active', both, { host: HOST2, dir: 'inbound', kind: 'task' }, 'forbidden'],
    ['wrong host on a revoked link', 'revoked', both, { host: HOST2, dir: 'inbound', kind: 'reply' }, 'forbidden'],
    ['task on proposed-out', 'proposed-out', both, { v: 1, dir: 'outbound', kind: 'task' }, 'link-not-active'],
    ['reply on proposed-in', 'proposed-in', both, { v: 1, dir: 'inbound', kind: 'reply' }, 'link-not-active'],
    ['state on revoked', 'revoked', both, { v: 3, dir: 'inbound', kind: 'state' }, 'link-not-active'],
    ['task on broken', 'broken', both, { v: 3, dir: 'inbound', kind: 'task' }, 'link-not-active'],
    ['link notice on proposed-out (remote accept)', 'proposed-out', none, { v: 2, dir: 'inbound', kind: 'link' }, 'ok'],
    ['link notice on active, any version', 'active', none, { v: 7, dir: 'inbound', kind: 'link' }, 'ok'],
    ['link notice on revoked', 'revoked', both, { dir: 'inbound', kind: 'link' }, 'link-not-active'],
    ['link notice from wrong host', 'proposed-out', both, { host: HOST2, dir: 'inbound', kind: 'link' }, 'forbidden'],
  ];
  for (const [label, state, allow, a, expected] of rows) {
    it(`${label} -> ${expected}`, () => {
      const s = make();
      const id = linkIn(s, state, { allow });
      const r = s.checkMessage(id, a.v ?? 2, a.host ?? HOST, a.dir, a.kind);
      if (expected === 'ok') expect(r).toMatchObject({ ok: true, link: { linkId: id } });
      else expect(r).toEqual({ ok: false, error: expected });
    });
  }

  it('unknown link -> unknown-link', () => {
    expect(make().checkMessage('nope', 1, HOST, 'inbound', 'task')).toEqual({ ok: false, error: 'unknown-link' });
  });

  it('an unrecognised kind is refused', () => {
    const s = make();
    const id = linkIn(s, 'active', { allow: both });
    expect(s.checkMessage(id, 2, HOST, 'inbound', 'bogus' as never)).toEqual({ ok: false, error: 'forbidden' });
  });
});

describe('linkFromProposal', () => {
  it('flips perspective and directions', () => {
    const got = linkFromProposal(HOST, {
      linkId: 'L',
      from: { workspaceId: 'their-ws', paneId: 'their-p', label: 'codex' },
      to: { workspaceId: 'our-ws', paneId: 'our-p' },
      allow: { outbound: true, inbound: false },
    });
    expect(got).toEqual({
      linkId: 'L',
      local: { workspaceId: 'our-ws', paneId: 'our-p' },
      remote: { hostId: HOST, workspaceId: 'their-ws', paneId: 'their-p', label: 'codex' },
      allow: { outbound: false, inbound: true },
    });
  });
});

describe('LinkStore persistence', () => {
  it('round-trips through a new instance', () => {
    const s = make();
    const a = linkIn(s, 'active');
    linkIn(s, 'broken', { local: { workspaceId: 'ws2', paneId: 'p2' } });
    const raw = JSON.parse(fs.readFileSync(path.join(dir, LINKS_FILE), 'utf-8'));
    expect(raw.v).toBe(1);
    const t = make();
    expect(t.list()).toEqual(s.list());
    expect(t.checkMessage(a, 2, HOST, 'outbound', 'task')).toMatchObject({ ok: true });
  });

  it('corrupt file: starts empty, keeps the original as .corrupt-<ts>, warns', () => {
    const file = path.join(dir, LINKS_FILE);
    fs.writeFileSync(file, JSON.stringify({ v: 1, links: [{ v: 1, linkId: 'x', state: 'weird' }] }));
    const log = vi.fn();
    const s = make({ log });
    expect(s.list()).toEqual([]);
    expect(fs.existsSync(`${file}.corrupt-${clock}`)).toBe(true);
    expect(fs.existsSync(file)).toBe(false);
    expect(log).toHaveBeenCalledWith('warn', expect.stringContaining('corrupt'));
  });

  it('a wrong file version is treated as corrupt', () => {
    fs.writeFileSync(path.join(dir, LINKS_FILE), JSON.stringify({ v: 2, links: [] }));
    expect(make().list()).toEqual([]);
    expect(fs.existsSync(path.join(dir, `${LINKS_FILE}.corrupt-${clock}`))).toBe(true);
  });

  it('create / accept / applyRemoteAccept roll back on a failed write', () => {
    const s = make();
    const pin = linkIn(s, 'proposed-in');
    const pout = linkIn(s, 'proposed-out', { local: { workspaceId: 'ws3', paneId: 'p3' } });
    fail = true;
    expect(() => s.proposeOut(input({ local: { workspaceId: 'ws4', paneId: 'p4' } }))).toThrow('disk full');
    expect(() => s.receiveProposal({ ...input({ local: { workspaceId: 'ws5', paneId: 'p5' } }), linkId: 'R' })).toThrow();
    expect(s.list()).toHaveLength(2);
    expect(() => s.accept(pin)).toThrow();
    expect(s.get(pin)).toMatchObject({ state: 'proposed-in', version: 1 });
    expect(() => s.applyRemoteAccept(pout, 2)).toThrow();
    expect(s.get(pout)).toMatchObject({ state: 'proposed-out', version: 1 });
    fail = false;
    expect(make().list()).toHaveLength(2);
  });

  it('revoke and markBroken keep their in-memory effect on a failed write', () => {
    const log = vi.fn();
    const s = make({ log });
    const a = linkIn(s, 'active');
    const b = linkIn(s, 'active', { local: { workspaceId: 'ws2', paneId: 'p2' } });
    fail = true;
    expect(() => s.revoke(a, 'local')).toThrow('disk full');
    expect(s.get(a)?.state).toBe('revoked');
    expect(s.checkMessage(a, 3, HOST, 'inbound', 'reply')).toEqual({ ok: false, error: 'link-not-active' });
    expect(() => s.markBroken(b, 'pane-closed')).toThrow('disk full');
    expect(s.get(b)?.state).toBe('broken');
    expect(log).toHaveBeenCalledWith('error', expect.stringContaining('could not be persisted'));
  });
});
