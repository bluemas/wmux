import { describe, expect, it } from 'vitest';
import { goalPanelDetail } from '../moaGoalPanel';
import type { MoaGoalContract } from '../../../shared/moaGoal';

const base: MoaGoalContract = {
  id: 'G-abc123', hqWorkspaceId: 'ws-hq', goal: 'g', repoRoot: '/r', workspaceIds: [], level: 2,
  budget: { maxTasks: 4, maxHours: 4, maxTurns: 40 }, humanOnly: [], doneCriteria: ['tests pass', 'docs updated'],
  status: 'active', createdAt: 0, taskWorkspaceIds: [], tasksUsed: 0, turnsUsed: 0,
};

describe('goalPanelDetail — per-criterion ✓/✗ for Settings', () => {
  it('open goal, nothing checked: every criterion is open', () => {
    expect(goalPanelDetail(base).criteria?.map((c) => c.state)).toEqual(['open', 'open']);
  });

  it('a refused completion marks the named criteria ✗ and lists the other problems', () => {
    const d = goalPanelDetail({ ...base, lastCheck: { at: 1, problems: ['task t1: the gate failed (npm test, exit 1)', 'criterion 2 ("docs updated"): no evidence named'] } });
    expect(d.criteria?.map((c) => c.state)).toEqual(['open', 'fail']);
    expect(d.problems).toEqual(['task t1: the gate failed (npm test, exit 1)']);
  });

  it('a completed goal shows ✓ with its evidence and the delivered PR', () => {
    const d = goalPanelDetail({
      ...base,
      status: 'completed',
      lastCheck: { at: 1, problems: ['old'] },
      verification: { at: 2, gates: [], criteria: [{ criterion: 1, text: 'tests pass', artifacts: [{ path: '/w/out.txt', sha256: 'x', bytes: 1 }] }, { criterion: 2, text: 'docs updated', artifacts: [{ path: '/w/README.md', sha256: 'y', bytes: 1 }] }] },
      delivery: { at: 3, items: [{ taskId: 't1', branch: 'wtask/x', headSha: 'h', base: 'main', pushed: true, prUrl: 'https://x/pull/9', prNumber: 9 }], revertRecipe: [] },
    });
    expect(d.criteria).toEqual([
      { n: 1, text: 'tests pass', state: 'pass', evidence: ['/w/out.txt'] },
      { n: 2, text: 'docs updated', state: 'pass', evidence: ['/w/README.md'] },
    ]);
    expect(d.problems).toBeUndefined();
    expect(d.delivery).toEqual({ items: [{ branch: 'wtask/x', pushed: true, prUrl: 'https://x/pull/9', prNumber: 9 }], reverted: false });
  });
});
