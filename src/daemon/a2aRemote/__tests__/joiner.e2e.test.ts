// In-process end to end: two "PCs" (separate data dirs, separate listeners).
// B joins A's invite over the pinned client, exactly as the RPC does.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { A2A_ROUTES, formatInvite, formatPeerCredential, parseInvite, type A2aInvite } from '../../../shared/a2aRemote';
import { joinRemoteHost, type JoinDeps } from '../joiner';
import { A2A_PAIR_TTL_MS } from '../pairing';
import { PinnedTlsClient } from '../pinnedClient';
import { registerA2aRemoteRpc } from '../rpc';
import { disposeAll, freePort, makePc, type Pc } from './a2aServerRig';

afterEach(async () => {
  await disposeAll();
});

const FAST = { connectMs: 2_000, requestMs: 5_000 };

function joinerDeps(pc: Pc, name = 'PC B'): JoinDeps {
  return { self: () => pc.server.ensureIdentity(), selfName: name, remoteHosts: pc.remoteHosts, timeouts: FAST };
}

function inviteOf(pc: Pc): A2aInvite {
  const parsed = parseInvite(pc.server.beginPairing().invite);
  if (!parsed.ok) throw new Error('invite did not parse');
  return parsed.invite;
}

function hello(credential: string, host: Pc): Promise<{ status: number; json: unknown }> {
  const status = host.server.status();
  return new PinnedTlsClient({
    addresses: ['127.0.0.1'],
    port: host.server.boundPort()!,
    fingerprint256: status.fingerprint256!,
    credential,
    connectTimeoutMs: 2_000,
    requestTimeoutMs: 5_000,
  }).requestJson('GET', A2A_ROUTES.hello);
}

describe('cross-host pairing, end to end', () => {
  it('B joins A: both stores record the pairing and hello succeeds', async () => {
    const a = await makePc('PC A');
    const b = await makePc('PC B');
    const invite = inviteOf(a);

    const result = await joinRemoteHost(formatInvite(invite), joinerDeps(b));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const aId = a.server.status().hostId!;
    const bId = b.server.status().hostId!;
    expect(result.host).toMatchObject({
      hostId: aId,
      name: 'PC A',
      addresses: ['127.0.0.1'],
      port: invite.port,
      fingerprint256: invite.fingerprint256,
    });
    // Joiner side: the record and its credential.
    expect(b.remoteHosts.list().map((h) => h.hostId)).toEqual([aId]);
    const cred = b.remoteHosts.credentialFor(aId)!;
    expect(cred.peerId).toBe(result.host.peerId);
    // Server side: the peer, bound to B's hostId and name.
    expect(a.peers.list()).toEqual([expect.objectContaining({ peerId: cred.peerId, hostId: bId, name: 'PC B' })]);

    const h = await hello(formatPeerCredential(cred), a);
    expect(h).toMatchObject({ status: 200, json: { hostId: aId, name: 'PC A' } });

    // Revoke on A: the credential stops working.
    expect(a.peers.revoke(cred.peerId)).toBe(true);
    const after = await hello(formatPeerCredential(cred), a);
    expect(after).toMatchObject({ status: 401, json: { reason: 'revoked' } });
  });

  it('a tampered fingerprint fails before the code is sent', async () => {
    const a = await makePc('PC A');
    const b = await makePc('PC B');
    const invite = inviteOf(a);
    // A third PC's certificate (B's own would trip the self check).
    const c = await makePc('PC C');
    const forgedC = formatInvite({ ...invite, fingerprint256: c.server.status().fingerprint256! });

    const result = await joinRemoteHost(forgedC, joinerDeps(b));
    expect(result).toMatchObject({ ok: false, error: 'fingerprint-mismatch' });
    // Nothing reached A: the invite is intact and no peer exists.
    expect(a.server.pairingStatus()).toMatchObject({ active: true, attemptsLeft: 5 });
    expect(a.peers.list()).toHaveLength(0);
    expect(b.remoteHosts.list()).toHaveLength(0);
  });

  it('an expired invite is refused', async () => {
    let now = Date.now();
    const a = await makePc('PC A', { deps: { now: () => now } });
    const b = await makePc('PC B');
    const invite = inviteOf(a);
    now += A2A_PAIR_TTL_MS + 1;
    const result = await joinRemoteHost(formatInvite(invite), joinerDeps(b));
    expect(result).toMatchObject({ ok: false, error: 'code-expired' });
    expect(a.peers.list()).toHaveLength(0);
  });

  it('five wrong codes burn the invite', async () => {
    const a = await makePc('PC A');
    const b = await makePc('PC B');
    const invite = inviteOf(a);
    const wrong = formatInvite({ ...invite, code: invite.code === 'ZZZZZZZZ' ? 'YYYYYYYY' : 'ZZZZZZZZ' });
    for (let i = 0; i < 5; i++) {
      expect(await joinRemoteHost(wrong, joinerDeps(b))).toMatchObject({ ok: false, error: 'code-invalid' });
    }
    expect(await joinRemoteHost(formatInvite(invite), joinerDeps(b))).toMatchObject({ ok: false, error: 'code-expired' });
    expect(a.peers.list()).toHaveLength(0);
  });

  it('re-pairing the same host is a 409 until A revokes', async () => {
    const a = await makePc('PC A');
    const b = await makePc('PC B');
    expect((await joinRemoteHost(formatInvite(inviteOf(a)), joinerDeps(b))).ok).toBe(true);
    const again = await joinRemoteHost(formatInvite(inviteOf(a)), joinerDeps(b));
    expect(again).toMatchObject({ ok: false, error: 'already-paired' });
    // The invite survives the refusal.
    expect(a.server.pairingStatus().active).toBe(true);
  });

  it('joining this PC’s own invite is refused', async () => {
    const b = await makePc('PC B');
    const result = await joinRemoteHost(b.server.beginPairing().invite, joinerDeps(b));
    expect(result).toMatchObject({ ok: false, error: 'self' });
    expect(b.peers.list()).toHaveLength(0);
  });

  it('distinguishes refused from unparseable', async () => {
    const b = await makePc('PC B');
    const a = await makePc('PC A');
    const invite = inviteOf(a);
    const closedPort = await freePort();
    const refused = await joinRemoteHost(formatInvite({ ...invite, port: closedPort }), joinerDeps(b));
    expect(refused).toMatchObject({ ok: false, error: 'connect-refused' });
    expect(await joinRemoteHost('not an invite', joinerDeps(b))).toMatchObject({ ok: false, error: 'invite-invalid' });
  });

  it('peers.revoke cascades to the link and exposure stores', async () => {
    const a = await makePc('PC A');
    const b = await makePc('PC B');
    expect((await joinRemoteHost(formatInvite(inviteOf(a)), joinerDeps(b))).ok).toBe(true);
    const handlers = new Map<string, (p: Record<string, unknown>) => Promise<unknown>>();
    const links = { forgetHost: vi.fn(() => 0) };
    const exposures = { forgetHost: vi.fn(() => true) };
    registerA2aRemoteRpc((m, h) => handlers.set(m, h), {
      controller: a.controller,
      server: a.server,
      peers: a.peers,
      remoteHosts: a.remoteHosts,
      links,
      exposures,
      log: () => undefined,
    });
    const [peer] = a.peers.list();
    expect(await handlers.get('a2a.remote.peers.revoke')!({ peerId: peer.peerId })).toEqual({ ok: true });
    expect(links.forgetHost).toHaveBeenCalledWith(b.server.status().hostId);
    expect(exposures.forgetHost).toHaveBeenCalledWith(b.server.status().hostId);
    expect(a.peers.list()[0].revokedAt).toBeDefined();
    expect(await handlers.get('a2a.remote.peers.revoke')!({ peerId: 'unknown' })).toEqual({ ok: false });
  });
});
