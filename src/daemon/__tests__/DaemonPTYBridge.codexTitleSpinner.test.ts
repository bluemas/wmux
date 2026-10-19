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
// Codex exits and zsh draws its prompt again (OSC 133 D, then A).
const BACK_TO_SHELL = '\x1b[?1049l\x1b[?2004l\x1b]133;D;0\x07\x1b]133;A\x07% \x1b[?2004h';
// What zsh prints on Enter: bracketed paste off, OSC 133 C.
const LAUNCH_OUTPUT = '\x1b[?2004l\x1b]133;C\x07';
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

  it('a braille title after the Codex process ended reports nothing on a shell without OSC 133', () => {
    bridge.noteAgentProcessAlive();
    bridge.noteAgentProcessEnded(); // the process tracker's death edge
    vi.advanceTimersByTime(6_000);
    spin(8, 100);
    vi.advanceTimersByTime(30_000);
    spin(8, 100);
    expect(active).toHaveLength(0);
    expect(bridge.isTurnOpen()).toBe(false);
  });

  it('a banner before an OSC 133 mark in the same chunk does not outlive the mark', () => {
    feed(CODEX_MODES + BANNER + BACK_TO_SHELL);
    vi.advanceTimersByTime(6_000);
    spin(8, 100);
    expect(active).toHaveLength(0);

    // The other order: the shell launches Codex, and its banner follows in the same chunk.
    feed(LAUNCH_OUTPUT + CODEX_MODES + BANNER);
    vi.advanceTimersByTime(6_000);
    spin(3, 100);
    expect(active).toHaveLength(1);
  });

  it('a late death edge of the old process leaves a relaunched Codex its pane', () => {
    bridge.noteAgentProcessAlive(); // the first Codex process, seen alive
    feed(BACK_TO_SHELL);
    feed(LAUNCH_OUTPUT);
    feed(CODEX_MODES + BANNER); // the relaunch, before the old death poll
    feed(`${' '.repeat(600)}\r\n`); // its first paint pushes the banner out of any tail
    vi.advanceTimersByTime(6_000);
    spin(3, 100);
    expect(active).toHaveLength(1);
    bridge.noteAgentProcessEnded(); // the old process's death edge, late, mid-turn
    expect(bridge.isTurnOpen()).toBe(true);
    spin(160, 1_000);
    expect(active.length).toBeGreaterThan(1);
    expect(bridge.getAgentStatus()).toBe('running');
    expect(bridge.isTurnOpen()).toBe(true);
  });

  it('a braille title after Codex has exited reports nothing, until Codex boots again', () => {
    feed(BACK_TO_SHELL);
    vi.advanceTimersByTime(6_000);
    // The detector still names Codex, but the shell owns the pane.
    expect(bridge.getLastAgent()).toBe('Codex CLI');
    feed(title('⠋ shell label'));
    vi.advanceTimersByTime(100);
    feed(title('⠙ shell label'));
    vi.advanceTimersByTime(30_000);
    feed(title('⠹ shell label'));
    expect(active).toHaveLength(0);

    feed(LAUNCH_OUTPUT);
    feed(CODEX_MODES + BANNER);
    vi.advanceTimersByTime(6_000);
    active = [];
    spin(2, 100);
    expect(active).toHaveLength(1);
  });
});
