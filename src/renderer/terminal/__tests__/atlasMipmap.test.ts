import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';

/**
 * I5 — atlas textures never depend on mipmap completeness.
 *
 * Upstream uploads each atlas page with texImage2D + generateMipmap and never
 * sets TEXTURE_MIN_FILTER, so sampling uses the GL default
 * NEAREST_MIPMAP_LINEAR. On drivers where generateMipmap fails (ANGLE's GL
 * backend on Mesa/AMD logs `allocateMipmapLevelsForGeneration ... Unexpected
 * driver error`), the page is left mipmap-incomplete, and the GLES spec makes
 * an incomplete texture sample as opaque black (0,0,0,1): every glyph on that
 * page renders as a solid black box. Glyphs are drawn 1:1, so only level 0 is
 * ever needed; a non-mipmap filter removes the dependency entirely.
 *
 * Pinned against every file the patch touches, including the bundles that
 * actually run in the app.
 */
const FILES = [
  'node_modules/@xterm/addon-webgl/src/GlyphRenderer.ts',
  'node_modules/@xterm/addon-webgl/lib/addon-webgl.js',
  'node_modules/@xterm/addon-webgl/lib/addon-webgl.mjs',
];

describe('addon-webgl atlas textures (I5)', () => {
  it.each(FILES)('%s never generates mipmaps', (file) => {
    expect(readFileSync(file, 'utf8')).not.toContain('generateMipmap');
  });

  it.each(FILES)('%s sets non-mipmap MIN and MAG filters', (file) => {
    const src = readFileSync(file, 'utf8');
    expect(src).toMatch(/TEXTURE_MIN_FILTER,\s*\w+\.LINEAR\)/);
    expect(src).toMatch(/TEXTURE_MAG_FILTER,\s*\w+\.LINEAR\)/);
  });
});
