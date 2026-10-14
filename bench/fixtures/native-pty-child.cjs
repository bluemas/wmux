// Run inside an actual PTY, not with mocked native bindings.
const mode = process.argv[2];
if (mode === 'output' || mode === 'output-raw') {
  // Exact-byte tests must not rely on OS newline expansion. Darwin can emit
  // a duplicate CR when ONLCR fills its output queue between the CR and LF.
  // Set this only in the synthetic child; production PTY defaults are intact.
  if (mode === 'output-raw' && process.platform !== 'win32') {
    require('node:child_process').execFileSync('/bin/stty', ['-opost'], { stdio: ['inherit', 'ignore', 'inherit'] });
  }
  const newline = mode === 'output-raw' ? '\r\n' : '\n';
  const count = Number(process.argv[3]);
  const write = index => {
    while (index < count) {
      const line = `ROW${String(index++).padStart(6, '0')}|한글🙂|${'x'.repeat(30)}${newline}`;
      if (!process.stdout.write(line)) { process.stdout.once('drain', () => write(index)); return; }
    }
    process.stdout.write(`FINAL-OUTPUT${newline}`, () => { process.exitCode = 7; });
  };
  write(0);
} else if (mode === 'input') {
  process.stdin.setRawMode(true);
  let received = 0;
  const expected = Number(process.argv[3]);
  const progressFile = process.argv[4];
  let nextProgress = 0;
  const record = phase => {
    if (progressFile) require('node:fs').writeFileSync(progressFile, JSON.stringify({ phase, received, expected, timestamp: Date.now() }));
  };
  const hash = require('node:crypto').createHash('sha256');
  if (process.platform === 'win32') {
    setInterval(() => process.stdout.write(`INPUT-PROGRESS:${received}/${expected}\n`), 5000).unref();
  }
  process.stdin.on('data', data => {
    received += data.length; hash.update(data);
    if (received >= nextProgress) { record('receiving'); nextProgress = received + 256 * 1024; }
    if (received > expected) throw new Error(`Unexpected input length: ${received} > ${expected}`);
    if (received === expected) {
      record('complete');
      process.stdout.write(`DIGEST:${hash.digest('hex')}\n`, () => process.exit(0));
    }
  });
  // Let the stream's resume/read-start run before inviting a bulk write. On
  // Windows stdout is synchronous; advertising READY before installing the
  // reader lets the parent flood ConPTY while the child is still in that write.
  setImmediate(() => { record('reader-started'); process.stdout.write('READY\n'); record('ready-sent'); });
} else if (mode === 'blocked-input') {
  process.stdin.setRawMode(true);
  process.stdout.write('READY\n');
  setInterval(() => {}, 1000);
} else if (mode === 'metadata') {
  process.stdout.write(JSON.stringify({ cwd: process.cwd(), value: process.env.WMUX_FIXTURE_VALUE,
    args: process.argv.slice(3), cols: process.stdout.columns, rows: process.stdout.rows }) + '\n');
} else if (mode === 'idle') {
  process.stdout.write('READY\n');
  setInterval(() => {}, 1000);
} else if (mode === 'tree') {
  const child = require('node:child_process').spawn(process.execPath, [__filename, 'idle'], { stdio: 'inherit' });
  process.stdout.write(`CHILD:${child.pid}\n`);
  setTimeout(() => process.exit(0), 100);
} else if (mode === 'resize') {
  process.stdout.on('resize', () => {
    if (process.stdout.columns === 120 && process.stdout.rows === 40) process.stdout.write('RESIZED:120x40\n', () => process.exit(0));
  });
  // Windows delivers resize notifications while reading a raw console input
  // stream. Arm the reader and listener before inviting the parent to resize.
  // https://nodejs.org/api/process.html#signal-events
  if (process.platform === 'win32') {
    process.stdin.setRawMode(true);
    process.stdin.resume();
  }
  process.stdout.write('READY\n');
  setInterval(() => {}, 1000);
} else { throw new Error(`Unknown mode: ${mode}`); }
