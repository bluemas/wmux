// Characterization of readClaudeInventory, readCodexInventory and
// readAgyInventory. Each scenario feeds a reader a virtual home and project
// through InventoryDeps.readFile/readdir and compares the WHOLE result (items in
// order, warnings in order, settingsPath, versions) with a recorded golden file
// in ./fixtures/inventory. The goldens pin today's behaviour so the readers can
// be restructured without changing what the Token usage tab shows.
//
// Portable across OSes: paths become <home>/<project> with '/' separators, the
// path-derived hash in Claude hook ids becomes <hash>, and parser messages
// become <parse error>. Lists owned elsewhere are reduced to a checked count:
// the wmux tool rows (CORE_TOOL_SURFACE) and the wmux Codex hook rows
// (CODEX_HOOK_EVENTS), so adding a tool or an event does not touch these files.
//
// Re-record only on purpose: WMUX_RECORD_INVENTORY=1 npx vitest run <this file>

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { ProviderInventory } from '../../../../shared/tokenUsage/surfaceTypes';
import { TESTED_CLI_VERSIONS } from '../../../../shared/tokenUsage/capabilities';
import {
  CODEX_HOOK_EVENTS,
  CODEX_HOOKS_MANAGED_END_MARKER,
  CODEX_HOOKS_MANAGED_MARKER,
} from '../../../../shared/configIO';
import { codexHookStateKey } from '../../writers/codex/planEdits';
import { readAgyInventory } from '../agyInventory';
import { readClaudeInventory } from '../claudeInventory';
import { readCodexInventory } from '../codexInventory';
import type { InventoryDeps } from '../types';
import { listWmuxToolNames } from '../wmuxTools';

const RECORD = process.env.WMUX_RECORD_INVENTORY === '1';
const GOLDEN_DIR = path.join(__dirname, 'fixtures', 'inventory');
const HOME = path.resolve('/wmux-inventory-char/home');
const PROJECT = path.resolve('/wmux-inventory-char/project');
const KEPT_WMUX_TOOLS = new Set(['terminal_read', 'terminal_send']);

const tmpDirs: string[] = [];
afterAll(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});

type Tree = Record<string, string>;

/** InventoryDeps over an in-memory tree. Keys are '/'-separated, prefixed `~/` (home) or `@/` (project). */
function virtualDeps(tree: Tree, opts: { version?: string | null; project?: boolean; store?: unknown; unreadable?: string[] }): InventoryDeps {
  const toAbs = (key: string) => {
    const [root, ...rest] = key.split('/');
    return path.join(root === '~' ? HOME : PROJECT, ...rest);
  };
  const files = new Map(Object.entries(tree).map(([k, v]) => [toAbs(k), v]));
  const unreadable = new Set((opts.unreadable ?? []).map(toAbs));
  const enoent = (p: string) => Object.assign(new Error(`ENOENT: no such file or directory, open '${p}'`), { code: 'ENOENT' });

  let surfacesStorePath = path.join(os.tmpdir(), 'wmux-inventory-char-missing', 'surfaces.json');
  if (opts.store !== undefined) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-inventory-char-'));
    tmpDirs.push(dir);
    surfacesStorePath = path.join(dir, 'surfaces.json');
    fs.writeFileSync(surfacesStorePath, typeof opts.store === 'string' ? opts.store : JSON.stringify(opts.store));
  }

  return {
    homeDir: HOME,
    projectDir: opts.project === false ? undefined : PROJECT,
    surfacesStorePath,
    now: () => 1_700_000_000_000,
    run: opts.version === null ? undefined : async (cli) => `${cli} version ${opts.version ?? '2.1.0'}`,
    readFile: async (p) => {
      if (unreadable.has(p)) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      const content = files.get(p);
      if (content === undefined) throw enoent(p);
      return content;
    },
    readdir: async (p) => {
      const prefix = p.endsWith(path.sep) ? p : p + path.sep;
      const names = new Set<string>();
      for (const f of files.keys()) {
        if (f.startsWith(prefix)) names.add(f.slice(prefix.length).split(path.sep)[0]);
      }
      if (names.size === 0) throw enoent(p);
      return [...names].sort();
    },
  };
}

function portable(value: string): string {
  let s = value;
  for (const [abs, token] of [[HOME, '<home>'], [PROJECT, '<project>']] as const) {
    const fwd = abs.replace(/\\/g, '/');
    s = s.split(abs).join(token).split(fwd).join(token).split(fwd.toLowerCase()).join(token);
  }
  return s
    .replace(/\\/g, '/')
    .replace(/(Failed to parse (?:JSON|TOML) at [^:]+): .*/s, '$1: <parse error>')
    .replace(/#[0-9a-f]{12}(?=@|$)/, '#<hash>');
}

/** `portable` applied to every string inside a JSON value, keys untouched. */
function portableDeep(value: unknown): unknown {
  if (typeof value === 'string') return portable(value);
  if (Array.isArray(value)) return value.map(portableDeep);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, portableDeep(v)]));
  }
  return value;
}

function stable(inv: ProviderInventory, versions: Record<string, string>) {
  const swapVersions = (s: string) => Object.entries(versions).reduce((acc, [v, token]) => acc.split(v).join(token), s);
  const wmuxTools = inv.items.filter((i) => i.kind === 'mcp-tool' && i.parent === 'wmux');
  const wmuxHookNames = new Set(CODEX_HOOK_EVENTS.map((e) => `wmux-${e.toLowerCase()}`));
  const wmuxHooks = inv.items.filter((i) => inv.provider === 'codex' && i.kind === 'hook' && i.source === 'wmux' && wmuxHookNames.has(i.name));
  const items = inv.items
    .filter((i) => !(i.kind === 'mcp-tool' && i.parent === 'wmux' && !KEPT_WMUX_TOOLS.has(i.name)))
    .filter((i) => !(wmuxHooks.includes(i) && i !== wmuxHooks[0]))
    .map(portableDeep);
  return {
    provider: inv.provider,
    cliVersion: inv.cliVersion === null ? null : swapVersions(inv.cliVersion),
    versionSupported: inv.versionSupported,
    writable: inv.writable,
    scannedAtMs: inv.scannedAtMs,
    wmuxToolRows: wmuxTools.length === 0 ? 0 : wmuxTools.length === listWmuxToolNames().length ? 'all' : wmuxTools.length,
    wmuxCodexHookRows: wmuxHooks.length === 0 ? 0 : wmuxHooks.length === CODEX_HOOK_EVENTS.length ? 'all' : wmuxHooks.length,
    warnings: inv.warnings.map((w) => portable(swapVersions(w))),
    items,
  };
}

function golden(name: string, actual: unknown): void {
  const file = path.join(GOLDEN_DIR, `${name}.json`);
  if (RECORD) {
    fs.mkdirSync(GOLDEN_DIR, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(actual, null, 2) + '\n');
    return;
  }
  expect(actual).toEqual(JSON.parse(fs.readFileSync(file, 'utf8')));
}

const skill = (name: string | null, description = 'Does a thing.') =>
  name === null ? 'no frontmatter here\n' : `---\nname: ${name}\ndescription: ${description}\n  continued on a second line\n---\nbody\n`;

// ─── Claude ──────────────────────────────────────────────────────────────────

const CLAUDE_FULL: Tree = {
  '~/.claude/settings.json': JSON.stringify({
    deniedMcpServers: [{ serverName: 'denied-srv' }, { nope: 1 }, 'bad'],
    permissions: { deny: ['mcp__alpha__danger_tool', 'mcp__wmux__terminal_send', 'WebFetch', 42] },
    enabledPlugins: { 'plug-on@market': true, 'plug-off@market': false },
    skillOverrides: { 'user-skill': 'off', 'dir-only-skill': 'off', 'quoted-name': 'on', ignored: 3 },
    autoMemoryEnabled: false,
    skillListingBudgetFraction: 0.5,
    disableBundledSkills: true,
    hooks: {
      PreToolUse: [
        { matcher: 'Bash', hooks: [{ type: 'command', name: 'bash-guard', command: 'node guard.js' }, 'skip-me'] },
        { type: 'command', command: 'node ~/.wmux/hook.mjs' },
      ],
      Stop: { type: 'command', command: 'say done' },
      SessionStart: [{ hooks: [{ type: 'command', command: 'echo ctx', managed: true }] }],
      UserPromptSubmit: [{ hooks: [{ type: 'prompt', prompt: 'check intent' }] }],
      Notification: [null],
    },
  }),
  '~/.claude/settings.local.json': JSON.stringify({ permissions: { deny: ['mcp__beta__other_tool'] }, autoCompactEnabled: true }),
  '@/.claude/settings.json': JSON.stringify({
    hooks: { PostToolUse: [{ matcher: 'Edit', hooks: [{ type: 'agent', name: 'reviewer' }] }] },
    skillOverrides: { 'project-skill': 'on' },
  }),
  '@/.claude/settings.local.json': '{ not json',
  '~/.claude.json': JSON.stringify({
    mcpServers: { alpha: {}, 'denied-srv': {}, wmux: {} },
    projects: {
      [PROJECT]: { mcpServers: { beta: {}, wmux: {} }, disabledMcpServers: ['beta', 7] },
      '/elsewhere': { mcpServers: { never: {} } },
    },
  }),
  '@/.mcp.json': JSON.stringify({ mcpServers: { gamma: {} } }),
  '~/.claude/skills/user-skill/SKILL.md': skill('user-skill'),
  '~/.claude/skills/dir-only-skill/SKILL.md': skill(null),
  '~/.claude/skills/quoted/SKILL.md': skill("'quoted-name'", '"quoted desc"'),
  '~/.claude/skills/no-skill-md/README.md': 'x',
  '@/.claude/skills/project-skill/SKILL.md': skill('project-skill'),
  '@/.claude/skills/user-skill/SKILL.md': skill('user-skill'),
  '~/.claude/plugins/market/skills/plug-skill/SKILL.md': skill('plug-skill'),
  '~/.claude/plugins/empty-plugin/plugin.json': '{}',
};

const projectSettings = path.join(PROJECT, '.claude', 'settings.json');
const userSettings = path.join(HOME, '.claude', 'settings.json');
const CLAUDE_STORE = {
  version: 1,
  intents: {},
  removedHooks: {
    claude: [
      { id: 'claude:hook::removed-cmd#aaaaaaaaaaaa', originPath: userSettings, definition: { event: 'PreToolUse', groupMeta: { matcher: 'Write' }, handler: { type: 'command', name: 'removed-cmd', command: 'node lint.js' } } },
      { id: 'claude:hook::removed-fallback#bbbbbbbbbbbb', originPath: projectSettings, definition: { event: 'Stop', type: 'prompt', prompt: 'sum up' } },
      { id: 'claude:hook::stop-removed#222222222222', originPath: userSettings, definition: { event: 'Stop', handler: { command: 'say bye', args: ['a', 'b'] } } },
      { id: 'claude:hook::args-differ#333333333333', originPath: userSettings, definition: { event: 'PreToolUse', groupMeta: { matcher: 'Bash' }, handler: { type: 'command', name: 'bash-guard', command: 'node guard.js', args: ['x'] } } },
      { id: 'claude:hook::wmux-removed#cccccccccccc', originPath: null, definition: { handler: { command: 'node .wmux/x.mjs' } } },
      { id: 'claude:hook::managed-removed#dddddddddddd', definition: { event: 'SessionStart', handler: { command: 'echo', managed: true } } },
      { id: 'claude:hook::still-live#eeeeeeeeeeee', originPath: userSettings, definition: { event: 'PreToolUse', groupMeta: { matcher: 'Bash' }, handler: { type: 'command', name: 'bash-guard', command: 'node guard.js' } } },
      { id: 'claude:hook::removed-cmd#aaaaaaaaaaaa', originPath: userSettings, definition: { event: 'PreToolUse', handler: { command: 'dup' } } },
      { id: '   ', definition: { event: 'Stop' } },
      { id: 'claude:hook::bad-origin#ffffffffffff', originPath: 5, definition: { event: 'Stop' } },
      { id: 'claude:hook::no-def#111111111111', definition: [] },
      'not an object',
    ],
  },
};

describe('inventory characterization — claude', () => {
  it('full home + project, removed hooks in the store', async () => {
    const inv = await readClaudeInventory(virtualDeps(CLAUDE_FULL, { store: CLAUDE_STORE }));
    golden('claude-full', stable(inv, {}));
  });

  it('no CLI version: everything read-only; disableAllHooks; no project', async () => {
    const tree: Tree = {
      '~/.claude/settings.json': JSON.stringify({
        disableAllHooks: true,
        permissions: { deny: ['Bash'] },
        hooks: { PreToolUse: [{ hooks: [{ command: 'x' }] }] },
      }),
      '~/.claude.json': JSON.stringify({ mcpServers: { solo: {} } }),
      '~/.claude/skills/s/SKILL.md': skill('s'),
    };
    const inv = await readClaudeInventory(virtualDeps(tree, { version: null, project: false, store: CLAUDE_STORE }));
    golden('claude-unsupported', stable(inv, {}));
  });

  it('a corrupt store, an unreadable settings file, an unknown store version', async () => {
    const tree: Tree = { '~/.claude.json': JSON.stringify({ mcpServers: {} }) };
    const corrupt = await readClaudeInventory(virtualDeps(tree, { store: '{ corrupt', unreadable: ['~/.claude/settings.json'] }));
    const newer = await readClaudeInventory(virtualDeps(tree, { store: { version: 9, removedHooks: {} } }));
    const notArray = await readClaudeInventory(virtualDeps(tree, { store: { version: 1, removedHooks: { claude: { a: 1 } } } }));
    golden('claude-store-errors', { corrupt: stable(corrupt, {}), newer: stable(newer, {}), notArray: stable(notArray, {}) });
  });
});

// ─── Codex ───────────────────────────────────────────────────────────────────

const CODEX_TESTED = TESTED_CLI_VERSIONS.codex.max;
const codexHooksJson = path.join(HOME, '.codex', 'hooks.json');

const CODEX_CONFIG = [
  'notify = ["node", "/opt/wmux/wmux-codex-notify.mjs"]',
  'model_verbosity = "low"',
  'tool_output_token_limit = 9000',
  '',
  '[mcp_servers.wmux]',
  'command = "wmux"',
  'enabled_tools = ["terminal_read", "terminal_send"]',
  'disabled_tools = ["terminal_send"]',
  '',
  '[mcp_servers.alpha]',
  'command = "a"',
  'enabled = false',
  'disabled_tools = ["drop_me", 3]',
  'enabled_tools = ["keep_me"]',
  '',
  '[mcp_servers.beta]',
  'command = "b"',
  '',
  '[plugins.one]',
  'enabled = false',
  '',
  '[plugins.two]',
  '',
  '[[skills.config]]',
  'path = "../.agents/skills/off-skill"',
  'enabled = false',
  '',
  '[[skills.config]]',
  'path = "/somewhere/else"',
  'enabled = true',
  '',
  '[features]',
  'shell_tool = false',
  'multi_agent = true',
  'memories = true',
  'web_search = "disabled"',
  '',
  '[hooks.state]',
  `${JSON.stringify(codexHookStateKey(codexHooksJson, 'Stop', 1))} = { enabled = false }`,
  '"unrelated:key" = { enabled = true }',
  '"not-a-table" = 4',
  '',
  `# ${CODEX_HOOKS_MANAGED_MARKER}`,
  `# ${CODEX_HOOKS_MANAGED_END_MARKER}`,
  '',
].join('\n');

const CODEX_FULL: Tree = {
  '~/.codex/config.toml': CODEX_CONFIG,
  '~/.codex/hooks.json': JSON.stringify({
    'prompt-check': { event: 'UserPromptSubmit', command: 'node check.js' },
    'stop-guard': { type: 'Stop', command: 'node stop.js' },
    'wmux-bridge': { event: 'PostToolUse', command: 'node ~/.wmux/b.mjs', enabled: false },
    'no-event': { command: 'x' },
    broken: 'nope',
  }),
  '@/.codex/hooks.json': JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ command: 'grouped' }] }], other: { event: 'Notify' } } }),
  '~/.agents/skills/user-skill/SKILL.md': skill('user-skill'),
  '~/.agents/skills/off-skill/SKILL.md': skill('off-skill'),
  '@/.agents/skills/project-skill/SKILL.md': skill('project-skill'),
  '~/.codex/skills/.system/builtin-skill/SKILL.md': skill('builtin-skill'),
};

describe('inventory characterization — codex', () => {
  it('full config.toml, hooks files and skill roots on a tested version', async () => {
    const inv = await readCodexInventory(virtualDeps(CODEX_FULL, { version: CODEX_TESTED }));
    golden('codex-full', stable(inv, { [CODEX_TESTED]: '<tested>' }));
  });

  it('a newer version, a user notify, an unterminated wmux block, unknown hooks layout', async () => {
    const newer = `${CODEX_TESTED.split('.')[0]}.999.0`;
    const tree: Tree = {
      '~/.codex/config.toml': [
        'notify = ["python", "mine.py"]',
        '[skills]',
        'config = [{ path = "/abs/x", enabled = false }]',
        '[features]',
        'web_search = false',
        `# ${CODEX_HOOKS_MANAGED_MARKER}`,
      ].join('\n'),
      '~/.codex/hooks.json': '[1, 2]',
    };
    const inv = await readCodexInventory(virtualDeps(tree, { version: newer, project: false }));
    golden('codex-newer', stable(inv, { [newer]: '<newer>', [TESTED_CLI_VERSIONS.codex.max]: '<tested-max>' }));
  });

  it('unsupported version and an unparsable config.toml', async () => {
    const tree: Tree = { '~/.codex/config.toml': 'this is = = not toml', '~/.codex/hooks.json': JSON.stringify({ h: { event: 'Stop' } }) };
    const inv = await readCodexInventory(virtualDeps(tree, { version: '0.1.0', project: false }));
    golden('codex-unsupported', stable(inv, {}));
  });
});

// ─── agy ─────────────────────────────────────────────────────────────────────

const AGY_TESTED = TESTED_CLI_VERSIONS.agy.max;

const AGY_FULL: Tree = {
  '~/.gemini/config/mcp_config.json': JSON.stringify({
    mcpServers: { wmux: { disabledTools: ['terminal_send', 9] }, alpha: { disabled: true, disabledTools: ['drop_me'] }, beta: null },
  }),
  '@/.agents/mcp_config.json': JSON.stringify({ mcpServers: { wmux: {}, gamma: {} } }),
  '~/.gemini/config/skills.json': JSON.stringify({ exclude: ['excluded-dir', 5], entries: [{ exclude: ['by-name'] }, null, { exclude: 'x' }] }),
  '@/.agents/skills.json': '{ broken',
  '~/.gemini/config/skills/excluded-dir/SKILL.md': skill('excluded-dir'),
  '~/.gemini/config/skills/named/SKILL.md': skill('by-name'),
  '~/.gemini/antigravity-cli/skills/cli-skill/SKILL.md': skill(null),
  '@/.agents/skills/project-skill/SKILL.md': skill('project-skill'),
  '~/.gemini/config/config.json': JSON.stringify({ plugins: { 'state-off': { enabled: false }, 'state-on': { enabled: true } } }),
  '~/.gemini/config/plugins/state-off/plugin.json': JSON.stringify({ name: 'State Off' }),
  '~/.gemini/config/plugins/state-on/plugin.json': JSON.stringify({ disabled: true }),
  '~/.gemini/config/plugins/self-off/plugin.json': JSON.stringify({ disabled: true }),
  '~/.gemini/config/plugins/self-off/skills/plug-skill/SKILL.md': skill('plug-skill'),
  '~/.gemini/config/plugins/self-off/skills/excluded-dir/SKILL.md': skill('excluded-plug'),
  '~/.gemini/config/plugins/self-off/hooks.json': JSON.stringify({ 'plug-hook': { event: 'Stop', command: 'x' } }),
  '~/.gemini/config/plugins/no-manifest/README.md': 'x',
  '~/.gemini/antigravity-cli/plugins/bad-json/plugin.json': '{ nope',
  '@/.agents/plugins/proj-plugin/plugin.json': JSON.stringify({ name: 'Proj' }),
  '~/.gemini/antigravity-cli/builtin/skills/builtin-skill/SKILL.md': skill('builtin-skill'),
  '~/.gemini/antigravity-cli/builtin/skills/no-md/notes.txt': 'x',
  '~/.gemini/config/hooks.json': JSON.stringify({
    hooks: { pre: { event: 'PreInvocation', command: 'node pre.js' }, post: { type: 'PostInvocation', command: 'node ~/.wmux/p.mjs' }, off: { event: 'Other', enabled: false }, junk: 3 },
  }),
  '@/.agents/hooks.json': JSON.stringify({ stopper: { event: 'Stop' } }),
};

describe('inventory characterization — agy', () => {
  it('full home + project on a tested version', async () => {
    const inv = await readAgyInventory(virtualDeps(AGY_FULL, { version: AGY_TESTED }));
    golden('agy-full', stable(inv, { [AGY_TESTED]: '<tested>' }));
  });

  it('a newer version and an unsupported one, no project', async () => {
    const newer = `${AGY_TESTED.split('.')[0]}.9.0`;
    const tree: Tree = {
      '~/.gemini/config/mcp_config.json': JSON.stringify({ mcpServers: { only: {} } }),
      '~/.gemini/config/hooks.json': JSON.stringify({ h: { event: 'Stop' } }),
    };
    const newerInv = await readAgyInventory(virtualDeps(tree, { version: newer, project: false }));
    const oldInv = await readAgyInventory(virtualDeps(tree, { version: '0.0.1', project: false }));
    golden('agy-versions', {
      newer: stable(newerInv, { [newer]: '<newer>', [TESTED_CLI_VERSIONS.agy.max]: '<tested-max>' }),
      unsupported: stable(oldInv, {}),
    });
  });
});
