# wmux portable-pty changes

Source: crates.io portable-pty 0.9.0, MIT license (LICENSE.md). Upstream:
https://github.com/wezterm/wezterm/tree/main/pty

Only the library sources and normalized manifest are vendored. Example targets
are omitted because the examples are not shipped here.

Windows changes:

- Load the selected ConPTY DLL by absolute path, with dependency lookup restricted
  to its directory and System32. Resolve bundled `Conpty*` exports or inbox exports
  per instance; keep its library loaded until the HPCON is closed.
- Match node-pty's default creation flags; expose optional clear/release functions.
- Create the child suspended, assign it to a kill-on-close Job Object, then resume.
  Termination affects the owned Windows process tree. Correct TerminateJobObject's
  success/error handling. WSL Linux descendants still require runtime qualification.
- Add a default no-op `MasterPty::clear` method, overridden by ConPTY.

Unix changes:

- Mark inherited descriptors close-on-exec instead of closing them in `pre_exec`.
  This preserves Rust Command's spawn-error pipe and avoids Chromium's inherited
  FD-ownership checks when loaded inside Electron. Linux uses `close_range` with
  `CLOSE_RANGE_CLOEXEC`, falling back to per-descriptor `fcntl` where unavailable.
  Other Unix targets use the per-descriptor path. Successful exec still closes
  all non-stdio inherited descriptors.

The wmux N-API adapter supplies bounded queues and dedicated read/write/wait
threads separately.
