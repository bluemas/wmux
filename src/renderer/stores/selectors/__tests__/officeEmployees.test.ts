import { describe, it, expect } from 'vitest';
import { selectOfficeEmployees, createOfficeEmployeesSelector } from '../officeEmployees';
import { selectWorkspaceAgentRoster } from '../workspaceAgentRoster';
import type { StoreState } from '../../index';
import type { Workspace, Pane, PaneLeaf, Surface, AgentStatus, TeammateInfo } from '../../../../shared/types';

function surface(id: string, ptyId: string, extra: Partial<Surface> = {}): Surface {
  return { id, ptyId, title: id, shell: 'pwsh', cwd: `C:\\repo\\${id}`, surfaceType: 'terminal', ...extra };
}
function leaf(id: string, surfaces: Surface[], activeSurfaceId?: string): PaneLeaf {
  return { id, type: 'leaf', surfaces, activeSurfaceId: activeSurfaceId ?? surfaces[0]?.id ?? '' };
}
function workspace(id: string, rootPane: Pane, activePaneId: string, extra: Partial<Workspace> = {}): Workspace {
  return { id, name: id, rootPane, activePaneId, ...extra };
}

const NOW = 1_000_000;

interface StateOverrides {
  workspaces?: Workspace[];
  surfaceAgent?: Record<string, { name?: string; status: AgentStatus }>;
  surfaceAgentStatus?: Record<string, AgentStatus>;
  surfacePendingQuestion?: Record<string, string>;
  surfaceActivity?: Record<string, string>;
  surfaceActivityAt?: Record<string, number>;
  surfaceTurnOpenAt?: Record<string, number>;
  surfaceTeammates?: Record<string, TeammateInfo[]>;
  usageLimits?: Record<string, { provider: string; detectedAt: number; resetsAt?: number }>;
  usageLimitWaiting?: Record<string, true>;
  paneLabel?: Record<string, string>;
  remoteWorkspaces?: StoreState['remoteWorkspaces'];
}

function state(overrides: StateOverrides = {}): StoreState {
  return {
    workspaces: [],
    activeWorkspaceId: '',
    surfaceAgent: {},
    surfaceAgentStatus: {},
    surfacePendingQuestion: {},
    surfaceActivity: {},
    surfaceActivityAt: {},
    surfaceTurnOpenAt: {},
    surfaceTeammates: {},
    usageLimits: {},
    usageLimitWaiting: {},
    paneLabel: {},
    agentClockMs: NOW,
    remoteWorkspaces: [],
    ...overrides,
  } as unknown as StoreState;
}

const claude = (status: AgentStatus = 'idle') => ({ name: 'Claude Code', status });
const mate = (name: string, working: boolean, extra: Partial<TeammateInfo> = {}): TeammateInfo => ({ name, working, at: NOW, ...extra });

describe('selectOfficeEmployees', () => {
  it('one employee per agent surface across all workspaces', () => {
    const s = state({
      workspaces: [
        workspace('ws-1', leaf('p1', [surface('s1', 'pty-1'), surface('s2', 'pty-2')]), 'p1'),
        workspace('ws-2', leaf('p2', [surface('s3', 'pty-3'), surface('s4', 'pty-shell')]), 'p2'),
      ],
      surfaceAgent: {
        'pty-1': claude(),
        'pty-2': { name: 'Codex CLI', status: 'idle' },
        'pty-3': claude(),
      },
    });
    const out = selectOfficeEmployees(s, NOW);
    expect(out.map((e) => e.id)).toEqual(['pty-1', 'pty-2', 'pty-3']);
    expect(out.map((e) => e.workspaceName)).toEqual(['ws-1', 'ws-1', 'ws-2']);
    expect(out[0]).toMatchObject({ kind: 'claude', jumpPtyId: 'pty-1', state: 'resting' });
    expect(out[1].kind).toBe('codex');
    expect(typeof out[0].look).toBe('number');
    expect(out[0].look).toBe(selectOfficeEmployees(s, NOW)[0].look);
  });

  it('remote rows and shell-only stashed rows are not employees', () => {
    const remote: Surface = {
      id: 'rs', ptyId: '', title: 'rs', shell: 'ssh', cwd: '/r', surfaceType: 'remote-terminal',
      remoteHostId: 'host-1', remoteSessionId: 'sess-1',
    };
    const ws = workspace('ws-1', leaf('p1', [remote]), 'p1', {
      stashedPanes: [{ pane: leaf('p-st', [surface('s-st', 'pty-shell')]), stashedAt: NOW - 1000 }],
    });
    const s = state({
      workspaces: [ws],
      remoteWorkspaces: [{
        key: 'host-1:rw-1', hostId: 'host-1', hostLabel: 'mac', workspaceId: 'rw-1', name: 'proj',
        panes: [{ sessionId: 'sess-1', shell: 'zsh', agentName: 'Codex', agentStatus: 'running' }],
      }] as unknown as StoreState['remoteWorkspaces'],
    });
    expect(selectWorkspaceAgentRoster(s, 'ws-1').rows.length).toBeGreaterThan(0);
    expect(selectOfficeEmployees(s, NOW)).toEqual([]);
  });

  it('exited stashed pane is not an employee', () => {
    const ws = workspace('ws-1', leaf('p1', [surface('s1', 'pty-1')]), 'p1', {
      stashedPanes: [{ pane: leaf('p-st', [surface('s-st', '')]), stashedAt: NOW - 1000 }],
    });
    // A stale agent entry under the cleared ptyId must not revive the pane.
    const s = state({ workspaces: [ws], surfaceAgent: { 'pty-1': claude(), '': claude() } });
    // The fixture is real: the roster does report the exited stashed pane
    // (error + needs attention), so the Office is what leaves it out.
    expect(selectWorkspaceAgentRoster(s, 'ws-1').rows.find((r) => r.stashed)).toMatchObject({
      stashedLiveness: 'exited', status: 'error', needsAttention: true,
    });
    expect(selectOfficeEmployees(s, NOW).map((e) => e.id)).toEqual(['pty-1']);
  });

  it('awaiting_input and error rows need you', () => {
    const s = state({
      workspaces: [workspace('ws-1', leaf('p1', [surface('s1', 'pty-q'), surface('s2', 'pty-e')]), 'p1')],
      surfaceAgent: { 'pty-q': claude('complete'), 'pty-e': claude('idle') },
      surfaceAgentStatus: { 'pty-e': 'error' },
      surfacePendingQuestion: { 'pty-q': 'Which branch?' },
    });
    const [q, e] = selectOfficeEmployees(s, NOW);
    expect(q).toMatchObject({ state: 'needs_you', need: 'question' });
    expect(e).toMatchObject({ state: 'needs_you', need: 'error' });
  });

  it('usage-limit pane needs you with reset clock', () => {
    const resetsAt = NOW + 3_600_000;
    const s = state({
      workspaces: [workspace('ws-1', leaf('p1', [surface('s1', 'pty-1')]), 'p1')],
      surfaceAgent: { 'pty-1': claude('idle') },
      usageLimits: { 'pty-1': { provider: 'claude', detectedAt: NOW, resetsAt } },
      usageLimitWaiting: { 'pty-1': true },
    });
    const [e] = selectOfficeEmployees(s, NOW);
    expect(e.state).toBe('needs_you');
    expect(e.need).toBe('usage_limit');
    expect(e.resetsAt).toBe(resetsAt);
  });

  const leadWs = () => [workspace('ws-1', leaf('p1', [surface('s1', 'pty-lead')]), 'p1')];

  it('lead rests while only its teammate works', () => {
    const s = state({
      workspaces: leadWs(),
      surfaceAgent: { 'pty-lead': claude('running') },
      surfaceActivityAt: { 'pty-lead': NOW },
      surfaceTeammates: { 'pty-lead': [mate('reviewer', true, { activity: 'Reading diff', color: 'blue' })] },
    });
    const [lead, tm] = selectOfficeEmployees(s, NOW);
    expect(lead).toMatchObject({ id: 'pty-lead', state: 'resting' });
    expect(tm).toMatchObject({ id: 'pty-lead#reviewer', kind: 'teammate', name: 'reviewer', state: 'working', bubble: 'Reading diff', color: 'blue' });
  });

  it('lead with its own open turn works alongside its teammate', () => {
    const s = state({
      workspaces: leadWs(),
      surfaceAgent: { 'pty-lead': claude('running') },
      surfaceActivityAt: { 'pty-lead': NOW },
      surfaceTurnOpenAt: { 'pty-lead': NOW - 10 },
      surfaceTeammates: { 'pty-lead': [mate('reviewer', true)] },
    });
    const [lead, tm] = selectOfficeEmployees(s, NOW);
    expect(lead.state).toBe('working');
    expect(tm.state).toBe('working');
  });

  it('lead rests once its last teammate stops, even while the roster still reads running', () => {
    const s = state({
      workspaces: leadWs(),
      surfaceAgent: { 'pty-lead': claude('running') },
      surfaceActivityAt: { 'pty-lead': NOW },
      surfaceTeammates: { 'pty-lead': [mate('reviewer', false)] },
    });
    const [lead, tm] = selectOfficeEmployees(s, NOW);
    expect(lead).toMatchObject({ id: 'pty-lead', state: 'resting' });
    expect(tm.state).toBe('resting');
  });

  it('teammate jumps to its lead', () => {
    const s = state({
      workspaces: leadWs(),
      surfaceAgent: { 'pty-lead': claude() },
      surfaceTeammates: { 'pty-lead': [mate('a', false), mate('b', true)] },
    });
    const out = selectOfficeEmployees(s, NOW);
    expect(out.map((e) => e.id)).toEqual(['pty-lead', 'pty-lead#a', 'pty-lead#b']);
    expect(out[1]).toMatchObject({ jumpPtyId: 'pty-lead', leadId: 'pty-lead', state: 'resting' });
    expect(out[2]).toMatchObject({ jumpPtyId: 'pty-lead', leadId: 'pty-lead', state: 'working' });
  });

  const oneWs = () => [workspace('ws-1', leaf('p1', [surface('s1', 'pty-1')]), 'p1')];

  it('finished pane reports at its desk until the owner looks', () => {
    const s = state({
      workspaces: oneWs(),
      surfaceAgent: { 'pty-1': claude('complete') },
      surfaceAgentStatus: { 'pty-1': 'complete' },
    });
    expect(selectOfficeEmployees(s, NOW)[0].state).toBe('finished');
    // Focusing the pane clears the attention status (Pane.tsx).
    const seen = state({ workspaces: oneWs(), surfaceAgent: { 'pty-1': claude('complete') } });
    expect(selectOfficeEmployees(seen, NOW)[0].state).toBe('resting');
  });

  it('a stale lifecycle complete does not count', () => {
    const s = state({ workspaces: oneWs(), surfaceAgent: { 'pty-1': claude('complete') } });
    expect(selectWorkspaceAgentRoster(s, 'ws-1').rows[0].status).toBe('complete');
    expect(selectOfficeEmployees(s, NOW)[0].state).toBe('resting');
  });

  it('needs-you and working outrank finished', () => {
    const q = state({
      workspaces: oneWs(),
      surfaceAgent: { 'pty-1': claude('complete') },
      surfaceAgentStatus: { 'pty-1': 'complete' },
      surfacePendingQuestion: { 'pty-1': 'Merge it?' },
    });
    expect(selectOfficeEmployees(q, NOW)[0].state).toBe('needs_you');
    const limit = state({
      workspaces: oneWs(),
      surfaceAgent: { 'pty-1': claude('complete') },
      surfaceAgentStatus: { 'pty-1': 'complete' },
      usageLimitWaiting: { 'pty-1': true },
    });
    expect(selectOfficeEmployees(limit, NOW)[0].state).toBe('needs_you');
    // A lead with a team works inside its own turn even with a finished row.
    const lead = state({
      workspaces: leadWs(),
      surfaceAgent: { 'pty-lead': claude('complete') },
      surfaceAgentStatus: { 'pty-lead': 'complete' },
      surfaceTurnOpenAt: { 'pty-lead': NOW - 10 },
      surfaceTeammates: { 'pty-lead': [mate('t', false)] },
    });
    const [l, t] = selectOfficeEmployees(lead, NOW);
    expect(l.state).toBe('working');
    expect(t.state).toBe('resting');
    // Without its own turn the lead reports; a teammate never does.
    const idleLead = state({
      workspaces: leadWs(),
      surfaceAgent: { 'pty-lead': claude('complete') },
      surfaceAgentStatus: { 'pty-lead': 'complete' },
      surfaceTeammates: { 'pty-lead': [mate('t', false)] },
    });
    const [l2, t2] = selectOfficeEmployees(idleLead, NOW);
    expect(l2.state).toBe('finished');
    expect(t2.state).toBe('resting');
  });

  it('the memoized selector sees a finished change', () => {
    const sel = createOfficeEmployeesSelector();
    const first = sel(state({ workspaces: oneWs(), surfaceAgent: { 'pty-1': claude('complete') } }));
    const next = sel(state({
      workspaces: oneWs(),
      surfaceAgent: { 'pty-1': claude('complete') },
      surfaceAgentStatus: { 'pty-1': 'complete' },
    }));
    expect(next).not.toBe(first);
    expect(next[0].state).toBe('finished');
  });

  const named = (id: string, wsOrdinal: number, leaves: PaneLeaf[]): Workspace =>
    workspace(id, leaves.length === 1 ? leaves[0] : { id: `${id}-split`, type: 'branch', direction: 'horizontal', children: leaves, sizes: leaves.map(() => 100 / leaves.length) } as unknown as Pane, leaves[0].id, { name: id === 'ws-a' ? 'PowerCraft' : 'Docs', wsOrdinal });
  const ordinal = (l: PaneLeaf, n: number): PaneLeaf => ({ ...l, ordinal: n });

  it('labels use the workspace name', () => {
    const s = state({
      workspaces: [named('ws-a', 30, [ordinal(leaf('p1', [surface('s1', 'pty-1')]), 1)]), named('ws-b', 31, [ordinal(leaf('p2', [surface('s2', 'pty-2')]), 1)])],
      surfaceAgent: { 'pty-1': claude(), 'pty-2': { name: 'Codex CLI', status: 'idle' } },
    });
    const [a, b] = selectOfficeEmployees(s, NOW);
    expect(a).toMatchObject({ label: 'PowerCraft', workspaceName: 'PowerCraft', agent: 'Claude', paneTag: 'w30-1' });
    expect(b).toMatchObject({ label: 'Docs', agent: 'Codex', paneTag: 'w31-1' });
    // The pane name stays for compatibility.
    expect(a.name).toBe('w30-1');
  });

  it('explicit pane label wins', () => {
    const p1 = { ...ordinal(leaf('p1', [surface('s1', 'pty-1')]), 1), metadata: { label: 'backend' } } as PaneLeaf;
    const p2 = ordinal(leaf('p2', [surface('s2', 'pty-2')]), 2);
    const s = state({
      workspaces: [named('ws-a', 30, [p1, p2])],
      surfaceAgent: { 'pty-1': claude(), 'pty-2': claude() },
      paneLabel: { p2: ' frontend ' },
    });
    expect(selectOfficeEmployees(s, NOW).map((e) => e.label)).toEqual(['backend', 'frontend']);
  });

  it('duplicate labels add the agent, then the pane tag', () => {
    const leaves = [1, 2, 3].map((n) => ordinal(leaf(`p${n}`, [surface(`s${n}`, `pty-${n}`)]), n));
    const s = state({
      workspaces: [named('ws-a', 30, leaves), named('ws-b', 31, [ordinal(leaf('p9', [surface('s9', 'pty-9')]), 1)])],
      surfaceAgent: {
        'pty-1': { name: 'Codex CLI', status: 'idle' },
        'pty-2': claude(),
        'pty-3': claude(),
        'pty-9': claude(),
      },
    });
    expect(selectOfficeEmployees(s, NOW).map((e) => e.label)).toEqual([
      'PowerCraft · Codex',
      'PowerCraft · w30-2',
      'PowerCraft · w30-3',
      'Docs',
    ]);
  });

  it('teammates keep their own name', () => {
    const s = state({
      workspaces: [named('ws-a', 30, [ordinal(leaf('p1', [surface('s1', 'pty-lead')]), 1)])],
      surfaceAgent: { 'pty-lead': claude() },
      surfaceTeammates: { 'pty-lead': [mate('reviewer', true)] },
    });
    const [lead, tm] = selectOfficeEmployees(s, NOW);
    expect(lead.label).toBe('PowerCraft');
    expect(tm).toMatchObject({ label: 'reviewer', name: 'reviewer', agent: 'Claude', paneTag: 'w30-1' });
  });

  it('returns a stable array from the memoized selector when inputs are unchanged', () => {
    const s = state({ workspaces: leadWs(), surfaceAgent: { 'pty-lead': claude() } });
    const sel = createOfficeEmployeesSelector();
    const first = sel(s);
    expect(sel({ ...s })).toBe(first);
  });

  it('working state matches the sidebar roster for every non-lead row', () => {
    const s = state({
      workspaces: [workspace('ws-1', leaf('p1', [
        surface('s1', 'pty-run'), surface('s2', 'pty-idle'), surface('s3', 'pty-q'), surface('s4', 'pty-lead'),
      ]), 'p1')],
      surfaceAgent: {
        'pty-run': claude('running'), 'pty-idle': claude('idle'), 'pty-q': claude('complete'), 'pty-lead': claude('running'),
      },
      surfaceActivityAt: { 'pty-run': NOW, 'pty-lead': NOW },
      surfacePendingQuestion: { 'pty-q': 'Proceed?' },
      surfaceTeammates: { 'pty-lead': [mate('t', true)] },
    });
    const rows = selectWorkspaceAgentRoster(s, 'ws-1').rows.filter((r) => r.ptyId !== 'pty-lead');
    const byId = new Map(selectOfficeEmployees(s, NOW).map((e) => [e.id, e]));
    expect(rows.length).toBe(3);
    for (const row of rows) {
      const emp = byId.get(row.ptyId)!;
      expect(emp.state === 'working').toBe(row.status === 'running');
      expect(emp.state === 'needs_you').toBe(row.needsAttention);
    }
  });
});
