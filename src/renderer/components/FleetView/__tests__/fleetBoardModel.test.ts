import { describe, expect, it } from 'vitest';
import type { FleetPane, FleetRow } from '../../../stores/selectors/fleet';
import type { ReviewQueueEntry } from '../../../stores/selectors/reviewQueue';
import type { FleetTicket } from '../fleetTickets';
import {
  boardColumnOf,
  boardGrid,
  buildBoardColumns,
  moveOnBoard,
  type BoardGrid,
  type BoardItem,
} from '../fleetBoardModel';

function row(id: string, section: FleetRow['section'], over: Partial<FleetPane> = {}): FleetRow {
  const pane = {
    workspaceId: `ws-${id}`, workspaceName: id, paneId: id, surfaceId: `s-${id}`, ptyId: `pty-${id}`,
    agentStatus: 'idle', title: id, surfaceType: 'terminal', isActivePane: true, unverifiable: false,
    ...over,
  } as FleetPane;
  return { pane, section, detailKey: 'fleet.detail.idle' } as FleetRow;
}
const entry = (workspaceId: string): ReviewQueueEntry =>
  ({ workspaceId, taskId: `t-${workspaceId}`, title: workspaceId, ownerWorkspaceId: 'owner' }) as ReviewQueueEntry;
const ticket = (id: string): FleetTicket => ({ id, title: id, workspaceId: 'ws-moa', updatedAt: 0 }) as FleetTicket;
const keys = { review: (ws: string) => `review:${ws}`, ticket: (id: string) => `ticket:${id}` };
const keysOf = (items: BoardItem[]) => items.map((item) => item.key);

describe('Fleet board columns', () => {
  it('puts a row in the column of its section', () => {
    expect(boardColumnOf(row('a', 'needsYou', { agentStatus: 'awaiting_input' }))).toBe('needsYou');
    expect(boardColumnOf(row('b', 'needsYou', { agentStatus: 'error' }))).toBe('needsYou');
    expect(boardColumnOf(row('c', 'finished', { agentStatus: 'complete' }))).toBe('finished');
    expect(boardColumnOf(row('d', 'running', { agentStatus: 'running' }))).toBe('running');
    expect(boardColumnOf(row('e', 'idle'))).toBe('idle');
  });

  it('fills the columns in list order, with decisions in Needs you and reports and review tasks in Finished', () => {
    const cols = buildBoardColumns({
      needsYou: [row('q', 'needsYou', { agentStatus: 'awaiting_input' }), row('err', 'needsYou', { agentStatus: 'error' })],
      finished: [row('solo', 'finished', { agentStatus: 'complete' })],
      running: [row('r1', 'running', { agentStatus: 'running' }), row('r2', 'running', { agentStatus: 'running' })],
      idle: [row('i', 'idle')],
    }, { decisions: [ticket('d1')], reports: [ticket('rep1')], review: [entry('ws-task')] }, keys);
    expect(keysOf(cols.needsYou)).toEqual(['q', 'err', 'ticket:d1']);
    expect(keysOf(cols.running)).toEqual(['r1', 'r2']);
    expect(keysOf(cols.finished)).toEqual(['ticket:rep1', 'review:ws-task', 'solo']);
    expect(keysOf(cols.idle)).toEqual(['i']);
  });

  it('shows a finished task once, as its review entry, not again as its finished pane', () => {
    const cols = buildBoardColumns({
      needsYou: [], running: [], idle: [],
      finished: [row('done', 'finished', { agentStatus: 'complete', workspaceId: 'ws-task' }), row('other', 'finished', { agentStatus: 'complete' })],
    }, { decisions: [], reports: [], review: [entry('ws-task')] }, keys);
    expect(keysOf(cols.finished)).toEqual(['review:ws-task', 'other']);
  });

  it('turns the columns into a key grid', () => {
    const cols = buildBoardColumns({
      needsYou: [row('a', 'needsYou')], finished: [], running: [row('b', 'running')], idle: [],
    }, { decisions: [], reports: [], review: [] }, keys);
    expect(boardGrid(cols)).toEqual({ needsYou: ['a'], running: ['b'], finished: [], idle: [] });
  });
});

describe('Fleet board keys', () => {
  const grid: BoardGrid = { needsYou: ['n1', 'n2', 'n3'], running: ['r1'], finished: [], idle: ['i1', 'i2'] };

  it('moves up and down inside a column, clamped, and Home/End go to its ends', () => {
    expect(moveOnBoard(grid, 'n1', 'down')).toBe('n2');
    expect(moveOnBoard(grid, 'n3', 'down')).toBe('n3');
    expect(moveOnBoard(grid, 'n1', 'up')).toBe('n1');
    expect(moveOnBoard(grid, 'n2', 'end')).toBe('n3');
    expect(moveOnBoard(grid, 'n3', 'home')).toBe('n1');
  });

  it('moves left and right to the nearest non-empty column at the nearest row', () => {
    // Columns run Running, Needs you, Finished, Idle.
    expect(moveOnBoard(grid, 'r1', 'right')).toBe('n1');
    // Finished is empty, so Needs you → Idle, at the nearest row.
    expect(moveOnBoard(grid, 'n3', 'right')).toBe('i2');
    expect(moveOnBoard(grid, 'i2', 'left')).toBe('n2');
    expect(moveOnBoard(grid, 'n2', 'left')).toBe('r1');
    expect(moveOnBoard(grid, 'r1', 'left')).toBe('r1');
    expect(moveOnBoard(grid, 'i2', 'right')).toBe('i2');
  });

  it('lands on the first card when nothing is focused, and on nothing on an empty board', () => {
    expect(moveOnBoard(grid, null, 'down')).toBe('r1');
    expect(moveOnBoard(grid, 'gone', 'right')).toBe('r1');
    expect(moveOnBoard({ needsYou: [], running: [], finished: [], idle: [] }, null, 'down')).toBeNull();
  });
});
