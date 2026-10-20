// @vitest-environment jsdom
//
// The Office page drawn from a fixed employee list: one employee element per
// OfficeEmployee, bubbles, the needs-you pose, click to jump, the empty state.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as React from 'react';
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
import { useStore } from '../../../stores';
import { focusPaneByPtyId } from '../../../hooks/useNotificationListener';

const act = React.act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function emp(id: string, extra: Partial<OfficeEmployee> = {}): OfficeEmployee {
  return {
    id,
    kind: 'claude',
    name: `name-${id}`,
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
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
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

  it('needs-you employee shows a raised hand and a red bubble', () => {
    const resetsAt = new Date(2026, 9, 20, 14, 0).getTime();
    mount([
      emp('q', { state: 'needs_you', need: 'question', bubble: 'ignored activity' }),
      emp('err', { state: 'needs_you', need: 'error' }),
      emp('lim', { state: 'needs_you', need: 'usage_limit', resetsAt }),
      emp('lim2', { state: 'needs_you', need: 'usage_limit' }),
    ]);
    const q = employeeEl('q');
    expect(q.getAttribute('data-pose')).toBe('raiseHand');
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
