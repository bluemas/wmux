// @vitest-environment jsdom
//
// The Office page drawn from a fixed employee list: one employee element per
// OfficeEmployee, bubbles, the needs-you pose, click to jump, the empty state.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as React from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRoot, type Root } from 'react-dom/client';
import type { OfficeEmployee } from '../../../stores/selectors/officeEmployees';

const fixture = vi.hoisted(() => ({ employees: [] as unknown[] }));

vi.mock('../../../stores/selectors/officeEmployees', () => ({
  createOfficeEmployeesSelector: () => () => fixture.employees,
}));

vi.mock('../../../hooks/useNotificationListener', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../hooks/useNotificationListener')>();
  return { ...actual, focusPaneByPtyId: vi.fn(() => true) };
});

import OfficePage from '../OfficePage';
import { forgetOfficeLayout } from '../officeMemory';
import { useStore } from '../../../stores';
import { focusPaneByPtyId } from '../../../hooks/useNotificationListener';

const act = React.act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function emp(id: string, extra: Partial<OfficeEmployee> = {}): OfficeEmployee {
  return {
    id,
    kind: 'claude',
    name: `pane-${id}`,
    label: `name-${id}`,
    agent: 'Claude',
    paneTag: `w1-${id}`,
    workspaceName: 'alpha',
    state: 'working',
    jumpPtyId: id,
    look: 3,
    ...extra,
  };
}

let container: HTMLDivElement;
let root: Root;

function mount(employees: OfficeEmployee[]): void {
  fixture.employees = employees;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(React.createElement(OfficePage));
  });
}

/** Swap the employee list and let the page re-render, as a store update would. */
function update(employees: OfficeEmployee[]): void {
  fixture.employees = employees;
  act(() => {
    useStore.setState({});
  });
}

function deskOf(id: string): HTMLElement {
  const desk = container.querySelector<HTMLElement>(`[data-office-desk-of="${id}"]`);
  if (!desk) throw new Error(`no desk for ${id}`);
  return desk;
}

function employeeEl(id: string): HTMLElement {
  const el = Array.from(container.querySelectorAll<HTMLElement>('[data-office-employee]')).find(
    (node) => node.getAttribute('data-office-employee') === id,
  );
  if (!el) throw new Error(`no employee ${id}`);
  return el;
}

beforeEach(() => {
  act(() => {
    useStore.setState({ ...useStore.getInitialState(), locale: 'en' });
  });
  vi.mocked(focusPaneByPtyId).mockClear();
  forgetOfficeLayout();
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  document.documentElement.removeAttribute('data-reduced-motion');
  vi.useRealTimers();
});

describe('OfficePage', () => {
  it('renders one employee per OfficeEmployee with its name', () => {
    mount([
      emp('pty-1'),
      emp('pty-2', { kind: 'codex', state: 'resting' }),
      emp('pty-3', { kind: 'other', workspaceName: 'beta' }),
      emp('pty-1#mate', { kind: 'teammate', leadId: 'pty-1', jumpPtyId: 'pty-1', color: 'blue' }),
    ]);
    const all = container.querySelectorAll('[data-office-employee]');
    expect(all.length).toBe(4);
    for (const id of ['pty-1', 'pty-2', 'pty-3', 'pty-1#mate']) {
      const el = employeeEl(id);
      expect(el.tagName).toBe('BUTTON');
      expect(el.textContent).toContain(`name-${id}`);
      // Accessible name: name, workspace and state.
      const label = el.getAttribute('aria-label') ?? '';
      expect(label).toContain(`name-${id}`);
    }
    expect(employeeEl('pty-3').getAttribute('aria-label')).toContain('beta');
    expect(employeeEl('pty-1').getAttribute('aria-label')).toContain('Working');
    expect(employeeEl('pty-2').getAttribute('aria-label')).toContain('Resting');
    // Hover text carries the workspace.
    expect(employeeEl('pty-3').textContent).toContain('beta');
    // Working sits typing at a desk; resting sits in the lounge.
    expect(employeeEl('pty-1').getAttribute('data-pose')).toBe('type');
    expect(employeeEl('pty-2').getAttribute('data-pose')).toBe('rest');
    expect(container.querySelector('[data-office-empty]')).toBeNull();
  });

  it('shows the label, and the workspace, agent and pane tag on hover and to screen readers', () => {
    mount([emp('pty-1', { label: 'PowerCraft · Codex', agent: 'Codex', paneTag: 'w30-2', workspaceName: 'PowerCraft' })]);
    const el = employeeEl('pty-1');
    expect(el.querySelector('.wmux-office-employee__name')!.textContent).toBe('PowerCraft · Codex');
    expect(el.textContent).not.toContain('pane-pty-1');
    const details = el.querySelector('.wmux-office-employee__workspace')!.textContent ?? '';
    for (const part of ['PowerCraft', 'Codex', 'w30-2']) expect(details).toContain(part);
    const aria = el.getAttribute('aria-label') ?? '';
    for (const part of ['PowerCraft · Codex', 'PowerCraft', 'Codex', 'w30-2', 'Working']) expect(aria).toContain(part);
  });

  it('leaves a missing pane tag out of the accessible name', () => {
    mount([emp('pty-1', { label: 'PowerCraft', agent: 'Codex', paneTag: undefined, workspaceName: 'PowerCraft' })]);
    expect(employeeEl('pty-1').getAttribute('aria-label')).toBe('PowerCraft, PowerCraft, Codex: Working');
  });

  it('bubble truncates long activity and hides empty', () => {
    const long = 'Running the whole integration suite\nagainst every fixture in the repo';
    mount([
      emp('long', { bubble: long }),
      emp('blank', { bubble: '   ' }),
      emp('none'),
      emp('rest', { state: 'resting', bubble: 'Read file.ts' }),
    ]);
    const bubble = employeeEl('long').querySelector('[data-office-bubble]');
    expect(bubble).not.toBeNull();
    const text = bubble!.textContent ?? '';
    expect(text.length).toBeLessThanOrEqual(40);
    expect(text.endsWith('…')).toBe(true);
    expect(text.startsWith('Running the whole integration suite aga')).toBe(true);
    expect(text).not.toContain('\n');
    expect(employeeEl('blank').querySelector('[data-office-bubble]')).toBeNull();
    expect(employeeEl('none').querySelector('[data-office-bubble]')).toBeNull();
    // Resting employees show no bubble.
    expect(employeeEl('rest').querySelector('[data-office-bubble]')).toBeNull();
  });

  it('names stay above every bubble and activity bubbles are one line stacked by depth', () => {
    // Desk 0 is in the back row; desk 5 is the desk in front of it in the next row.
    mount(Array.from({ length: 6 }, (_, i) => emp(`e${i}`, { bubble: `Running step ${i}` })));
    const zOf = (el: Element | null): number => Number((el as HTMLElement).style.zIndex);
    const bubbles = ['e0', 'e5'].map((id) => employeeEl(id).querySelector('[data-office-bubble]'));
    const labels = ['e0', 'e5'].map((id) => employeeEl(id).querySelector('.wmux-office-employee__label'));
    // (a) any name beats any bubble.
    const lowestLabel = Math.min(...labels.map(zOf));
    for (const b of bubbles) expect(zOf(b)).toBeLessThan(lowestLabel);
    // (b) the nearer employee's bubble wins.
    expect(zOf(bubbles[1])).toBeGreaterThan(zOf(bubbles[0]));
    // (c) activity bubbles are single-line.
    for (const b of bubbles) expect(b!.classList.contains('wmux-office-bubble--line')).toBe(true);
  });

  it('status bubbles draw above every name label; activity bubbles stay below', () => {
    // Desks 0-4 are the back row, 5-9 the row in front of it.
    mount([
      ...Array.from({ length: 5 }, (_, i) => emp(`w${i}`, { bubble: `Running step ${i}` })),
      emp('q', { state: 'needs_you', need: 'question' }),
      emp('d1', { state: 'finished' }),
      emp('d2', { state: 'finished' }),
      emp('e', { state: 'needs_you', need: 'error' }),
      emp('w9', { bubble: 'Thinking' }),
    ]);
    const zOf = (el: Element | null): number => Number((el as HTMLElement).style.zIndex);
    const labels = Array.from(container.querySelectorAll('.wmux-office-employee__label')).map(zOf);
    const bubbles = Array.from(container.querySelectorAll<HTMLElement>('[data-office-bubble]'));
    const status = bubbles.filter((b) => b.getAttribute('data-office-bubble') !== 'activity');
    const activity = bubbles.filter((b) => b.getAttribute('data-office-bubble') === 'activity');
    expect(status.length).toBe(4);
    expect(activity.length).toBe(6);
    for (const b of status) expect(zOf(b)).toBeGreaterThan(Math.max(...labels));
    for (const b of activity) expect(zOf(b)).toBeLessThan(Math.min(...labels));
    // Among themselves, status bubbles still stack by depth: the nearer one
    // (lower on screen, in the boss queue) wins.
    const queued = ['q', 'd1', 'd2', 'e'].map((id) => {
      const el = employeeEl(id);
      return { top: parseFloat(el.style.top), z: zOf(el.querySelector('[data-office-bubble]')) };
    });
    queued.sort((p, r) => p.top - r.top);
    for (let k = 1; k < queued.length; k += 1) {
      if (queued[k].top > queued[k - 1].top) expect(queued[k].z).toBeGreaterThan(queued[k - 1].z);
    }
  });

  it('queued needs-you renders a raised hand and a red bubble at a queue spot', () => {
    const resetsAt = new Date(2026, 9, 20, 14, 0).getTime();
    mount([
      emp('q', { state: 'needs_you', need: 'question', bubble: 'ignored activity' }),
      emp('err', { state: 'needs_you', need: 'error' }),
      emp('lim', { state: 'needs_you', need: 'usage_limit', resetsAt }),
      emp('lim2', { state: 'needs_you', need: 'usage_limit' }),
    ]);
    const q = employeeEl('q');
    expect(q.getAttribute('data-pose')).toBe('raiseHand');
    expect(q.getAttribute('data-spot')).toBe('queue');
    const bubble = q.querySelector('[data-office-bubble]')!;
    expect(bubble.getAttribute('data-office-bubble')).toBe('alert');
    expect(bubble.textContent).toContain('!');
    expect(bubble.textContent).toContain('Waiting for you');
    expect(bubble.textContent).not.toContain('ignored activity');
    expect(employeeEl('err').querySelector('[data-office-bubble]')!.textContent).toContain('Error');
    const lim = employeeEl('lim').querySelector('[data-office-bubble]')!.textContent ?? '';
    expect(lim).toContain('Usage limit');
    expect(lim).toMatch(/resumes .*2/);
    const lim2 = employeeEl('lim2').querySelector('[data-office-bubble]')!.textContent ?? '';
    expect(lim2).toContain('Usage limit');
    expect(lim2).not.toContain('resumes');
    expect(q.getAttribute('aria-label')).toContain('Waiting for you');
  });

  it('finished renders a ✓ bubble at a queue spot', () => {
    mount([emp('done', { state: 'finished', bubble: 'ignored activity' })]);
    const el = employeeEl('done');
    expect(el.getAttribute('data-pose')).toBe('stand');
    expect(el.getAttribute('data-spot')).toBe('queue');
    const bubble = el.querySelector('[data-office-bubble]')!;
    expect(bubble.getAttribute('data-office-bubble')).toBe('done');
    expect(bubble.classList.contains('wmux-office-bubble--done')).toBe(true);
    expect(bubble.textContent).toContain('✓');
    expect(bubble.textContent).toContain('Done');
    expect(bubble.textContent).not.toContain('ignored activity');
    expect(el.getAttribute('aria-label')).toContain('Finished');
  });

  it('working employees sit at their desk and resting ones on a sofa', () => {
    mount([emp('w'), emp('r', { state: 'resting' })]);
    expect(employeeEl('w').getAttribute('data-spot')).toBe('desk');
    expect(employeeEl('r').getAttribute('data-spot')).toBe('sofa');
    expect(deskOf('w').getAttribute('data-desk-state')).toBe('working');
    expect(deskOf('r').getAttribute('data-desk-state')).toBe('empty');
  });

  it("a queued employee's desk stays reserved for it", () => {
    mount([emp('q', { state: 'needs_you' }), emp('f', { state: 'finished' })]);
    // Monitor on, chair empty: the owner comes back to it.
    expect(deskOf('q').getAttribute('data-desk-state')).toBe('reserved');
    expect(deskOf('f').getAttribute('data-desk-state')).toBe('reserved');
  });

  it('renders the boss at the boss desk with a nameplate', () => {
    mount([emp('w')]);
    const boss = container.querySelector('[data-office-boss]');
    expect(boss).not.toBeNull();
    expect(boss!.getAttribute('aria-label')).toBe('Boss desk (you)');
    const plate = container.querySelector('[data-office-boss-nameplate]');
    expect(plate!.textContent).toBe('Boss');
    // The nameplate is a label like the employees' names: above every sprite.
    const label = employeeEl('w').querySelector('.wmux-office-employee__label') as HTMLElement;
    expect(Number((plate as HTMLElement).style.zIndex)).toBe(Number(label.style.zIndex));
  });

  it('walks to the boss desk when it needs you, then settles into its pose', () => {
    vi.useFakeTimers();
    mount([emp('a')]);
    const at = (el: HTMLElement) => `${el.style.left},${el.style.top}`;
    const desk = at(employeeEl('a'));
    update([emp('a', { state: 'needs_you' })]);
    const el = employeeEl('a');
    expect(at(el)).not.toBe(desk);
    expect(el.getAttribute('data-spot')).toBe('queue');
    // On the way: the walk cycle; the desk shows its chair already.
    expect(el.getAttribute('data-pose')).toBe('walk');
    expect(el.hasAttribute('data-walking')).toBe(true);
    expect(deskOf('a').getAttribute('data-desk-state')).toBe('reserved');
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(employeeEl('a').getAttribute('data-pose')).toBe('raiseHand');
    expect(employeeEl('a').hasAttribute('data-walking')).toBe(false);
    // Back to work: it walks to its desk, and the chair stays until it sits down.
    update([emp('a')]);
    expect(employeeEl('a').getAttribute('data-pose')).toBe('walk');
    expect(deskOf('a').getAttribute('data-desk-state')).toBe('reserved');
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(employeeEl('a').getAttribute('data-pose')).toBe('type');
    expect(at(employeeEl('a'))).toBe(desk);
    expect(deskOf('a').getAttribute('data-desk-state')).toBe('working');
  });

  it('queue order and desks survive leaving the page and coming back', () => {
    mount([emp('a', { state: 'needs_you' }), emp('b', { state: 'needs_you' }), emp('w')]);
    expect(employeeEl('a').getAttribute('data-queue-place')).toBe('0');
    const desk = employeeEl('w').style.left + employeeEl('w').style.top;
    act(() => {
      root.unmount();
    });
    container.remove();
    // The rail unmounts the page while it is hidden; the list order may differ on return.
    mount([emp('w'), emp('b', { state: 'needs_you' }), emp('a', { state: 'needs_you' })]);
    expect(employeeEl('a').getAttribute('data-queue-place')).toBe('0');
    expect(employeeEl('b').getAttribute('data-queue-place')).toBe('1');
    expect(employeeEl('w').style.left + employeeEl('w').style.top).toBe(desk);
  });

  it('growing the room does not mark anyone walking', () => {
    // 5 need you, 5 finished, 10 work (the first `called` of them need you too), 10 rest.
    const team = (called: number) =>
      Array.from({ length: 30 }, (_, i) =>
        emp(`p${i}`, {
          state: i < 5 || (i >= 10 && i < 10 + called) ? 'needs_you' : i < 10 ? 'finished' : i < 20 ? 'working' : 'resting',
        }),
      );
    mount(team(0));
    const height = (container.querySelector('.wmux-office-room') as HTMLElement).style.height;
    // Four workers are called: the needs-you rows grow by one and so does the room.
    update(team(4));
    expect((container.querySelector('.wmux-office-room') as HTMLElement).style.height).not.toBe(height);
    const walking = Array.from(container.querySelectorAll('[data-office-employee][data-walking]'))
      .map((el) => el.getAttribute('data-office-employee'))
      .sort();
    // Only the four who left their desks and the finished, a row further back, walk.
    expect(walking).toEqual(['p10', 'p11', 'p12', 'p13', 'p5', 'p6', 'p7', 'p8', 'p9']);
    for (let i = 14; i < 20; i += 1) expect(deskOf(`p${i}`).getAttribute('data-desk-state')).toBe('working');
  });

  it('reduced motion disables the transition: the employee jumps to its spot', () => {
    document.documentElement.setAttribute('data-reduced-motion', 'true');
    mount([emp('a')]);
    update([emp('a', { state: 'finished' })]);
    const el = employeeEl('a');
    expect(el.getAttribute('data-spot')).toBe('queue');
    expect(el.getAttribute('data-pose')).toBe('stand');
    expect(el.hasAttribute('data-walking')).toBe(false);
    // The CSS transition is off under both reduced-motion sources.
    const css = readFileSync(join(__dirname, '..', 'office.css'), 'utf8').replace(/\s+/g, ' ');
    // Only a walking employee transitions, so a room that grows moves the rest at once.
    expect(css).not.toMatch(/\.wmux-office-employee \{[^}]*transition/);
    expect(css).toMatch(/\.wmux-office-employee\[data-walking\] \{[^}]*transition: left/);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{[^@]*\.wmux-office-employee\[data-walking\] \{ transition: none; \}/);
    expect(css).toContain(':root[data-reduced-motion] .wmux-office-employee[data-walking] { transition: none; }');
  });

  it("click jumps to the employee's pane", () => {
    mount([emp('pty-1'), emp('pty-2')]);
    act(() => {
      employeeEl('pty-2').click();
    });
    expect(focusPaneByPtyId).toHaveBeenCalledTimes(1);
    const [getState, ptyId] = vi.mocked(focusPaneByPtyId).mock.calls[0];
    expect(ptyId).toBe('pty-2');
    expect(getState()).toBe(useStore.getState());
  });

  it('teammate click jumps to its lead', () => {
    mount([
      emp('lead'),
      emp('lead#alice', { kind: 'teammate', leadId: 'lead', jumpPtyId: 'lead' }),
    ]);
    act(() => {
      employeeEl('lead#alice').click();
    });
    expect(vi.mocked(focusPaneByPtyId).mock.calls[0][1]).toBe('lead');
  });

  it('shows the empty state with no employees', () => {
    mount([]);
    const empty = container.querySelector('[data-office-empty]');
    expect(empty).not.toBeNull();
    expect(empty!.textContent).toContain('No agent sessions');
    expect(container.querySelectorAll('[data-office-employee]').length).toBe(0);
  });
});
