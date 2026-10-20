#!/usr/bin/env node
// Writes a review contact sheet for the Office art: every furniture sprite,
// every look in every pose at 2x and 3x, and a sample room composed only from
// the exported sprites and anchors (the same contract the Office page uses).
//
//   node scripts/office-art/preview-office-art.mjs <out-dir>
//
// Output: <out-dir>/office-contact-sheet.html (images inlined) and
// <out-dir>/office-sample-room.png (the sample room at 2x).
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Layer, compose, crop, encodePng, rect, scaleRgba, toRgba } from './raster.mjs';
import { RAMPS } from './palette.mjs';
import { SOFA_SEATS, STATION, SEAT, iso } from './furniture.mjs';
import { POSES } from './characters.mjs';
import { buildSheets } from './build-office-art.mjs';

const outDir = resolve(process.argv[2] ?? '.');
mkdirSync(outDir, { recursive: true });

const built = buildSheets();
const F = Object.fromEntries(built.furniture.map((f) => [f.key, f]));
const charFrame = (lookId, pose) => {
  const r = built.frames[lookId][pose];
  return crop(built.cSheet, r.x, r.y, r.w, r.h);
};
const charAnchor = iso(STATION.ox, STATION.oy)(SEAT.a, SEAT.b, 0);

const png = (layer, scale = 1) =>
  encodePng(layer.w * scale, layer.h * scale, scaleRgba(layer.w, layer.h, toRgba(layer, RAMPS), scale));
const dataUri = (layer) => `data:image/png;base64,${png(layer).toString('base64')}`;

// ---------------------------------------------------------------------------
// Sample room: 12 x 10 tiles, walls on the two far sides.
const COLS = 12;
const ROWS = 12;
const room = new Layer(COLS * 16 + ROWS * 16 + 24, (COLS + ROWS) * 8 + 90);
RAMPS.backdrop = Array(5).fill('#eef1f4');
rect(room, 0, 0, room.w, room.h, 'backdrop', 2);
const ox = ROWS * 16 + 8;
const oy = 70;
const P = iso(ox, oy);

/** Draw a sprite so its anchor pixel lands on world point (a, b). */
const place = (layer, anchor, a, b) => {
  const [x, y] = P(a, b, 0);
  compose(room, layer, Math.round(x - anchor.x), Math.round(y - anchor.y));
};
const placeF = (key, a, b) => place(F[key].layer, F[key].anchor, a, b);

const lounge = (i, j) => j >= 7;
for (let j = 0; j < ROWS; j++) for (let i = 0; i < COLS; i++) {
  placeF(lounge(i, j) || i < 1 || j < 0 ? 'floor' : i <= 10 && j <= 6 ? 'carpet' : 'floor', i * 16, j * 16);
}
// Walls: windows along the right wall, one along the left.
for (let i = COLS - 1; i >= 0; i--) placeF(i % 3 === 1 || i % 3 === 2 ? 'window' : 'wall', i * 16, 0);
for (let j = ROWS - 1; j >= 0; j--) placeF(j === 3 || j === 4 ? 'windowLeft' : 'wallLeft', 0, j * 16);
placeF('rug', 100, 146);

// Depth-sorted objects: [depth, draw]
const items = [];
const add = (a, b, draw) => items.push([a + b, draw]);
const station = (a, b, lookId, pose, on = true) =>
  add(a + 16, b + 26, () => {
    const [x, y] = P(a, b, 0);
    const at = (l) => compose(room, l, Math.round(x - STATION.ox), Math.round(y - STATION.oy));
    at(F.desk.layer);
    at((on ? F.monitorOn : F.monitorOff).layer);
    if (lookId) at(charFrame(lookId, pose));
    else at(F.chair.layer);
  });
station(32, 18, 'spiky', 'type1');
station(88, 18, 'bob', 'type2');
station(144, 18, 'curly', 'raiseHand');
station(32, 66, 'long', 'sit');
station(88, 66, 'sidepart', 'type2');
station(144, 66, null, null, false);
add(176, 4, () => placeF('shelf', 152, 0));
add(6, 6, () => placeF('plant', 6, 6));
add(186, 10, () => placeF('plant', 182, 6));
add(6, 182, () => placeF('plant', 6, 182));
// Lounge: sofa against nothing in the corner, two resting looks, a table.
const sofaA = 104;
const sofaB = 130;
add(sofaA + 20, sofaB + 4, () => placeF('sofa', sofaA, sofaB));
const sofaAt = P(sofaA, sofaB, 0);
SOFA_SEATS.forEach(([sx, sy], k) =>
  add(sofaA + 20, sofaB + 6 + k, () => {
    const x = sofaAt[0] - F.sofa.anchor.x + sx;
    const y = sofaAt[1] - F.sofa.anchor.y + sy;
    compose(room, charFrame(k === 0 ? 'ponytail' : 'beanie', k === 0 ? 'rest1' : 'rest2'), x - charAnchor[0], y - charAnchor[1]);
  }),
);
add(sofaA + 14, sofaB + 30, () => placeF('coffeeTable', sofaA + 6, sofaB + 24));
add(186, 182, () => placeF('plant', 186, 182));
// Someone walking to the lounge.
add(40, 132, () => {
  const [x, y] = P(40, 132, 0);
  compose(room, charFrame('bun', 'walk1'), Math.round(x - charAnchor[0]), Math.round(y - charAnchor[1]));
});
items.sort((p, q) => p[0] - q[0]).forEach(([, draw]) => draw());

writeFileSync(join(outDir, 'office-sample-room.png'), png(room, 2));

// ---------------------------------------------------------------------------
// Contact sheet.
const img = (layer, scale, title = '') =>
  `<img src="${dataUri(layer)}" width="${layer.w * scale}" height="${layer.h * scale}" title="${title}" alt="${title}">`;
const furnitureCards = built.furniture
  .map(
    (f) => `<figure>${img(f.layer, 2, f.key)}${img(f.layer, 3, f.key)}<figcaption>${f.key} Â· ${f.layer.w}Ã—${f.layer.h} Â· anchor ${f.anchor.x},${f.anchor.y}</figcaption></figure>`,
  )
  .join('\n');
const charRows = (scale) =>
  built.looks
    .map(
      (l) =>
        `<tr><th>${l.id}</th>${POSES.map((p) => `<td>${img(charFrame(l.id, p), scale, `${l.id} ${p}`)}</td>`).join('')}</tr>`,
    )
    .join('\n');
const bossAtDesk = compose(
  compose(new Layer(built.boss.w, built.boss.h), F.bossDesk.layer),
  crop(built.cSheet, built.boss.x, built.boss.y, built.boss.w, built.boss.h),
);
const head = `<tr><th></th>${POSES.map((p) => `<th>${p}</th>`).join('')}</tr>`;
const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Office Art Contact Sheet</title>
<style>
:root { --bg: #f4f1ea; --fg: #2a2733; --muted: #6b6676; --card: #fffdf8; --line: #e2dccf; }
@media (prefers-color-scheme: dark) { :root { --bg: #1d1c22; --fg: #ecebf0; --muted: #a29fae; --card: #26252d; --line: #393744; } }
body { margin: 0; padding: 24px 16px 64px; background: var(--bg); color: var(--fg); font: 14px/1.5 system-ui, sans-serif; }
main { max-width: 1600px; margin: 0 auto; }
h1 { font-size: 22px; margin: 0 0 4px; } h2 { font-size: 16px; margin: 32px 0 12px; }
p { color: var(--muted); margin: 0 0 12px; }
img { image-rendering: pixelated; display: inline-block; vertical-align: bottom; background: #efe6d6; margin: 2px; }
.grid { display: flex; flex-wrap: wrap; gap: 12px; }
figure { margin: 0; padding: 8px; background: var(--card); border: 1px solid var(--line); border-radius: 8px; }
figcaption { color: var(--muted); font-size: 12px; margin-top: 4px; }
.scroll { overflow-x: auto; background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 8px; }
table { border-collapse: collapse; } th { font-weight: 600; font-size: 12px; color: var(--muted); padding: 4px 8px; text-align: left; }
td { padding: 2px; }
.room img { background: none; max-width: none; }
</style></head><body><main>
<h1>Office pixel art</h1>
<p>Original art made by <code>scripts/office-art/build-office-art.mjs</code>. Isometric 2:1, tile ${built.furniture.find((f) => f.key === 'floor').layer.w}Ã—16, one palette, light from the top-left. Every image is shown with nearest-neighbour scaling.</p>
<h2>Sample room (2x), composed from the exported sprites and anchors</h2>
<div class="scroll room">${img(room, 2, 'sample room')}</div>
<h2>Characters at 2x (${built.looks.length} looks; the last, <code>${built.looks.at(-1).id}</code>, is the generic look)</h2>
<div class="scroll"><table>${head}${charRows(2)}</table></div>
<h2>Characters at 3x</h2>
<div class="scroll"><table>${head}${charRows(3)}</table></div>
<h2>The boss at the boss desk (2x and 3x)</h2>
<div class="grid"><figure>${img(bossAtDesk, 2, 'boss')}${img(bossAtDesk, 3, 'boss')}<figcaption>bossDesk + boss ¡¤ one frame, ${bossAtDesk.w}¡¿${bossAtDesk.h}</figcaption></figure></div>
<h2>Furniture and room pieces (2x and 3x)</h2>
<p>Desk, monitors and chair share the 64Ã—56 station frame with the characters: draw desk, monitor, then the character (seated frames already include the chair) at one origin.</p>
<div class="grid">${furnitureCards}</div>
</main></body></html>
`;
writeFileSync(join(outDir, 'office-contact-sheet.html'), html);
console.log(`wrote ${join(outDir, 'office-contact-sheet.html')} and office-sample-room.png`);
