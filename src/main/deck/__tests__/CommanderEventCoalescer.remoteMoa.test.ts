// Cross-host A2A: another PC's Moa handed this Moa work (`a2a.received`). It is
// a wake-worthy kind in assist (value-filtered), and it obeys every gate a local
// receipt obeys: the auto-wake switch and a pending decision still block it.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CommanderEventCoalescer, type CoalescerInput } from '../CommanderEventCoalescer';
import type { WorkspaceAutonomy } from '../deckAutonomyStore';

const ASSIST: WorkspaceAutonomy = {
  mode: 'assist',
  wakePolicy: 'value-filtered',
  summarize: true,
  continueInstruction: false,
  approvalPress: false,
};

const settle = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

function mk(opts: { autoWake?: boolean; pendingDecision?: boolean; autonomy?: WorkspaceAutonomy } = {}): { c: CommanderEventCoalescer; prompts: string[] } {
  const prompts: string[] = [];
  const c = new CommanderEventCoalescer({
    runTurn: async (_ws, prompt) => {
      prompts.push(prompt);
      return { ok: true };
    },
    isBusy: () => false,
    getAutonomy: () => opts.autonomy ?? ASSIST,
    getLoop: () => null,
    isAutoWakeEnabled: () => opts.autoWake ?? true,
    hasPendingDecision: () => opts.pendingDecision ?? false,
    log: () => undefined,
    debounceMs: 1_000,
  });
  return { c, prompts };
}

const received = (seq: number, item: 'task' | 'reply' | 'state' = 'task'): CoalescerInput => ({
  workspaceId: 'ws-hq',
  ptyId: `a2a:rt-${seq}#${item}`,
  kind: 'a2a.received',
  source: 'a2a',
  agent: null,
  seq,
  ts: seq * 1000,
  a2a: { taskId: `rt-${seq}`, from: 'DESKTOP-WIN2/Moa', to: 'ws-hq', state: item === 'task' ? 'submitted' : 'working', remote: { host: 'DESKTOP-WIN2', item } },
});

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('CommanderEventCoalescer — a2a.received (remote Moa)', () => {
  it('wakes the brain in value-filtered with a pointer to query, the PC name, and the answer-it-yourself rule', async () => {
    const { c, prompts } = mk();
    c.push(received(1));
    vi.advanceTimersByTime(1_000);
    await settle();
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('kind=remote-moa');
    expect(prompts[0]).toContain('PC "DESKTOP-WIN2"');
    expect(prompts[0]).toContain('a2a_task_query({ task_id: "rt-1" })');
    expect(prompts[0]).toContain('send_message({ task_id: "rt-1", message })');
    expect(prompts[0]).toContain('Do not fan it out or hand it off');
  });

  it('a reply is surfaced as a reply', async () => {
    const { c, prompts } = mk();
    c.push(received(2, 'reply'));
    vi.advanceTimersByTime(1_000);
    await settle();
    expect(prompts[0]).toContain('REMOTE MOA REPLIED');
  });

  it('does not wake while a decision is pending', async () => {
    const { c, prompts } = mk({ pendingDecision: true });
    c.push(received(3));
    vi.advanceTimersByTime(1_000);
    await settle();
    expect(prompts).toHaveLength(0);
  });

  it('does not wake with the auto-wake switch off', async () => {
    const { c, prompts } = mk({ autoWake: false });
    c.push(received(4));
    vi.advanceTimersByTime(1_000);
    await settle();
    expect(prompts).toHaveLength(0);
  });

  it('wakePolicy none still swallows it (no bypass)', async () => {
    const { c, prompts } = mk({ autonomy: { ...ASSIST, mode: 'off', wakePolicy: 'none' } });
    c.push(received(5));
    vi.advanceTimersByTime(1_000);
    await settle();
    expect(prompts).toHaveLength(0);
  });
});
