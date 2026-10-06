import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

// Electron-free so it can be unit-tested without an Electron runtime — the
// IPC registration that wraps this lives in ../ipc/handlers/fonts.handler.ts.

const execFileAsync = promisify(execFile);

// Enumerate installed font *family* names via .NET's
// InstalledFontCollection. This returns CSS-resolvable family names
// ("Cascadia Code", "JetBrains Mono", "D2Coding") — unlike the registry
// `…\Fonts` value-names, which are file-display strings like
// "Arial Bold (TrueType)" that don't match a CSS family. `[Console]::
// OutputEncoding = UTF-8` is set first so Korean/CJK family names survive the
// pipe instead of being mangled by the console's OEM codepage (CP949 on a
// Korean Windows). Single line by design (see feedback_command_single_line).
const PS_FONT_SCRIPT =
  "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; Add-Type -AssemblyName System.Drawing; (New-Object System.Drawing.Text.InstalledFontCollection).Families | ForEach-Object { $_.Name }";

// PowerShell cold-start + assembly load is a few hundred ms; 5s is generous
// headroom while still bounding a hung spawn so the Settings panel never waits
// indefinitely for suggestions.
const PS_TIMEOUT_MS = 5000;

// 156 families on a stock box, longest ~40 chars → ~10KB. 1MB is ~100x
// headroom and caps a runaway/garbage stream.
const PS_MAX_BUFFER = 1024 * 1024;

/**
 * Parse the newline-delimited PowerShell stdout into a clean, de-duplicated,
 * locale-sorted list of family names. Pure (no I/O) so it is unit-testable
 * without spawning PowerShell. Trims each line, drops blanks, and collapses
 * the weight-variant duplicates PowerShell can emit (the datalist filters the
 * rest as the user types).
 */
export function parseFontList(stdout: string): string[] {
  const names = stdout
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return Array.from(new Set(names)).sort((a, b) => a.localeCompare(b));
}

// Resolve powershell.exe candidates. A bare `'powershell.exe'` relies on
// %SystemRoot%\System32\WindowsPowerShell\v1.0 being on the *spawned* process's
// PATH — which is NOT guaranteed. In Electron's main process (and some shells)
// the lookup fails with ENOENT, so the enumeration silently fell into the
// catch-all `[]` and the Settings picker showed no installed fonts at all.
// Prefer the absolute path (SystemRoot is always set on Windows), then fall
// back to the bare name in case SystemRoot is somehow unset but PATH works.
function powershellCandidates(): string[] {
  const root = process.env.SystemRoot || process.env.windir;
  const candidates: string[] = [];
  if (root) candidates.push(`${root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`);
  candidates.push('powershell.exe');
  return candidates;
}

// system_profiler는 첫 실행(폰트 캐시 콜드)에 수 초 걸릴 수 있어 넉넉히 15s.
// 제안 목록은 선택적 편의 기능이므로 타임아웃 시 조용히 []로 떨어진다.
const SP_TIMEOUT_MS = 15000;

// 수백 개 폰트 × typeface 메타데이터 JSON — 수 MB까지 갈 수 있어 16MB 상한.
const SP_MAX_BUFFER = 16 * 1024 * 1024;

/**
 * `system_profiler SPFontsDataType -json` stdout을 파싱해 CSS로 해석 가능한
 * 폰트 패밀리 이름 목록을 만든다. typeface의 `family` 필드가 CSS family와
 * 일치한다("Menlo", "Apple SD Gothic Neo" 등 — 파일명이 아니라 패밀리명).
 * 순수 함수(I/O 없음)라 system_profiler 없이 단위 테스트 가능. 형식이
 * 어긋나면 던지지 않고 파싱 가능한 만큼만 수집한다.
 */
export function parseMacFontProfile(stdout: string): string[] {
  const names: string[] = [];
  try {
    const json = JSON.parse(stdout) as {
      SPFontsDataType?: Array<{ typefaces?: Array<{ family?: unknown }> }>;
    };
    for (const font of json.SPFontsDataType ?? []) {
      for (const typeface of font.typefaces ?? []) {
        if (typeof typeface.family === 'string') {
          const name = typeface.family.trim();
          if (name.length > 0) names.push(name);
        }
      }
    }
  } catch {
    // JSON 자체가 깨진 경우 — 제안 없음으로 처리
    return [];
  }
  return Array.from(new Set(names)).sort((a, b) => a.localeCompare(b));
}

// NSFontManager answers in ~0.2s (system_profiler takes 8s+), and its family
// names are the same CSS-resolvable ones. JXA via osascript needs no native
// module. Falls back to system_profiler when osascript is unavailable or fails.
const OSASCRIPT_TIMEOUT_MS = 5000;
const OSASCRIPT_FONT_SCRIPT =
  'ObjC.import("AppKit"); $.NSFontManager.sharedFontManager.availableFontFamilies.js.map(x => x.js).join("\\n")';

async function listMacFontsFast(): Promise<string[]> {
  const { stdout } = await execFileAsync(
    '/usr/bin/osascript',
    ['-l', 'JavaScript', '-e', OSASCRIPT_FONT_SCRIPT],
    { timeout: OSASCRIPT_TIMEOUT_MS, encoding: 'utf8' as const },
  );
  const names = parseFontList(stdout);
  if (names.length === 0) throw new Error('empty NSFontManager family list');
  return names;
}

async function listMacFonts(): Promise<string[]> {
  try {
    return await listMacFontsFast();
  } catch {
    // fall through to the slower system_profiler path
  }
  // system_profiler는 항상 /usr/sbin에 있다 — PATH 의존 없이 절대 경로 사용.
  const { stdout } = await execFileAsync(
    '/usr/sbin/system_profiler',
    ['SPFontsDataType', '-json'],
    { timeout: SP_TIMEOUT_MS, maxBuffer: SP_MAX_BUFFER, encoding: 'utf8' as const },
  );
  return parseMacFontProfile(stdout);
}

async function listWindowsFonts(): Promise<string[]> {
  const args = ['-NoProfile', '-NonInteractive', '-Command', PS_FONT_SCRIPT];
  const opts = { timeout: PS_TIMEOUT_MS, windowsHide: true, maxBuffer: PS_MAX_BUFFER, encoding: 'utf8' as const };
  let lastErr: unknown;
  for (const exe of powershellCandidates()) {
    try {
      const { stdout } = await execFileAsync(exe, args, opts);
      return parseFontList(stdout);
    } catch (err) {
      // Try the next candidate (e.g. ENOENT on the bare name); the public
      // listInstalledFonts() still swallows a total failure into [].
      lastErr = err;
    }
  }
  throw lastErr;
}

/**
 * Best-effort enumeration of installed font families for the Settings font
 * picker. Contract: NEVER throws and NEVER rejects. On a non-Windows platform,
 * a spawn failure, a timeout, or a parse error it resolves `[]`. The renderer's
 * font input is free-text, so an empty list simply means "no suggestions".
 */
export async function listInstalledFonts(): Promise<string[]> {
  try {
    if (process.platform === 'win32') return await listWindowsFonts();
    if (process.platform === 'darwin') return await listMacFonts();
    // Linux 열거는 후속 과제 — []면 피커는 free-text로 동작한다.
    return [];
  } catch {
    // Swallow: a missing/locked PowerShell, a slow system_profiler, or a slow
    // box must not surface an error toast for an optional convenience feature.
    return [];
  }
}
