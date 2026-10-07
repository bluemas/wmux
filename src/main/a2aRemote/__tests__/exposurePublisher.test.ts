import { describe, expect, it, vi } from 'vitest';
import type { A2aExposureCandidate, A2aRemotePaneGoneParams, A2aRemotePaneSnapshot } from '../../../shared/rpc';
import { A2aExposurePublisher, coercePaneSnapshot, diffGonePanes } from '../exposurePublisher';

const snap = (ws: Array<[string, string[]]>): A2aRemotePaneSnapshot => ({
  workspaces: ws.map(([id, panes]) => ({ id, name: `name-${id}`, panes: panes.map((paneId) => ({ paneId, cwd: `/repo/${paneId}` })) })),
});

describe('diffGonePanes', () => {
  it('reports closed panes, moved panes and gone workspaces (not their panes)', () => {
    const prev = snap([['w1', ['a', 'b', 'c']], ['w2', ['d']], ['w3', ['e']]]);
    const next = snap([['w1', ['a']], ['w2', ['d', 'c']]]);
    expect(diffGonePanes(prev, next)).toEqual([
      { workspaceId: 'w1', paneId: 'b', reason: 'pane-closed' },
      { workspaceId: 'w1', paneId: 'c', reason: 'pane-moved' },
      { workspaceId: 'w3', reason: 'workspace-gone' },
    ]);
  });
});

describe('A2aExposurePublisher', () => {
  function rig(exposed: string[]) {
    const published: A2aExposureCandidate[][] = [];
    const gone: A2aRemotePaneGoneParams[] = [];
    const client = {
      a2aRemoteExposureList: vi.fn(async () => ({ exposures: exposed.length ? [{ v: 1 as const, hostId: 'h', workspaceIds: exposed, updatedAt: '' }] : [] })),
      a2aRemoteExposurePublish: vi.fn(async (p: A2aExposureCandidate[]) => void published.push(p)),
      a2aRemotePaneGone: vi.fn(async (p: A2aRemotePaneGoneParams) => void gone.push(p)),
    };
    const pub = new A2aExposurePublisher({
      client: () => client,
      repoKey: async (cwd) => (cwd === '/repo/a' ? 'github.com/acme/api' : null),
      log: () => undefined,
    });
    return { pub, published, gone };
  }

  it('publishes only exposed workspaces, with the repo key; the first snapshot is only a baseline', async () => {
    const { pub, published, gone } = rig(['w1']);
    await pub.accept(snap([['w1', ['a']], ['w2', ['d']]]));
    expect(gone).toEqual([]);
    expect(published.at(-1)).toEqual([
      { kind: 'pane', workspaceId: 'w1', workspaceName: 'name-w1', paneId: 'a', cwd: '/repo/a', gitRemote: 'github.com/acme/api' },
    ]);
    await pub.accept(snap([['w1', ['a']]]));
    expect(gone).toEqual([{ workspaceId: 'w2', reason: 'workspace-gone' }]);
  });

  it('an empty tree after a real one breaks nothing (a reloading window)', async () => {
    const { pub, gone } = rig(['w1']);
    await pub.accept(snap([['w1', ['a']]]));
    await pub.accept({ workspaces: [] });
    await pub.accept(snap([['w1', ['a']]]));
    expect(gone).toEqual([]);
  });

  it('publishes nothing while nothing is exposed', async () => {
    const { pub, published } = rig([]);
    await pub.accept(snap([['w1', ['a']]]));
    expect(published).toEqual([[]]);
  });
});

describe('A2aExposurePublisher Moa', () => {
  function rig(brainExposed: boolean) {
    const published: A2aExposureCandidate[][] = [];
    const gone: A2aRemotePaneGoneParams[] = [];
    const client = {
      a2aRemoteExposureList: vi.fn(async () => ({ exposures: [{ v: 1 as const, hostId: 'h', workspaceIds: [], updatedAt: '', ...(brainExposed ? { brain: true } : {}) }] })),
      a2aRemoteExposurePublish: vi.fn(async (p: A2aExposureCandidate[]) => void published.push(p)),
      a2aRemotePaneGone: vi.fn(async (p: A2aRemotePaneGoneParams) => void gone.push(p)),
    };
    return { pub: new A2aExposurePublisher({ client: () => client, repoKey: async () => null, log: () => undefined }), published, gone };
  }
  const withMoa = (hq: string | null): A2aRemotePaneSnapshot => ({ ...snap([['hq', []], ['w1', ['a']]]), ...(hq ? { brain: { workspaceId: hq, name: 'Moa' } } : {}) });

  it('publishes Moa only while some PC may see it', async () => {
    const shown = rig(true);
    await shown.pub.accept(withMoa('hq'));
    expect(shown.published.at(-1)).toEqual([{ kind: 'brain', workspaceId: 'hq', workspaceName: 'Moa' }]);
    const hidden = rig(false);
    await hidden.pub.accept(withMoa('hq'));
    expect(hidden.published.at(-1)).toEqual([]);
  });

  it('Moa turning off breaks its links (brain endpoint gone)', async () => {
    const { pub, gone, published } = rig(true);
    await pub.accept(withMoa('hq'));
    await pub.accept(withMoa(null));
    expect(gone).toEqual([{ workspaceId: 'hq', reason: 'workspace-gone', endpoint: 'brain' }]);
    expect(published.at(-1)).toEqual([]);
  });
});

describe('coercePaneSnapshot', () => {
  it('rejects malformed input and drops empty optional fields', () => {
    expect(coercePaneSnapshot(null)).toBeNull();
    expect(coercePaneSnapshot({ workspaces: [{ id: 'w', panes: [{ paneId: '' }] }] })).toBeNull();
    expect(coercePaneSnapshot({ workspaces: [{ id: 'w', name: 'W', panes: [{ paneId: 'p', label: '', agent: 'claude' }] }] }))
      .toEqual({ workspaces: [{ id: 'w', name: 'W', panes: [{ paneId: 'p', agent: 'claude' }] }] });
  });
});
