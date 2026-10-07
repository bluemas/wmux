// In-process end to end for layers 2-3: server B exposes panes, joiner A reads
// them over the pinned client, proposes a pane-to-pane link, B's human accepts
// and A's refresh sees it active. Two listeners on loopback, separate stores.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { A2A_ROUTES, a2aLinkPath, formatPeerCredential, type A2aLinkRecordV1 } from '../../../shared/a2aRemote';
import type { A2aRemoteLinkEvent } from '../../../shared/rpc';
import { ExposedPaneCache } from '../exposedPanes';
import { ExposureStore } from '../exposureStore';
import { joinRemoteHost } from '../joiner';
import { registerA2aLinkRpc } from '../linkRpc';
import { LinkStore } from '../linkStore';
import { PinnedTlsClient } from '../pinnedClient';
import { createA2aRoutes } from '../routes';
import { disposeAll, makePc, type Pc } from './a2aServerRig';

const FAST = { connectMs: 2_000, requestMs: 5_000 };
const dirs: string[] = [];

afterEach(async () => {
  await disposeAll();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

type Rpc = (method: string, params?: Record<string, unknown>) => Promise<unknown>;

interface Side {
  pc: Pc;
  hostId: string;
  links: LinkStore;
  exposures: ExposureStore;
  panes: ExposedPaneCache;
  events: A2aRemoteLinkEvent[];
  rpc: Rpc;
}

/** One PC with its link/exposure stores behind both the listener routes and the control RPCs. */
async function makeSide(name: string): Promise<Side> {
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-links-'));
  dirs.push(storeDir);
  const stores = { dir: storeDir, scheduleHarden: (): void => undefined };
  const links = new LinkStore(stores);
  const exposures = new ExposureStore(stores);
  const panes = new ExposedPaneCache();
  const events: A2aRemoteLinkEvent[] = [];
  const broadcast = (e: A2aRemoteLinkEvent): void => void events.push(e);
  const log = (): void => undefined;
  const pc = await makePc(name, { deps: { routes: createA2aRoutes({ exposures, panes, links, broadcast, log }) } });
  const handlers = new Map<string, (p: Record<string, unknown>) => Promise<unknown>>();
  registerA2aLinkRpc((m, h) => handlers.set(m, h), {
    links, exposures, panes, remoteHosts: pc.remoteHosts, broadcast, log, timeouts: FAST,
  });
  const rpc: Rpc = (method, params = {}) => handlers.get(method)!(params);
  return { pc, hostId: pc.server.ensureIdentity().hostId, links, exposures, panes, events, rpc };
}

/** `joiner` pastes `server`'s invite. */
async function pair(joiner: Side, server: Side, name: string): Promise<void> {
  const result = await joinRemoteHost(server.pc.server.beginPairing().invite, {
    self: () => joiner.pc.server.ensureIdentity(),
    selfName: name,
    remoteHosts: joiner.pc.remoteHosts,
    timeouts: FAST,
  });
  expect(result.ok).toBe(true);
}

/** A raw pinned call to `server` with `joiner`'s credential. */
function asPeer(joiner: Side, server: Side) {
  const cred = joiner.pc.remoteHosts.credentialFor(server.hostId)!;
  return new PinnedTlsClient({
    addresses: ['127.0.0.1'],
    port: server.pc.server.boundPort()!,
    fingerprint256: server.pc.server.status().fingerprint256!,
    credential: formatPeerCredential(cred),
    connectTimeoutMs: FAST.connectMs,
    requestTimeoutMs: FAST.requestMs,
  });
}

const B_PANES = [
  { workspaceId: 'ws-api', workspaceName: 'API', paneId: 'pane-1', label: 'w1-1(claude)', agent: 'claude', cwd: '/srv/api', gitRemote: 'github.com/acme/api', gitBranch: 'main' },
  { workspaceId: 'ws-api', workspaceName: 'API', paneId: 'pane-2', label: 'w1-2' },
  { workspaceId: 'ws-secret', workspaceName: 'Secret', paneId: 'pane-9', label: 'w2-1' },
];

const A_PANE = { workspaceId: 'ws-a', paneId: 'pane-a', label: 'w1-1(codex)', workspaceName: 'Web', gitRemote: 'github.com/acme/api' };

/** B exposes only ws-api/pane-1 to A. */
async function exposeOne(a: Side, b: Side): Promise<void> {
  await b.rpc('a2a.remote.exposure.publish', { panes: B_PANES });
  await b.rpc('a2a.remote.exposure.set', { hostId: a.hostId, workspaceIds: ['ws-api'], paneIds: { 'ws-api': ['pane-1'] } });
}

async function propose(a: Side, b: Side, remotePane: Record<string, unknown>): Promise<{ ok: boolean; link?: A2aLinkRecordV1; error?: string }> {
  return (await a.rpc('a2a.remote.links.propose', {
    hostId: b.hostId,
    localPane: A_PANE,
    remotePane,
    allow: { outbound: true, inbound: true },
  })) as { ok: boolean; link?: A2aLinkRecordV1; error?: string };
}

describe('cross-host exposure and pane links, end to end', () => {
  it('pair → expose → list → propose → accept → refresh is active', async () => {
    const a = await makeSide('PC A');
    const b = await makeSide('PC B');
    await pair(a, b, 'PC A');
    await exposeOne(a, b);

    // A sees exactly the one exposed pane, with its display fields.
    const listed = (await a.rpc('a2a.remote.hosts.exposed', { hostId: b.hostId })) as { ok: boolean; panes: unknown[] };
    expect(listed).toEqual({ ok: true, panes: [B_PANES[0]] });

    const proposed = await propose(a, b, { workspaceId: 'ws-api', paneId: 'pane-1', label: 'w1-1(claude)', workspaceName: 'API', gitRemote: 'github.com/acme/api' });
    expect(proposed.ok).toBe(true);
    const linkId = proposed.link!.linkId;
    expect(a.links.get(linkId)).toMatchObject({ state: 'proposed-out', remote: { hostId: b.hostId, workspaceName: 'API', paneId: 'pane-1' } });

    // B holds it as proposed-in, sender recorded from the proposal, directions flipped.
    expect(b.links.get(linkId)).toMatchObject({
      state: 'proposed-in',
      version: 1,
      local: { workspaceId: 'ws-api', paneId: 'pane-1' },
      remote: { hostId: a.hostId, workspaceId: 'ws-a', paneId: 'pane-a', label: 'w1-1(codex)', workspaceName: 'Web', gitRemote: 'github.com/acme/api' },
      allow: { outbound: true, inbound: true },
    });
    expect(b.events).toContainEqual({ type: 'a2a.remote.link.proposed', linkId });

    // Still pending on A before B's human acts.
    expect(await a.rpc('a2a.remote.links.refresh', { linkId })).toMatchObject({ ok: true, link: { state: 'proposed-out' } });

    expect(await b.rpc('a2a.remote.links.accept', { linkId })).toMatchObject({ ok: true, link: { state: 'active', version: 2 } });
    expect(await a.rpc('a2a.remote.links.refresh', { linkId })).toMatchObject({ ok: true, link: { state: 'active', version: 2 } });
    expect(a.events).toContainEqual({ type: 'a2a.remote.link.changed', linkId, state: 'active' });
  });

  it('a proposal to a pane that is not exposed is refused (403) and leaves nothing on A', async () => {
    const a = await makeSide('PC A');
    const b = await makeSide('PC B');
    await pair(a, b, 'PC A');
    await exposeOne(a, b);

    // A sibling pane of an exposed workspace, and a pane of an unexposed one.
    for (const pane of [{ workspaceId: 'ws-api', paneId: 'pane-2' }, { workspaceId: 'ws-secret', paneId: 'pane-9' }]) {
      expect(await propose(a, b, pane)).toMatchObject({ ok: false, error: 'forbidden' });
    }
    expect(a.links.list()).toHaveLength(0);
    expect(b.links.list()).toHaveLength(0);
  });

  it('a peer cannot read or revoke another host\'s link (403)', async () => {
    const a = await makeSide('PC A');
    const b = await makeSide('PC B');
    const c = await makeSide('PC C');
    await pair(a, b, 'PC A');
    await pair(c, b, 'PC C');
    await exposeOne(a, b);
    const { link } = await propose(a, b, { workspaceId: 'ws-api', paneId: 'pane-1' });

    const asC = asPeer(c, b);
    expect(await asC.requestJson('POST', a2aLinkPath(link!.linkId) + A2A_ROUTES.linkRevokeSuffix, {})).toMatchObject({ status: 403, json: { error: 'forbidden' } });
    expect(await asC.requestJson('GET', a2aLinkPath(link!.linkId))).toMatchObject({ status: 403 });
    expect(b.links.get(link!.linkId)?.state).toBe('proposed-in');

    // The owner can: A's revoke ends it on both sides.
    expect(await a.rpc('a2a.remote.links.revoke', { linkId: link!.linkId })).toMatchObject({ ok: true, remoteNotified: true, link: { state: 'revoked' } });
    expect(b.links.get(link!.linkId)).toMatchObject({ state: 'revoked', endedReason: 'revoked-remote' });
  });

  it('a duplicate linkId is refused (409)', async () => {
    const a = await makeSide('PC A');
    const b = await makeSide('PC B');
    await pair(a, b, 'PC A');
    await exposeOne(a, b);
    const body = {
      linkId: crypto.randomUUID(),
      from: { workspaceId: 'ws-a', paneId: 'pane-a' },
      to: { workspaceId: 'ws-api', paneId: 'pane-1' },
      allow: { outbound: true, inbound: false },
    };
    const client = asPeer(a, b);
    expect((await client.requestJson('POST', A2A_ROUTES.links, body)).status).toBe(200);
    // Same id, even for another pane pair.
    const again = await client.requestJson('POST', A2A_ROUTES.links, { ...body, from: { workspaceId: 'ws-a', paneId: 'pane-b' } });
    expect(again).toMatchObject({ status: 409, json: { error: 'conflict' } });
    expect(b.links.list()).toHaveLength(1);
  });

  it('a closed pane breaks its link and leaves the exposed list', async () => {
    const a = await makeSide('PC A');
    const b = await makeSide('PC B');
    await pair(a, b, 'PC A');
    await exposeOne(a, b);
    const { link } = await propose(a, b, { workspaceId: 'ws-api', paneId: 'pane-1' });
    await b.rpc('a2a.remote.links.accept', { linkId: link!.linkId });
    await a.rpc('a2a.remote.links.refresh', { linkId: link!.linkId });

    expect(await b.rpc('a2a.remote.local.paneGone', { workspaceId: 'ws-api', paneId: 'pane-1', reason: 'pane-closed' })).toEqual({ ok: true, broken: 1 });
    expect(b.links.get(link!.linkId)).toMatchObject({ state: 'broken', endedReason: 'pane-closed' });
    expect(b.events).toContainEqual({ type: 'a2a.remote.link.changed', linkId: link!.linkId, state: 'broken' });
    expect(await a.rpc('a2a.remote.hosts.exposed', { hostId: b.hostId })).toEqual({ ok: true, panes: [] });

    // A learns it on its next refresh.
    expect(await a.rpc('a2a.remote.links.refresh', { linkId: link!.linkId })).toMatchObject({ ok: true, link: { state: 'broken', endedReason: 'pane-closed' } });
  });

  it('a joiner-side workspace that goes away breaks its links', async () => {
    const a = await makeSide('PC A');
    const b = await makeSide('PC B');
    await pair(a, b, 'PC A');
    await exposeOne(a, b);
    const { link } = await propose(a, b, { workspaceId: 'ws-api', paneId: 'pane-1' });
    expect(await a.rpc('a2a.remote.local.paneGone', { workspaceId: 'ws-a', reason: 'workspace-gone' })).toEqual({ ok: true, broken: 1 });
    expect(a.links.get(link!.linkId)).toMatchObject({ state: 'broken', endedReason: 'workspace-gone' });
  });

  it('un-exposing takes the pane out of the list at once', async () => {
    const a = await makeSide('PC A');
    const b = await makeSide('PC B');
    await pair(a, b, 'PC A');
    await exposeOne(a, b);
    expect(((await a.rpc('a2a.remote.hosts.exposed', { hostId: b.hostId })) as { panes: unknown[] }).panes).toHaveLength(1);
    await b.rpc('a2a.remote.exposure.set', { hostId: a.hostId, workspaceIds: [], paneIds: {} });
    expect(await a.rpc('a2a.remote.hosts.exposed', { hostId: b.hostId })).toEqual({ ok: true, panes: [] });
  });

  it('a workspace listed without a pane list exposes no pane', async () => {
    const a = await makeSide('PC A');
    const b = await makeSide('PC B');
    await pair(a, b, 'PC A');
    await b.rpc('a2a.remote.exposure.publish', { panes: B_PANES });
    const set = (await b.rpc('a2a.remote.exposure.set', { hostId: a.hostId, workspaceIds: ['ws-api'] })) as { exposure: { paneIds: unknown } };
    expect(set.exposure.paneIds).toEqual({ 'ws-api': [] });
    expect(await a.rpc('a2a.remote.hosts.exposed', { hostId: b.hostId })).toEqual({ ok: true, panes: [] });
  });

  it('reject ends a proposal on the server; the joiner sees it revoked', async () => {
    const a = await makeSide('PC A');
    const b = await makeSide('PC B');
    await pair(a, b, 'PC A');
    await exposeOne(a, b);
    const { link } = await propose(a, b, { workspaceId: 'ws-api', paneId: 'pane-1' });
    expect(await b.rpc('a2a.remote.links.reject', { linkId: link!.linkId })).toMatchObject({ ok: true, link: { state: 'revoked', endedReason: 'revoked-local' } });
    expect(await a.rpc('a2a.remote.links.refresh', { linkId: link!.linkId })).toMatchObject({ ok: true, link: { state: 'revoked', endedReason: 'revoked-remote' } });
  });

  it('a proposal to an unpaired PC fails without a local record', async () => {
    const a = await makeSide('PC A');
    const b = await makeSide('PC B');
    expect(await propose(a, b, { workspaceId: 'ws-api', paneId: 'pane-1' })).toMatchObject({ ok: false, error: 'not-paired' });
    expect(a.links.list()).toHaveLength(0);
  });

  it('the exposed snapshot drops malformed entries', () => {
    const cache = new ExposedPaneCache();
    expect(cache.publish([B_PANES[0], { workspaceId: '', paneId: 'x' }, 'nope', { workspaceId: 'w', paneId: 'p', gitRemote: 'has space' }])).toBe(2);
    expect(cache.all()[1]).toEqual({ workspaceId: 'w', workspaceName: 'w', paneId: 'p' });
  });
});

