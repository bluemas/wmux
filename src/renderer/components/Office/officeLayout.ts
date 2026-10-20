// Pure layout for the Office page: the room's size, one desk per employee
// (stable across updates), lounge spots for resting employees, and the room
// pieces to draw. No React, no DOM.
//
// World units follow the art (docs/office-art.md): one floor tile is 16x16
// units, `a` runs down-right along the right (back) wall, `b` down-left along
// the left wall, and a floor point (a, b) lands at screen ((a - b), (a + b) / 2)
// at 1x. Every point this module returns is a 1x screen pixel relative to the
// room's top-left; the scene multiplies by its display scale.
import type { OfficeEmployee } from '../../stores/selectors/officeEmployees';
import type { FurnitureKey, OfficeExtraKey } from '../../assets/office';

export interface Seat {
  /** 1x screen point of the seat's floor anchor (see `spot`). */
  x: number;
  y: number;
  /** Depth: larger draws in front. */
  z: number;
  facing: 'left' | 'right';
  /**
   * `desk`: (x, y) is the north corner of the desk footprint (the station
   * frame's `deskX/deskY`). `sofa`: (x, y) is the character anchor (the
   * frame's `seatX/seatY`).
   */
  spot: 'desk' | 'sofa';
}

/** A static room piece: its floor anchor at (x, y), stacked by `zIndex`. */
export interface OfficeProp {
  key: FurnitureKey | OfficeExtraKey;
  x: number;
  y: number;
  zIndex: number;
}

export interface OfficeLayout {
  /** Room size in 1x px. */
  width: number;
  height: number;
  desks: Seat[];
  lounge: Seat[];
  /** Employee id → index into `desks`. Every employee keeps a desk. */
  deskFor: Record<string, number>;
  /** Resting employee id → index into `lounge`. */
  loungeFor: Record<string, number>;
  props: OfficeProp[];
}

/** Desks per row: the room's width is fixed, it grows by rows. */
export const DESK_COLUMNS = 5;
/** Rows of the drawn desk area the room always has. */
export const BASE_DESK_ROWS = 2;

const TILE = 16;
const DESK_A0 = 32;
const DESK_A_STEP = 48;
const DESK_B0 = 18;
const DESK_B_STEP = 56;
/** Desk (1 tile) plus the chair's tile in front of it. */
const STATION_DEPTH = 32;
/** Room length along `a` (the back wall). */
const ROOM_A = DESK_A0 + (DESK_COLUMNS - 1) * DESK_A_STEP + 2 * TILE + TILE;

/** Sofas the lounge always has; it adds whole sofas until every resting employee sits. */
const BASE_SOFAS = 3;
const SOFAS_PER_ROW = 3;
const SOFA_A0 = 40;
const SOFA_A_STEP = 80;
/** One sofa row: the sofa, the rug and coffee table in front, and a gap. */
const SOFA_B_STEP = 64;
/** From the last sofa row to the front wall: the rug and the front plants. */
const LOUNGE_FRONT = 36;
/** Sofa-seat world offsets from the sofa's anchor (from the art's SOFA_SEATS). */
const SOFA_SEAT_OFFSETS: ReadonlyArray<{ a: number; b: number }> = [
  { a: 13, b: 11 },
  { a: 35, b: 11 },
];

const PAD_X = 24;
/** Above the back corner: wall height plus room for the back row's bubbles. */
const PAD_TOP = 72;
/** Below the front corner: name labels of the front row. */
const PAD_BOTTOM = 40;

/** Depth band → CSS z-index: floor 1-2, walls 10+, objects above. */
export function stackIndex(depth: number, step: number): number {
  return 1000 + Math.round(depth) * 4 + step;
}

const roundUp = (v: number, unit: number): number => Math.ceil(v / unit) * unit;

function deskCell(index: number): { row: number; col: number } {
  return { row: Math.floor(index / DESK_COLUMNS), col: index % DESK_COLUMNS };
}

function assignDesks(employees: OfficeEmployee[], prev?: OfficeLayout): Record<string, number> {
  const deskFor: Record<string, number> = {};
  const taken = new Set<number>();
  const present = new Set(employees.map((e) => e.id));
  /** Lead id → desks held next to it for its new teammates. */
  const reserved = new Map<string, number[]>();
  const assign = (id: string, desk: number): void => {
    deskFor[id] = desk;
    taken.add(desk);
  };

  if (prev) {
    for (const e of employees) {
      const desk = prev.deskFor[e.id];
      if (desk !== undefined && !taken.has(desk)) assign(e.id, desk);
    }
  }

  const isSeatedMate = (e: OfficeEmployee): boolean => e.leadId !== undefined && present.has(e.leadId);

  // Leads and solo agents first, each with a free run of desks in one row for
  // its newly arriving teammates, so a new team sits together.
  for (const e of employees) {
    if (deskFor[e.id] !== undefined || isSeatedMate(e)) continue;
    const newMates = employees.filter((m) => m.leadId === e.id && deskFor[m.id] === undefined).length;
    const run = newMates + 1 <= DESK_COLUMNS ? newMates + 1 : 1;
    const start = firstFreeRun(taken, run);
    assign(e.id, start);
    const held: number[] = [];
    for (let k = 1; k < run; k += 1) {
      taken.add(start + k);
      held.push(start + k);
    }
    if (held.length > 0) reserved.set(e.id, held);
  }

  // Teammates take their lead's held desks, then the free desk nearest it.
  for (const e of employees) {
    if (deskFor[e.id] !== undefined || !isSeatedMate(e)) continue;
    const leadId = e.leadId as string;
    const held = reserved.get(leadId)?.shift();
    if (held !== undefined) {
      deskFor[e.id] = held;
      continue;
    }
    const lead = deskFor[leadId];
    assign(e.id, lead === undefined ? firstFreeRun(taken, 1) : nearestFree(taken, lead, employees.length));
  }
  return deskFor;
}

/** Lounge spots for the resting: each keeps its previous one, newcomers fill the freed spots first. */
function assignLounge(resting: OfficeEmployee[], prev?: OfficeLayout): Record<string, number> {
  const loungeFor: Record<string, number> = {};
  const taken = new Set<number>();
  if (prev) {
    for (const e of resting) {
      const spot = prev.loungeFor[e.id];
      if (spot !== undefined && !taken.has(spot)) {
        loungeFor[e.id] = spot;
        taken.add(spot);
      }
    }
  }
  let next = 0;
  for (const e of resting) {
    if (loungeFor[e.id] !== undefined) continue;
    while (taken.has(next)) next += 1;
    loungeFor[e.id] = next;
    taken.add(next);
  }
  return loungeFor;
}

function firstFreeRun(taken: Set<number>, run: number): number {
  for (let start = 0; ; start += 1) {
    const { col } = deskCell(start);
    if (col + run > DESK_COLUMNS) continue;
    let free = true;
    for (let k = 0; k < run; k += 1) {
      if (taken.has(start + k)) {
        free = false;
        break;
      }
    }
    if (free) return start;
  }
}

function nearestFree(taken: Set<number>, from: number, count: number): number {
  const origin = deskCell(from);
  const limit = (Math.ceil((count + taken.size) / DESK_COLUMNS) + 2) * DESK_COLUMNS;
  let best = -1;
  let bestScore = Infinity;
  for (let d = 0; d < limit; d += 1) {
    if (taken.has(d)) continue;
    const { row, col } = deskCell(d);
    // Same row first, then the nearer column, then the lower desk.
    const score = (Math.abs(row - origin.row) * 2 + Math.abs(col - origin.col)) * limit + d;
    if (score < bestScore) {
      bestScore = score;
      best = d;
    }
  }
  return best;
}

export function layoutOffice(employees: OfficeEmployee[], prev?: OfficeLayout): OfficeLayout {
  const deskFor = assignDesks(employees, prev);
  const maxDesk = Object.values(deskFor).reduce((m, d) => Math.max(m, d), -1);
  const rows = Math.max(BASE_DESK_ROWS, Math.ceil((maxDesk + 1) / DESK_COLUMNS));

  const resting = employees.filter((e) => e.state === 'resting');
  const loungeFor = assignLounge(resting, prev);
  // Kept spots can leave holes, so count sofas by the highest spot: a sofa
  // stays while anyone sits on it, and each sofa keeps its place.
  const loungeSpots = Object.values(loungeFor).reduce((m, spot) => Math.max(m, spot + 1), 0);
  const sofas = Math.max(BASE_SOFAS, Math.ceil(loungeSpots / SOFA_SEAT_OFFSETS.length));
  const sofaRows = Math.ceil(sofas / SOFAS_PER_ROW);

  const deskEnd = DESK_B0 + (rows - 1) * DESK_B_STEP + STATION_DEPTH;
  const loungeB = roundUp(deskEnd + 8, TILE);
  const roomA = ROOM_A;
  const roomB = roundUp(loungeB + 8 + sofaRows * SOFA_B_STEP + LOUNGE_FRONT, TILE);

  const toScreen = (a: number, b: number): { x: number; y: number } => ({
    x: a - b + roomB + PAD_X,
    y: (a + b) / 2 + PAD_TOP,
  });

  const desks: Seat[] = [];
  for (let d = 0; d < rows * DESK_COLUMNS; d += 1) {
    const { row, col } = deskCell(d);
    const a = DESK_A0 + col * DESK_A_STEP;
    const b = DESK_B0 + row * DESK_B_STEP;
    desks.push({ ...toScreen(a, b), z: a + b + 42, facing: 'right', spot: 'desk' });
  }

  const props: OfficeProp[] = [];
  const prop = (key: OfficeProp['key'], a: number, b: number, zIndex: number): void => {
    props.push({ key, ...toScreen(a, b), zIndex });
  };

  const lounge: Seat[] = [];
  // Sofas in rows of three; each row has a rug and coffee table at its middle
  // sofa (at its only sofa while the last row has one).
  for (let s = 0; s < sofas; s += 1) {
    const col = s % SOFAS_PER_ROW;
    const rowLength = Math.min(SOFAS_PER_ROW, sofas - (s - col));
    const a = SOFA_A0 + col * SOFA_A_STEP;
    const b = loungeB + 8 + Math.floor(s / SOFAS_PER_ROW) * SOFA_B_STEP;
    const depth = a + 20 + b + 4;
    prop('sofa', a, b, stackIndex(depth, 0));
    SOFA_SEAT_OFFSETS.forEach((o, k) => {
      lounge.push({ ...toScreen(a + o.a, b + o.b), z: depth + k + 1, facing: 'left', spot: 'sofa' });
    });
    if (col === Math.min(1, rowLength - 1)) {
      prop('rug', a - 4, b + 16, 3);
      prop('coffeeTable', a + 6, b + 24, stackIndex(a + 14 + b + 30, 0));
    }
  }

  // Floor: wood everywhere, a carpet under the desk area.
  const tilesA = roomA / TILE;
  const tilesB = roomB / TILE;
  const carpetRows = Math.ceil((deskEnd + 8) / TILE);
  for (let j = 0; j < tilesB; j += 1) {
    for (let i = 0; i < tilesA; i += 1) {
      const carpet = i >= 1 && i < tilesA - 1 && j < carpetRows;
      prop(carpet ? 'carpet' : 'floor', i * TILE, j * TILE, 1);
    }
  }
  // Walls: windows in pairs along the back wall, every sixth tile on the left.
  for (let i = 0; i < tilesA; i += 1) {
    prop(i % 3 === 0 ? 'wall' : 'window', i * TILE, 0, 10 + (tilesA - i));
  }
  for (let j = 0; j < tilesB; j += 1) {
    prop(j % 6 === 3 || j % 6 === 4 ? 'windowLeft' : 'wallLeft', 0, j * TILE, 10 + (tilesB - j));
  }

  // Decor.
  prop('shelf', roomA - 40, 0, stackIndex(roomA - 40 + 24 + 4, 0));
  prop('plant', 6, 6, stackIndex(12, 0));
  prop('plant', roomA - 10, 6, stackIndex(roomA - 4, 0));
  prop('plant', 6, roomB - 10, stackIndex(roomB - 4, 0));
  prop('plant', roomA - 10, roomB - 10, stackIndex(roomA + roomB - 20, 0));

  return {
    width: roomA + roomB + 2 * PAD_X,
    height: (roomA + roomB) / 2 + PAD_TOP + PAD_BOTTOM,
    desks,
    lounge,
    deskFor,
    loungeFor,
    props,
  };
}
