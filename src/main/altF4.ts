/**
 * Whether Alt and F4 are physically held right now (Windows only).
 *
 * Alt+F4 reaches an app as a plain close request — the same one the title-bar
 * X sends — and Windows handles the key itself, so Chromium's input events do
 * not report it. Asking the OS for the key state at the moment the close
 * arrives is what tells the two apart.
 */
const VK_MENU = 0x12; // Alt
const VK_F4 = 0x73;
/** High bit of GetAsyncKeyState: the key is down now. */
const KEY_DOWN = 0x8000;

type GetAsyncKeyState = (vkey: number) => number;
let getAsyncKeyState: GetAsyncKeyState | null | undefined;

function load(): GetAsyncKeyState | null {
  if (getAsyncKeyState !== undefined) return getAsyncKeyState;
  getAsyncKeyState = null;
  if (process.platform !== 'win32') return null;
  try {
    // Runtime require, like winSnapshotNative: koffi stays external to the bundle.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const koffi = require('koffi') as {
      load(name: string): { func(name: string, result: string, args: string[]): unknown };
    };
    getAsyncKeyState = koffi.load('user32.dll').func('GetAsyncKeyState', 'int16', ['int']) as GetAsyncKeyState;
  } catch (err) {
    console.warn(`[altF4] koffi load failed — Alt+F4 detection disabled: ${err instanceof Error ? err.message : String(err)}`);
  }
  return getAsyncKeyState;
}

export function isAltF4Held(): boolean {
  const fn = load();
  if (!fn) return false;
  try {
    return (fn(VK_MENU) & KEY_DOWN) !== 0 && (fn(VK_F4) & KEY_DOWN) !== 0;
  } catch {
    return false;
  }
}
