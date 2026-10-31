---
name: verify
description: "How to check a wmux change before calling it done: which typecheck and vitest suites to run for which area, known environment-only failures, building and installing the Windows installer or the macOS app, and reading live app state over CDP. Use after editing code in this repo, before committing, and when asked to build, reinstall or measure the installed app. For driving the UI itself, use verify-wmux."
---

# verify (fork notes)

## 1. Always

```sh
npx tsc --noEmit -p .          # must print 0 errors
```

On macOS under Node 26 tsc can crash with a V8 stack dump (out of heap); run it with
Node 22 and `NODE_OPTIONS=--max-old-space-size=8192`.

## 2. Tests for what you touched

Run the narrowest suites first; widen when the change crosses processes.

| Changed | Run |
|---|---|
| `src/daemon/DaemonPTYBridge.ts`, activity/agent detection | `npx vitest run src/daemon/__tests__/DaemonPTYBridge` |
| other `src/daemon/**` | `npx vitest run src/daemon` |
| `src/main/notification/**`, status routing | `npx vitest run src/main/notification src/daemon/__tests__/DaemonPTYBridge` |
| `src/main/daemon/**`, `DaemonClient` | `npx vitest run src/main/daemon src/daemon/__tests__/DaemonPipeServer.test.ts` |
| `src/renderer/hooks/useTerminal.ts`, `src/renderer/terminal/**` | `npx vitest run src/renderer/terminal src/renderer/hooks` |
| `src/renderer/components/Pane/**` | `npx vitest run src/renderer/components/Pane` |
| `integrations/claude/**` | `npx vitest run integrations/claude` |
| i18n keys | `npx tsc` catches duplicate keys (TS1117) |

Whole unit suite: `npm run test:parallel`. `*.runtime.test.*` and `*.os.test.*`
spawn real processes; run them alone (`npm run test:runtime`) — run beside other
suites they time out on a loaded machine.

Known environment-only failures (fail on clean `main` too, ignore):
- `src/daemon/transcript/__tests__/chatSkills.test.ts` (2 cases) — reads the
  real `~/.claude`.

Runtime tests may leave a `Microsoft/` PowerShell cache folder in the repo
root; delete it.

## 3. Build and install (Windows)

1. Check free space on C: first; the Squirrel step needs about 1 GB and fails
   with `WriteEntryTo or OpenEntryStream can only be called once`
   (`node_modules/electron-winstaller/vendor/Squirrel-Releasify.log`) when the
   disk is nearly full.
2. `npm install` if `package.json`/lockfile changed, then
   `git checkout package-lock.json` (npm rewrites `libc` fields as noise).
3. `npm run make` (run in background, ~4 min) →
   `out/make/squirrel.windows/x64/wmux-<version>.Setup.exe`.
4. Copy it to the repo root (ignored by `/*.exe`), replacing only your own
   previous copy.
5. Run the installer ONCE, and only when no `*Setup*`/`Update` process is
   running — two overlapping installs leave `app-<ver>/` holding only
   `wmux.exe`. Start it from a cleaned environment (Claude's shell env leaks
   into every new terminal): drop `NO_COLOR`, `GIT_EDITOR`,
   `GIT_TERMINAL_PROMPT`, `GCM_INTERACTIVE`, `CLAUDE_*`, `OTEL_*`, `WMUX_*`,
   rebuild `Path` from Machine+User, then `Start-Process`.
6. Confirm: `%LOCALAPPDATA%\SquirrelTemp\Squirrel-Install.log` ends with
   `Finished Squirrel Updater`, `app-<ver>\resources\app.asar` exists, and
   `wmux.exe` runs from `app-<ver>`.

Installing restarts the daemon only when the install folder's exe is replaced
(same-version reinstall kills it): sessions then recover from snapshots.

## 3b. Build and install (macOS, local unsigned)

1. Dependencies: npm 11 skips dependency install scripts unless they are
   allowed, and does so silently. `--allow-scripts` is rejected at project
   scope, so write a temporary `.npmrc` with
   `allow-scripts=electron,esbuild,node-pty,koffi,fsevents,fs-xattr,macos-alias,wasm-pack,electron-winstaller`,
   run `npm ci`, then delete the `.npmrc`. Re-run after any pull that touches
   `package-lock.json` or `patches/` (patch-package runs in postinstall).
2. `npm run package` with Node 22 (nvm). Under Node 26 it exits 0 but leaves
   no `out/`: electron-packager's `extract-zip` quits silently. Check that
   `out/wmux-darwin-arm64/wmux.app` exists.
3. Without Apple credentials the build is unsigned and its signature is
   invalid after packaging: `ditto` it to `/Applications/wmux.app.new`, then
   `codesign --force --deep --sign - /Applications/wmux.app.new` and
   `codesign --verify --deep` it.
4. Swap: the session usually runs inside the installed wmux, so never quit
   the app or kill the daemon from it without asking. `mv` the running
   bundle to `/Applications/wmux-old.app` (a running app survives the move),
   `mv` the new one into place, and let the owner restart. Delete
   `wmux-old.app` only when `lsof | grep wmux-old.app/` is empty; the app and
   daemon keep executing from it until each restarts.
5. Restart the app only (terminals survive, the daemon holds the PTYs):
   from a `nohup` script with `trap '' HUP`,
   `osascript -e 'quit app "wmux"'`, wait for
   `pgrep -f "Contents/MacOS/wmux$"` to clear, then `open -a /Applications/wmux.app`.
   Restarting the daemon kills every terminal, including the session. A
   `package.json` version change since the daemon started makes the new app
   replace the daemon by itself, so warn before restarting in that case.

## 4. Live app state

- CDP port: the listening port of the main `wmux.exe` (18800–18999;
  `Get-NetTCPConnection -State Listen`). `%APPDATA%\wmux\DevToolsActivePort`
  can be stale.
- The `wmux` page target (`index.html`) exposes `window.electronAPI`; e.g.
  count `electronAPI.notification.onTitleChanged` and
  `electronAPI.metadata.onUpdate` events for a few seconds to prove the app
  still receives daemon events.
- Sidebar state: `.sidebar-row` `[aria-label]` ("Name, Running") and
  `.sidebar-dot-running`.
- Daemon events directly: connect to the pipe, send
  `daemon.client.identify {role:'main'}` then `daemon.events.subscribe`
  (string `id`, `token` from `~/.wmux/daemon-auth-token`).
- Never switch the user's workspaces from a script without saying when.

## 5. Commits in this fork

The repo's wmux pre-commit hook blocks upstream merges whose test fixtures hold
fake tokens (GitHub-token-shaped strings, the AWS docs example key). Ask the owner before
using `--no-verify`.
