/** Load the same Node-built binary in Electron main without rebuilding it. */
const { app } = require('electron');
const assert = require('node:assert/strict');
const { NativeTerminal, NativeRing, NativePty } = require('../dist/native-core/index.cjs');
let pty;
const deadline = setTimeout(() => { console.error('Electron PTY deadline'); pty?.close(); app.exit(1); }, 10000);
app.whenReady().then(async () => {
  try {
    const ring = new NativeRing(1024);
    const terminal = new NativeTerminal(80, 24, 100);
    pty = new NativePty('/bin/sh', ['-c', 'printf "native-electron 한글"'], require('node:os').tmpdir(), 80, 24);
    for (;;) {
      const result = pty.read();
      assert(!result.error, result.error);
      ring.write(result.data);
      if (result.eof) break;
      await new Promise(resolve => setTimeout(resolve, 2));
    }
    terminal.feed(ring.readAll());
    assert.equal(terminal.textSnapshot(false).rows[0].text, 'native-electron 한글');
    terminal.dispose();
    console.log(JSON.stringify({ ok: true, electron: process.versions.electron, node: process.versions.node, abi: process.versions.modules }));
  } catch (e) { console.error(e); process.exitCode = 1; }
  finally { pty?.close(); clearTimeout(deadline); app.exit(process.exitCode ?? 0); }
});
