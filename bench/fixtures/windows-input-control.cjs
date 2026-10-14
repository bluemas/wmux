// Diagnostic baseline only; the native verifier remains the qualification gate.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const nodePty = require('node-pty');
if (process.platform !== 'win32') throw new Error('This control requires Windows');
fs.mkdirSync('out', { recursive: true });
const progressFile = path.resolve('out/node-input-progress.json');
const input = Buffer.alloc(4 * 1024 * 1024, 'x');
const expected = crypto.createHash('sha256').update(input).digest('hex');
const started = Date.now();
const pty = nodePty.spawn(process.execPath, [path.resolve('bench/fixtures/native-pty-child.cjs'), 'input', String(input.length), progressFile], {
  cols: 80, rows: 24, cwd: process.cwd(), env: process.env, useConptyDll: true,
});
let output = '', sent = false, done = false;
const finish = (timedOut, event) => {
  if (done) return;
  done = true; clearTimeout(timer);
  const result = { backend: 'node-pty', platform: process.platform, release: os.release(), node: process.versions.node,
    elapsedMs: Date.now() - started, timedOut, sent, event, expected,
    matched: output.includes(`DIGEST:${expected}`), outputTail: output.slice(-1000),
    childProgress: fs.existsSync(progressFile) ? fs.readFileSync(progressFile, 'utf8') : null };
  fs.writeFileSync('out/windows-input-control.json', JSON.stringify(result, null, 2));
  process.stdout.write(JSON.stringify(result, null, 2) + '\n', () => {
    // The synthetic child has exited. Do not let node-pty's helper handles
    // keep this standalone diagnostic alive after its report is durable.
    if (!timedOut) process.exit(0);
  });
  if (timedOut) {
    try { process.kill(pty.pid); } catch { /* The fixture may already have exited. */ }
    pty.kill();
  }
};
const timer = setTimeout(() => finish(true), 300000);
pty.onData(text => {
  output += text;
  if (!sent && output.includes('READY')) { sent = true; pty.write(input); }
});
pty.onExit(event => finish(false, event));
