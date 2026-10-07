// JoinerSession pump, with a fake pinned client: what happens when this side
// cannot record the outcome of a send.
import { afterEach, describe, expect, it } from 'vitest';
import { A2A_REMOTE_PROTOCOL, A2A_ROUTES, type A2aOutboxRecordV1 } from '../../../shared/a2aRemote';
import { JoinerSession, type SessionClient } from '../session';

const HOST = '11111111-1111-4111-8111-111111111111';

function record(): A2aOutboxRecordV1 {
  return {
    v: 1, epoch: 'e', seq: 1, hostId: HOST, state: 'pending', attempts: 0, createdAt: 'x', updatedAt: 'x',
    envelope: { protocol: A2A_REMOTE_PROTOCOL, linkId: 'l', linkVersion: 2, messageId: 'm', kind: 'reply', taskId: 't', text: 'hi', sentAt: 'x' },
  };
}

const sessions: JoinerSession[] = [];
afterEach(async () => {
  for (const s of sessions.splice(0)) await s.stop();
});

function make(answer: unknown, failWrites: { ack?: boolean; refuse?: boolean }): { posts: () => number } {
  let posts = 0;
  const rec = record();
  const client: SessionClient = {
    requestJson: async (_m, p) => {
      if (p === A2A_ROUTES.messages) posts += 1;
      return { status: 200, json: answer };
    },
    // A stream that never yields: only the pump is under test.
    openStream: async function* (_p, { signal }) {
      await new Promise<void>((r) => signal.addEventListener('abort', () => r(), { once: true }));
    },
  };
  const session = new JoinerSession({
    hostId: HOST,
    host: () => ({ v: 1, hostId: HOST, name: 'B', addresses: ['127.0.0.1'], port: 1, fingerprint256: 'AB', peerId: 'p', createdAt: 'x' }),
    credential: () => ({ peerId: '22222222-2222-4222-8222-222222222222', secret: 'a'.repeat(43) }),
    outbox: {
      epoch: 'e',
      head: () => structuredClone(rec),
      openCount: () => 1,
      markSent: () => rec,
      markOutcomeUnknown: () => rec,
      ack: () => { if (failWrites.ack) throw new Error('disk'); return 1; },
      refuse: () => { if (failWrites.refuse) throw new Error('disk'); return rec; },
    },
    accept: async () => ({ ok: true, duplicate: false }),
    onRefused: () => undefined,
    reconcileLinks: async () => undefined,
    onStatus: () => undefined,
    timing: { backoffMinMs: 100, backoffMaxMs: 400, livenessMs: 60_000 },
    client: () => client,
    log: () => undefined,
  });
  sessions.push(session);
  session.start();
  return { posts: () => posts };
}

describe('JoinerSession pump', () => {
  it('an ack it cannot record backs off instead of re-POSTing in a tight loop', async () => {
    const s = make({ ok: true, duplicate: false }, { ack: true });
    await new Promise((r) => setTimeout(r, 600));
    expect(s.posts()).toBeGreaterThanOrEqual(1);
    expect(s.posts()).toBeLessThanOrEqual(5);
  });

  it('a refusal it cannot record backs off too', async () => {
    const s = make({ ok: false, error: 'conflict' }, { refuse: true });
    await new Promise((r) => setTimeout(r, 600));
    expect(s.posts()).toBeGreaterThanOrEqual(1);
    expect(s.posts()).toBeLessThanOrEqual(5);
  });
});
