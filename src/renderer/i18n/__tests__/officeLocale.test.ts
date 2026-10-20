import { describe, expect, it } from 'vitest';
import { en } from '../locales/en';
import { ko } from '../locales/ko';
import { pl } from '../locales/pl';
import { zh } from '../locales/zh';

const placeholders = (s: string) => [...s.matchAll(/\{([a-zA-Z0-9_]+)\}/g)].map((m) => m[1]).sort();
const officeKeys = (Object.keys(en) as (keyof typeof en)[]).filter((k) => k.startsWith('office.'));

describe('office locale coverage', () => {
  it('has the rail page title', () => {
    expect(officeKeys).toContain('office.title');
  });

  for (const [name, messages] of Object.entries({ ko, pl, zh })) {
    it(`${name} owns every office string with the same placeholders`, () => {
      const table = messages as Record<string, string>;
      for (const key of officeKeys) {
        expect(table[key], key).toBeTruthy();
        expect(placeholders(table[key]), key).toEqual(placeholders(en[key]));
      }
    });
  }
});
