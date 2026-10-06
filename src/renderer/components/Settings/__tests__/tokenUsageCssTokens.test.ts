import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

// An undefined `var(--x)` silently falls back (borders to currentColor, errors to the parent colour).
// Every token the Token usage tab uses must be defined by the renderer's stylesheets.

const ROOT = join(__dirname, '..', '..', '..');
const TAB_DIR = join(__dirname, '..', 'tabs', 'TokenUsageTab');

function files(dir: string, ext: RegExp): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (name === '__tests__') return [];
    return statSync(full).isDirectory() ? files(full, ext) : ext.test(name) ? [full] : [];
  });
}

describe('Token usage tab CSS tokens', () => {
  it('uses only tokens the renderer defines', () => {
    const css = files(join(ROOT, 'styles'), /\.css$/).map((f) => readFileSync(f, 'utf8')).join('\n');
    const defined = new Set([...css.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
    const sources = [...files(TAB_DIR, /\.tsx?$/), join(TAB_DIR, '..', 'TokenUsageTab.tsx')];
    const undefinedTokens = sources.flatMap((f) =>
      [...readFileSync(f, 'utf8').matchAll(/var\((--[a-z0-9-]+)\)/g)]
        .map((m) => m[1])
        .filter((v) => !defined.has(v))
        .map((v) => `${f.slice(ROOT.length)}: ${v}`));
    expect(undefinedTokens).toEqual([]);
  });
});
