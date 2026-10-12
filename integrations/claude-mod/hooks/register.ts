// wmux × Claude Code mod: the turn end classic hooks never fire.
//
// The classic bridge (integrations/claude, or `wmux setup-hooks`) stays the
// signal path for every turn edge it covers. One it cannot: an interrupted
// turn (Esc / Ctrl+C) fires no Stop (measured on Claude Code 2.1.296), so a
// hook-governed pane stays "running" until the next prompt. The engine's own
// `turn.complete` does fire there, with `reason: 'aborted'`, so this mod
// replays the missing Stop through the SAME bridge script: one wire format
// and one daemon path. `wmux_turn_reason` tells the daemon the turn was
// interrupted, which settles the pane without a "work finished" alarm.
//
// An interrupt with a prompt queued behind it is not a stop: the engine
// starts the queued turn at once (its UserPromptSubmit already fired at
// Enter) and does not wait on this hook. A Stop sent then would land inside
// that turn and close its completion gate, so the mod waits a beat and sends
// nothing when another turn has started. A prompt typed just after that beat
// can still beat the Stop to wmux, so the Stop carries the interrupt time and
// the daemon drops it when a newer prompt already landed.
//
// Deliberately not done here: observing the classic hooks (`classic.*`) or
// adding a system prompt section (`prompt.compose`). A Team organization
// seats Claude Code's default security plugin outermost, and it bypasses a
// user plugin's hooks on those events, so neither can be relied on.

import type { EngineInterface, Register } from 'claude-code'

/** Hard cap on the bridge run so a hung child never piles up. */
const BRIDGE_TIMEOUT_MS = 10_000
/** How long after an interrupt a queued turn has to start before the pane
 *  counts as stopped. The engine starts a queued turn within milliseconds. */
export const QUEUED_TURN_GRACE_MS = 1_000

async function bridgePath($: EngineInterface): Promise<string | undefined> {
  const override = await $.env.get('WMUX_BRIDGE_PATH')
  if (override) return override
  // `wmux setup-hooks` (and the app's first-run hook install) copies the
  // bridge here so it survives app updates.
  const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE'))
  return home ? `${home}/.wmux/hooks/wmux-bridge.mjs` : undefined
}

async function replayInterruptedStop(
  $: EngineInterface,
  answer: string,
  endedAt: number,
  stillCurrent: () => boolean,
): Promise<void> {
  // Outside a wmux pane there is nobody to tell; the bridge would drop it.
  if (!(await $.env.get('WMUX_PTY_ID'))) return
  const bridge = await bridgePath($)
  if (!bridge || !(await $.fs.exists(bridge))) return
  // No session_id: the bridge would rebind the pane's resume target to it,
  // and after a resume the engine's id is not the transcript the pane resumes
  // (the classic hooks derive that from transcript_path, which mods lack).
  const payload = {
    hook_event_name: 'Stop',
    cwd: await $.session.cwd(),
    last_assistant_message: answer,
    wmux_source: 'mod',
    wmux_turn_reason: 'aborted',
    wmux_turn_ended_at: endedAt,
  }
  // The lookups above yield; a turn may have started meanwhile.
  if (!stillCurrent()) return
  await $.process.run(['node', bridge, 'Stop'], {
    stdin: JSON.stringify(payload),
    timeoutMs: BRIDGE_TIMEOUT_MS,
  })
}

export const register: Register = on => {
  // The main loop's latest turn: an interrupted turn still current after the
  // grace period had nothing queued behind it.
  const state: { currentTurnId: string | undefined } = { currentTurnId: undefined }

  on('turn.start', async ($, e, next) => {
    const started = await next(e)
    state.currentTurnId = started.turnId
    return started
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    // Subagent runs end with SubagentStop; only the main loop's interrupt is a gap.
    if (e.agentId === undefined && e.reason === 'aborted' && state.currentTurnId === e.turnId) {
      const interrupted = e.turnId
      const answer = e.answer
      const endedAt = await $.clock.now()
      const stillCurrent = (): boolean => state.currentTurnId === interrupted
      $.clock.after(QUEUED_TURN_GRACE_MS, () => {
        if (!stillCurrent()) return
        replayInterruptedStop($, answer, endedAt, stillCurrent).catch(err =>
          $.ui.log(`wmux: Stop replay failed: ${String(err)}`, { to: 'debug' }),
        )
      })
    }
    return done
  })
}
