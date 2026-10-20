import { describe, it, expect } from 'vitest';
import { layoutOffice, DESK_COLUMNS, BASE_DESK_ROWS } from '../officeLayout';
import type { OfficeEmployee } from '../../../stores/selectors/officeEmployees';

function emp(id: string, extra: Partial<OfficeEmployee> = {}): OfficeEmployee {
  return {
    id,
    kind: 'claude',
    name: id,
    workspaceName: 'ws',
    state: 'working',
    jumpPtyId: id,
    look: 0,
    ...extra,
  };
}

function deskCell(index: number): { row: number; col: number } {
  return { row: Math.floor(index / DESK_COLUMNS), col: index % DESK_COLUMNS };
}

describe('layoutOffice', () => {
  it('lays out 30 employees without overlapping seats', () => {
    const employees = Array.from({ length: 30 }, (_, i) =>
      emp(`pty-${i}`, { state: i % 3 === 0 ? 'resting' : i % 3 === 1 ? 'working' : 'needs_you' }),
    );
    const layout = layoutOffice(employees);

    // Every employee has its own desk, all desks distinct.
    const deskIndexes = employees.map((e) => layout.deskFor[e.id]);
    expect(deskIndexes.every((d) => Number.isInteger(d) && d >= 0 && d < layout.desks.length)).toBe(true);
    expect(new Set(deskIndexes).size).toBe(30);

    // Every resting employee has its own lounge spot.
    const resting = employees.filter((e) => e.state === 'resting');
    const loungeIndexes = resting.map((e) => layout.loungeFor[e.id]);
    expect(loungeIndexes.every((l) => Number.isInteger(l) && l >= 0 && l < layout.lounge.length)).toBe(true);
    expect(new Set(loungeIndexes).size).toBe(resting.length);
    // Nobody at a desk is in the lounge.
    for (const e of employees.filter((x) => x.state !== 'resting')) expect(layout.loungeFor[e.id]).toBeUndefined();

    // No two seats (desk or lounge) share a point, and all lie inside the room.
    const seats = [...layout.desks, ...layout.lounge];
    const points = new Set(seats.map((s) => `${s.x},${s.y}`));
    expect(points.size).toBe(seats.length);
    for (const s of seats) {
      expect(s.x).toBeGreaterThan(0);
      expect(s.x).toBeLessThan(layout.width);
      expect(s.y).toBeGreaterThan(0);
      expect(s.y).toBeLessThan(layout.height);
    }
    // Desk seats are far enough apart that two stations never stack.
    for (let i = 0; i < layout.desks.length; i += 1) {
      for (let j = i + 1; j < layout.desks.length; j += 1) {
        const dx = Math.abs(layout.desks[i].x - layout.desks[j].x);
        const dy = Math.abs(layout.desks[i].y - layout.desks[j].y);
        expect(dx >= 32 || dy >= 16).toBe(true);
      }
    }
  });

  it('starts with the drawn desk area and grows by desk rows past it', () => {
    const small = layoutOffice([emp('a')]);
    expect(small.desks.length).toBe(DESK_COLUMNS * BASE_DESK_ROWS);
    const big = layoutOffice(Array.from({ length: 30 }, (_, i) => emp(`p${i}`)));
    expect(big.desks.length).toBe(Math.ceil(30 / DESK_COLUMNS) * DESK_COLUMNS);
    expect(big.height).toBeGreaterThan(small.height);
  });

  it("keeps each employee's desk across updates", () => {
    const first = layoutOffice([emp('a'), emp('b'), emp('c'), emp('d')]);
    // 'b' leaves, 'e' arrives, 'c' starts resting, the order changes.
    const second = layoutOffice(
      [emp('d'), emp('e'), emp('a'), emp('c', { state: 'resting' })],
      first,
    );
    expect(second.deskFor.a).toBe(first.deskFor.a);
    expect(second.deskFor.c).toBe(first.deskFor.c);
    expect(second.deskFor.d).toBe(first.deskFor.d);
    expect(second.deskFor.b).toBeUndefined();
    // The newcomer takes a free desk (the one 'b' left), not someone else's.
    expect(second.deskFor.e).toBe(first.deskFor.b);
  });

  it('seats teammates next to their lead', () => {
    const employees = [
      emp('lead-1'),
      emp('solo-1'),
      emp('solo-2'),
      emp('lead-1#alice', { kind: 'teammate', leadId: 'lead-1', jumpPtyId: 'lead-1' }),
      emp('lead-1#bob', { kind: 'teammate', leadId: 'lead-1', jumpPtyId: 'lead-1' }),
    ];
    const layout = layoutOffice(employees);
    const lead = deskCell(layout.deskFor['lead-1']);
    for (const id of ['lead-1#alice', 'lead-1#bob']) {
      const mate = deskCell(layout.deskFor[id]);
      expect(Math.max(Math.abs(mate.row - lead.row), Math.abs(mate.col - lead.col))).toBeLessThanOrEqual(2);
    }
    // The first teammate sits right beside the lead.
    const alice = deskCell(layout.deskFor['lead-1#alice']);
    expect(Math.abs(alice.row - lead.row) + Math.abs(alice.col - lead.col)).toBe(1);
  });

  it('a teammate that arrives later still sits next to its lead', () => {
    const first = layoutOffice([emp('lead'), emp('x'), emp('y'), emp('z')]);
    const second = layoutOffice(
      [emp('lead'), emp('lead#m', { kind: 'teammate', leadId: 'lead', jumpPtyId: 'lead' }), emp('x'), emp('y'), emp('z')],
      first,
    );
    const lead = deskCell(second.deskFor.lead);
    const mate = deskCell(second.deskFor['lead#m']);
    expect(Math.abs(mate.row - lead.row) + Math.abs(mate.col - lead.col)).toBe(1);
  });
});
