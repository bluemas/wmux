// Settings › Moa's per-goal detail: per-criterion ✓/✗ with evidence, the
// last refusal's other problems, and what Moa delivered. Pure; exported for
// tests.

import type { MoaGoalPanel } from '../../shared/moa';
import { goalTermsOf, type MoaGoalContract } from '../../shared/moaGoal';

export function goalPanelDetail(c: MoaGoalContract): Pick<MoaGoalPanel, 'criteria' | 'problems' | 'delivery'> {
  const { doneCriteria } = goalTermsOf(c);
  const problems = c.status === 'active' ? c.lastCheck?.problems ?? [] : [];
  const criterionProblem = (n: number) => problems.find((p) => p.startsWith(`criterion ${n}`) && /^criterion \d+\b/.test(p));
  const criteria = doneCriteria.map((text, i) => {
    const n = i + 1;
    const proved = c.verification?.criteria.find((x) => x.criterion === n);
    if (proved) return { n, text, state: 'pass' as const, evidence: proved.artifacts.map((a) => a.path) };
    return { n, text, state: criterionProblem(n) ? ('fail' as const) : ('open' as const), evidence: [] };
  });
  const other = problems.filter((p) => !/^criterion \d+\b/.test(p));
  return {
    ...(criteria.length ? { criteria } : {}),
    ...(other.length ? { problems: other } : {}),
    ...(c.delivery
      ? {
          delivery: {
            items: c.delivery.items.map((x) => ({
              branch: x.branch,
              pushed: x.pushed,
              ...(x.prUrl ? { prUrl: x.prUrl } : {}),
              ...(x.prNumber !== undefined ? { prNumber: x.prNumber } : {}),
              ...(x.error ? { error: x.error } : {}),
            })),
            reverted: !!c.delivery.reverted,
            ...(c.delivery.reverted ? { revertNotes: c.delivery.reverted.notes } : {}),
          },
        }
      : {}),
  };
}
