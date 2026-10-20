import type { StoreState } from '../index';
import { agentRow, type AgentSlugWith } from '../../../shared/agentIdentity';
import { selectWorkspaceAgentRoster, type WorkspaceAgentRosterRow } from './workspaceAgentRoster';

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

function needOf(row: WorkspaceAgentRosterRow): OfficeNeed | undefined {
  if (row.usageLimitWaiting) return 'usage_limit';
  if (row.status === 'awaiting_input' || row.status === 'waiting') return 'question';
  if (row.status === 'error') return 'error';
  return undefined;
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
    for (const row of selectWorkspaceAgentRoster(state, workspace.id).rows) {
      if (row.remote || !row.ptyId || !row.agentName) continue;
      if (row.stashed && row.stashedLiveness === 'exited') continue;

      const teammates = state.surfaceTeammates?.[row.ptyId] ?? [];
      const need = needOf(row);
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

      out.push({
        id: row.ptyId,
        kind: agentKind(row),
        name: row.paneName,
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
