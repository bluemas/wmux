// Claude Code fires no Stop hook for an interrupted turn. The bridge reports
// the agent's own "Interrupted" row so main can settle the pane, but that row
// stays in the transcript: one printed again by a resize redraw belongs to an
// old turn and must not settle the current one.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { IPty } from 'node-pty';
import { DaemonPTYBridge } from '../DaemonPTYBridge';
import { PromptEventLog } from '../PromptEventLog';
import { RingBuffer } from '../RingBuffer';
import { RESIZE_REDRAW_GUARD_MS } from '../../main/notification/idleSuppression';

const ROW = '  ⎿  Interrupted · What should Claude do instead?\r\n';

function makeFakePty(): { pty: IPty; feed: (data: string) => void } {
  let dataHandler: ((data: string) => void) | null = null;
  const pty = {
    onData: (cb: (data: string) => void) => {
      dataHandler = cb;
      return { dispose: () => { dataHandler = null; } };
    },
    onExit: () => ({ dispose: () => {} }),
  } as unknown as IPty;
  return { pty, feed: (data: string) => dataHandler?.(data) };
}

describe('DaemonPTYBridge — interrupted-turn row', () => {
  let bridge: DaemonPTYBridge;
  let feed: (data: string) => void;
  let interrupted: Array<{ sessionId: string; agent: string }>;

  beforeEach(() => {
    vi.useFakeTimers();
    bridge = new DaemonPTYBridge();
    const fake = makeFakePty();
    feed = fake.feed;
    interrupted = [];
    bridge.on('turnInterrupted', (e: { sessionId: string; agent: string }) => interrupted.push(e));
    bridge.setupDataForwarding(fake.pty, new RingBuffer(65536), 'sess-1', new PromptEventLog());
    feed('Claude Code v2.1.300\r\n  bypass permissions on\r\n'); // opens the Claude gate
  });

  afterEach(() => {
    bridge.cleanup();
    vi.useRealTimers();
  });

  it('reports the row the agent prints after an interrupt', () => {
    vi.advanceTimersByTime(RESIZE_REDRAW_GUARD_MS);
    feed(ROW);
    expect(interrupted).toEqual([{ sessionId: 'sess-1', agent: 'Claude Code' }]);
  });

  it('ignores the row inside a resize redraw', () => {
    bridge.noteResize();
    feed(ROW);
    expect(interrupted).toEqual([]);
  });
});
