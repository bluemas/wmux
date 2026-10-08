// The board's narrow layouts. Container queries do not run in jsdom, so these
// read the rules: stacked columns (two or one per row) must grow to their
// cards, and a card's name must not be pulled onto its status line by the
// list's narrow-panel placement (@container max-width: 580px).
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const css = readFileSync(path.join(__dirname, '..', '..', '..', 'styles', 'ui.css'), 'utf8');

function rule(selector: string, from = 0): string {
  const at = css.indexOf(`${selector} {`, from);
  expect(at, selector).toBeGreaterThanOrEqual(0);
  return css.slice(at, css.indexOf('}', at));
}

describe('Fleet board CSS', () => {
  it('stacked columns size their rows to the cards, so the board scrolls instead of overlapping them', () => {
    const query = css.indexOf('@container (max-width: 760px)');
    expect(query).toBeGreaterThanOrEqual(0);
    const stacked = rule('.wmux-board .wmux-fleet-board', query);
    expect(stacked).toContain('grid-auto-rows: max-content');
    expect(stacked).toContain('overflow-y: auto');
  });

  it('the name and now-doing lines keep their own rows under the list narrow-panel rule', () => {
    expect(rule('.wmux-fleet-board .wmux-fleet-identity, .wmux-fleet-board .wmux-fleet-progress')).toContain('grid-row: auto');
  });

  it('a long status word clips inside its column instead of running under the verb', () => {
    const status = rule('.wmux-fleet-board .wmux-fleet-status');
    expect(status).toContain('min-width: 0');
    expect(status).toContain('overflow: hidden');
    expect(rule('.wmux-fleet-board .wmux-fleet-status > span:last-child')).toContain('text-overflow: ellipsis');
  });
});
