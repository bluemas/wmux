import { describe, it, expect } from 'vitest';
import { layoutOffice, DESK_COLUMNS, BASE_DESK_ROWS } from '../officeLayout';
import type { OfficeEmployee } from '../../../stores/selectors/officeEmployees';

function emp(id: string, extra: Partial<OfficeEmployee> = {}): OfficeEmployee {
  return {
    id,
    kind: 'claude',
    name: id,
    label: id,
    agent: 'Claude',
    paneTag: 'w1-1',
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

  it("keeps each resting employee's lounge spot across updates", () => {
    const rest = (id: string): OfficeEmployee => emp(id, { state: 'resting' });
    const first = layoutOffice([rest('a'), rest('b'), rest('c'), emp('d')]);
    // 'a' goes back to work, so 'b' and 'c' move up the list; 'd' sits down.
    const second = layoutOffice([emp('a'), rest('b'), rest('c'), rest('d')], first);
    expect(second.loungeFor.b).toBe(first.loungeFor.b);
    expect(second.loungeFor.c).toBe(first.loungeFor.c);
    // The newcomer takes the spot 'a' freed.
    expect(second.loungeFor.d).toBe(first.loungeFor.a);
    expect(second.loungeFor.a).toBeUndefined();
  });

  it('seats every resting employee on a sofa', () => {
    const employees = Array.from({ length: 25 }, (_, i) => emp(`r${i}`, { state: 'resting' }));
    const layout = layoutOffice(employees);
    expect(layout.props.filter((p) => p.key === 'sofa').length).toBe(13);
    const seats = employees.map((e) => layout.loungeFor[e.id]);
    expect(new Set(seats).size).toBe(25);
    for (const s of seats) expect(layout.lounge[s].spot).toBe('sofa');
  });

  it('no sofa overlaps a desk or another sofa at 30 employees', () => {
    const employees = Array.from({ length: 30 }, (_, i) => emp(`p${i}`, { state: 'resting' }));
    const layout = layoutOffice(employees);
    // Floor footprints relative to each piece's anchor (docs/office-art.md):
    // a station is the desk plus its chair tile, a sofa 48x16, a coffee table 20x12.
    const boxes = [
      ...layout.desks.map((d) => ({ x: d.x, y: d.y, a: 32, b: 32 })),
      ...layout.props
        .filter((p) => p.key === 'sofa' || p.key === 'coffeeTable')
        .map((p) => ({ x: p.x, y: p.y, a: p.key === 'sofa' ? 48 : 20, b: p.key === 'sofa' ? 16 : 12 })),
    ];
    expect(boxes.filter((b) => b.a === 48).length).toBe(15);
    // Screen deltas back to floor deltas: dx = da - db, dy = (da + db) / 2.
    for (let i = 0; i < boxes.length; i += 1) {
      for (let j = i + 1; j < boxes.length; j += 1) {
        const p = boxes[i];
        const q = boxes[j];
        const dx = q.x - p.x;
        const dy = q.y - p.y;
        const da = dy + dx / 2;
        const db = dy - dx / 2;
        const apart = da >= p.a || -da >= q.a || db >= p.b || -db >= q.b;
        expect(apart).toBe(true);
      }
    }
    // Every sofa lies inside the room.
    for (const p of layout.props.filter((x) => x.key === 'sofa')) {
      expect(p.x).toBeGreaterThan(0);
      expect(p.y + 24).toBeLessThan(layout.height);
    }
  });

  it('keeps a sofa drawn while someone sits on it after others leave', () => {
    const rest = (id: string): OfficeEmployee => emp(id, { state: 'resting' });
    const first = layoutOffice(Array.from({ length: 10 }, (_, i) => rest(`r${i}`)));
    const sofaAt = (l: typeof first, id: string) => l.lounge[l.loungeFor[id]];
    // Everyone but the last one goes back to work.
    const second = layoutOffice(
      Array.from({ length: 10 }, (_, i) => (i === 9 ? rest(`r${i}`) : emp(`r${i}`))),
      first,
    );
    expect(sofaAt(second, 'r9')).toEqual(sofaAt(first, 'r9'));
  });

  it('a finished employee keeps its desk and stands beside it', () => {
    const first = layoutOffice([emp('a'), emp('b')]);
    const second = layoutOffice([emp('a', { state: 'finished' }), emp('b')], first);
    expect(second.deskFor.a).toBe(first.deskFor.a);
    expect(second.loungeFor.a).toBeUndefined();
    expect(second.stands.length).toBe(second.desks.length);
    expect(second.stands[second.deskFor.a].spot).toBe('stand');
  });

  it('no stand spot falls on a station or another stand spot at 30 employees', () => {
    const layout = layoutOffice(Array.from({ length: 30 }, (_, i) => emp(`p${i}`, { state: 'finished' })));
    // A standing character takes about 12x12 floor units around its anchor.
    const R = 6;
    for (const s of layout.stands) {
      for (const d of layout.desks) {
        const dx = s.x - d.x;
        const dy = s.y - d.y;
        const da = dy + dx / 2;
        const db = dy - dx / 2;
        const inside = da > -R && da < 32 + R && db > -R && db < 32 + R;
        expect(inside).toBe(false);
      }
    }
    for (let i = 0; i < layout.stands.length; i += 1) {
      for (let j = i + 1; j < layout.stands.length; j += 1) {
        const dx = layout.stands[j].x - layout.stands[i].x;
        const dy = layout.stands[j].y - layout.stands[i].y;
        expect(Math.max(Math.abs(dy + dx / 2), Math.abs(dy - dx / 2))).toBeGreaterThanOrEqual(2 * R);
      }
    }
    for (const s of layout.stands) {
      expect(s.x).toBeGreaterThan(0);
      expect(s.x).toBeLessThan(layout.width);
    }
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
