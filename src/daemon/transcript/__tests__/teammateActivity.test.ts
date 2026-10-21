import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  FRESH_MS,
  PENDING_TOOL_CAP_MS,
  TeammateScanner,
  classifyTeammateTail,
  subagentsDirFor,
  teammateWorking,
} from '../teammateActivity';

const T0 = Date.parse('2026-10-20T07:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();

const toolUse = (id: string, at = T0, stop: string | null = null) => JSON.stringify({
  type: 'assistant', isSidechain: true, timestamp: iso(at),
  message: { role: 'assistant', stop_reason: stop, content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'npm test' } }] },
});
const toolResult = (id: string, at = T0) => JSON.stringify({
  type: 'user', isSidechain: true, timestamp: iso(at),
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] },
});
const reply = (stop: string | null, at = T0) => JSON.stringify({
  type: 'assistant', isSidechain: true, timestamp: iso(at),
  message: { role: 'assistant', stop_reason: stop, content: [{ type: 'text', text: 'done' }] },
});
const prompt = (at = T0) => JSON.stringify({
  type: 'user', isSidechain: true, timestamp: iso(at), message: { role: 'user', content: 'next task' },
});
const noise = [
  JSON.stringify({ type: 'api-request-blob', message: { role: 'user', content: [{ type: 'tool_use', id: 'copy', name: 'Bash' }] } }),
  JSON.stringify({ type: 'api-request', timestamp: iso(T0 + 1000) }),
  JSON.stringify({ type: 'attachment', timestamp: iso(T0 + 1000), attachment: { type: 'x' } }),
];

describe('classifyTeammateTail', () => {
  it('reads a tool call without a result as pending', () => {
    expect(classifyTeammateTail([prompt(), toolUse('a')])).toEqual({ state: 'pending_tool', at: T0 });
  });

  it('keeps a parallel call pending after a sibling result', () => {
    expect(classifyTeammateTail([toolUse('a'), toolUse('b'), toolResult('a')])?.state).toBe('pending_tool');
  });

  it('reads an answered call as busy (the model is on its next step)', () => {
    expect(classifyTeammateTail([toolUse('a'), toolResult('a')])?.state).toBe('busy');
  });

  it('reads a streamed partial reply (no stop_reason yet) as busy', () => {
    expect(classifyTeammateTail([toolUse('a'), toolResult('a'), reply(null)])?.state).toBe('busy');
  });

  it('reads a reply that ended its turn as replied', () => {
    expect(classifyTeammateTail([toolUse('a'), toolResult('a'), reply('end_turn')])?.state).toBe('replied');
  });

  it('reads a new message after a finished reply as busy', () => {
    expect(classifyTeammateTail([reply('end_turn'), prompt()])?.state).toBe('busy');
  });

  it('skips bookkeeping records', () => {
    expect(classifyTeammateTail([toolUse('a'), toolResult('a'), reply('end_turn'), ...noise])?.state).toBe('replied');
    expect(classifyTeammateTail([toolUse('a'), ...noise])).toEqual({ state: 'pending_tool', at: T0 });
    expect(classifyTeammateTail(noise)).toBeNull();
  });

  it('skips meta user records and unparsable lines', () => {
    const meta = JSON.stringify({ type: 'user', isMeta: true, timestamp: iso(T0), message: { role: 'user', content: 'caveat' } });
    expect(classifyTeammateTail([reply('end_turn'), meta, '{"type":"user",'])?.state).toBe('replied');
  });
});

describe('teammateWorking', () => {
  it('never counts a finished reply', () => {
    expect(teammateWorking({ state: 'replied', at: T0 }, T0, T0)).toBe(false);
  });

  it('holds a pending call up to the cap, measured from the newer of record and file', () => {
    const tail = { state: 'pending_tool' as const, at: T0 };
    expect(teammateWorking(tail, T0, T0 + 7 * 60_000)).toBe(true);
    expect(teammateWorking(tail, T0, T0 + PENDING_TOOL_CAP_MS)).toBe(true);
    expect(teammateWorking(tail, T0, T0 + PENDING_TOOL_CAP_MS + 1)).toBe(false);
    // The file still grows (an attachment): the cap runs from the growth.
    expect(teammateWorking(tail, T0 + 20 * 60_000, T0 + PENDING_TOOL_CAP_MS + 1)).toBe(true);
  });

  it('holds anything else only for the freshness window', () => {
    const tail = { state: 'busy' as const, at: T0 };
    expect(teammateWorking(tail, T0, T0 + FRESH_MS)).toBe(true);
    expect(teammateWorking(tail, T0, T0 + FRESH_MS + 1)).toBe(false);
    // No meaningful record in the tail: the file's own age decides.
    expect(teammateWorking(null, T0, T0 + 60_000)).toBe(true);
    expect(teammateWorking(null, T0, T0 + FRESH_MS + 1)).toBe(false);
  });
});

describe('TeammateScanner', () => {
  let dir: string;
  let sub: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tx-teammates-'));
    sub = subagentsDirFor(path.join(dir, 'session.jsonl'));
    fs.mkdirSync(sub, { recursive: true });
  });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  function agent(name: string, taskKind: string | undefined, lines: string[], mtimeMs = Date.now()): string {
    const file = path.join(sub, `agent-${name}.jsonl`);
    fs.writeFileSync(file, lines.map((l) => `${l}\n`).join(''));
    fs.writeFileSync(path.join(sub, `agent-${name}.meta.json`), JSON.stringify({ agentType: name, ...(taskKind ? { taskKind } : {}) }));
    fs.utimesSync(file, mtimeMs / 1000, mtimeMs / 1000);
    return file;
  }

  it('derives the folder from the transcript path', () => {
    expect(subagentsDirFor(path.join('a', 'b', 'sid.jsonl'))).toBe(path.join('a', 'b', 'sid', 'subagents'));
  });

  it('finds a working teammate and ignores ordinary subagents', () => {
    const now = Date.now();
    agent('plain', undefined, [toolUse('x', now)]);
    const scanner = new TeammateScanner(sub);
    expect(scanner.anyWorking(now)).toBe(false);
    agent('mate', 'in_process_teammate', [toolUse('a', now)]);
    expect(scanner.anyWorking(now)).toBe(true);
  });

  it('a teammate added within the folder mtime tick of the last listing is still found', () => {
    const now = Date.now();
    agent('plain', undefined, [toolUse('x', now)]);
    const scanner = new TeammateScanner(sub);
    // A coarse-tick filesystem leaves the folder mtime where the listing saw it.
    const tick = new Date(Math.floor(now / 1000) * 1000);
    fs.utimesSync(sub, tick, tick);
    expect(scanner.anyWorking(now)).toBe(false);
    agent('mate', 'in_process_teammate', [toolUse('a', now)]);
    fs.utimesSync(sub, tick, tick);
    expect(scanner.anyWorking(now)).toBe(true);
  });

  it('an unchanged folder is listed once more after it settles, then served from cache', () => {
    const now = Date.now();
    agent('mate', 'in_process_teammate', [toolUse('a', now)]);
    let clock = 1_000;
    const mono = vi.spyOn(performance, 'now').mockImplementation(() => clock);
    const scanner = new TeammateScanner(sub);
    const listing = vi.spyOn(fs, 'readdirSync');
    try {
      scanner.anyWorking(now);
      scanner.anyWorking(now);
      clock += 2_001;
      scanner.anyWorking(now);
      const settled = listing.mock.calls.length;
      scanner.anyWorking(now);
      expect(settled).toBe(3);
      expect(listing.mock.calls.length).toBe(3);
    } finally {
      listing.mockRestore();
      mono.mockRestore();
    }
  });

  it('a meta file caught mid-write is asked again, not taken as no teammate', () => {
    const now = Date.now();
    const file = agent('mate', 'in_process_teammate', [toolUse('a', now)]);
    const meta = file.replace(/\.jsonl$/, '.meta.json');
    const whole = fs.readFileSync(meta, 'utf8');
    fs.writeFileSync(meta, whole.slice(0, 10));
    const scanner = new TeammateScanner(sub);
    expect(scanner.anyWorking(now)).toBe(false);
    fs.writeFileSync(meta, whole);
    expect(scanner.anyWorking(now)).toBe(true);
  });

  it('a folder listing that failed once is listed again on the next scan', () => {
    const now = Date.now();
    agent('mate', 'in_process_teammate', [toolUse('a', now)]);
    const scanner = new TeammateScanner(sub);
    const spy = vi.spyOn(fs, 'readdirSync').mockImplementationOnce(() => { throw new Error('EBUSY'); });
    try {
      expect(scanner.anyWorking(now)).toBe(false);
      expect(scanner.anyWorking(now)).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it('a call still running stays pending after a sibling\'s large result pushed it out of the window', () => {
    const now = Date.now();
    const file = agent('mate', 'in_process_teammate', [toolUse('long', now), toolUse('quick', now), toolUse('small', now)]);
    const scanner = new TeammateScanner(sub);
    expect(scanner.anyWorking(now)).toBe(true);
    const big = JSON.stringify({
      type: 'user', isSidechain: true, timestamp: iso(now),
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'quick', content: 'q'.repeat(300 * 1024) }] },
    });
    fs.appendFileSync(file, `${big}\n${toolResult('small', now)}\n`);
    fs.utimesSync(file, now / 1000, now / 1000);
    // Past FRESH_MS, inside PENDING_TOOL_CAP_MS: 'long' has no result yet.
    expect(scanner.anyWorking(now + FRESH_MS + 60_000)).toBe(true);
  });

  it('a call whose result fell outside every window is forgotten at the turn\'s end', () => {
    const now = Date.now();
    const pending = new Set<string>(['lost']);
    expect(classifyTeammateTail([reply('end_turn', now)], pending)).toEqual({ state: 'replied', at: now });
    expect(pending.size).toBe(0);
    pending.add('lost');
    expect(classifyTeammateTail([prompt(now)], pending)).toEqual({ state: 'busy', at: now });
    expect(pending.size).toBe(0);
  });

  it('a replaced transcript does not inherit the old one\'s pending calls', () => {
    const now = Date.now();
    const file = agent('mate', 'in_process_teammate', [toolUse('old', now)]);
    const scanner = new TeammateScanner(sub);
    expect(scanner.anyWorking(now)).toBe(true);
    const fresh = `${file}.new`;
    fs.writeFileSync(fresh, `${prompt(now)}\n${toolResult('other', now)}\n`);
    fs.renameSync(fresh, file);
    fs.utimesSync(file, now / 1000, now / 1000);
    // Past FRESH_MS, inside PENDING_TOOL_CAP_MS: nothing of the new file is pending.
    expect(scanner.anyWorking(now + FRESH_MS + 60_000)).toBe(false);
  });

  it('bookkeeping lines that push the conversation out of the window keep the last verdict', () => {
    const now = Date.now();
    const file = agent('mate', 'in_process_teammate', [prompt(now), toolResult('a', now), reply('end_turn', now)]);
    const scanner = new TeammateScanner(sub);
    expect(scanner.anyWorking(now)).toBe(false);
    const filler = JSON.stringify({ type: 'api-request', timestamp: iso(now), body: 'b'.repeat(300 * 1024) });
    fs.appendFileSync(file, `${filler}\n${JSON.stringify({ type: 'attachment', timestamp: iso(now), attachment: { type: 'x' } })}\n`);
    fs.utimesSync(file, (now + 1000) / 1000, (now + 1000) / 1000);
    expect(scanner.anyWorking(now + 1000)).toBe(false);
  });

  it('a turn end written before a burst of bookkeeping is still read', () => {
    const now = Date.now();
    const file = agent('mate', 'in_process_teammate', [prompt(now), toolUse('a', now)]);
    const scanner = new TeammateScanner(sub);
    expect(scanner.anyWorking(now)).toBe(true);
    const filler = JSON.stringify({ type: 'api-request', timestamp: iso(now), body: 'b'.repeat(300 * 1024) });
    fs.appendFileSync(file, `${toolResult('a', now)}\n${reply('end_turn', now)}\n${filler}\n`);
    fs.utimesSync(file, (now + 1000) / 1000, (now + 1000) / 1000);
    expect(scanner.anyWorking(now + 1000)).toBe(false);
  });

  it('an API error the teammate stopped on is a turn end', () => {
    const now = Date.now();
    const pending = new Set<string>(['a']);
    const apiError = JSON.stringify({
      type: 'assistant', isSidechain: true, isApiErrorMessage: true, timestamp: iso(now),
      message: { role: 'assistant', content: [{ type: 'text', text: 'API Error: 529 overloaded' }] },
    });
    expect(classifyTeammateTail([toolUse('a', now), apiError], pending)).toEqual({ state: 'replied', at: now });
    expect(pending.size).toBe(0);
  });

  it('a first read that lands in a record still being written reads that record once it ends', () => {
    const now = Date.now();
    const file = agent('mate', 'in_process_teammate', [prompt(now), toolUse('a', now), toolResult('a', now)]);
    const long = JSON.stringify({
      type: 'assistant', isSidechain: true, timestamp: iso(now),
      message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'r'.repeat(400 * 1024) }] },
    });
    fs.appendFileSync(file, long.slice(0, 300 * 1024));
    const scanner = new TeammateScanner(sub);
    scanner.anyWorking(now);
    fs.appendFileSync(file, `${long.slice(300 * 1024)}\n`);
    fs.utimesSync(file, (now + 1000) / 1000, (now + 1000) / 1000);
    expect(scanner.anyWorking(now + 1000)).toBe(false);
  });

  it('a final reply too big for the tail window still reads as replied', () => {
    const now = Date.now();
    const long = JSON.stringify({
      type: 'assistant', isSidechain: true, timestamp: iso(now),
      message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'r'.repeat(200 * 1024) }] },
    });
    agent('mate', 'in_process_teammate', [prompt(now), long]);
    expect(new TeammateScanner(sub).anyWorking(now)).toBe(false);
  });

  it('stops counting once the teammate replies, and re-reads only a changed file', () => {
    const now = Date.now();
    const file = agent('mate', 'in_process_teammate', [toolUse('a', now)]);
    const scanner = new TeammateScanner(sub);
    expect(scanner.anyWorking(now)).toBe(true);
    fs.appendFileSync(file, `${toolResult('a', now)}\n${reply('end_turn', now)}\n`);
    fs.utimesSync(file, (now + 1000) / 1000, (now + 1000) / 1000);
    expect(scanner.anyWorking(now + 1000)).toBe(false);
  });

  it('does not count a stale teammate (stat only) or a missing folder', () => {
    const old = Date.now() - PENDING_TOOL_CAP_MS - 60_000;
    agent('mate', 'in_process_teammate', [toolUse('a', old)], old);
    expect(new TeammateScanner(sub).anyWorking(Date.now())).toBe(false);
    expect(new TeammateScanner(path.join(dir, 'nope', 'subagents')).anyWorking(Date.now())).toBe(false);
  });

  it('asks again for a meta file written after the transcript', () => {
    const now = Date.now();
    const file = path.join(sub, 'agent-late.jsonl');
    fs.writeFileSync(file, `${toolUse('a', now)}\n`);
    const scanner = new TeammateScanner(sub);
    expect(scanner.anyWorking(now)).toBe(false);
    fs.writeFileSync(path.join(sub, 'agent-late.meta.json'), JSON.stringify({ taskKind: 'in_process_teammate' }));
    expect(scanner.anyWorking(now)).toBe(true);
  });

  it('list reports name from file, color from meta, working state and activity', () => {
    const now = Date.now();
    agent('zed-9f3', 'in_process_teammate', [reply('end_turn', now)]);
    const file = agent('researcher-ab12', 'in_process_teammate', [toolUse('a', now)]);
    fs.writeFileSync(file.replace(/.jsonl$/, '.meta.json'), JSON.stringify({ taskKind: 'in_process_teammate', color: 'blue' }));
    const list = new TeammateScanner(sub).list(now);
    expect(list.map((t) => t.name)).toEqual(['researcher', 'zed']);
    expect(list[0]).toMatchObject({ name: 'researcher', color: 'blue', working: true, activity: '$ npm test' });
    expect(list[0].at).toBeGreaterThan(0);
    expect(list[1]).toMatchObject({ name: 'zed', working: false });
    expect(list[1].color).toBeUndefined();
    expect(list[1].activity).toBeUndefined();
  });

  it('list keeps only the newest of two teammates sharing a name', () => {
    const now = Date.now();
    const older = agent('twin-1', 'in_process_teammate', [reply('end_turn', now - 60_000)], now - 60_000);
    const newer = agent('twin-2', 'in_process_teammate', [toolUse('a', now)], now);
    expect(older).not.toBe(newer);
    const list = new TeammateScanner(sub).list(now);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ name: 'twin', working: true });
  });

  it('list prefers the meta name when present', () => {
    const now = Date.now();
    const file = agent('mate-1', 'in_process_teammate', [toolUse('a', now)]);
    fs.writeFileSync(file.replace(/.jsonl$/, '.meta.json'), JSON.stringify({ taskKind: 'in_process_teammate', name: 'Ada' }));
    expect(new TeammateScanner(sub).list(now).map((t) => t.name)).toEqual(['Ada']);
  });

  it('list omits teammates older than 30 minutes', () => {
    const old = Date.now() - PENDING_TOOL_CAP_MS - 60_000;
    agent('stale-1', 'in_process_teammate', [reply('end_turn', old)], old);
    const fresh = Date.now() - 20 * 60_000;
    agent('idle-1', 'in_process_teammate', [reply('end_turn', fresh)], fresh);
    expect(new TeammateScanner(sub).list(Date.now()).map((t) => t.name)).toEqual(['idle']);
  });

  it('list ignores files whose meta is not in_process_teammate', () => {
    const now = Date.now();
    agent('plain-1', undefined, [toolUse('x', now)]);
    agent('other-1', 'something_else', [toolUse('y', now)]);
    expect(new TeammateScanner(sub).list(now)).toEqual([]);
  });
});
