import type { On, TurnCompleteInput } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const BRIDGE = '/home/u/.wmux/hooks/wmux-bridge.mjs'
const GRACE = 1_000
const T0 = 1_760_000_000_000

type Run = { argv: readonly string[]; payload: Record<string, unknown> }

// The world beneath the mod: a wmux pane, a bridge on disk, and a recorder in
// place of the bridge process.
function world(on: On, env: Record<string, string> = {}): { runs: Run[]; advance: (ms: number) => Promise<void> } {
  const runs: Run[] = []
  mock.env(on, { HOME: '/home/u', WMUX_PTY_ID: 'pty-1', ...env })
  const clock = mock.clock(on, { now: T0 })
  on('fs.exists', ($, e) => ({ value: e.path === BRIDGE }))
  on('session.cwd', () => ({ value: '/work' }))
  on('ui.log', () => ({ value: undefined }))
  on('process.run', ($, e) => {
    runs.push({ argv: e.argv, payload: JSON.parse(e.init?.stdin ?? '{}') })
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  return { runs, advance: ms => clock.advance(ms) }
}

function ended(fields: Partial<TurnCompleteInput> & Pick<TurnCompleteInput, 'reason'>): TurnCompleteInput {
  return {
    answer: 'partial essay',
    durationMs: 900,
    isAborted: fields.reason === 'aborted',
    turnId: 't1',
    ...fields,
  } as TurnCompleteInput
}

test('an interrupted main turn replays the Stop the classic hooks never fire', async ($, on) => {
  const w = world(on)
  await $.turn.start({ text: 'write an essay', turnId: 't1' })
  await $.turn.complete(ended({ reason: 'aborted' }))
  await w.advance(GRACE - 1)
  expect(w.runs).toEqual([])
  await w.advance(1)
  expect(w.runs.map(r => r.argv)).toEqual([['node', BRIDGE, 'Stop']])
  expect(w.runs[0]?.payload).toEqual({
    hook_event_name: 'Stop',
    cwd: '/work',
    last_assistant_message: 'partial essay',
    wmux_source: 'mod',
    wmux_turn_reason: 'aborted',
    wmux_turn_ended_at: T0,
  })
})

test('an interrupt with a queued prompt behind it sends nothing', async ($, on) => {
  const w = world(on)
  await $.turn.start({ text: 'write an essay', turnId: 't1' })
  await $.turn.complete(ended({ reason: 'aborted' }))
  // The engine starts the queued turn at once; that turn owns the pane now.
  await $.turn.start({ text: 'reply OK', turnId: 't2' })
  await w.advance(GRACE * 4)
  expect(w.runs).toEqual([])
})

test('turns the classic hooks already close send nothing', async ($, on) => {
  const w = world(on)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await $.turn.complete(ended({ reason: 'answer' }))
  await $.turn.start({ text: 'hi', turnId: 't2' })
  await $.turn.complete(ended({ reason: 'error', turnId: 't2' }))
  await w.advance(GRACE * 4)
  expect(w.runs).toEqual([])
})

test("an interrupted subagent run is not the pane's turn", async ($, on) => {
  const w = world(on)
  await $.turn.start({ text: 'delegate', turnId: 't1' })
  await $.turn.complete(ended({ reason: 'aborted', agentId: 'agent-7', turnId: 'sub-1' }))
  await w.advance(GRACE * 4)
  expect(w.runs).toEqual([])
})

test('a turn the mod never saw start is left alone', async ($, on) => {
  const w = world(on)
  await $.turn.complete(ended({ reason: 'aborted' }))
  await w.advance(GRACE * 4)
  expect(w.runs).toEqual([])
})

test('outside a wmux pane, or with no bridge installed, nothing runs', async ($, on) => {
  const w = world(on, { WMUX_PTY_ID: '', WMUX_BRIDGE_PATH: '/nowhere/bridge.mjs' })
  await $.turn.start({ text: 'x', turnId: 't1' })
  await $.turn.complete(ended({ reason: 'aborted' }))
  await w.advance(GRACE * 4)
  expect(w.runs).toEqual([])
})

test('WMUX_BRIDGE_PATH overrides the stable bridge location', async ($, on) => {
  const w = world(on, { WMUX_BRIDGE_PATH: BRIDGE, HOME: '/elsewhere' })
  await $.turn.start({ text: 'x', turnId: 't1' })
  await $.turn.complete(ended({ reason: 'aborted' }))
  await w.advance(GRACE)
  expect(w.runs.map(r => r.argv[1])).toEqual([BRIDGE])
})
