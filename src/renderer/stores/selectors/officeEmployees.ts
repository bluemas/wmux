import type { StoreState } from '../index';
import { agentRow, type AgentSlugWith } from '../../../shared/agentIdentity';
import { getLeafPanes } from '../../../shared/paneUtils';
import type { PaneLeaf, Workspace } from '../../../shared/types';
import { paneTag as paneTagOf } from '../../utils/paneNaming';
import { selectWorkspaceAgentRoster, type WorkspaceAgentRosterRow } from './workspaceAgentRoster';
import { surfaceAttentionStatus } from './fleet';

export type OfficeState = 'working' | 'needs_you' | 'finished' | 'resting';
export type OfficeNeed = 'question' | 'error' | 'usage_limit';

/** One agent session (or Agent Teams teammate) drawn as an employee in the Office view. */
export interface OfficeEmployee {
  /** ptyId, or `${leadPtyId}#${teammateName}` for a teammate. */
  id: string;
  /** The agent's slug when it has its own Office looks (`officeLook`), else 'other'. */
  kind: AgentSlugWith<'officeLook'> | 'other' | 'teammate';
  /** Pane name / teammate name. */
  name: string;
  /**
   * The name the Office shows: the pane's explicit label, else the workspace
   * name, with the agent and then the pane tag added while two employees
   * would read the same. A teammate's is its own name.
   */
  label: string;
  /** The agent's short name (`Claude`, `Codex`); a teammate's is its lead's. */
  agent: string;
  /**
   * The pane's unique coordinate, e.g. `w30-2`; a teammate's is its lead's.
   * Undefined while the pane has no coordinate yet.
   */
  paneTag?: string;
  /** 1-based tab position, set when the pane holds more than one tab. */
  tab?: number;
  workspaceName: string;
  state: OfficeState;
  need?: OfficeNeed;
  /**
   * Activity text only. The scene builds the localized need text itself from
   * `need` + `resetsAt`, so this selector carries no UI copy.
   */
  bubble?: string;
  /** Reset time of the provider usage limit; set for `need === 'usage_limit'`. */
  resetsAt?: number;
  /** The lead's ptyId for a teammate. */
  jumpPtyId: string;
  /** Set on teammates. */
  leadId?: string;
  /** Stable appearance seed (hash of id). */
  look: number;
  /** Teammate meta color. */
  color?: string;
}

/** FNV-1a: a small, stable, well-spread string hash. */
function hashLook(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i += 1) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function agentKind(row: WorkspaceAgentRosterRow): OfficeEmployee['kind'] {
  return agentRow(row.slug)?.officeLook ? (row.slug as AgentSlugWith<'officeLook'>) : 'other';
}

/**
 * Read from the Fleet board's attention status, not the roster's `status`:
 * that one falls back to the lifecycle status once the owner looks at the
 * pane, and a seen `waiting` or `error` would keep its bubble forever.
 */
function needOf(state: StoreState, row: WorkspaceAgentRosterRow): OfficeNeed | undefined {
  if (row.usageLimitWaiting) return 'usage_limit';
  const attention = surfaceAttentionStatus(state, row.ptyId);
  if (attention === 'awaiting_input' || attention === 'waiting') return 'question';
  if (attention === 'error') return 'error';
  return undefined;
}

/** The agent's short name from its registry row, else the name the row carries. */
function shortAgentName(row: WorkspaceAgentRosterRow): string {
  return agentRow(row.slug)?.short ?? row.agentName;
}

/** The pane's `w<ws>-<pane>` tag, or undefined before it has a coordinate. */
function paneTagFor(workspace: Workspace, leaf: PaneLeaf | undefined): string | undefined {
  if (!leaf || workspace.wsOrdinal === undefined || leaf.ordinal === undefined) return undefined;
  return paneTagOf(workspace, leaf).replace(/^#/, '');
}

/** Every leaf of a workspace, laid out or stashed, by id. */
function leavesById(workspace: Workspace): Map<string, PaneLeaf> {
  const leaves = [
    ...getLeafPanes(workspace.rootPane),
    ...(workspace.stashedPanes ?? []).flatMap((s) => getLeafPanes(s.pane)),
  ];
  return new Map(leaves.map((l) => [l.id, l]));
}

/**
 * Where two pane employees would read the same, add the agent; where that
 * still collides, the pane tag instead, and then the tab position (two agent
 * tabs in one pane). Teammates keep their own names.
 */
function disambiguateLabels(employees: OfficeEmployee[]): void {
  const panes = employees.filter((e) => e.kind !== 'teammate');
  const step = (make: (e: OfficeEmployee) => string): void => {
    const counts = new Map<string, number>();
    for (const e of panes) counts.set(e.label, (counts.get(e.label) ?? 0) + 1);
    for (const e of panes) if ((counts.get(e.label) ?? 0) > 1) e.label = make(e);
  };
  const base = new Map(panes.map((e) => [e, e.label]));
  step((e) => `${base.get(e)} · ${e.agent}`);
  const join = (...parts: Array<string | number | undefined>): string =>
    parts.filter((p) => p !== undefined && p !== '').join(' · ');
  step((e) => join(base.get(e), e.paneTag ?? e.agent));
  step((e) => join(base.get(e), e.paneTag ?? e.agent, e.tab));
}

/**
 * Fleet's "Finished": an unseen `complete` attention status. Not the lifecycle
 * status, which can stay 'complete' after the owner looked at the pane; the
 * attention status clears when the pane is focused, a turn starts or it closes.
 */
function isFinished(row: WorkspaceAgentRosterRow): boolean {
  return row.attentionStatus === 'complete' && !row.pendingQuestion && !row.remote && !row.stashed && !row.usageLimitWaiting;
}

/**
 * Every agent session in every workspace as an employee, in workspace order
 * then pane order, each lead followed by its Agent Teams teammates. Derived
 * from the same roster rows the sidebar draws, so the two cannot disagree.
 */
export function selectOfficeEmployees(state: StoreState, _now: number): OfficeEmployee[] {
  const out: OfficeEmployee[] = [];
  for (const workspace of state.workspaces) {
    const leaves = leavesById(workspace);
    for (const row of selectWorkspaceAgentRoster(state, workspace.id).rows) {
      if (row.remote || !row.ptyId || !row.agentName) continue;
      if (row.stashed && row.stashedLiveness === 'exited') continue;

      const teammates = state.surfaceTeammates?.[row.ptyId] ?? [];
      const need = needOf(state, row);
      let officeState: OfficeState;
      if (need) {
        officeState = 'needs_you';
      } else if (teammates.length > 0) {
        // The roster reads a pane as running while a teammate works, and keeps
        // doing so for up to the hook TTL after the last one stops; a lead with
        // a team works only inside its own hook turn.
        officeState = (state.surfaceTurnOpenAt?.[row.ptyId] ?? 0) > 0 ? 'working' : 'resting';
      } else {
        officeState = row.status === 'running' ? 'working' : 'resting';
      }
      // A finished turn the owner has not looked at yet: reporting at the desk.
      if (officeState === 'resting' && isFinished(row)) officeState = 'finished';

      const leaf = leaves.get(row.paneId);
      // Each label trimmed on its own, so a blank pane label falls through.
      const explicitLabel = state.paneLabel?.[row.paneId]?.trim() || leaf?.metadata?.label?.trim();
      const agent = shortAgentName(row);
      const paneTag = paneTagFor(workspace, leaf);
      const tab = row.surfaceCount > 1 ? row.surfaceIndex + 1 : undefined;

      out.push({
        id: row.ptyId,
        kind: agentKind(row),
        name: row.paneName,
        label: explicitLabel || workspace.name,
        agent,
        ...(paneTag ? { paneTag } : {}),
        ...(tab !== undefined ? { tab } : {}),
        workspaceName: workspace.name,
        state: officeState,
        ...(need ? { need } : {}),
        ...(row.activity ? { bubble: row.activity } : {}),
        ...(need === 'usage_limit' && state.usageLimits?.[row.ptyId]?.resetsAt != null
          ? { resetsAt: state.usageLimits[row.ptyId].resetsAt }
          : {}),
        jumpPtyId: row.ptyId,
        look: hashLook(row.ptyId),
      });

      for (const mate of teammates) {
        const id = `${row.ptyId}#${mate.name}`;
        out.push({
          id,
          kind: 'teammate',
          name: mate.name,
          label: mate.name,
          agent,
          ...(paneTag ? { paneTag } : {}),
          workspaceName: workspace.name,
          state: mate.working ? 'working' : 'resting',
          ...(mate.activity ? { bubble: mate.activity } : {}),
          jumpPtyId: row.ptyId,
          leadId: row.ptyId,
          look: hashLook(id),
          ...(mate.color ? { color: mate.color } : {}),
        });
      }
    }
  }
  disambiguateLabels(out);
  return out;
}

function employeesEqual(previous: OfficeEmployee[], next: OfficeEmployee[]): boolean {
  if (previous.length !== next.length) return false;
  for (let i = 0; i < previous.length; i += 1) {
    const a = previous[i];
    const b = next[i];
    if (
      a.id !== b.id ||
      a.kind !== b.kind ||
      a.name !== b.name ||
      a.label !== b.label ||
      a.agent !== b.agent ||
      a.paneTag !== b.paneTag ||
      a.tab !== b.tab ||
      a.workspaceName !== b.workspaceName ||
      a.state !== b.state ||
      a.need !== b.need ||
      a.bubble !== b.bubble ||
      a.resetsAt !== b.resetsAt ||
      a.jumpPtyId !== b.jumpPtyId ||
      a.leadId !== b.leadId ||
      a.look !== b.look ||
      a.color !== b.color
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Reference-stable wrapper for a React subscription: unrelated store writes
 * return the previous array, so the Office scene only rerenders when an
 * employee actually changes.
 */
export function createOfficeEmployeesSelector(
  now: () => number = Date.now,
): (state: StoreState) => OfficeEmployee[] {
  let previous: OfficeEmployee[] | undefined;
  return (state) => {
    const next = selectOfficeEmployees(state, now());
    if (previous && employeesEqual(previous, next)) return previous;
    previous = next;
    return next;
  };
}
