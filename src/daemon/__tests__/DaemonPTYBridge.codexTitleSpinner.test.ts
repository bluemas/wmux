// A hookless Codex turn that reasons for minutes barely changes the screen and
// runs no tool, so neither the byte-rate heuristic nor the transcript watcher
// reports it. Its braille title spinner does: a frame arms the activity cycle,
// the next one reports `active`, and a frame every 30 s reports it again while
// it keeps spinning, so the renderer's two-minute activity stamp never runs
// out mid-turn.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { IPty } from 'node-pty';
import { DaemonPTYBridge } from '../DaemonPTYBridge';
import { RingBuffer } from '../RingBuffer';
import { PromptEventLog } from '../PromptEventLog';

const BANNER = '\x1b[9;1H│ >_ OpenAI Codex (v0.149.1)            │\r\n';
// Codex turns bracketed paste back on before it paints its banner.
const CODEX_MODES = '\x1b[?2004h\x1b[?1049h';
const title = (t: string) => `\x1b]0;${t}\x07`;

function makeFakePty(): { pty: IPty; feed: (data: string) => void } {
  let dataHandler: ((data: string) => void) | null = null;
  const pty = {
    onData: (cb: (data: string) => void) => {
      dataHandler = cb;
      return { dispose: () => { dataHandler = null; } };
    },
    onExit: () => ({ dispose: () => undefined }),
  } as unknown as IPty;
  return { pty, feed: (data: string) => dataHandler?.(data) };
}

describe('DaemonPTYBridge — a Codex title spinner reports running', () => {
  let bridge: DaemonPTYBridge;
  let feed: (data: string) => void;
  let active: Array<{ likelyRepaint?: boolean }>;
  let idle: unknown[];
  const frames = ['⠋', '⠙', '⠹', '⠸'];
  /** `n` spinner frames, `gapMs` apart. */
  const spin = (n: number, gapMs: number) => {
    for (let i = 0; i < n; i++) {
      feed(title(`${frames[i % 4]} AAA quality pass | Heartbound`));
      vi.advanceTimersByTime(gapMs);
    }
  };

  beforeEach(() => {
    vi.useFakeTimers();
    bridge = new DaemonPTYBridge();
    const fake = makeFakePty();
    feed = fake.feed;
    bridge.setupDataForwarding(fake.pty, new RingBuffer(65536), 'sess-1', new PromptEventLog());
    bridge.noteAgentProcess({ slug: 'codex', alive: true }); // the tracker picked Codex
    feed(CODEX_MODES + BANNER);
    feed('ready\r\n'); // spends the cycle the banner armed
    vi.advanceTimersByTime(6_000); // past any boot burst and its idle
    active = [];
    idle = [];
    bridge.on('active', (e: { likelyRepaint?: boolean }) => active.push(e));
    bridge.on('idle', (e) => idle.push(e));
  });

  afterEach(() => {
    bridge.cleanup();
    vi.useRealTimers();
  });

  it('reports running from the spinner, then every 30 s while it spins', () => {
    spin(10, 100);
    expect(active).toHaveLength(1);
    expect(active[0].likelyRepaint).toBe(false);
    expect(bridge.getAgentStatus()).toBe('running');
    expect(bridge.isTurnOpen()).toBe(true);

    spin(31, 1_000);
    expect(active).toHaveLength(2);
  });

  it('a title without the spinner reports nothing, and the next spinner reports once the pane went idle', () => {
    spin(2, 100);
    expect(active).toHaveLength(1);
    feed(title('AAA quality pass | Heartbound'));
    vi.advanceTimersByTime(1_000);
    feed(title('Heartbound'));
    vi.advanceTimersByTime(6_000);
    expect(active).toHaveLength(1);
    expect(idle).toHaveLength(1);
    spin(2, 100);
    expect(active).toHaveLength(2);
  });

  it('reopens a turn a detector settled mid-turn, and the event, status and turn agree', () => {
    spin(2, 100);
    const turnId = bridge.getTurn(bridge.getAgentStatus()).id;
    bridge.noteAgentStatus('waiting'); // the footer matched mid-turn
    expect(bridge.isTurnOpen()).toBe(false);
    active = [];

    vi.advanceTimersByTime(6_100); // the settle cooldown
    spin(2, 100);
    expect(active).toHaveLength(1);
    expect(bridge.getAgentStatus()).toBe('running');
    expect(bridge.isTurnOpen()).toBe(true);
    expect(bridge.getTurn(bridge.getAgentStatus())).toMatchObject({ id: turnId, state: 'running' });

    // The frame drops when the turn ends: the turn closes and the settle is back.
    feed(title('AAA quality pass | Heartbound'));
    expect(bridge.isTurnOpen()).toBe(false);
    expect(bridge.getAgentStatus()).toBe('waiting');
    expect(idle).toHaveLength(1);
  });

  it('a pane whose hooks report is left to them: the last frames after Stop report nothing', () => {
    bridge.noteAgentStatus('running', true);
    active = [];
    bridge.noteAgentStatus('complete', true); // the Stop hook
    spin(2, 100);
    vi.advanceTimersByTime(7_000);
    spin(2, 100);
    expect(active).toHaveLength(0);
  });

  it('a detector settle holds the title back for the settle cooldown', () => {
    bridge.noteAgentStatus('waiting');
    spin(2, 100);
    vi.advanceTimersByTime(3_000);
    spin(2, 100);
    expect(active).toHaveLength(0);
    vi.advanceTimersByTime(3_000);
    spin(2, 100);
    expect(active).toHaveLength(1);
  });

  it('a banner and a spinner report nothing until the process tracker names the agent', () => {
    const fresh = new DaemonPTYBridge();
    const fake = makeFakePty();
    fresh.setupDataForwarding(fake.pty, new RingBuffer(65536), 'sess-2', new PromptEventLog());
    const seen: unknown[] = [];
    fresh.on('active', (e) => seen.push(e));
    fake.feed(CODEX_MODES + BANNER);
    fake.feed('ready\r\n');
    vi.advanceTimersByTime(6_000);
    seen.length = 0;
    for (let i = 0; i < 8; i++) {
      fake.feed(title(`${frames[i % 4]} AAA quality pass | Heartbound`));
      vi.advanceTimersByTime(100);
    }
    expect(seen).toHaveLength(0);
    fresh.cleanup();
  });

  it('the tracked process dying ends the title path: frames after it report nothing', () => {
    spin(2, 100);
    expect(active).toHaveLength(1);
    expect(bridge.getAgentStatus()).toBe('running');
    expect(bridge.isTurnOpen()).toBe(true);

    // The daemon's death edge: noteAgentEnded, then the process state.
    bridge.noteAgentEnded();
    bridge.noteAgentProcess({ slug: 'codex', alive: false });
    vi.advanceTimersByTime(6_000);
    active = [];
    spin(8, 100);
    vi.advanceTimersByTime(30_000);
    spin(8, 100);
    expect(active).toHaveLength(0);
    expect(bridge.isTurnOpen()).toBe(false);
  });

  it('another tracked agent ignores the braille title; a late launch edge does not stop a Codex turn', () => {
    bridge.noteAgentProcess({ slug: 'claude', alive: true });
    spin(8, 100);
    expect(active).toHaveLength(0);

    // Codex takes the pane and a prompt starts a turn.
    bridge.noteAgentProcess({ slug: 'codex', alive: true });
    bridge.noteInput('fix the tests\r');
    spin(3, 100);
    expect(active).toHaveLength(1);

    // The tracker's launch edge for Codex arrives late, after the turn began:
    // the daemon ends the previous agent's episode, then records Codex.
    bridge.noteAgentEnded();
    bridge.noteAgentProcess({ slug: 'codex', alive: true });
    spin(2, 100);
    expect(bridge.isTurnOpen()).toBe(true);
    expect(bridge.getAgentStatus()).toBe('running');
    spin(31, 1_000);
    expect(active).toHaveLength(2);
  });

  it('a death edge after prompt-only marks (OSC 133 A/B) still ends the episode', () => {
    bridge.noteAgentStatus('running', true);
    expect(bridge.isTurnOpen()).toBe(true);
    feed('\x1b]133;A\x07\x1b]133;B\x07');
    bridge.noteAgentEnded();
    bridge.noteAgentProcess({ slug: 'codex', alive: false });
    expect(bridge.isTurnOpen()).toBe(false);
    expect(bridge.hasHookReports()).toBe(false);
  });
});
