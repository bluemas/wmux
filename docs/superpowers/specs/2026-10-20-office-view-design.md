# Office view — design (fork only)

Status: draft for owner approval · 2026-10-20 · fork `bluemas/wmux` only (never an upstream PR)

## Intent

The owner runs many agent sessions at once across wmux workspaces (often 15+ panes of Claude Code
and Codex, plus Claude Code Agent Teams teammates). Today their state is spread over the sidebar
dots and the roster rows. The owner wants a single, pleasant place to *see the crew at work*:
an illustrated office, in the style and quality of Nookrew
(https://github.com/hw01931/nookrew, screenshot: `media/02-office.png`), where every session is an
employee who is visibly working at a desk or resting, with what they are doing right now.

Why now: the owner keeps asking "is this pane still working, and on what?" (missing running dots,
interrupted Codex turns whose subagents kept going, a teammate working after its lead stopped).
A glanceable office answers that at a look and makes the waiting enjoyable.

## Goals

1. A new **Office** rail page inside wmux (alongside Workspaces · Bots · Fleet · Schedules ·
   Remote · Git).
2. **One employee per session**, each independent:
   - every live Claude Code pane,
   - every live Codex pane,
   - every Claude Code Agent Teams **in-process teammate** (taskKind `in_process_teammate`) as its
     own employee, seated next to the employee (lead) that spawned it.
3. For each employee, at a glance, one of three states:
   - **working** — sits at their desk, monitor on, speech bubble with the current activity (the
     same text the sidebar roster shows, e.g. a tool line or "Running tests");
   - **needs you** — stays at the desk with a **raised hand and a red "!" bubble** (owner
     decision). Covers every roster state that wants the owner: `awaiting_input` / `waiting`
     (approval or answer), `error`, and `usageLimitWaiting`. The bubble says which (e.g. "Waiting
     for approval", "Error", "Usage limit — resumes 14:00"). This state has its own sprites;
   - **resting** — away from the desk (lounge / sofa area).
4. **A lead and its teammates each show their OWN state** (owner decision): when the lead's turn
   ended but a teammate still works, the lead rests and only the teammate works. This is the one
   deliberate difference from the sidebar, whose dot for that pane reads running while any
   teammate works (commit 0cb2a4c65). The daemon must therefore publish the lead's own state
   separately from its teammates' (the current `activity.active` refresh for teammates is not
   enough to tell them apart).
5. **Click an employee → jump to that session's terminal pane** (switch workspace, focus the pane
   and its surface). For a teammate, jump to its lead's pane. A stashed pane is unstashed first.
6. **Illustration quality comparable to Nookrew:** isometric pixel-art office (floor, walls,
   windows, desks, monitors, chairs, plants, a lounge), small chibi characters (2–3 heads tall) with
   name labels, tidy speech bubbles. Not flat wireframes, not emoji.

## Non-goals

- No messaging/chat to employees from the office (the terminal is where you talk; clicking jumps
  there).
- No reading conversations, token totals, file browsers, furniture editing, themes, mini-games
  (Nookrew features the owner did not ask for).
- No Bots-page integration; factory bots are not employees unless they are ordinary panes.
- Not an upstream PR; it may ignore DESIGN.md's "no decoration" grammar *inside the office canvas
  only*.

## Anti-goals (would be a failure even if it "works")

- An office that **disagrees with the sidebar** (an employee working while the pane's dot is off,
  or vice versa). The office must read the same state the sidebar reads, except the intended
  lead/teammate split in Goal 4.
- An agent that needs the owner hidden on the sofa.
- Low-quality or mismatched art (mixed styles, blurry upscaling, placeholder boxes) — the owner
  set Nookrew-level quality as the bar.
- Using assets without a licence that allows redistribution in a public repo (Nookrew's own art
  has no licence and must not be copied).
- Noticeable CPU/GPU cost while the page is not visible, or jank in terminals while it is.

## Decided (by the owner)

- Lives **inside wmux** as a page (not a browser tab, not a separate app).
- Style **A: one isometric pixel office room** (chosen over a card grid and per-workspace zones),
  at Nookrew's quality.
- Claude Code, Codex and teammates are **each an employee**.
- Shown per employee: **current activity** and **working vs resting**.
- Click → **jump to that terminal pane**.
- **Fork only.**
- Art: the owner delegated sourcing and making it to the builder (see Constraints).
- **Needs-you employees raise a hand at their desk** with a red "!" bubble (not sent to the
  lounge).
- **Lead and teammates show their own states**, even when that differs from the pane's sidebar
  dot.

## Calls made by the designer (owner may override)

- **Which teammates are employees:** a teammate (meta `taskKind: "in_process_teammate"`) whose
  transcript changed in the last 30 minutes, matching the `TeammateScanner` freshness cap. Older
  teammate files are former team members and are not shown; there is no team-shutdown signal to
  read, and reading the Agent Teams team config is not required.
- **Other employees:** any other locally detected agent kind in a live pane (e.g. Gemini,
  OpenCode) is an employee with a generic character; stashed panes are included (jump unstashes);
  remote mirrored sessions (`remote:{host}:{session}`) are left out — they have no local pane to
  jump to.
- **Agreement with the sidebar** means: the same per-pane source of truth for each employee's own
  state; the lead/teammate split above is the only intended difference.

## Constraints

- **Art licensing:** only assets whose licence allows redistribution in a public GitHub repo
  (CC0 preferred; CC-BY / OFL / MIT acceptable with attribution). Record every source, author,
  licence and URL in `THIRD_PARTY_NOTICES.md`. Gaps (most likely the characters) may be produced
  by image generation, then cleaned to a consistent palette and pixel grid; no copying of
  Nookrew's or any unlicensed art.
- **Single source of truth for state:** employee state must come from the same renderer store the
  sidebar uses — per pane: `isHookRunning` (`src/renderer/stores/selectors/fleet.ts`), the roster's
  activity text (`surfaceActivity`), agent kind (`surfaceAgent`), `subagents`
  (`surfaceSubagents`); see `workspaceAgentRoster.ts`. Teammates are not in the renderer today:
  the daemon's `TranscriptActivityWatcher` already scans `<session>/subagents/*.jsonl` +
  `.meta.json` per Claude pane (`teammateActivity.ts`, `TeammateScanner`) but only emits a bare
  `activity.active` for the lead. The builder must extend that to publish a per-pane teammate list
  (name, colour from meta, working/idle, current activity line) to the renderer through the same
  daemon event → `DaemonNotificationRouter` → `METADATA_UPDATE` path the subagent count uses.
- **Jump:** reuse `focusPaneByPtyId` (`src/renderer/hooks/useNotificationListener.ts`), the
  hardened path Fleet View uses.
- **Rail page:** follow the existing rail page wiring (`src/renderer/components/Layout/RailPage.tsx`,
  the rail item list in AppLayout/rail components, i18n en+ko and any locale `tsc` requires).
- **Performance:** render only while the page is visible; no work when hidden. Animation (idle
  breathing, typing) is light — CSS/sprite-sheet frames, no per-frame React re-render of the
  whole room. Tested with ~30 employees.
- **Repo rules:** English code, comments and docs; CRLF files; new tests with vitest; i18n for all
  visible strings (en, ko; plus whatever the locale coverage tests require).

## Left to the builder

- The exact asset packs (or generation pipeline) and the final art direction details, within the
  quality bar and licences above. A short `docs/office-art.md` should record how the art was
  assembled so it can be extended.
- Rendering technique (layered DOM with `image-rendering: pixelated`, canvas, or a light 2D
  library) — pick what keeps text crisp (labels, bubbles) and the cost low.
- Room layout and how it grows past the number of desks drawn (more rooms/floors, a larger room,
  scrolling/zoom) — must stay legible at 30 employees.
- How an employee's appearance is chosen (stable per session, e.g. hashed from the pane id or
  session id; teammates take their meta `color`).
- Where resting employees go, idle animations, transitions when an employee starts/stops working.
- Speech bubble length/truncation and when bubbles show (always for working employees, or on
  hover when crowded).
- An empty state (no sessions) and how exited/closed panes leave the office.
