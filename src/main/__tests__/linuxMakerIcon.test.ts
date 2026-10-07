import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Source-level wiring invariant for the Linux installer icon.
//
// GNOME (dock, taskbar, alt-tab) takes an installed app's icon from the
// `.desktop` file's `Icon=wmux`, which resolves to /usr/share/pixmaps/wmux.png.
// electron-installer-debian / -redhat fill that file from their `icon` option
// and, when it is absent, fall back to their bundled resources/icon.png — the
// stock Electron logo. So a deb/rpm built without `icon` shows the Electron icon
// even though the window itself carries the wmux icon.
//
// forge.config.ts cannot be imported in a unit test (makers are platform-gated
// and pull in native tooling), so the wiring is pinned over its source text —
// the same pattern as makerDebAsarCache.test.ts.

describe('Linux makers ship the wmux icon, not the Electron default', () => {
  const forgeConfigPath = path.join(__dirname, '..', '..', '..', 'forge.config.ts');
  const src = fs.readFileSync(forgeConfigPath, 'utf-8');

  function makerOptions(maker: string): string {
    const start = src.indexOf(`new ${maker}(`);
    expect(start).toBeGreaterThan(-1);
    const end = src.indexOf('}),', start);
    return src.slice(start, end);
  }

  it.each(['MakerDeb', 'MakerRpm', 'MakerAppImage'])('%s sets icon to assets/icon.png', (maker) => {
    expect(makerOptions(maker)).toMatch(/icon:\s*'\.\/assets\/icon\.png'/);
  });

  it('the icon asset the makers point at exists', () => {
    expect(fs.existsSync(path.join(__dirname, '..', '..', '..', 'assets', 'icon.png'))).toBe(true);
  });
});
