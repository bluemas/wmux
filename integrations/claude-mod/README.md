# wmux-turn-signals

A Claude Code **mod** (function hooks, Claude Code 2.1.296+) that closes one
gap the classic hook bridge cannot: an **interrupted turn**.

When you press Esc (or Ctrl+C) mid-turn, Claude Code fires no `Stop` hook. A
pane wmux tracks through hooks then stays `running` until the next prompt.
Claude Code's own `turn.complete` event does fire there, with
`reason: 'aborted'`. This mod replays the missing `Stop` through the same
bridge script the classic hooks use, marked `wmux_turn_reason: 'aborted'`.
wmux then settles the pane without a "work finished" alarm, because you
stopped the turn yourself.

Turns that end normally, and turns a background task starts, already get
their classic `UserPromptSubmit` / `Stop` (measured on 2.1.296). The mod sends
nothing for them. Nor does it send anything when a queued prompt starts the
next turn right after the interrupt (it waits 1 s to see): that turn owns
the pane, and its own `Stop` closes it.

## Install

The classic hooks must already be installed (`wmux setup-hooks`, or the
`wmux-claude-integration` plugin). This mod is an addition, not a replacement.
Then, inside Claude Code:

```
/plugin marketplace add openwong2kim/wmux
/plugin install wmux-turn-signals@wmux
```

The mod runs the bridge at `~/.wmux/hooks/wmux-bridge.mjs`, where
`wmux setup-hooks` installs it. If yours lives elsewhere (for example, only
the marketplace plugin is installed), set `WMUX_BRIDGE_PATH` to its path.
Outside a wmux pane (no `WMUX_PTY_ID`) the mod does nothing.

## Limits

- Mods are early access in Claude Code; the API may change between releases.
- `$.process` is CLI-only, so the mod does nothing under SDK or desktop hosts.
- A turn that dies on an API error is not filled in. The classic
  `StopFailure` covers rate limits, and with no way to tell whether it fired,
  a second report could overwrite its `rate_limit` reason.
- A reload of the mod (an edit under `--plugin-dir`, or an update) forgets
  the turn in flight, so interrupting that one turn is not reported.
- On a Team organization, Claude Code's default security plugin bypasses a
  user mod's hooks on `classic.*` and `prompt.compose`. The mod relies on
  neither of them.

## Develop

```
claude plugin validate integrations/claude-mod
claude plugin test integrations/claude-mod
claude --plugin-dir integrations/claude-mod   # a live session with the mod loaded
```

Loading the mod once writes its API types to `.claude-plugin/types/`
(ignored by git); after that, `tsc -p integrations/claude-mod` type-checks it.
