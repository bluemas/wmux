// Moa goal evidence gate, end to end in the real Electron app.
//
// The app is the built .vite output on the plain electron binary, with an
// isolated HOME. No model runs: this file plays Moa's brain over the pipe RPC
// (the same calls its MCP tools make, under a real commander token from the
// dev-only e2e hook), and fan-out workers are a fake `claude` that runs a
// scripted shell job in its worktree. The project is cloned from a local bare
// remote. The operator's part — choosing level 2, approving the goal card —
// is done in the UI.
//
// Scenarios (one app session, in order):
//   1. a goal with 2 done criteria: approve, worker commits, evidence gate
//      passes, the goal completes and records gates pinned to the commit;
//   2. the worker's change fails the project's test: completion is refused
//      as `unverified` and the goal stays open;
//   3. a memo-only completion is refused.
// Delivery (fake gh shim, bare remote): scenario 1 checks the push and the PR
// Moa opens itself, and 1b reverts it from Settings.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fakePrs, git, killRun, launchApp, makeSandbox, rpc, setWorkerScript, shot, sleep, waitFor } from './lib.mjs';

const sb = makeSandbox('goal');
let app;
let win;
let logs;
let token;
let fanouts = 0;

const goals = () => JSON.parse(fs.readFileSync(path.join(sb.home, '.wmux-e2e', 'moa-goals.json'), 'utf8')).items;
const brain = (method, params, timeout) => rpc(sb, method, params, { commanderToken: token, ...(timeout ? { timeout } : {}) });

async function dismissOnboarding() {
  for (const label of ['Skip for now', "Don't ask again"]) {
    const l = win.getByText(label, { exact: true });
    if (await l.count()) {
      await l.first().click();
      await sleep(500);
    }
  }
}

async function openMoaSettings() {
  await win.keyboard.press('Control+Comma');
  const nav = win.locator('.settings-nav-row', { hasText: /^Moa$/ }).first();
  await nav.waitFor({ timeout: 15_000 });
  await nav.click();
  await win.getByTestId('moa-tab').waitFor();
}

/** Settings › Moa, scrolled to the "Moa's goal" row (its status line). */
async function showGoalRow() {
  await openMoaSettings();
  const row = win.getByText("Moa's goal", { exact: true }).first();
  await row.scrollIntoViewIfNeeded();
  await sleep(300);
}

async function proposeAndApprove(goal, doneCriteria, shotName) {
  const p = await brain('deck.proposeGoal', { goal, repo: sb.project, doneCriteria, evidence: ['npm test output'], constraints: ['no new dependencies'] });
  assert.equal(p.ok, true, JSON.stringify(p));
  const approve = win.getByRole('button', { name: 'Approve goal', exact: true });
  await approve.waitFor({ timeout: 15_000 });
  for (const c of doneCriteria) await win.getByText(c, { exact: false }).first().waitFor();
  // The card is a structured list: one line per done criterion.
  const ctx = await win.locator('[data-moa-decision-context]').first().innerText();
  doneCriteria.forEach((c, i) => assert.match(ctx, new RegExp(`\\n\\s*\\(${i + 1}\\) ${c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`)));
  if (shotName) await shot(win, shotName);
  await approve.click();
  await waitFor(async () => (await brain('deck.goal', { action: 'status' })).goal?.status === 'active', { what: `goal ${p.id} active` });
  return p.id;
}

/** Fan out one task as the brain and wait for the fake worker's commit. */
async function fanOutOne(title) {
  const key = `e2e-${sb.runId}-${++fanouts}`;
  const params = { idempotencyKey: key, titles: [title], prompt: `${title}.` };
  let r = await brain('task.fanout.start', params);
  r = await waitFor(async () => {
    const x = await brain('task.fanout.start', params);
    return x.status === 'completed' ? x : null;
  }, { timeout: 60_000, what: 'fan-out' });
  const task = r.result.tasks[0];
  assert.equal(task.ok, true, JSON.stringify(task));
  // Progress is on the main screen, not only in Settings.
  const strip = win.getByTestId('moa-goal-strip');
  await strip.waitFor({ timeout: 15_000 });
  assert.equal(await strip.getAttribute('data-status'), 'active');
  await shot(win, `progress-${fanouts}-after-fanout`);
  await waitFor(() => git(['log', '-1', '--format=%s'], task.worktreePath).startsWith('e2e worker:'), { timeout: 60_000, what: 'worker commit' });
  return task;
}

before(async () => {
  ({ app, win, logs } = await launchApp(sb));
  await win.locator('text=Workspaces').first().waitFor({ timeout: 60_000 });
  await sleep(2000);
  await dismissOnboarding();
  await openMoaSettings();
  const master = win.locator('[role=switch][aria-label="Moa"]').first();
  if ((await master.getAttribute('aria-checked')) !== 'true') {
    await master.click();
    await win.getByRole('button', { name: 'Turn on Moa', exact: true }).click();
  }
  await waitFor(async () => (await app.evaluate(() => globalThis.__wmuxE2E?.hqWorkspaceId() ?? null)) !== null, { what: 'Moa HQ' });
  await win.getByRole('combobox', { name: 'What Moa may do on its own' }).selectOption('2');
  await shot(win, '01-settings-level-2');
  await win.keyboard.press('Escape');
  token = await app.evaluate(() => globalThis.__wmuxE2E.mintHqCommanderToken());
  assert.ok(token, 'commander token');
  await waitFor(() => fs.existsSync(path.join(sb.home, '.wmux-e2e-auth-token')), { what: 'pipe auth token' });
});

after(async () => {
  try {
    if (win) await shot(win, '99-final');
  } catch {
    /* the window may be gone */
  }
  killRun(sb);
  if (process.env.WMUX_E2E_KEEP !== '1') fs.rmSync(sb.home, { recursive: true, force: true });
});

describe('Moa goal evidence gate (Electron e2e)', () => {
  it('1: approved goal with 2 criteria — worker commits, gate passes, goal completes', async () => {
    setWorkerScript(sb, [
      'mkdir -p node_modules e2e-evidence',
      'echo done > feature.txt',
      'npm test > e2e-evidence/test-output.txt 2>&1',
      'git add feature.txt e2e-evidence',
      'git -c user.name=fake-worker -c user.email=w@wmux.invalid commit -q -m "e2e worker: feature done"',
    ].join('\n'));
    const id = await proposeAndApprove('Make feature.txt say done', ['npm test passes', 'feature.txt says done'], '02-goal-card-two-criteria');
    const task = await fanOutOne('make feature done');
    const head = git(['rev-parse', 'HEAD'], task.worktreePath);
    const r = await brain('deck.goal', {
      action: 'complete',
      summary: 'feature.txt says done; npm test passes in the task worktree',
      criteria: [
        { criterion: 1, artifacts: [path.join(task.worktreePath, 'e2e-evidence', 'test-output.txt')] },
        { criterion: 2, artifacts: [path.join(task.worktreePath, 'feature.txt')] },
      ],
    }, 300_000);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.id, id);
    // Delivered by Moa: the verified commit is on the bare remote under the
    // task branch, and a PR (fake gh) was opened against main with the proof.
    assert.equal(r.delivered.length, 1);
    assert.equal(r.delivered[0].pushed, true, JSON.stringify(r.delivered));
    assert.equal(r.delivered[0].branch, task.branch);
    assert.match(r.delivered[0].prUrl, /\/pull\/1$/);
    assert.equal(git(['rev-parse', `refs/heads/${task.branch}`], sb.remote), head);
    const pr = fakePrs(sb)[1];
    assert.equal(pr.head, task.branch);
    assert.equal(pr.base, 'main');
    assert.equal(pr.state, 'open');
    assert.match(pr.body, /✅ \(1\) npm test passes/);
    assert.match(pr.body, new RegExp(head));
    // main itself is untouched: merging stays the operator's.
    assert.equal(git(['rev-parse', 'refs/heads/main'], sb.remote), git(['rev-parse', 'origin/main'], sb.project));
    const g = goals()[id];
    assert.equal(g.status, 'completed');
    assert.equal(g.verification.gates.length, 1);
    assert.equal(g.verification.gates[0].headSha, head);
    assert.equal(g.verification.gates[0].exitCode, 0);
    assert.match(fs.readFileSync(g.verification.gates[0].logPath, 'utf8'), /PASS 1 test/);
    assert.deepEqual(g.verification.criteria.map((c) => c.criterion), [1, 2]);
    // Main screen strip: both criteria ✓ and the PR link.
    await win.keyboard.press('Escape');
    await win.getByTestId('moa-goal-strip-criterion-2').waitFor({ timeout: 15_000 });
    assert.equal(await win.getByTestId('moa-goal-strip-criterion-1').getAttribute('data-state'), 'pass');
    assert.equal(await win.getByTestId('moa-goal-strip-criterion-2').getAttribute('data-state'), 'pass');
    await shot(win, '03a-main-screen-goal-strip-done');
    await showGoalRow();
    // Settings shows each criterion ✓ with its evidence, and the PR.
    await win.getByTestId('moa-goal-criterion-1').waitFor();
    assert.equal(await win.getByTestId('moa-goal-criterion-1').getAttribute('data-state'), 'pass');
    assert.equal(await win.getByTestId('moa-goal-criterion-2').getAttribute('data-state'), 'pass');
    assert.match(await win.getByTestId('moa-goal-delivery').innerText(), /PR #1/);
    await win.getByTestId('moa-goal-detail').scrollIntoViewIfNeeded();
    await shot(win, '03-goal-completed-criteria-and-pr');
    await win.keyboard.press('Escape');
  });

  it('1b: "Revert this goal" closes the PR Moa opened and keeps the branch', async () => {
    await showGoalRow();
    const revert = win.getByTestId('moa-goal-revert');
    await revert.scrollIntoViewIfNeeded();
    await revert.click();
    await win.getByTestId('moa-goal-reverted').waitFor({ timeout: 15_000 });
    assert.equal(fakePrs(sb)[1].state, 'closed');
    assert.equal(await win.getByTestId('moa-goal-revert').count(), 0);
    const branch = fakePrs(sb)[1].head;
    assert.ok(git(['rev-parse', `refs/heads/${branch}`], sb.remote), 'branch kept on the remote');
    await win.getByTestId('moa-goal-detail').scrollIntoViewIfNeeded();
    await shot(win, '03b-goal-reverted');
    await win.keyboard.press('Escape');
  });

  it('2: a failing project test keeps the goal open as unverified', async () => {
    setWorkerScript(sb, [
      'mkdir -p node_modules',
      'echo broken > feature.txt',
      'git add feature.txt',
      'git -c user.name=fake-worker -c user.email=w@wmux.invalid commit -q -m "e2e worker: broken change"',
    ].join('\n'));
    const id = await proposeAndApprove('Break-check: feature.txt must say done', ['npm test passes'], null);
    const task = await fanOutOne('try the feature');
    const r = await brain('deck.goal', {
      action: 'complete',
      summary: 'claims done, but the test fails',
      criteria: [{ criterion: 1, artifacts: [path.join(task.worktreePath, 'feature.txt')] }],
    }, 300_000);
    assert.equal(r.ok, false);
    assert.equal(r.code, 'unverified');
    assert.match(r.problems.join('\n'), /the gate failed \(npm test, exit 1\)/);
    assert.equal(goals()[id].status, 'active');
    assert.equal(goals()[id].verification, undefined);
    // Main screen: the strip shows the failure as a summary with an openable
    // log, not a raw temp path.
    await win.getByTestId('moa-goal-strip-problem').waitFor({ timeout: 15_000 });
    const stripProblem = await win.getByTestId('moa-goal-strip-problem').innerText();
    assert.match(stripProblem, /gate failed \(npm test, exit 1\)/);
    assert.doesNotMatch(stripProblem, /\.log\b/);
    await win.getByTestId('moa-goal-strip-log').waitFor();
    await shot(win, '04a-main-screen-goal-strip-failure');
    await showGoalRow();
    await win.getByTestId('moa-goal-end').waitFor(); // the goal is still open: "End goal" is offered
    // The refusal is visible: the gate failure is listed with ✗.
    assert.match(await win.getByTestId('moa-goal-problem').first().innerText(), /gate failed/);
    await win.getByTestId('moa-goal-log').first().waitFor();
    assert.match(await win.getByTestId('moa-goal-log-excerpt').first().innerText(), /not ok|fail|Error|expected/i);
    // Task worktrees are grouped behind one toggle in Workspace modes.
    const toggle = win.getByTestId('moa-modes-tasks-toggle');
    await toggle.waitFor();
    assert.equal(await win.locator('[data-testid="moa-modes"]').getByText('wtask:', { exact: false }).count(), 0);
    await toggle.scrollIntoViewIfNeeded();
    await shot(win, '04b-workspace-modes-tasks-collapsed');
    assert.equal(Object.keys(fakePrs(sb)).length, 1, 'nothing delivered for a refused goal');
    await win.getByTestId('moa-goal-detail').scrollIntoViewIfNeeded();
    await shot(win, '04-failing-test-goal-still-open');
    await win.keyboard.press('Escape');
    assert.equal((await brain('deck.goal', { action: 'cancel', summary: 'e2e cleanup' })).ok, true);
  });

  it('3: a memo-only completion is refused', async () => {
    const id = await proposeAndApprove('Memo-only check', ['npm test passes'], null);
    const r = await brain('deck.goal', { action: 'complete', summary: 'all done and verified, trust me' }, 300_000);
    assert.equal(r.ok, false);
    assert.equal(r.code, 'unverified');
    assert.match(r.problems.join('\n'), /no fan-out task/);
    assert.match(r.problems.join('\n'), /criterion 1 .*no evidence named/);
    assert.equal(goals()[id].status, 'active');
    await shot(win, '05-memo-only-refused');
    assert.equal((await brain('deck.goal', { action: 'cancel', summary: 'e2e cleanup' })).ok, true);
  });
});

process.on('exit', () => {
  if (process.exitCode && logs) fs.writeFileSync(path.join(process.env.WMUX_E2E_ARTIFACTS || path.join(path.dirname(new URL(import.meta.url).pathname), 'artifacts'), 'app.log'), logs.join(''));
});
