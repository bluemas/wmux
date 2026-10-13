import { afterEach, describe, expect, it } from 'vitest';
import { LOCALE_OPTIONS, setLocale, t } from '../index';

// Settings › General › Startup is shown on Windows and macOS, and the toggle
// registers a login item on both (src/main/autostart.ts). The copy used to say
// "Windows" in every locale that had it, so macOS users were told the toggle
// was about Windows. Checked through t() so locales that fall back to English
// are covered as well.
const KEYS = ['settings.startOnLogin', 'settings.startOnLoginDesc'] as const;

describe('Startup toggle copy is platform-neutral', () => {
  afterEach(() => setLocale('en'));

  it.each(LOCALE_OPTIONS.map((o) => o.value))('%s does not name an operating system', (locale) => {
    setLocale(locale);
    for (const key of KEYS) {
      const text = t(key);
      expect(text).not.toBe(key);
      expect(text).not.toMatch(/windows|macos|mac os/i);
    }
  });
});
