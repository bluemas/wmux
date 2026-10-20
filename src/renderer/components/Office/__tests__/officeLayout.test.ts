import { describe, it, expect } from 'vitest';
import { layoutOffice, DESK_COLUMNS, BASE_DESK_ROWS, BOSS_DESK } from '../officeLayout';
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

/** Screen delta from `from` to `to`, back in floor units (dx = da - db, dy = (da + db) / 2). */
function floor(to: { x: number; y: number }, from: { x: number; y: number }): { da: number; db: number } {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  return { da: dy + dx / 2, db: dy - dx / 2 };
}

/** Queued ids in queue order. */
function line(layout: ReturnType<typeof layoutOffice>): string[] {
  return Object.keys(layout.queueFor).sort((x, y) => layout.queueFor[x] - layout.queueFor[y]);
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

  it('queues needs-you and finished employees in front of the boss desk', () => {
    const layout = layoutOffice([
      emp('w'),
      emp('q', { state: 'needs_you', need: 'question' }),
      emp('f', { state: 'finished' }),
      emp('r', { state: 'resting' }),
    ]);
    for (const id of ['q', 'f']) {
      const spot = layout.queue[layout.queueFor[id]];
      expect(spot.spot).toBe('queue');
      // In floor units from the boss desk's anchor: in front of its footprint
      // (larger b), and level with it along a.
      const { da, db } = floor(spot, layout.boss);
      expect(db).toBeGreaterThanOrEqual(BOSS_DESK.b + 6);
      expect(da).toBeGreaterThan(-BOSS_DESK.a);
      expect(da).toBeLessThan(2 * BOSS_DESK.a);
      // Nearer the boss than the first row of desks.
      expect(floor(spot, layout.desks[0]).db).toBeLessThan(-6);
    }
    expect(layout.queueFor.w).toBeUndefined();
    expect(layout.queueFor.r).toBeUndefined();
    expect(layout.loungeFor.f).toBeUndefined();
    expect(layout.loungeFor.r).toBeDefined();
  });

  it('needs-you are ahead of finished', () => {
    const layout = layoutOffice([
      emp('f1', { state: 'finished' }),
      emp('q1', { state: 'needs_you' }),
      emp('f2', { state: 'finished' }),
      emp('q2', { state: 'needs_you' }),
    ]);
    expect(line(layout)).toEqual(['q1', 'q2', 'f1', 'f2']);
    // The finished start a row of their own, behind the needs-you row.
    const rowOf = (id: string) => floor(layout.queue[layout.queueFor[id]], layout.boss).db;
    expect(rowOf('q1')).toBe(rowOf('q2'));
    expect(rowOf('f1')).toBe(rowOf('f2'));
    expect(rowOf('f1')).toBeGreaterThan(rowOf('q2'));
  });

  it('the longest-waiting needs-you stands at the boss-side end of the front row', () => {
    const layout = layoutOffice([
      emp('f1', { state: 'finished' }),
      emp('q1', { state: 'needs_you' }),
      emp('q2', { state: 'needs_you' }),
      emp('q3', { state: 'needs_you' }),
    ]);
    // From the boss, who sits 10 units behind the desk's back edge.
    const dist = (s: { x: number; y: number }) => {
      const { da, db } = floor(s, layout.boss);
      return Math.hypot(da - BOSS_DESK.a / 2, db + 10);
    };
    const first = layout.queue[layout.queueFor.q1];
    const front = layout.queue.filter((s) => floor(s, layout.boss).db === floor(first, layout.boss).db);
    for (const s of front) expect(dist(s)).toBeGreaterThanOrEqual(dist(first));
    // The row fills in one direction from there: each next one further from the boss.
    const spots = ['q1', 'q2', 'q3'].map((id) => layout.queue[layout.queueFor[id]]);
    expect(dist(spots[1])).toBeGreaterThan(dist(spots[0]));
    expect(dist(spots[2])).toBeGreaterThan(dist(spots[1]));
  });

  it('no queued status bubble covers another queued figure', () => {
    // On screen (1x px from the anchor): a standing figure's body is about
    // 18 wide and 35 tall above its anchor; its status bubble (about 110x20
    // at 2x) sits 47-57 above the anchor.
    const body = (s: { x: number; y: number }) => ({ x0: s.x - 9, x1: s.x + 9, y0: s.y - 35, y1: s.y });
    const bubble = (s: { x: number; y: number }) => ({ x0: s.x - 27.5, x1: s.x + 27.5, y0: s.y - 57, y1: s.y - 47 });
    const cross = (p: ReturnType<typeof body>, q: ReturnType<typeof body>) =>
      p.x0 < q.x1 && q.x0 < p.x1 && p.y0 < q.y1 && q.y0 < p.y1;
    for (const needs of [10, 5, 3]) {
      const employees = Array.from({ length: 30 }, (_, i) =>
        emp(`p${i}`, { state: i < needs ? 'needs_you' : i < 10 ? 'finished' : i < 20 ? 'working' : 'resting' }),
      );
      const layout = layoutOffice(employees);
      const spots = employees.slice(0, 10).map((e) => layout.queue[layout.queueFor[e.id]]);
      for (const a of spots) {
        for (const b of spots) {
          if (a === b) continue;
          expect(cross(bubble(a), body(b)), `${needs} needs-you`).toBe(false);
        }
      }
    }
  });

  it('queue order is stable across updates', () => {
    const first = layoutOffice([
      emp('a', { state: 'needs_you' }),
      emp('b', { state: 'needs_you' }),
      emp('c', { state: 'finished' }),
    ]);
    expect(line(first)).toEqual(['a', 'b', 'c']);
    // The list order flips and a newcomer needs you: it joins the back of the
    // needs-you group; everyone else keeps their place.
    const second = layoutOffice(
      [emp('c', { state: 'finished' }), emp('d', { state: 'needs_you' }), emp('b', { state: 'needs_you' }), emp('a', { state: 'needs_you' })],
      first,
    );
    expect(line(second)).toEqual(['a', 'b', 'd', 'c']);
    // 'a' is answered and goes back to work: the queue moves up behind it.
    const third = layoutOffice(
      [emp('a'), emp('b', { state: 'needs_you' }), emp('c', { state: 'finished' }), emp('d', { state: 'needs_you' })],
      second,
    );
    expect(third.queueFor.a).toBeUndefined();
    expect(line(third)).toEqual(['b', 'd', 'c']);
    // 'a' needs you again later: it rejoins at the back of its group.
    const fourth = layoutOffice(
      [emp('a', { state: 'needs_you' }), emp('b', { state: 'needs_you' }), emp('c', { state: 'finished' }), emp('d', { state: 'needs_you' })],
      third,
    );
    expect(line(fourth)).toEqual(['b', 'd', 'a', 'c']);
    // A finished employee that needs you joins the back of the needs-you group.
    const fifth = layoutOffice(
      [emp('a', { state: 'needs_you' }), emp('b', { state: 'needs_you' }), emp('c', { state: 'needs_you' }), emp('d', { state: 'needs_you' })],
      fourth,
    );
    expect(line(fifth)).toEqual(['b', 'd', 'a', 'c']);
  });

  it('queued employees keep their desk reserved', () => {
    const first = layoutOffice([emp('a'), emp('b'), emp('c')]);
    const second = layoutOffice(
      [emp('a', { state: 'needs_you' }), emp('b', { state: 'finished' }), emp('c'), emp('n1'), emp('n2')],
      first,
    );
    expect(second.deskFor.a).toBe(first.deskFor.a);
    expect(second.deskFor.b).toBe(first.deskFor.b);
    // Newcomers never take a queued employee's desk.
    expect([second.deskFor.n1, second.deskFor.n2]).not.toContain(first.deskFor.a);
    expect([second.deskFor.n1, second.deskFor.n2]).not.toContain(first.deskFor.b);
    // Back to work: the same desk.
    const third = layoutOffice([emp('a'), emp('b'), emp('c'), emp('n1'), emp('n2')], second);
    expect(third.deskFor.a).toBe(first.deskFor.a);
    expect(third.queueFor.a).toBeUndefined();
  });

  it('no queue spot overlaps a desk, sofa or the boss desk at 30 employees (10 queued)', () => {
    const employees = Array.from({ length: 30 }, (_, i) =>
      emp(`p${i}`, {
        state: i < 5 ? 'needs_you' : i < 10 ? 'finished' : i < 20 ? 'working' : 'resting',
      }),
    );
    const layout = layoutOffice(employees);
    const queued = employees.slice(0, 10).map((e) => layout.queueFor[e.id]);
    expect(new Set(queued).size).toBe(10);
    // A standing character takes about 12x12 floor units around its anchor.
    const R = 6;
    const spots = queued.map((k) => layout.queue[k]);
    const boxes = [
      ...layout.desks.map((d) => ({ x: d.x, y: d.y, a0: 0, a1: 32, b0: 0, b1: 32 })),
      ...layout.props
        .filter((p) => p.key === 'sofa' || p.key === 'coffeeTable')
        .map((p) => ({ x: p.x, y: p.y, a0: 0, a1: p.key === 'sofa' ? 48 : 20, b0: 0, b1: p.key === 'sofa' ? 16 : 12 })),
    ];
    // The boss desk and the boss's chair behind it.
    const boss = { x: layout.boss.x, y: layout.boss.y, a0: 0, a1: BOSS_DESK.a, b0: -BOSS_DESK.chair, b1: BOSS_DESK.b };
    for (const s of spots) {
      for (const b of [...boxes, boss]) {
        const { da, db } = floor(s, b);
        const inside = da > b.a0 - R && da < b.a1 + R && db > b.b0 - R && db < b.b1 + R;
        expect(inside).toBe(false);
      }
      expect(s.x).toBeGreaterThan(0);
      expect(s.x).toBeLessThan(layout.width);
      expect(s.y).toBeGreaterThan(0);
      expect(s.y).toBeLessThan(layout.height);
    }
    for (let i = 0; i < spots.length; i += 1) {
      for (let j = i + 1; j < spots.length; j += 1) {
        const { da, db } = floor(spots[j], spots[i]);
        expect(Math.max(Math.abs(da), Math.abs(db))).toBeGreaterThanOrEqual(2 * R);
      }
    }
    // The boss desk (with its chair) clears every desk and sofa.
    for (const b of boxes) {
      const { da, db } = floor({ x: boss.x, y: boss.y }, b);
      const apart = da >= b.a1 || -da >= BOSS_DESK.a || db - BOSS_DESK.chair >= b.b1 || -db >= BOSS_DESK.b;
      expect(apart).toBe(true);
    }
  });

  it('the queue wraps into more rows and the room grows with it', () => {
    const many = Array.from({ length: 24 }, (_, i) => emp(`q${i}`, { state: 'needs_you' }));
    const few = layoutOffice(many.slice(0, 2));
    const lots = layoutOffice(many);
    expect(new Set(many.map((e) => lots.queueFor[e.id])).size).toBe(24);
    expect(lots.height).toBeGreaterThan(few.height);
    // Still clear of every desk.
    for (const e of many) {
      const s = lots.queue[lots.queueFor[e.id]];
      for (const d of lots.desks) expect(floor(s, d).db).toBeLessThan(-6);
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
