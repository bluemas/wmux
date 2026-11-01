// fs.list / fs.stat / fs.readText against a real temp folder: the answers, the
// path checks they share with the app's file tree, and the size and binary
// limits of readText.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  ipcMain: { removeHandler: vi.fn(), handle: vi.fn() },
  BrowserWindow: { getFocusedWindow: vi.fn(), getAllWindows: vi.fn(() => []) },
}));

import { handleFsList, handleFsReadText, handleFsStat, validatePathParam } from '../fs.rpc';

let root: string;
let home: string;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-fsrpc-')));
  home = path.join(root, 'home');
  fs.mkdirSync(path.join(home, '.ssh'), { recursive: true });
  fs.writeFileSync(path.join(home, '.ssh', 'id_ed25519'), 'secret');
  fs.mkdirSync(path.join(root, 'work', 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'work', 'README.md'), '# hello\n');
  vi.spyOn(os, 'homedir').mockReturnValue(home);
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('validatePathParam', () => {
  it('takes absolute paths only', () => {
    expect(validatePathParam(root)).toBe(root);
    expect(validatePathParam('relative/dir')).toBeNull();
    expect(validatePathParam('')).toBeNull();
    expect(validatePathParam(42)).toBeNull();
    expect(validatePathParam(`${root}\0x`)).toBeNull();
    expect(validatePathParam(`/${'a'.repeat(5000)}`)).toBeNull();
  });
});

describe('fs.list', () => {
  it('lists a folder with kinds, sizes and its parent', async () => {
    const res = await handleFsList({ path: path.join(root, 'work') });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.path).toBe(path.join(root, 'work'));
    expect(res.parent).toBe(root);
    expect(res.truncated).toBe(false);
    const byName = Object.fromEntries(res.entries.map((e) => [e.name, e]));
    expect(byName.src.kind).toBe('dir');
    expect(byName['README.md'].mode).toBe(fs.lstatSync(path.join(root, 'work', 'README.md')).mode & 0o777);
    expect(byName.src.size).toBe(0);
    expect(byName['README.md']).toMatchObject({ kind: 'file', size: 8 });
  });

  it('shows where a symlink leads, and a broken one as null', async () => {
    if (process.platform === 'win32') return; // symlinks need elevation there
    fs.symlinkSync(path.join(root, 'work', 'src'), path.join(root, 'work', 'link-dir'));
    fs.symlinkSync(path.join(root, 'nowhere'), path.join(root, 'work', 'dangling'));
    const res = await handleFsList({ path: path.join(root, 'work') });
    if (!res.ok) throw new Error(res.reason);
    const byName = Object.fromEntries(res.entries.map((e) => [e.name, e]));
    expect(byName['link-dir']).toMatchObject({ kind: 'symlink', target: 'dir' });
    expect(byName.dangling).toMatchObject({ kind: 'symlink', target: null });
  });

  it('refuses a credential folder as unavailable', async () => {
    expect(await handleFsList({ path: path.join(home, '.ssh') })).toEqual({ ok: false, reason: 'unavailable' });
  });

  it('refuses a symlink into a credential folder', async () => {
    if (process.platform === 'win32') return;
    fs.symlinkSync(path.join(home, '.ssh'), path.join(root, 'work', 'keys'));
    expect(await handleFsList({ path: path.join(root, 'work', 'keys') })).toEqual({ ok: false, reason: 'unavailable' });
  });

  it('answers a missing folder the same as a blocked one', async () => {
    expect(await handleFsList({ path: path.join(root, 'missing') })).toEqual({ ok: false, reason: 'unavailable' });
  });

  it('says when the path is a file', async () => {
    expect(await handleFsList({ path: path.join(root, 'work', 'README.md') })).toEqual({ ok: false, reason: 'not-a-directory' });
  });

  it('refuses a relative path', async () => {
    expect(await handleFsList({ path: 'work' })).toEqual({ ok: false, reason: 'invalid' });
  });

  it('gives a filesystem root no parent', async () => {
    const top = path.parse(root).root;
    const res = await handleFsList({ path: top });
    if (!res.ok) throw new Error(res.reason);
    expect(res.parent).toBeNull();
  });
});

describe('fs.stat', () => {
  it('answers one entry with the canonical path', async () => {
    const res = await handleFsStat({ path: path.join(root, 'work', 'src', '..', 'README.md') });
    expect(res).toMatchObject({ ok: true, path: path.join(root, 'work', 'README.md'), entry: { name: 'README.md', kind: 'file' } });
  });

  it('refuses a credential file', async () => {
    expect(await handleFsStat({ path: path.join(home, '.ssh', 'id_ed25519') })).toEqual({ ok: false, reason: 'unavailable' });
  });
});

describe('fs.readText', () => {
  it('reads a text file', async () => {
    const res = await handleFsReadText({ path: path.join(root, 'work', 'README.md') });
    expect(res).toEqual({ ok: true, path: path.join(root, 'work', 'README.md'), size: 8, text: '# hello\n', truncated: false });
  });

  it('stops at maxBytes and says it truncated', async () => {
    const file = path.join(root, 'work', 'long.txt');
    fs.writeFileSync(file, 'x'.repeat(1000));
    const res = await handleFsReadText({ path: file, maxBytes: 10 });
    expect(res).toMatchObject({ ok: true, size: 1000, text: 'x'.repeat(10), truncated: true });
  });

  it('caps maxBytes at 1 MB', async () => {
    const file = path.join(root, 'work', 'big.txt');
    fs.writeFileSync(file, 'y'.repeat(1024 * 1024 + 10));
    const res = await handleFsReadText({ path: file, maxBytes: 10 * 1024 * 1024 });
    if (!res.ok) throw new Error(res.reason);
    expect(res.text.length).toBe(1024 * 1024);
    expect(res.truncated).toBe(true);
  });

  it('refuses a binary file', async () => {
    const file = path.join(root, 'work', 'blob.bin');
    fs.writeFileSync(file, Buffer.from([0x89, 0x50, 0x00, 0x47]));
    expect(await handleFsReadText({ path: file })).toEqual({ ok: false, reason: 'binary' });
  });

  it('refuses a folder', async () => {
    expect(await handleFsReadText({ path: path.join(root, 'work') })).toEqual({ ok: false, reason: 'is-a-directory' });
  });

  it('refuses a malformed maxBytes', async () => {
    for (const maxBytes of [0, -1, 1.5, '10']) {
      expect(await handleFsReadText({ path: path.join(root, 'work', 'README.md'), maxBytes })).toEqual({ ok: false, reason: 'invalid' });
    }
  });

  it('refuses a credential file', async () => {
    expect(await handleFsReadText({ path: path.join(home, '.ssh', 'id_ed25519') })).toEqual({ ok: false, reason: 'unavailable' });
  });
});
