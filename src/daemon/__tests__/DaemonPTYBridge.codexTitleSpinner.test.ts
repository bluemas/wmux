// A hookless Codex turn that reasons for minutes barely changes the screen and
// runs no tool, so neither the byte-rate heuristic nor the transcript watcher
// reports it. Its braille title spinner does: the bridge reports `active` on
// the spinner's first frame and again every 30 s while it keeps spinning, so
// the renderer's two-minute activity stamp never runs out mid-turn.
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
    bridge.on('active', (e: { likelyRepaint?: boolean }) => active.push(e));
  });

  afterEach(() => {
    bridge.cleanup();
    vi.useRealTimers();
  });

  it('reports running on the first spinner frame, then every 30 s while it spins', () => {
    const frames = ['⠋', '⠙', '⠹', '⠸'];
    for (let i = 0; i < 10; i++) {
      feed(title(`${frames[i % 4]} AAA quality pass | Heartbound`));
      vi.advanceTimersByTime(100);
    }
    expect(active).toHaveLength(1);
    expect(active[0].likelyRepaint).toBe(false);

    for (let s = 0; s < 31; s++) {
      feed(title(`${frames[s % 4]} AAA quality pass | Heartbound`));
      vi.advanceTimersByTime(1_000);
    }
    expect(active).toHaveLength(2);
  });

  it('a title without the spinner reports nothing, and the next spinner reports again at once', () => {
    feed(title('⠋ AAA quality pass | Heartbound'));
    expect(active).toHaveLength(1);
    feed(title('AAA quality pass | Heartbound'));
    vi.advanceTimersByTime(1_000);
    feed(title('Heartbound'));
    expect(active).toHaveLength(1);
    feed(title('⠙ next turn | Heartbound'));
    expect(active).toHaveLength(2);
  });

  it('a pane whose hooks report is left to them: the last frames after Stop report nothing', () => {
    bridge.noteAgentStatus('running', true);
    active = [];
    bridge.noteAgentStatus('complete', true); // the Stop hook
    feed(title('⠋ AAA quality pass | Heartbound'));
    vi.advanceTimersByTime(7_000);
    feed(title('⠙ AAA quality pass | Heartbound'));
    expect(active).toHaveLength(0);
  });

  it('a detector settle holds the title back for the settle cooldown', () => {
    bridge.noteAgentStatus('waiting');
    feed(title('⠋ AAA quality pass | Heartbound'));
    vi.advanceTimersByTime(3_000);
    feed(title('⠙ AAA quality pass | Heartbound'));
    expect(active).toHaveLength(0);
    vi.advanceTimersByTime(3_100);
    feed(title('⠹ AAA quality pass | Heartbound'));
    expect(active).toHaveLength(1);
  });

  it('a braille title after Codex has exited reports nothing, until Codex boots again', () => {
    feed(BACK_TO_SHELL);
    vi.advanceTimersByTime(6_000);
    // The detector still names Codex, but the shell owns the pane.
    expect(bridge.getLastAgent()).toBe('Codex CLI');
    feed(title('⠋ shell label'));
    vi.advanceTimersByTime(30_000);
    feed(title('⠙ shell label'));
    expect(active).toHaveLength(0);

    feed(LAUNCH_OUTPUT);
    feed(CODEX_MODES + BANNER);
    vi.advanceTimersByTime(6_000);
    active = [];
    feed(title('⠋ AAA quality pass | Heartbound'));
    expect(active).toHaveLength(1);
  });
});
