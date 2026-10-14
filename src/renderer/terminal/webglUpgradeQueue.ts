// Deferred WebGL upgrades for terminals that reveal without a context.
//
// Building a WebGL renderer is synchronous GPU setup: context creation plus a
// shader compile, measured at 0.45–0.55 s per terminal on Windows
// (2026-10-14). A terminal that reveals without a context — a cold-parked
// workspace remounting its panes, or the first reveal after start — used to
// pay that inside the switch's input task, so the whole window froze for
// 0.5 s per pane before the new workspace painted, whether the switch came
// from a click or a shortcut.
//
// Such a terminal now paints at once with xterm's DOM renderer and takes its
// context later through this queue: one terminal per idle period, after a
// short settle delay, so a burst of reveals never stacks into one long
// freeze and input stays responsive between them. The swap can shift glyphs
// by up to a pixel, once, which is the price of not freezing.

export interface WebglUpgradeQueueOptions {
  /** Wait after the most recent enqueue before the first job runs. */
  settleMs?: number;
  /** Schedules `cb` when the main thread is idle (injectable for tests). */
  idle?: (cb: () => void) => void;
  /** Delayed scheduler (injectable for tests). */
  delay?: (cb: () => void, ms: number) => unknown;
  /** Cancels a `delay` handle. */
  cancelDelay?: (handle: unknown) => void;
}

/** Settle delay before the first upgrade: past the reveal's own paint and the
 *  daemon snapshot that usually lands within it. */
export const WEBGL_UPGRADE_SETTLE_MS = 600;

function defaultIdle(cb: () => void): void {
  if (typeof requestIdleCallback === 'function') {
    requestIdleCallback(() => cb(), { timeout: 1000 });
  } else {
    setTimeout(cb, 0);
  }
}

export class WebglUpgradeQueue {
  private jobs: Array<{ run: () => void }> = [];
  private settleHandle: unknown = null;
  private draining = false;
  private readonly settleMs: number;
  private readonly idle: (cb: () => void) => void;
  private readonly delay: (cb: () => void, ms: number) => unknown;
  private readonly cancelDelay: (handle: unknown) => void;

  constructor(opts: WebglUpgradeQueueOptions = {}) {
    this.settleMs = opts.settleMs ?? WEBGL_UPGRADE_SETTLE_MS;
    this.idle = opts.idle ?? defaultIdle;
    this.delay = opts.delay ?? ((cb, ms) => setTimeout(cb, ms));
    this.cancelDelay = opts.cancelDelay ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  /** Queue `run`. Returns a cancel function; cancelling a job that already
   *  ran or was cancelled is a no-op. */
  enqueue(run: () => void): () => void {
    const job = { run };
    this.jobs.push(job);
    // Every enqueue restarts the settle wait, so a switch that reveals
    // several panes (or several quick switches) upgrades only once the
    // reveals stop.
    if (!this.draining) {
      if (this.settleHandle !== null) this.cancelDelay(this.settleHandle);
      this.settleHandle = this.delay(() => {
        this.settleHandle = null;
        this.drain();
      }, this.settleMs);
    }
    return () => {
      const i = this.jobs.indexOf(job);
      if (i >= 0) this.jobs.splice(i, 1);
    };
  }

  /** Jobs still waiting (diagnostics/tests). */
  get pending(): number {
    return this.jobs.length;
  }

  private drain(): void {
    if (this.jobs.length === 0) {
      this.draining = false;
      return;
    }
    this.draining = true;
    this.idle(() => {
      const job = this.jobs.shift();
      if (job) {
        try {
          job.run();
        } catch {
          /* an upgrade failure must not stall the queue */
        }
      }
      this.drain();
    });
  }
}

/** Process-wide queue — every terminal shares it. */
export const webglUpgradeQueue = new WebglUpgradeQueue();
