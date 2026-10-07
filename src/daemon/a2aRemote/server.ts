import fs from 'node:fs';
import type http from 'node:http';
import https from 'node:https';
import type net from 'node:net';
import os from 'node:os';
import {
  A2A_REMOTE_BODY_MAX,
  A2A_REMOTE_PROTOCOL,
  A2A_ROUTES,
  formatPeerCredential,
  isA2aRoute,
  isHostId,
  looksLikePeerCredential,
  parsePeerCredential,
  type A2aHelloResponse,
  type A2aPairRefusal,
  type A2aPairResponse,
  type A2aRemoteErrorCode,
} from '../../shared/a2aRemote';
import type { A2aRemotePairBeginResult, A2aRemotePairStatus, A2aRemoteStatus } from '../../shared/rpc';
import type { WebA2aPeer, WebA2aRoutes } from '../web/WebTerminalServer';
import { A2A_REMOTE_CONFIG_CHANGED, type A2aRemoteController } from './controller';
import { loadOrCreateHostIdentity, type HostIdentity, type HostIdentityOptions } from './hostIdentity';
import { PairingSlot, inviteHost } from './pairing';
import type { PeerAuthResult } from './peerStore';

/**
 * The dedicated cross-host A2A listener: a small HTTPS server serving the
 * host identity's self-signed certificate on `0.0.0.0:<port>`, and nothing
 * but `/api/a2a/*`.
 *
 * Deliberately NOT the phone web server (WebTerminalServer): that server
 * cannot run native TLS beside tailscale, opens device pairing to the whole
 * LAN once TLS is on, and has one bind/TLS setting for both jobs. This one
 * holds no operator token and no device store, so it has nothing to issue
 * but a PEER credential.
 *
 * No Host allowlist: there is no browser client. Instead any request that
 * carries an `Origin` header is refused (403) before anything else — a
 * server-to-server call never sends one, and a browser always does on a
 * cross-origin fetch, so a DNS-rebinding page cannot reach a route.
 */

/**
 * Cap on a request body. The contract caps a message's TEXT at
 * `A2A_REMOTE_BODY_MAX`; JSON escaping can grow that text, so the envelope
 * around a full-size text gets twice the room plus the fixed fields.
 */
export const A2A_REQUEST_BODY_MAX = 2 * A2A_REMOTE_BODY_MAX + 4096;

const HEADERS_TIMEOUT_MS = 10_000;
const REQUEST_TIMEOUT_MS = 30_000;
const KEEP_ALIVE_TIMEOUT_MS = 5_000;
const HANDSHAKE_TIMEOUT_MS = 10_000;
const MAX_CONNECTIONS = 64;

/** The slice of `PeerStore` the listener needs. */
export interface A2aPeerSource {
  resolve(peerId: string, secret: string): Promise<PeerAuthResult>;
  touch(peerId: string): void;
  mint(params: { hostId: string; name: string }): Promise<{ peerId: string; secret: string }>;
  listByHost(hostId: string): Array<{ revokedAt?: string }>;
}

export type A2aServerLog = (level: 'info' | 'warn' | 'error', msg: string) => void;

export interface A2aServerDeps {
  controller: A2aRemoteController;
  /** Directory holding the host identity (`<wmux dir>/a2a`). */
  identityDir: string;
  peers: A2aPeerSource;
  /** Every other `/api/a2a/*` route, reached only with an authenticated peer. Absent: 503. */
  routes?: WebA2aRoutes;
  /** This machine's name. Default `os.hostname()`. */
  hostname?: () => string;
  /** This machine's external IPv4s. Default: `os.networkInterfaces()`. */
  ipv4s?: () => string[];
  /** Bind address. Default `0.0.0.0` (PoC); tests bind loopback. */
  bindHost?: string;
  /** Clock for the invite's lifetime. Default `Date.now`. */
  now?: () => number;
  /** Test seam; default `loadOrCreateHostIdentity`. */
  loadIdentity?: (opts: HostIdentityOptions) => HostIdentity;
  log?: A2aServerLog;
}

export function externalIpv4s(): string[] {
  const out: string[] = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const nic of list ?? []) {
      if (nic.family === 'IPv4' && !nic.internal && !nic.address.startsWith('169.254.')) out.push(nic.address);
    }
  }
  return out;
}

export class A2aServer {
  private readonly deps: A2aServerDeps;
  private readonly hostname: () => string;
  private readonly ipv4s: () => string[];
  private readonly loadIdentity: (opts: HostIdentityOptions) => HostIdentity;
  private readonly log: A2aServerLog;
  private readonly pairing: PairingSlot;
  private server: https.Server | null = null;
  private port: number | null = null;
  private identity: HostIdentity | null = null;
  private lastError: string | null = null;
  private chain: Promise<void> = Promise.resolve();
  private disposed = false;

  constructor(deps: A2aServerDeps) {
    this.deps = deps;
    this.hostname = deps.hostname ?? ((): string => os.hostname());
    this.ipv4s = deps.ipv4s ?? externalIpv4s;
    this.loadIdentity = deps.loadIdentity ?? loadOrCreateHostIdentity;
    this.pairing = new PairingSlot({ ...(deps.now ? { now: deps.now } : {}) });
    this.log = deps.log ?? ((level, msg): void => void console[level === 'info' ? 'log' : level](msg));
    deps.controller.on(A2A_REMOTE_CONFIG_CHANGED, () => this.scheduleReconcile());
    // `changed` does not fire at boot: an enabled listener starts here.
    if (deps.controller.current().enabled) this.scheduleReconcile();
  }

  /** Resolves once every queued start/stop/rebind has run. */
  whenIdle(): Promise<void> {
    return this.chain;
  }

  /**
   * This PC's identity, loading (and on a fresh data directory creating) it
   * on first use. The joiner needs the hostId even while the listener is off.
   */
  ensureIdentity(): HostIdentity {
    if (!this.identity) this.identity = this.readIdentity();
    return this.identity;
  }

  /** The port actually bound, or null when not listening. */
  boundPort(): number | null {
    return this.port;
  }

  name(): string {
    return this.hostname().trim() || 'wmux';
  }

  status(): A2aRemoteStatus {
    const cfg = this.deps.controller;
    return {
      enabled: cfg.current().enabled,
      port: cfg.effectivePort(),
      listening: this.server !== null,
      hostId: this.identity?.hostId ?? null,
      name: this.name(),
      fingerprint256: this.identity?.fingerprint256 ?? null,
      lastError: this.lastError,
    };
  }

  /** Open (or replace) the one-shot invite. Throws while the listener is down. */
  beginPairing(): A2aRemotePairBeginResult {
    if (!this.server || this.port === null || !this.identity) {
      throw new Error('a2a.remote.pair.begin: the A2A listener is not running');
    }
    const host = inviteHost(this.hostname(), this.ipv4s());
    if (!host) throw new Error('a2a.remote.pair.begin: this PC has no usable name or IPv4 address');
    return this.pairing.begin({ host, port: this.port, fingerprint256: this.identity.fingerprint256 });
  }

  cancelPairing(): void {
    this.pairing.cancel();
  }

  pairingStatus(): A2aRemotePairStatus {
    return this.pairing.status();
  }

  dispose(): void {
    this.disposed = true;
    this.pairing.cancel();
    this.scheduleReconcile();
  }

  // --- lifecycle --------------------------------------------------------------

  private scheduleReconcile(): void {
    this.chain = this.chain
      .then(() => this.reconcile())
      .catch((err: unknown) => this.log('error', `[a2a-remote] reconcile failed: ${errMsg(err)}`));
  }

  private readIdentity(): HostIdentity {
    return this.loadIdentity({ dir: this.deps.identityDir, hostname: this.name(), ipAddresses: this.ipv4s() });
  }

  private async reconcile(): Promise<void> {
    await this.close();
    // An invite names the port and fingerprint of the listener it was minted
    // for; any start/stop/rebind makes it stale.
    this.pairing.cancel();
    const cfg = this.deps.controller.current();
    if (this.disposed || !cfg.enabled) {
      this.lastError = null;
      return;
    }

    let identity: HostIdentity;
    try {
      // Every (re)bind re-reads the identity so the served certificate is the
      // active generation (renewed when close to expiry).
      identity = this.readIdentity();
    } catch (err) {
      this.lastError = `identity: ${errMsg(err)}`;
      this.log('error', `[a2a-remote] cannot load the host identity, listener stays stopped: ${errMsg(err)}`);
      return;
    }
    if (this.identity && identity.fingerprint256 !== this.identity.fingerprint256) {
      this.log('warn', '[a2a-remote] certificate re-issued: paired PCs must be invited again');
    }
    this.identity = identity;

    let server: https.Server;
    try {
      server = https.createServer(
        {
          cert: fs.readFileSync(identity.certPath),
          key: fs.readFileSync(identity.keyPath),
          minVersion: 'TLSv1.2',
          handshakeTimeout: HANDSHAKE_TIMEOUT_MS,
        },
        (req, res) => {
          this.handle(req, res).catch((err: unknown) => {
            this.log('warn', `[a2a-remote] request failed: ${errMsg(err)}`);
            if (!res.headersSent) sendJson(res, 500, { ok: false, error: 'unavailable' });
            else res.destroy();
          });
        },
      );
    } catch (err) {
      this.lastError = `tls: ${errMsg(err)}`;
      this.log('error', `[a2a-remote] cannot build the TLS listener: ${errMsg(err)}`);
      return;
    }
    server.headersTimeout = HEADERS_TIMEOUT_MS;
    server.requestTimeout = REQUEST_TIMEOUT_MS;
    server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;
    server.maxConnections = MAX_CONNECTIONS;

    const port = this.deps.controller.effectivePort();
    const bindHost = this.deps.bindHost ?? '0.0.0.0';
    const listenError = await new Promise<NodeJS.ErrnoException | null>((resolve) => {
      const onError = (err: NodeJS.ErrnoException): void => resolve(err);
      server.once('error', onError);
      server.listen(port, bindHost, () => {
        server.off('error', onError);
        resolve(null);
      });
    });
    if (listenError) {
      // No retry loop: the operator changes the port or frees it.
      this.lastError = listenError.code ?? errMsg(listenError);
      this.log('warn', `[a2a-remote] cannot listen on ${bindHost}:${port}: ${errMsg(listenError)}`);
      server.close();
      return;
    }
    server.on('error', (err) => this.log('warn', `[a2a-remote] listener error: ${errMsg(err)}`));
    // A dispose or reconfigure that arrived while binding is already queued behind us.
    this.server = server;
    this.port = (server.address() as net.AddressInfo).port;
    this.lastError = null;
    this.log('info', `[a2a-remote] listening on ${bindHost}:${this.port}`);
  }

  private close(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.port = null;
    if (!server) return Promise.resolve();
    return new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }

  // --- requests ---------------------------------------------------------------

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const refuse = (status: number, error: A2aRemoteErrorCode, extra?: Record<string, unknown>): void =>
      sendJson(res, status, { ok: false, error, ...extra });

    // Before anything else, on every path: a browser sent this (see the class note).
    if (req.headers['origin'] !== undefined) return refuse(403, 'forbidden');

    const url = new URL(req.url ?? '/', 'https://a2a.invalid');
    const p = url.pathname;
    if (!isA2aRoute(p)) return refuse(404, 'bad-request', { message: 'not found' });

    const length = Number(req.headers['content-length'] ?? 0);
    if (Number.isFinite(length) && length > A2A_REQUEST_BODY_MAX) {
      res.setHeader('Connection', 'close');
      return refuse(413, 'too-large');
    }

    // The one route that takes no credential: it is how a joiner gets one.
    if (p === A2A_ROUTES.pair) {
      if (req.method !== 'POST') return refuse(405, 'bad-request');
      return this.handlePair(req, res);
    }

    const peer = await this.authenticate(req, url, refuse);
    if (!peer) return;

    if (p === A2A_ROUTES.hello) {
      if (req.method !== 'GET') return refuse(405, 'bad-request');
      const identity = this.identity;
      if (!identity) return refuse(503, 'unavailable');
      const hello: A2aHelloResponse = { protocol: A2A_REMOTE_PROTOCOL, hostId: identity.hostId, name: this.name() };
      return sendJson(res, 200, hello);
    }

    const routes = this.deps.routes;
    if (!routes) return refuse(503, 'unavailable');
    await routes.handle(req, res, url, p, peer);
  }

  /**
   * Peer authentication, the same judgement as the phone web server's peer
   * gate: a malformed peer credential or none at all is a failed peer login
   * (401); any other credential shape (a device credential, a `?token=` or a
   * stream ticket) is a principal never allowed here (403).
   */
  private async authenticate(
    req: http.IncomingMessage,
    url: URL,
    refuse: (status: number, error: A2aRemoteErrorCode, extra?: Record<string, unknown>) => void,
  ): Promise<WebA2aPeer | null> {
    const header = req.headers['authorization'];
    const bearer = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice('Bearer '.length) : null;
    const cred = parsePeerCredential(bearer);
    if (!cred) {
      const otherCredential =
        (bearer !== null && !looksLikePeerCredential(bearer) && bearer.includes('.')) ||
        url.searchParams.has('token') ||
        url.searchParams.has('ticket');
      refuse(otherCredential ? 403 : 401, otherCredential ? 'forbidden' : 'unauthorized');
      return null;
    }
    let result: PeerAuthResult;
    try {
      result = await this.deps.peers.resolve(cred.peerId, cred.secret);
    } catch (err) {
      this.log('warn', `[a2a-remote] peer auth failed: ${errMsg(err)}`);
      refuse(401, 'unauthorized', { reason: 'unknown' });
      return null;
    }
    if (!result.ok) {
      refuse(401, 'unauthorized', { reason: result.reason });
      return null;
    }
    try {
      this.deps.peers.touch(result.peerId);
    } catch (err) {
      this.log('warn', `[a2a-remote] peer touch failed: ${errMsg(err)}`);
    }
    return { peerId: result.peerId, hostId: result.hostId, name: result.name };
  }

  /**
   * `POST /api/a2a/pair` — redeem the open invite for a PEER credential.
   * Issues nothing else: this listener holds no operator token and no device
   * store.
   */
  private async handlePair(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const refusePair = (status: number, error: A2aRemoteErrorCode, reason?: A2aPairRefusal): void =>
      sendJson(res, status, { ok: false, error, ...(reason ? { reason } : {}) });

    const body = await readJsonBody(req, A2A_REMOTE_BODY_MAX);
    if (body === 'too-large') {
      res.setHeader('Connection', 'close');
      return refusePair(413, 'too-large');
    }
    if (!isRecord(body)) return refusePair(400, 'bad-request');
    const { code, hostId, name, protocol } = body;
    if (typeof code !== 'string' || !isHostId(hostId) || typeof name !== 'string' || typeof protocol !== 'number') {
      return refusePair(400, 'bad-request');
    }
    if (protocol !== A2A_REMOTE_PROTOCOL) return refusePair(400, 'protocol');

    const identity = this.identity;
    if (!identity) return refusePair(503, 'unavailable');
    // No open invite: say only that, whatever else the request claims.
    if (!this.pairing.status().active) return refusePair(403, 'forbidden', 'expired');
    if (hostId === identity.hostId) return refusePair(400, 'bad-request', 'self');
    // One live peer per host (PeerStore rule). Checked before the code so a
    // refused re-pair does not spend the invite the operator just made.
    if (this.deps.peers.listByHost(hostId).some((r) => r.revokedAt === undefined)) {
      return refusePair(409, 'conflict');
    }
    const check = this.pairing.check(code);
    if (!check.ok) return refusePair(403, 'forbidden', check.reason);
    // Consume BEFORE the await: a second request with the same code must not mint again.
    this.pairing.consume();

    let minted: { peerId: string; secret: string };
    try {
      minted = await this.deps.peers.mint({ hostId, name });
    } catch (err) {
      this.log('warn', `[a2a-remote] pairing could not mint a peer credential: ${errMsg(err)}`);
      // A concurrent pairing for the same host won the race.
      if (this.deps.peers.listByHost(hostId).some((r) => r.revokedAt === undefined)) return refusePair(409, 'conflict');
      return refusePair(500, 'unavailable');
    }
    this.log('info', `[a2a-remote] paired with host ${hostId}`);
    const response: A2aPairResponse = {
      credential: formatPeerCredential(minted),
      hostId: identity.hostId,
      name: this.name(),
      protocol: A2A_REMOTE_PROTOCOL,
    };
    sendJson(res, 200, response);
  }
}

/** Read a JSON body of at most `max` bytes. Non-JSON is `undefined`; over the cap is `'too-large'`. */
export function readJsonBody(req: http.IncomingMessage, max: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    req.on('data', (chunk: Buffer) => {
      if (done) return;
      size += chunk.length;
      if (size > max) {
        done = true;
        req.resume();
        resolve('too-large');
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown);
      } catch {
        resolve(undefined);
      }
    });
    req.on('error', (err) => {
      if (done) return;
      done = true;
      reject(err);
    });
  });
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
