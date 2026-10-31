import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { alignResumeCwd } from '../alignResumeCwd';

describe('alignResumeCwd', () => {
  it('gives a binding the pane spelling when both name one folder through a symlink', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-align-'));
    const real = path.join(root, 'real');
    const link = path.join(root, 'link');
    fs.mkdirSync(real);
    fs.symlinkSync(real, link, 'dir');
    const b = { agent: 'claude', sessionId: 'x', cwd: real };
    expect(alignResumeCwd(b, link).cwd).toBe(link);
    expect(alignResumeCwd(b, path.join(root)).cwd).toBe(real); // a different folder stays a mismatch
    expect(alignResumeCwd(b, path.join(root, 'gone'))).toBe(b); // unresolvable: unchanged
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('leaves a folder-less or already-matching binding alone', () => {
    const b = { cwd: undefined };
    expect(alignResumeCwd(b, '/x')).toBe(b);
    const same = { cwd: '/x/' };
    expect(alignResumeCwd(same, '/x', () => { throw new Error('not called'); })).toBe(same);
  });
});
