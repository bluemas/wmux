import dns from 'node:dns';
import net from 'node:net';
import {
  A2A_REMOTE_PROTOCOL,
  A2A_ROUTES,
  formatPeerCredential,
  isHostId,
  normalizeFingerprint256,
  parseInvite,
  parsePeerCredential,
  type A2aPairRequest,
  type A2aRemoteHostRecordV1,
  type PeerCredential,
} from '../../shared/a2aRemote';
import type { A2aRemoteJoinError, A2aRemoteJoinResult } from '../../shared/rpc';
import { PinnedClientError, PinnedTlsClient, type PinnedClientOptions } from './pinnedClient';
import type { NewRemoteHost } from './remoteHostStore';

/**
 * Joiner side of invite pairing. The invite carries the server's certificate
 * fingerprint, so the very first byte this side writes already goes over a
 * pinned connection: a wrong certificate fails before the pairing code (or,
 * later, the credential) leaves this machine.
 */

export interface JoinDeps {
  /** This PC's identity (hostId + fingerprint). Loaded on demand. */
  self: () => { hostId: string; fingerprint256: string };
  selfName: string;
  remoteHosts: { add(input: NewRemoteHost, credential: PeerCredential): A2aRemoteHostRecordV1 };
  /** Resolve a host name to the IPv4 it reaches, to remember next to the name. */
  lookup?: (host: string) => Promise<string | null>;
  /** Test seam. */
  timeouts?: { connectMs: number; requestMs: number };
}

const DEFAULT_TIMEOUTS = { connectMs: 5_000, requestMs: 10_000 };

class JoinFailure extends Error {
  constructor(readonly code: A2aRemoteJoinError, detail: string) {
    super(detail);
  }
}

async function defaultLookup(host: string): Promise<string | null> {
  try {
    return (await dns.promises.lookup(host, { family: 4 })).address;
  } catch {
    return null;
  }
}

export async function joinRemoteHost(inviteString: string, deps: JoinDeps): Promise<A2aRemoteJoinResult> {
  try {
    return { ok: true, host: await join(inviteString, deps) };
  } catch (err) {
    if (err instanceof JoinFailure) return { ok: false, error: err.code, detail: err.message };
    return { ok: false, error: 'failed', detail: err instanceof Error ? err.message : String(err) };
  }
}

async function join(inviteString: string, deps: JoinDeps): Promise<A2aRemoteHostRecordV1> {
  const parsed = parseInvite(inviteString);
  if (!parsed.ok) throw new JoinFailure('invite-invalid', `invite: ${parsed.error}`);
  const invite = parsed.invite;

  const self = deps.self();
  if (normalizeFingerprint256(self.fingerprint256) === invite.fingerprint256) {
    throw new JoinFailure('self', 'the invite was made on this PC');
  }

  const timeouts = deps.timeouts ?? DEFAULT_TIMEOUTS;
  const base: PinnedClientOptions = {
    addresses: [invite.host],
    port: invite.port,
    fingerprint256: invite.fingerprint256,
    connectTimeoutMs: timeouts.connectMs,
    requestTimeoutMs: timeouts.requestMs,
  };

  const request: A2aPairRequest = { code: invite.code, hostId: self.hostId, name: deps.selfName, protocol: A2A_REMOTE_PROTOCOL };
  const paired = await call(new PinnedTlsClient(base), 'POST', A2A_ROUTES.pair, request);
  if (paired.status !== 200) throw pairRefusal(paired.status, paired.json);

  const body = isRecord(paired.json) ? paired.json : {};
  const credential = parsePeerCredential(body['credential']);
  const serverHostId = body['hostId'];
  const serverName = typeof body['name'] === 'string' ? body['name'] : '';
  if (!credential || !isHostId(serverHostId) || body['protocol'] !== A2A_REMOTE_PROTOCOL) {
    throw new JoinFailure('protocol', 'the pairing answer is malformed');
  }
  if (serverHostId === self.hostId) throw new JoinFailure('self', 'the invite was made on this PC');

  // Prove the credential works and that the same host answers with it.
  const hello = await call(
    new PinnedTlsClient({ ...base, credential: formatPeerCredential(credential) }),
    'GET',
    A2A_ROUTES.hello,
  );
  const helloBody = isRecord(hello.json) ? hello.json : {};
  if (hello.status !== 200 || helloBody['hostId'] !== serverHostId) {
    throw new JoinFailure('protocol', `hello answered ${hello.status} for another identity`);
  }

  // Remember the name AND the address it reached, so a later DNS outage does
  // not strand the pairing. Best effort: the invite host alone is enough.
  const ip = net.isIPv4(invite.host) ? invite.host : await (deps.lookup ?? defaultLookup)(invite.host);
  try {
    return deps.remoteHosts.add(
      {
        hostId: serverHostId,
        name: serverName,
        addresses: ip ? [invite.host, ip] : [invite.host],
        port: invite.port,
        fingerprint256: invite.fingerprint256,
        peerId: credential.peerId,
      },
      credential,
    );
  } catch (err) {
    throw new JoinFailure('failed', `could not save the pairing: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function call(client: PinnedTlsClient, method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
  try {
    return await client.requestJson(method, path, body);
  } catch (err) {
    throw transportFailure(err);
  }
}

function transportFailure(err: unknown): JoinFailure {
  const msg = err instanceof Error ? err.message : String(err);
  if (!(err instanceof PinnedClientError)) return new JoinFailure('failed', msg);
  switch (err.code) {
    case 'fingerprint-mismatch':
      return new JoinFailure('fingerprint-mismatch', msg);
    case 'timeout':
      return new JoinFailure('timeout', msg);
    case 'connect-failed':
      if (/ECONNREFUSED/.test(msg)) return new JoinFailure('connect-refused', msg);
      if (/ENOTFOUND|EAI_AGAIN|EAI_NONAME/.test(msg)) return new JoinFailure('not-found', msg);
      if (/timed out|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH/.test(msg)) return new JoinFailure('timeout', msg);
      return new JoinFailure('failed', msg);
    default:
      return new JoinFailure('failed', msg);
  }
}

function pairRefusal(status: number, json: unknown): JoinFailure {
  const body = isRecord(json) ? json : {};
  const reason = body['reason'];
  const error = body['error'];
  if (status === 409) return new JoinFailure('already-paired', 'that PC already has a pairing for this PC');
  if (reason === 'self') return new JoinFailure('self', 'the invite was made on this PC');
  if (reason === 'expired') return new JoinFailure('code-expired', 'the invite expired or was cancelled');
  if (reason === 'invalid-code') return new JoinFailure('code-invalid', 'the invite code was not accepted');
  if (error === 'protocol') return new JoinFailure('protocol', 'the other PC speaks another protocol version');
  return new JoinFailure('failed', `pairing answered HTTP ${status}`);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
