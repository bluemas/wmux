import type {
  A2aExposureCandidate,
  A2aRemoteExposureListResult,
  A2aRemotePaneGoneParams,
  A2aRemotePaneSnapshot,
} from '../../shared/rpc';

/**
 * Main's half of cross-host exposure. The renderer sends its whole pane tree
 * (`A2aRemotePaneSnapshot`) whenever it changes; this:
 *
 *   1. diffs it against the previous one and tells the daemon which panes or
 *      workspaces went away (a pane under another workspace = moved), so the
 *      daemon breaks the links bound to them and drops them from exposure —
 *      for EVERY pane, not only exposed ones: a joiner's linked pane is never
 *      exposed to anyone;
 *   2. publishes the panes of the workspaces exposed to any paired PC, with
 *      their git remote key, plus this PC's Moa when some PC may see it, as
 *      the daemon's exposure snapshot. Nothing is published while nothing is
 *      exposed. Moa turning off (or its HQ going) withdraws it and breaks its
 *      links (`endpoint: 'brain'`).
 *
 * The first snapshot is only a baseline. The renderer sends none before its
 * session is restored, so an empty pre-restore tree never reads as "closed".
 */

export interface ExposurePublisherClient {
  a2aRemoteExposureList(): Promise<A2aRemoteExposureListResult>;
  a2aRemoteExposurePublish(panes: A2aExposureCandidate[]): Promise<unknown>;
  a2aRemotePaneGone(params: A2aRemotePaneGoneParams): Promise<unknown>;
}

export interface ExposurePublisherDeps {
  /** The live daemon client, or null while disconnected. */
  client: () => ExposurePublisherClient | null;
  /** The cwd's origin as `host/owner/repo` (detectRemote's key), or null. */
  repoKey: (cwd: string) => Promise<string | null>;
  log: (msg: string) => void;
}

/** What went away between two snapshots. A workspace that is gone covers its panes. */
export function diffGonePanes(prev: A2aRemotePaneSnapshot, next: A2aRemotePaneSnapshot): A2aRemotePaneGoneParams[] {
  const nextWs = new Set(next.workspaces.map((w) => w.id));
  const nextPaneWs = new Map<string, string>();
  for (const w of next.workspaces) for (const p of w.panes) nextPaneWs.set(p.paneId, w.id);
  const gone: A2aRemotePaneGoneParams[] = [];
  for (const w of prev.workspaces) {
    if (!nextWs.has(w.id)) {
      gone.push({ workspaceId: w.id, reason: 'workspace-gone' });
      continue;
    }
    for (const p of w.panes) {
      const now = nextPaneWs.get(p.paneId);
      if (now === undefined) gone.push({ workspaceId: w.id, paneId: p.paneId, reason: 'pane-closed' });
      else if (now !== w.id) gone.push({ workspaceId: w.id, paneId: p.paneId, reason: 'pane-moved' });
    }
  }
  // This PC's Moa went away (turned off, or its HQ is gone or replaced).
  if (prev.brain && prev.brain.workspaceId !== next.brain?.workspaceId) {
    gone.push({ workspaceId: prev.brain.workspaceId, reason: 'workspace-gone', endpoint: 'brain' });
  }
  return gone;
}

export class A2aExposurePublisher {
  private last: A2aRemotePaneSnapshot | null = null;
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly deps: ExposurePublisherDeps) {}

  /** A new snapshot from the renderer. Resolves once its effects ran. */
  accept(snapshot: A2aRemotePaneSnapshot): Promise<void> {
    return this.enqueue(async () => {
      const prev = this.last;
      this.last = snapshot;
      if (prev) {
        const client = this.deps.client();
        for (const gone of diffGonePanes(prev, snapshot)) {
          try {
            await client?.a2aRemotePaneGone(gone);
          } catch (err) {
            this.deps.log(`paneGone ${gone.reason} failed: ${errMsg(err)}`);
          }
        }
      }
      await this.publishNow();
    });
  }

  /** Re-publish the last snapshot (exposure settings changed, or the daemon reconnected). */
  republish(): Promise<void> {
    return this.enqueue(() => this.publishNow());
  }

  private enqueue(job: () => Promise<void>): Promise<void> {
    this.chain = this.chain.then(job).catch((err: unknown) => this.deps.log(`publish failed: ${errMsg(err)}`));
    return this.chain;
  }

  private async publishNow(): Promise<void> {
    const client = this.deps.client();
    if (!client || !this.last) return;
    const { exposures } = await client.a2aRemoteExposureList();
    const exposed = new Set((exposures ?? []).flatMap((e) => e.workspaceIds));
    const panes: A2aExposureCandidate[] = [];
    // Moa first, and only while some PC may see it.
    if (this.last.brain && (exposures ?? []).some((e) => e.brain === true)) {
      panes.push({ kind: 'brain', workspaceId: this.last.brain.workspaceId, workspaceName: this.last.brain.name });
    }
    for (const w of this.last.workspaces) {
      if (!exposed.has(w.id)) continue;
      for (const p of w.panes) {
        const gitRemote = p.cwd ? await this.deps.repoKey(p.cwd).catch(() => null) : null;
        panes.push({
          kind: 'pane',
          workspaceId: w.id,
          workspaceName: w.name,
          paneId: p.paneId,
          ...(p.label ? { label: p.label } : {}),
          ...(p.agent ? { agent: p.agent } : {}),
          ...(p.cwd ? { cwd: p.cwd } : {}),
          ...(gitRemote ? { gitRemote } : {}),
          ...(p.gitBranch ? { gitBranch: p.gitBranch } : {}),
        });
      }
    }
    await client.a2aRemoteExposurePublish(panes);
  }
}

/** Shape check of a renderer snapshot (IPC input). */
export function coercePaneSnapshot(raw: unknown): A2aRemotePaneSnapshot | null {
  if (!isRecord(raw) || !Array.isArray(raw['workspaces'])) return null;
  const workspaces: A2aRemotePaneSnapshot['workspaces'] = [];
  for (const w of raw['workspaces']) {
    if (!isRecord(w) || typeof w['id'] !== 'string' || !w['id'] || !Array.isArray(w['panes'])) return null;
    const panes: A2aRemotePaneSnapshot['workspaces'][number]['panes'] = [];
    for (const p of w['panes']) {
      if (!isRecord(p) || typeof p['paneId'] !== 'string' || !p['paneId']) return null;
      const pane: (typeof panes)[number] = { paneId: p['paneId'] };
      for (const key of ['label', 'agent', 'cwd', 'gitBranch'] as const) {
        if (typeof p[key] === 'string' && p[key]) pane[key] = p[key];
      }
      panes.push(pane);
    }
    workspaces.push({ id: w['id'], name: typeof w['name'] === 'string' ? w['name'] : '', panes });
  }
  const b = raw['brain'];
  if (b === undefined || b === null) return { workspaces };
  if (!isRecord(b) || typeof b['workspaceId'] !== 'string' || !b['workspaceId']) return null;
  return { workspaces, brain: { workspaceId: b['workspaceId'], name: typeof b['name'] === 'string' ? b['name'] : '' } };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
