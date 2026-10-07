import http from 'node:http';
import net from 'node:net';
import tls from 'node:tls';
import { StringDecoder } from 'node:string_decoder';
import { normalizeFingerprint256 } from '../../shared/a2aRemote';

/**
 * Certificate-pinned HTTPS client for cross-host A2A (joiner -> server).
 *
 * Identity is the pinned SHA-256 fingerprint, not a CA chain: the server runs a
 * self-signed certificate and the joiner learned its fingerprint from the
 * invite. The order is the security property:
 *
 *   1. TCP + TLS handshake, nothing else.
 *   2. Compare the leaf certificate's fingerprint with the pin. On mismatch the
 *      socket is destroyed before a single HTTP byte — and so before any
 *      credential — is written, and the remaining addresses are NOT tried: a
 *      host answering with the wrong certificate is an identity failure, not an
 *      unreachable address.
 *   3. Only then is an HTTP/1.1 request built on that socket.
 *
 * Addresses are tried in order (machine name first, then known IPv4s); only
 * connect-level failures (refused, unreachable, DNS, handshake timeout) advance
 * to the next one. Proxy environment variables are ignored by construction: the
 * socket is dialled here and handed to `http.request` via `createConnection`,
 * so no agent — proxy-aware or not — is ever consulted.
 */

export interface PinnedClientOptions {
  /** Tried in order; the first that completes a handshake decides the outcome. */
  addresses: string[];
  port: number;
  /** The pinned leaf fingerprint (`X509Certificate.fingerprint256` form; case and colons are normalized). */
  fingerprint256: string;
  /** Peer credential. Sent ONLY as `Authorization: Bearer`, never in a URL. Absent for pre-pairing calls. */
  credential?: string;
  /** Budget per address for TCP connect + TLS handshake. */
  connectTimeoutMs: number;
  /** Budget from request start to a complete JSON answer (requestJson) or to response headers (openStream). */
  requestTimeoutMs: number;
}

export type PinnedClientErrorCode =
  | 'bad-options'
  /** No address completed a handshake. Nothing was sent. */
  | 'connect-failed'
  /** A host answered with a certificate other than the pinned one. Nothing was sent. */
  | 'fingerprint-mismatch'
  /** The request was written but no complete answer arrived in time. */
  | 'timeout'
  | 'aborted'
  /** The socket failed after the request was written. */
  | 'network'
  /** An answer arrived but is unusable (oversized, or a stream event that is not JSON). */
  | 'protocol'
  /** The stream route answered something other than 200. `status`/`json` carry the answer. */
  | 'http';

export class PinnedClientError extends Error {
  readonly code: PinnedClientErrorCode;
  /**
   * True once request bytes may have reached the peer. An outbox uses this to
   * tell "retry freely" (false) from "outcome unknown, resend idempotently" (true).
   */
  readonly sent: boolean;
  readonly status?: number;
  readonly json?: unknown;

  constructor(code: PinnedClientErrorCode, message: string, extra: { sent: boolean; status?: number; json?: unknown }) {
    super(message);
    this.name = 'PinnedClientError';
    this.code = code;
    this.sent = extra.sent;
    if (extra.status !== undefined) this.status = extra.status;
    if (extra.json !== undefined) this.json = extra.json;
  }
}

/** One server-sent event whose `data` was JSON. */
export interface PinnedSseEvent {
  /** The stream's last event id at dispatch (SSE semantics: it persists across events). */
  id?: string;
  /** SSE event type; `message` when the server sent none. */
  event: string;
  data: unknown;
}

/** Cap on a buffered JSON answer and on one SSE line — a misbehaving peer must not grow memory without bound. */
const MAX_BODY_BYTES = 4 * 1024 * 1024;

export class PinnedTlsClient {
  private readonly opts: PinnedClientOptions;

  constructor(opts: PinnedClientOptions) {
    this.opts = opts;
  }

  /** One JSON request. Resolves with any HTTP status; `json` is null when the body is empty or not JSON. */
  async requestJson(method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
    const { socket, address } = await this.connect();
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), 'utf8');
    return new Promise((resolve, reject) => {
      let settled = false;
      const req = http.request({
        method,
        path,
        host: address,
        port: this.opts.port,
        headers: this.headers({
          Accept: 'application/json',
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': String(payload.length) } : {}),
        }),
        createConnection: () => socket,
      });
      const finish = (outcome: PinnedClientError | { status: number; json: unknown }): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        req.destroy();
        socket.destroy();
        if (outcome instanceof PinnedClientError) reject(outcome);
        else resolve(outcome);
      };
      const timer = setTimeout(
        () => finish(new PinnedClientError('timeout', `no answer within ${this.opts.requestTimeoutMs}ms`, { sent: true })),
        this.opts.requestTimeoutMs,
      );
      req.on('error', (err) => finish(new PinnedClientError('network', errMsg(err), { sent: true })));
      req.on('response', (res) => {
        readCapped(res).then(
          (text) => finish({ status: res.statusCode ?? 0, json: parseJsonOrNull(text) }),
          (err: unknown) => finish(asSentError(err)),
        );
      });
      req.end(payload);
    });
  }

  /**
   * Open a server-sent event stream. Iteration ends normally when the server
   * closes the stream or `signal` aborts; it throws on a non-200 answer
   * (`http`), a socket failure (`network`) or a non-JSON event (`protocol`).
   * Breaking out of the loop closes the connection.
   *
   * No idle timeout is applied once the stream is open — liveness is the
   * caller's call (abort on a missed heartbeat).
   */
  async *openStream(
    path: string,
    { signal, lastEventId }: { signal: AbortSignal; lastEventId?: string },
  ): AsyncGenerator<PinnedSseEvent, void, undefined> {
    if (signal.aborted) return;
    let conn: { socket: tls.TLSSocket; address: string };
    try {
      conn = await this.connect(signal);
    } catch (err) {
      if (signal.aborted) return;
      throw err;
    }
    const { socket, address } = conn;
    const req = http.request({
      method: 'GET',
      path,
      host: address,
      port: this.opts.port,
      headers: this.headers({
        Accept: 'text/event-stream',
        'Cache-Control': 'no-cache',
        ...(lastEventId !== undefined ? { 'Last-Event-ID': lastEventId } : {}),
      }),
      createConnection: () => socket,
    });
    const onAbort = (): void => {
      // With an error so a request still waiting for headers rejects at once.
      req.destroy(new Error('aborted'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      const res = await this.awaitResponse(req);
      if (res.statusCode !== 200) {
        const text = await readCapped(res).catch(() => '');
        throw new PinnedClientError('http', `stream refused: HTTP ${res.statusCode}`, {
          sent: true,
          status: res.statusCode ?? 0,
          json: parseJsonOrNull(text),
        });
      }
      const parser = new SseParser();
      const decoder = new StringDecoder('utf8');
      for await (const chunk of res as AsyncIterable<Buffer>) {
        const events = parser.feed(decoder.write(chunk));
        for (const ev of events) yield ev;
      }
      // The server ended the stream; a trailing event without its blank line is
      // incomplete and dropped, as the SSE spec says.
    } catch (err) {
      if (signal.aborted) return;
      throw asSentError(err);
    } finally {
      signal.removeEventListener('abort', onAbort);
      req.destroy();
      socket.destroy();
    }
  }

  private headers(extra: Record<string, string>): Record<string, string> {
    return {
      ...extra,
      ...(this.opts.credential ? { Authorization: `Bearer ${this.opts.credential}` } : {}),
    };
  }

  /** Resolve with response headers, or reject on socket error / `requestTimeoutMs`. */
  private awaitResponse(req: http.ClientRequest): Promise<http.IncomingMessage> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new PinnedClientError('timeout', `no response within ${this.opts.requestTimeoutMs}ms`, { sent: true }));
        req.destroy();
      }, this.opts.requestTimeoutMs);
      req.once('response', (res) => {
        clearTimeout(timer);
        resolve(res);
      });
      req.on('error', (err) => {
        clearTimeout(timer);
        reject(new PinnedClientError('network', errMsg(err), { sent: true }));
      });
      req.end();
    });
  }

  /** Handshake with the first reachable address and verify the pin. Writes nothing. */
  private async connect(signal?: AbortSignal): Promise<{ socket: tls.TLSSocket; address: string }> {
    const pin = normalizeFingerprint256(this.opts.fingerprint256);
    if (!pin) throw new PinnedClientError('bad-options', 'pinned fingerprint is malformed', { sent: false });
    if (this.opts.addresses.length === 0) throw new PinnedClientError('bad-options', 'no address to try', { sent: false });
    const failures: string[] = [];
    for (const address of this.opts.addresses) {
      let socket: tls.TLSSocket;
      try {
        socket = await this.handshake(address, signal);
      } catch (err) {
        if (err instanceof PinnedClientError) throw err; // aborted
        failures.push(`${address}: ${errMsg(err)}`);
        continue;
      }
      const presented = normalizeFingerprint256(socket.getPeerCertificate()?.fingerprint256);
      if (presented !== pin) {
        socket.destroy();
        throw new PinnedClientError(
          'fingerprint-mismatch',
          `${address} presented certificate ${presented ?? '(none)'}, expected the pinned ${pin}`,
          { sent: false },
        );
      }
      return { socket, address };
    }
    throw new PinnedClientError('connect-failed', `no address reachable (${failures.join('; ')})`, { sent: false });
  }

  private handshake(address: string, signal?: AbortSignal): Promise<tls.TLSSocket> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new PinnedClientError('aborted', 'aborted', { sent: false }));
        return;
      }
      const socket = tls.connect({
        host: address,
        port: this.opts.port,
        // No CA verification: the fingerprint check in `connect` IS the identity check.
        rejectUnauthorized: false,
        // SNI must not carry an IP literal.
        ...(net.isIP(address) ? {} : { servername: address }),
      });
      let done = false;
      const finish = (err: Error | null): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        if (err) {
          socket.destroy();
          reject(err);
        } else {
          resolve(socket);
        }
      };
      const onAbort = (): void => finish(new PinnedClientError('aborted', 'aborted', { sent: false }));
      const timer = setTimeout(
        () => finish(new Error(`handshake timed out after ${this.opts.connectTimeoutMs}ms`)),
        this.opts.connectTimeoutMs,
      );
      signal?.addEventListener('abort', onAbort, { once: true });
      socket.once('secureConnect', () => finish(null));
      // Stays attached after success: it covers the gap before http.request
      // attaches its own listener, and is a no-op once `done`.
      socket.on('error', (err) => finish(err));
    });
  }
}

/** Incremental SSE parser (WHATWG event-stream rules for the fields this protocol uses). */
class SseParser {
  private pending = '';
  private dataLines: string[] = [];
  private eventType = '';
  private lastId: string | undefined;

  feed(text: string): PinnedSseEvent[] {
    this.pending += text;
    const out: PinnedSseEvent[] = [];
    for (;;) {
      const m = /\r\n|\r|\n/.exec(this.pending);
      if (!m) break;
      // A lone trailing CR may be the first half of a CRLF split across chunks.
      if (m[0] === '\r' && m.index === this.pending.length - 1) break;
      const line = this.pending.slice(0, m.index);
      this.pending = this.pending.slice(m.index + m[0].length);
      const ev = this.line(line);
      if (ev) out.push(ev);
    }
    if (this.pending.length > MAX_BODY_BYTES) {
      throw new PinnedClientError('protocol', 'stream line exceeds the size cap', { sent: true });
    }
    return out;
  }

  private line(line: string): PinnedSseEvent | null {
    if (line === '') return this.dispatch();
    if (line.startsWith(':')) return null;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') this.dataLines.push(value);
    else if (field === 'event') this.eventType = value;
    else if (field === 'id' && !value.includes('\0')) this.lastId = value;
    return null;
  }

  private dispatch(): PinnedSseEvent | null {
    const lines = this.dataLines;
    const event = this.eventType || 'message';
    this.dataLines = [];
    this.eventType = '';
    if (lines.length === 0) return null;
    let data: unknown;
    try {
      data = JSON.parse(lines.join('\n'));
    } catch {
      throw new PinnedClientError('protocol', 'stream event data is not JSON', { sent: true });
    }
    return { ...(this.lastId !== undefined ? { id: this.lastId } : {}), event, data };
  }
}

function readCapped(res: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    res.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        res.destroy();
        reject(new PinnedClientError('protocol', 'response body exceeds the size cap', { sent: true }));
        return;
      }
      chunks.push(chunk);
    });
    res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    res.on('error', reject);
    res.on('aborted', () => reject(new Error('response aborted')));
  });
}

function parseJsonOrNull(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function asSentError(err: unknown): PinnedClientError {
  return err instanceof PinnedClientError ? err : new PinnedClientError('network', errMsg(err), { sent: true });
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
