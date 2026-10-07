import fs from 'node:fs';

/**
 * Shared load helpers for the cross-host A2A stores (links, exposure, peers,
 * remote hosts). Writes go through `atomicWriteJSONSync` in each store; this
 * module only covers the READ side, which deliberately does NOT use
 * `atomicReadJSONSync`: that helper falls back to the `.bak` generation when
 * the primary is unreadable, and a stale generation is exactly what these
 * stores must never resurrect (a revoked peer, a cleared exposure, a revoked
 * link would come back to life).
 */

export type StoreLog = (level: 'info' | 'warn' | 'error', msg: string) => void;

export type StoreFileRead =
  | { kind: 'missing' }
  | { kind: 'parsed'; value: unknown }
  | { kind: 'corrupt'; detail: string };

/** Read and parse a store file. Never throws. */
export function readStoreFile(filePath: string): StoreFileRead {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' };
    return { kind: 'corrupt', detail: `unreadable: ${errMsg(err)}` };
  }
  if (!raw.trim()) return { kind: 'corrupt', detail: 'empty file' };
  try {
    const value: unknown = JSON.parse(raw, (key, v: unknown) => {
      // Prototype pollution guard (mirrors config.ts / DeviceStore).
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') return undefined;
      return v;
    });
    return { kind: 'parsed', value };
  } catch (err) {
    return { kind: 'corrupt', detail: `malformed JSON: ${errMsg(err)}` };
  }
}

/**
 * Move a corrupt store file aside as `<file>.corrupt-<ts>` so the next write
 * neither overwrites the evidence nor rotates it into `.bak`. Rename (not
 * copy) keeps the original inode and its owner-only permissions. Best-effort:
 * returns the new path, or null when the move failed.
 */
export function preserveCorrupt(filePath: string, now: () => number, log: StoreLog): string | null {
  const target = `${filePath}.corrupt-${now()}`;
  try {
    fs.renameSync(filePath, target);
    return target;
  } catch (err) {
    log('error', `[a2a-remote] could not preserve corrupt ${filePath}: ${errMsg(err)}`);
    return null;
  }
}

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

export function isIsoString(v: unknown): v is string {
  return typeof v === 'string' && !Number.isNaN(Date.parse(v));
}

export function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
