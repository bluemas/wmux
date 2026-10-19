import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CHARACTERS,
  CHARACTER_POSES,
  FURNITURE,
  GENERIC_CHARACTER,
  OFFICE_EXTRAS,
  OFFICE_TILE,
  type SpriteRef,
} from '..';

// Vite resolves `import url from './x.png'` to a root-relative path in tests
// (`/src/renderer/assets/office/x.png`); read the file it names.
function pngSize(src: string): { w: number; h: number } {
  const rel = src.split('?')[0].replace(/^\/+/, '');
  const buf = readFileSync(join(process.cwd(), rel));
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  expect([...buf.subarray(0, 8)]).toEqual(signature);
  expect(buf.toString('latin1', 12, 16)).toBe('IHDR');
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

function allSprites(): Array<[string, SpriteRef]> {
  const out: Array<[string, SpriteRef]> = [];
  for (const [k, s] of Object.entries(FURNITURE)) out.push([`furniture.${k}`, s]);
  for (const [k, s] of Object.entries(OFFICE_EXTRAS)) out.push([`extras.${k}`, s]);
  for (const c of [...CHARACTERS, GENERIC_CHARACTER]) {
    for (const [pose, s] of Object.entries(c.frames)) out.push([`${c.id}.${pose}`, s]);
  }
  return out;
}

describe('office pixel-art assets', () => {
  it('uses a 2:1 isometric tile', () => {
    expect(OFFICE_TILE.w).toBe(OFFICE_TILE.h * 2);
  });

  it('every SpriteRef points at an imported sheet and lies inside it', () => {
    const sizes = new Map<string, { w: number; h: number }>();
    for (const [name, s] of allSprites()) {
      expect(s.src, name).toMatch(/\.png(\?.*)?$/);
      if (!sizes.has(s.src)) sizes.set(s.src, pngSize(s.src));
      const sheet = sizes.get(s.src)!;
      expect(Number.isInteger(s.x) && Number.isInteger(s.y), name).toBe(true);
      expect(s.w > 0 && s.h > 0, name).toBe(true);
      expect(s.x >= 0 && s.y >= 0, name).toBe(true);
      expect(s.x + s.w <= sheet.w && s.y + s.h <= sheet.h, name).toBe(true);
    }
  });

  it('there are at least 8 character looks with every pose', () => {
    expect(CHARACTERS.length).toBeGreaterThanOrEqual(8);
    const ids = new Set([...CHARACTERS, GENERIC_CHARACTER].map((c) => c.id));
    expect(ids.size).toBe(CHARACTERS.length + 1);
    for (const c of [...CHARACTERS, GENERIC_CHARACTER]) {
      expect(Object.keys(c.frames).sort()).toEqual([...CHARACTER_POSES].sort());
      // One frame size for every pose, so a pose change never moves the anchor.
      const { w, h } = c.frames.sit;
      for (const s of Object.values(c.frames)) expect([s.w, s.h]).toEqual([w, h]);
    }
  });

  it('no two looks or poses share a frame rectangle', () => {
    const seen = new Set<string>();
    for (const c of [...CHARACTERS, GENERIC_CHARACTER]) {
      for (const s of Object.values(c.frames)) {
        const key = `${s.src}:${s.x},${s.y}`;
        expect(seen.has(key), key).toBe(false);
        seen.add(key);
      }
    }
  });
});
