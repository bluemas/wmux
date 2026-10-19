// Furniture and room pieces, drawn as isometric boxes and planes.
//
// World units: one floor tile is 16x16 units, z is height in pixels. A point
// (a, b, z) lands on screen at (ox + a - b, oy + (a + b) / 2 - z), which gives
// the 2:1 isometric lines (two pixels across for one down). `a` runs down-right
// (south-east), `b` runs down-left (south-west).
import { BASE, DARK, HI, LIGHT, Layer, SHADE, compose, fillPoly, line, outline, rect } from './raster.mjs';
import { RAMPS } from './palette.mjs';

export const TILE_W = 32;
export const TILE_H = 16;

/** Station frame: desk, monitor, chair and every character frame share it. */
export const STATION = { w: 64, h: 56, ox: 28, oy: 26 };
/** Chair centre on the floor, in station-frame pixels (also the character anchor). */
export const SEAT = { a: 20, b: 26 };

export function iso(ox, oy) {
  return (a, b, z = 0) => [ox + a - b, oy + (a + b) / 2 - z];
}

/**
 * An axis-aligned box. Visible faces: top (light), south-west face (base),
 * south-east face (shade); the top's front edges take the highlight tone.
 */
export function box(layer, P, a0, a1, b0, b1, z0, z1, ramp, opts = {}) {
  const { top = ramp, left = ramp, right = ramp, rim = true } = opts;
  const tmp = new Layer(layer.w, layer.h);
  if (z1 > z0) {
    fillPoly(tmp, [P(a1, b0, z1), P(a1, b1, z1), P(a1, b1, z0), P(a1, b0, z0)], right, SHADE);
    fillPoly(tmp, [P(a0, b1, z1), P(a1, b1, z1), P(a1, b1, z0), P(a0, b1, z0)], left, BASE);
  }
  fillPoly(tmp, [P(a0, b0, z1), P(a1, b0, z1), P(a1, b1, z1), P(a0, b1, z1)], top, LIGHT);
  if (rim && z1 > z0) {
    // Highlight the top face's pixels that sit on a side face (the front rim).
    for (let y = 0; y < tmp.h; y++) for (let x = 0; x < tmp.w; x++) {
      if (tmp.ramp(x, y) === top && tmp.tone(x, y) === LIGHT) {
        const below = tmp.tone(x, y + 1);
        if (tmp.filled(x, y + 1) && below !== LIGHT) tmp.set(x, y, top, HI);
      }
    }
  }
  return compose(layer, tmp);
}

/** A flat parallelogram in the plane b = const (faces south-west). */
function planeB(layer, P, b, a0, a1, z0, z1, ramp, tone) {
  fillPoly(layer, [P(a0, b, z1), P(a1, b, z1), P(a1, b, z0), P(a0, b, z0)], ramp, tone);
}

/** Map a point on the plane b = const, given in (u along a, v up) to pixels. */
function onPlaneB(P, b, a0, ztop) {
  return (u, v) => {
    const [x, y] = P(a0 + u, b, ztop - v);
    return [Math.floor(x), Math.floor(y)];
  };
}

function frame(w = STATION.w, h = STATION.h) {
  return new Layer(w, h);
}

// ---------------------------------------------------------------------------
// Station pieces (64x56 frames, desk footprint a 0..32, b 0..16)

export function drawDesk() {
  const L = frame();
  const P = iso(STATION.ox, STATION.oy);
  // Legs behind the drawer unit, then the drawer unit, then the top slab.
  box(L, P, 1, 3, 1, 3, 0, 9, 'woodDark');
  box(L, P, 1, 3, 13, 15, 0, 9, 'woodDark');
  box(L, P, 21, 31, 2, 15, 0, 9, 'plastic');
  // Drawer fronts on the drawer unit (south-west face, b = 15).
  for (const z of [3, 6]) {
    const [x0, y0] = P(22, 15, z);
    const [x1, y1] = P(30, 15, z);
    line(L, x0, y0, x1 - 1, y1 - 1, 'plastic', SHADE);
  }
  const [hx, hy] = P(25, 15, 7.5);
  rect(L, Math.floor(hx), Math.floor(hy), 2, 1, 'metal', BASE);
  const [hx2, hy2] = P(25, 15, 4.5);
  rect(L, Math.floor(hx2), Math.floor(hy2), 2, 1, 'metal', BASE);
  box(L, P, 0, 32, 0, 16, 9, 11, 'wood');
  // Grain lines on the top.
  for (const [a0, a1, b] of [
    [3, 14, 4],
    [17, 29, 9],
    [6, 12, 13],
  ]) {
    const [x0, y0] = P(a0, b, 11);
    const [x1, y1] = P(a1, b, 11);
    line(L, Math.floor(x0), Math.floor(y0), Math.floor(x1), Math.floor(y1), 'wood', BASE);
  }
  // Keyboard, mouse, notebook and a mug on the top.
  box(L, P, 12, 24, 10, 14, 11, 12, 'plastic', { rim: false });
  for (let k = 0; k < 5; k++) {
    const [x, y] = P(13.5 + k * 2, 11.5, 12);
    L.set(Math.floor(x), Math.floor(y), 'plastic', SHADE);
    const [x2, y2] = P(13.5 + k * 2, 13, 12);
    L.set(Math.floor(x2), Math.floor(y2), 'plastic', SHADE);
  }
  box(L, P, 27, 29, 11, 13, 11, 12, 'plastic', { rim: false });
  box(L, P, 2, 10, 4, 10, 11, 12, 'coral', { rim: false });
  {
    const [x0, y0] = P(3, 9, 12);
    const [x1, y1] = P(9, 9, 12);
    line(L, Math.floor(x0), Math.floor(y0), Math.floor(x1), Math.floor(y1), 'paper', LIGHT);
  }
  // Mug: a tiny cylinder at the back-right corner of the desk.
  const [mx, my] = P(28, 3, 11);
  rect(L, mx - 1, my - 4, 3, 4, 'mug', BASE);
  rect(L, mx - 1, my - 4, 1, 4, 'mug', LIGHT);
  rect(L, mx + 1, my - 4, 1, 4, 'mug', SHADE);
  rect(L, mx - 1, my - 5, 3, 1, 'coffee', BASE);
  L.set(mx + 2, my - 3, 'mug', SHADE);
  return outline(L, RAMPS);
}

function drawMonitorBase(L, P) {
  box(L, P, 16, 22, 3, 8, 11, 12, 'metal');
  box(L, P, 18, 20, 4, 6, 12, 15, 'metal', { rim: false });
  // Panel: front face in the plane b = 8 from a 8..28, z 14..28, 2 deep.
  box(L, P, 8, 28, 6, 8, 14, 28, 'bezel', { rim: false });
}

const SCREEN = { a0: 9, a1: 27, zTop: 27, zBot: 15, b: 8 };

function screenPixels(P, fn) {
  // Visit the screen's inner pixels in panel space (u across, v down).
  const W = SCREEN.a1 - SCREEN.a0;
  const H = SCREEN.zTop - SCREEN.zBot;
  const map = onPlaneB(P, SCREEN.b, SCREEN.a0, SCREEN.zTop);
  for (let v = 0; v < H; v++) for (let u = 0; u < W; u++) {
    const [x, y] = map(u + 0.5, v + 0.5);
    fn(u, v, x, y, W, H);
  }
}

export function drawMonitor(on) {
  const L = frame();
  const P = iso(STATION.ox, STATION.oy);
  drawMonitorBase(L, P);
  if (!on) {
    screenPixels(P, (u, v, x, y) => {
      // Dark glass with one soft diagonal reflection.
      const d = u - v * 1.6;
      const tone = d > 3 && d < 6 ? LIGHT : d >= 6 && d < 7 ? BASE : v > 9 ? SHADE : BASE;
      L.set(x, y, 'screenOff', tone);
    });
  } else {
    // An editor: a title bar, a gutter and coloured code lines.
    const code = [
      [1, 'teal', 2, 6],
      [1, 'coral', 9, 4],
      [3, 'navy', 4, 7],
      [3, 'mustard', 12, 3],
      [5, 'navy', 4, 3],
      [5, 'coral', 8, 6],
      [7, 'teal', 2, 9],
      [9, 'navy', 4, 5],
      [9, 'sage', 10, 4],
    ];
    screenPixels(P, (u, v, x, y, W) => {
      let ramp = 'screenOn';
      let tone = v === 0 ? SHADE : LIGHT;
      if (v === 0 && u >= W - 3) ramp = 'coral';
      if (v > 0 && u === 0) tone = BASE;
      for (const [row, r, start, len] of code) {
        if (v === row + 1 && u >= start && u < start + len) {
          ramp = r;
          tone = BASE;
        }
      }
      if (v === 11 && u >= 2 && u < 3) {
        ramp = 'navy';
        tone = SHADE;
      }
      L.set(x, y, ramp, tone);
    });
  }
  return outline(L, RAMPS);
}

export function drawChair() {
  const L = frame();
  const P = iso(STATION.ox, STATION.oy);
  const { a, b } = SEAT;
  // Five-star base with castors.
  const [cx, cy] = P(a, b, 2);
  const spokes = [
    [0, -7],
    [7, -2],
    [4, 6],
    [-5, 6],
    [-7, -2],
  ];
  for (const [da, db] of spokes) {
    const [x, y] = P(a + da, b + db, 1);
    line(L, Math.round(cx), Math.round(cy), Math.round(x), Math.round(y), 'metal', BASE);
    rect(L, Math.round(x) - 1, Math.round(y), 2, 2, 'bezel', SHADE);
  }
  // Gas lift.
  rect(L, Math.round(cx) - 1, Math.round(cy) - 5, 2, 5, 'metal', LIGHT);
  L.set(Math.round(cx), Math.round(cy) - 5, 'metal', SHADE);
  // Seat cushion.
  box(L, P, a - 5, a + 5, b - 5, b + 5, 5, 8, 'chair');
  // Backrest on the far-from-desk side (south-west, towards the viewer).
  box(L, P, a - 4, a + 4, b + 4, b + 5, 6, 9, 'metal', { rim: false });
  box(L, P, a - 5, a + 5, b + 4, b + 6, 9, 16, 'chair');
  // Round the backrest's top corners and add a seam.
  const [tlx, tly] = P(a - 5, b + 6, 16);
  L.clear(Math.round(tlx), Math.round(tly));
  const [trx, try_] = P(a + 5, b + 4, 16);
  L.clear(Math.round(trx) - 1, Math.round(try_));
  const [s0x, s0y] = P(a - 3, b + 6, 13);
  const [s1x, s1y] = P(a + 3, b + 6, 13);
  line(L, Math.round(s0x), Math.round(s0y), Math.round(s1x), Math.round(s1y) - 1, 'chair', LIGHT);
  return outline(L, RAMPS);
}

// ---------------------------------------------------------------------------
// Room pieces

/** Floor tile: wooden planks running along `a`. No outline, so tiles butt cleanly. */
export function drawFloor(ramp = 'floor', planks = true) {
  const L = new Layer(TILE_W, TILE_H);
  for (let y = 0; y < TILE_H; y++) for (let x = 0; x < TILE_W; x++) {
    const cx = x + 0.5 - TILE_W / 2;
    const cy = y + 0.5;
    if (Math.abs(cx) / (TILE_W / 2) + Math.abs(cy - TILE_H / 2) / (TILE_H / 2) > 1) continue;
    const a = cy + cx / 2; // 0..16
    const b = cy - cx / 2; // 0..16
    let tone = BASE;
    if (planks) {
      const plank = Math.floor(b / 4);
      if (plank % 2 === 1) tone = LIGHT;
      if (b - plank * 4 < 1) tone = SHADE;
      const joint = [3, 11, 7, 14][plank] ?? 0;
      if (a >= joint && a < joint + 1 && b - plank * 4 >= 1) tone = SHADE;
    } else {
      // Carpet: a quiet woven dot pattern.
      const ai = Math.floor(a);
      const bi = Math.floor(b);
      if ((ai + bi * 3) % 7 === 0) tone = LIGHT;
      else if ((ai * 5 + bi) % 11 === 0) tone = SHADE;
    }
    L.set(x, y, ramp, tone);
  }
  return L;
}

const WALL_H = 52;
const WALL_T = 4;

/**
 * One tile of the back-right wall (runs along `a`, faces south-west).
 * Frame: anchor (0, WALL_H + WALL_T/2) is the floor point at the tile's
 * north corner.
 */
export function drawWall(withWindow = false) {
  const w = 16 + WALL_T;
  const h = WALL_H + 8 + WALL_T / 2 + 1;
  const L = new Layer(w, h);
  const ox = 0;
  const oy = WALL_H + WALL_T / 2;
  const P = iso(ox, oy);
  planeB(L, P, 0, 0, 16, 0, WALL_H, 'wall', BASE);
  // A soft light band near the top and darker near the floor.
  planeB(L, P, 0, 0, 16, WALL_H - 6, WALL_H, 'wall', LIGHT);
  planeB(L, P, 0, 0, 16, 4, 8, 'wall', SHADE);
  planeB(L, P, 0, 0, 16, 0, 4, 'baseboard', BASE);
  {
    const [x0, y0] = P(0, 0, 4);
    for (let x = 0; x < 16; x++) L.set(x0 + x, Math.floor(y0 + x / 2) - 0, 'baseboard', LIGHT);
  }
  // Top cap.
  fillPoly(L, [P(0, -WALL_T, WALL_H), P(16, -WALL_T, WALL_H), P(16, 0, WALL_H), P(0, 0, WALL_H)], 'wall', HI);
  {
    const [x0, y0] = P(0, -WALL_T, WALL_H);
    for (let x = 0; x < 16; x++) L.set(x0 + x, Math.floor(y0 + x / 2) - 1, 'wall', DARK);
    const [x1, y1] = P(0, 0, WALL_H);
    for (let x = 0; x < 16; x++) L.set(x1 + x, Math.floor(y1 + x / 2), 'wall', SHADE);
  }
  if (withWindow) {
    const zb = 18;
    const zt = 44;
    // Frame, then glass inset by one pixel, then a mullion and a sill.
    planeB(L, P, 0, 1, 15, zb, zt, 'frame', BASE);
    planeB(L, P, 0, 2, 14, zb + 1, zt - 1, 'glass', BASE);
    const map = onPlaneB(P, 0, 2, zt - 1);
    for (let v = 0; v < zt - zb - 2; v++) for (let u = 0; u < 12; u++) {
      const [x, y] = map(u + 0.5, v + 0.5);
      const d = u + v * 0.6;
      let tone = v < 3 ? LIGHT : BASE;
      if ((d > 6 && d < 8) || (d > 10 && d < 11)) tone = HI;
      if (v > zt - zb - 6) tone = SHADE;
      L.set(x, y, 'glass', tone);
    }
    planeB(L, P, 0, 1, 15, zt - 13, zt - 12, 'frame', LIGHT);
    planeB(L, P, 0, 7.5, 8.5, zb + 1, zt - 1, 'frame', LIGHT);
    box(L, P, 0, 16, 0, 2, zb - 2, zb, 'frame', { rim: true });
  }
  return L;
}

/** Mirror a wall piece for the back-left wall (runs along `b`, faces south-east). */
export function mirrorWall(src) {
  const L = new Layer(src.w, src.h);
  for (let y = 0; y < src.h; y++) for (let x = 0; x < src.w; x++) {
    const r = src.ramp(x, y);
    if (!r) continue;
    L.set(src.w - 1 - x, y, r === 'wall' ? 'wallSide' : r, src.tone(x, y));
  }
  return L;
}

/** A leafy plant in a terracotta pot (hand-drawn template). */
export function drawPlant() {
  const T = [
    '.........ll.........',
    '......l.lLLl..l.....',
    '.....lLlLLLLllLl....',
    '....lLLLLDLLLLLLl...',
    '...lLLLDDLLLDLLLLl..',
    '..lLLLDDLLLLDDLLLl..',
    '..lLLDDLLLLLLDLLLLl.',
    '.lLLLDLLLLDLLLDDLLl.',
    '.lLLLLLLLDDLLLLDLLl.',
    '.lLLDLLLLDLLLLLLLDl.',
    'lLLDDLLLLDLLLDLLLDDl',
    'lLLDLLLDLLLLDDLLLLDl',
    '.lLLLLDDLLLLDLLLLDd.',
    '.dLLLDDLLLDLLLLLDDd.',
    '..dDLLLLLDDLLLDDDd..',
    '...ddDDLLDLLDDDdd...',
    '.....dddDDDDddd.....',
    '.....OOOOOOOOOO.....',
    '....OSSSSSSSSSSO....',
    '....OOOOOOOOOOOO....',
    '.....OOOOOOOOOo.....',
    '.....OOOOOOOOOo.....',
    '.....oOOOOOOOoo.....',
    '......oOOOOOoo......',
    '......oooooooo......',
  ];
  const map = {
    l: ['leaf', LIGHT],
    L: ['leaf', BASE],
    D: ['leafDeep', BASE],
    d: ['leafDeep', SHADE],
    O: ['pot', BASE],
    o: ['pot', SHADE],
    S: ['soil', BASE],
  };
  const L = new Layer(T[0].length + 2, T.length + 2);
  T.forEach((row, y) =>
    [...row].forEach((ch, x) => {
      const m = map[ch];
      if (m) L.set(x + 1, y + 1, m[0], m[1]);
    }),
  );
  // Leaf highlights on the upper-left of each clump; pot rim highlight.
  for (const [x, y] of [
    [6, 3],
    [7, 3],
    [5, 6],
    [4, 8],
    [10, 2],
    [11, 4],
    [3, 11],
    [8, 9],
    [14, 6],
    [15, 9],
    [9, 13],
  ]) {
    L.set(x + 1, y + 1, 'leaf', HI);
  }
  for (let x = 6; x <= 15; x++) L.set(x, 18, 'pot', LIGHT);
  for (let y = 20; y <= 23; y++) L.set(7, y, 'pot', LIGHT);
  return outline(L, RAMPS);
}

/** Bookshelf against a wall: footprint a 0..24, b 0..8, 40 high. */
export function drawShelf() {
  const P = iso(10, 46);
  const L = new Layer(38, 66);
  box(L, P, 0, 24, 0, 8, 0, 40, 'woodDark');
  const shelves = [
    [3, 13],
    [15, 25],
    [27, 37],
  ];
  const books = ['coral', 'navy', 'mustard', 'teal', 'sage', 'purple', 'paper', 'coral', 'navy'];
  let n = 0;
  for (const [z0, z1] of shelves) {
    // Recess (back of the compartment).
    fillPoly(L, [P(2, 8, z1), P(22, 8, z1), P(22, 8, z0), P(2, 8, z0)], 'woodDark', DARK);
    // Books: vertical strips of varying height along the shelf.
    let a = 2.5;
    while (a < 21) {
      const wdt = 1.5 + ((n * 7) % 3) * 0.5;
      const hgt = z1 - z0 - 1 - ((n * 5) % 4);
      const ramp = books[n % books.length];
      const lean = n % 7 === 4;
      if (n % 9 !== 6) {
        for (let k = 0; k < wdt * 2; k++) {
          const [x, y] = P(a + k / 2, 8, z0);
          for (let h = 0; h < hgt; h++) {
            const xx = Math.floor(x) + (lean && h > hgt / 2 ? 1 : 0);
            L.set(xx, Math.floor(y) - h - 1, ramp, k === 0 ? LIGHT : k >= wdt * 2 - 1 ? SHADE : BASE);
          }
          const [tx, ty] = P(a + k / 2, 8, z0 + hgt);
          L.set(Math.floor(tx), Math.floor(ty), ramp, HI);
        }
      }
      a += wdt + 0.5;
      n++;
    }
  }
  // A plant pot on top for life.
  box(L, P, 15, 20, 2, 7, 40, 44, 'pot');
  for (const [x, y] of [
    [27, 18],
    [28, 17],
    [29, 18],
    [27, 19],
    [26, 18],
    [29, 16],
    [30, 17],
  ]) {
    L.set(x, y, 'leaf', BASE);
  }
  L.set(28, 16, 'leaf', LIGHT);
  return outline(L, RAMPS);
}

/** Sofa facing south-west: footprint a 0..48, b 0..16. */
export const SOFA_FRAME = { w: 72, h: 52, ox: 18, oy: 24 };
export function drawSofa() {
  const P = iso(SOFA_FRAME.ox, SOFA_FRAME.oy);
  const L = new Layer(SOFA_FRAME.w, SOFA_FRAME.h);
  // Feet.
  for (const [a, b] of [
    [1, 14],
    [46, 14],
    [46, 1],
  ]) box(L, P, a, a + 1.5, b, b + 1.5, 0, 2, 'woodDark', { rim: false });
  box(L, P, 0, 48, 0, 16, 2, 7, 'sofa');
  box(L, P, 0, 48, 0, 5, 7, 20, 'sofa');
  box(L, P, 5, 24, 5, 15, 7, 10, 'sofa');
  box(L, P, 24, 43, 5, 15, 7, 10, 'sofa');
  box(L, P, 0, 5, 0, 16, 7, 14, 'sofa');
  box(L, P, 43, 48, 0, 16, 7, 14, 'sofa');
  // Throw pillow in the middle.
  box(L, P, 21, 27, 5, 7, 10, 17, 'cushion');
  return outline(L, RAMPS);
}
/** Floor points (sofa-frame pixels) where a resting character's anchor goes. */
export const SOFA_SEATS = [
  { a: 13, b: 11 },
  { a: 35, b: 11 },
].map(({ a, b }) => iso(SOFA_FRAME.ox, SOFA_FRAME.oy)(a, b, 0));

/** A low coffee table: footprint a 0..20, b 0..12. */
export function drawCoffeeTable() {
  const P = iso(14, 12);
  const L = new Layer(36, 30);
  for (const [a, b] of [
    [1, 10],
    [18, 10],
    [18, 1],
  ]) box(L, P, a, a + 1.5, b, b + 1.5, 0, 6, 'woodDark', { rim: false });
  box(L, P, 0, 20, 0, 12, 6, 8, 'wood');
  box(L, P, 3, 9, 3, 8, 8, 9, 'navy', { rim: false });
  const [mx, my] = P(14, 6, 8);
  rect(L, mx - 1, my - 3, 3, 3, 'mug', BASE);
  rect(L, mx - 1, my - 3, 1, 3, 'mug', LIGHT);
  rect(L, mx - 1, my - 4, 3, 1, 'coffee', BASE);
  return outline(L, RAMPS);
}

/** A lounge rug: footprint a 0..48, b 0..32, flat. No outline. */
export function drawRug() {
  const P = iso(32, 0);
  const L = new Layer(80, 41);
  fillPoly(L, [P(0, 0), P(48, 0), P(48, 32), P(0, 32)], 'rug', SHADE);
  fillPoly(L, [P(2, 2), P(46, 2), P(46, 30), P(2, 30)], 'rug', BASE);
  fillPoly(L, [P(5, 5), P(43, 5), P(43, 27), P(5, 27)], 'rug', LIGHT);
  fillPoly(L, [P(7, 7), P(41, 7), P(41, 25), P(7, 25)], 'rug', BASE);
  // A diamond motif in the middle.
  fillPoly(L, [P(24, 10), P(34, 16), P(24, 22), P(14, 16)], 'rug', HI);
  fillPoly(L, [P(24, 13), P(29, 16), P(24, 19), P(19, 16)], 'rug', BASE);
  return L;
}
