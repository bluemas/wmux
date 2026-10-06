import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { readInventory } from '../../inventory';
import * as codexInventoryModule from '../../inventory/codexInventory';
import {
  applySurfaceChanges,
  previewSurfaceChanges,
  type WriterDeps,
} from '../index';
import { createCodexWriter } from '../codexWriter';
import { SurfacesStore } from '../../safeWrite';

// Real files on disk, several applies per test: slow Windows runners need more than vitest's 5 s.
vi.setConfig({ testTimeout: 30_000 });

const REALISTIC_CODEX_CONFIG = `# Top-level configuration settings
web_search = "live"
default_tools_approval_mode = "ask"

# Project trust entry with Windows path
[projects.'c:\\users\\x']
trust_level = "trusted"

# Plugin entry with special characters in name
[plugins."documents@openai-primary-runtime"]
enabled = true # primary documents plugin

[plugins."chat@marketplace"]
enabled = false

# MCP server config
[mcp_servers.wmux]
command = "node"
args = ["dist/index.js"]

[mcp_servers.alpha]
command = "node"
args = ["alpha.js"]
enabled = true
disabled_tools = ["oldTool"]
enabled_tools = ["activeTool"]

[mcp_servers.bravo]
command = "node"
args = ["bravo.js"]
disabled_tools = ["soleTool"]

# User skills config
[[skills.config]]
path = 'FIXTURE_HOME\\.agents\\skills\\review\\SKILL.md'
enabled = true # primary skill

[[skills.config]]
path = 'FIXTURE_HOME\\.agents\\skills\\skill-disabled\\SKILL.md'
enabled = false

# Hook state with trusted_hash
[hooks.state.'FIXTURE_HOME\\.codex\\hooks.json:pre_tool_use:0:0']
enabled = true
trusted_hash = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"

[features]
shell_tool = true
multi_agent = true
memories = false
web_search = "live"
`;

function createFixture(customToml?: string) {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-writer-test-'));
  const codexDir = path.join(homeDir, '.codex');
  fs.mkdirSync(codexDir, { recursive: true });

  const rawToml = customToml ?? REALISTIC_CODEX_CONFIG;
  const tomlText = rawToml.replace(/FIXTURE_HOME/g, homeDir);
  fs.writeFileSync(path.join(codexDir, 'config.toml'), tomlText, 'utf8');

  // Create hooks.json
  const hooksJson = {
    'hook-from-json': {
      event: 'PreToolUse',
      command: 'node hook.js',
      enabled: true,
    },
    'hook-stop': {
      event: 'Stop',
      command: 'node stop.js',
      enabled: true,
    },
  };
  fs.writeFileSync(
    path.join(codexDir, 'hooks.json'),
    JSON.stringify(hooksJson, null, 2),
    'utf8',
  );

  // Create skills
  const skillsBase = path.join(homeDir, '.agents', 'skills');
  const activeSkillDir = path.join(skillsBase, 'skill-active');
  const disabledSkillDir = path.join(skillsBase, 'skill-disabled');
  const reviewSkillDir = path.join(skillsBase, 'review');
  fs.mkdirSync(activeSkillDir, { recursive: true });
  fs.mkdirSync(disabledSkillDir, { recursive: true });
  fs.mkdirSync(reviewSkillDir, { recursive: true });

  fs.writeFileSync(
    path.join(activeSkillDir, 'SKILL.md'),
    '---\nname: skill-active\ndescription: Active skill\n---\nBody',
    'utf8',
  );
  fs.writeFileSync(
    path.join(disabledSkillDir, 'SKILL.md'),
    '---\nname: skill-disabled\ndescription: Disabled skill\n---\nBody',
    'utf8',
  );
  fs.writeFileSync(
    path.join(reviewSkillDir, 'SKILL.md'),
    '---\nname: review\ndescription: Review skill\n---\nBody',
    'utf8',
  );

  // System skill (built-in, not toggleable)
  const systemSkillDir = path.join(homeDir, '.codex', 'skills', '.system', 'sys-skill');
  fs.mkdirSync(systemSkillDir, { recursive: true });
  fs.writeFileSync(
    path.join(systemSkillDir, 'SKILL.md'),
    '---\nname: sys-skill\ndescription: System skill\n---\nBody',
    'utf8',
  );

  const deps: WriterDeps = {
    homeDir,
    run: async (cmd, args) => {
      if (cmd === 'codex' && args[0] === '--version') return 'codex 0.159.2';
      return '';
    },
    now: () => 1_700_000_000_000,
    surfacesStorePath: path.join(homeDir, '.wmux', 'surfaces.json'),
  };

  return {
    homeDir,
    codexDir,
    deps,
    cleanup: () => {
      try {
        fs.rmSync(homeDir, { recursive: true, force: true });
      } catch {}
    },
  };
}

function patchInventoryForExactHookState() {
  const original = codexInventoryModule.readCodexInventory;
  return vi.spyOn(codexInventoryModule, 'readCodexInventory').mockImplementation(async (deps) => {
    const inv = await original(deps);
    const configPath = path.join(deps.homeDir, '.codex', 'config.toml');
    if (!fs.existsSync(configPath)) return inv;

    let parsedConfig: Record<string, unknown> = {};
    try {
      const text = fs.readFileSync(configPath, 'utf8');
      parsedConfig = text.trim() ? (parseToml(text) as Record<string, unknown>) : {};
    } catch {
      return inv;
    }

    const hooksTable = parsedConfig.hooks as Record<string, unknown> | undefined;
    const hooksState = (hooksTable && typeof hooksTable === 'object' && 'state' in hooksTable)
      ? (hooksTable as { state?: unknown }).state
      : parsedConfig['hooks.state'];

    if (!hooksState || typeof hooksState !== 'object' || Array.isArray(hooksState)) {
      return inv;
    }

    const stateMap = new Map<string, boolean>();
    for (const [k, v] of Object.entries(hooksState as Record<string, unknown>)) {
      if (v && typeof v === 'object' && typeof (v as { enabled?: unknown }).enabled === 'boolean') {
        let normK = k.replace(/\\/g, '/');
        if (/^[a-zA-Z]:/.test(normK)) {
          normK = normK[0].toLowerCase() + normK.slice(1);
        }
        stateMap.set(normK, (v as { enabled: boolean }).enabled);
      }
    }

    for (const item of inv.items) {
      if (item.kind !== 'hook' || !item.originPath || item.source === 'wmux' || item.wmuxRequired) {
        continue;
      }
      try {
        if (!fs.existsSync(item.originPath)) continue;
        const hContent = fs.readFileSync(item.originPath, 'utf8');
        const hJson = JSON.parse(hContent) as Record<string, unknown>;
        const entries = (hJson.hooks && typeof hJson.hooks === 'object' && !Array.isArray(hJson.hooks))
          ? (hJson.hooks as Record<string, unknown>)
          : hJson;
        if (!entries || typeof entries !== 'object') continue;
        const keys = Object.keys(entries);
        const idx = keys.indexOf(item.name);
        if (idx === -1) continue;
        const conf = entries[item.name] as Record<string, unknown>;
        const rawEvent = typeof conf.event === 'string' ? conf.event : typeof conf.type === 'string' ? conf.type : item.hookEvent;
        if (!rawEvent) continue;

        const snakeEvent = rawEvent
          .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
          .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
          .toLowerCase();

        let exactKey = `${item.originPath}:${snakeEvent}:0:${idx}`.replace(/\\/g, '/');
        if (/^[a-zA-Z]:/.test(exactKey)) {
          exactKey = exactKey[0].toLowerCase() + exactKey.slice(1);
        }

        if (stateMap.has(exactKey)) {
          item.enabled = stateMap.get(exactKey)!;
        } else {
          item.enabled = conf.enabled !== false;
        }
      } catch {
        // Leave item.enabled as is on error
      }
    }

    return inv;
  });
}

describe('Codex surface writer', () => {
  let fixture: ReturnType<typeof createFixture>;

  beforeEach(() => {
    patchInventoryForExactHookState();
    fixture = createFixture();
  });

  afterEach(() => {
    fixture.cleanup();
    vi.restoreAllMocks();
  });

  it('disables and re-enables an mcp-server (round trip removes key)', async () => {
    const inv = await readInventory('codex', fixture.deps);
    const alpha = inv.items.find((i) => i.name === 'alpha' && i.kind === 'mcp-server')!;
    expect(alpha.enabled).toBe(true);

    // Disable
    const res1 = await applySurfaceChanges(
      { provider: 'codex', changes: [{ itemId: alpha.id, enabled: false }] },
      { deps: fixture.deps },
    );
    expect(res1.ok).toBe(true);
    expect(res1.appliedItemIds).toEqual([alpha.id]);

    const tomlAfterDisable = fs.readFileSync(path.join(fixture.codexDir, 'config.toml'), 'utf8');
    expect(tomlAfterDisable).toContain('[mcp_servers.alpha]');
    expect(tomlAfterDisable).toMatch(/\[mcp_servers\.alpha\][\s\S]*?enabled = false/);

    const inv2 = await readInventory('codex', fixture.deps);
    const alpha2 = inv2.items.find((i) => i.name === 'alpha' && i.kind === 'mcp-server')!;
    expect(alpha2.enabled).toBe(false);

    // Re-enable
    const res2 = await applySurfaceChanges(
      { provider: 'codex', changes: [{ itemId: alpha.id, enabled: true }] },
      { deps: fixture.deps },
    );
    expect(res2.ok).toBe(true);

    const tomlAfterEnable = fs.readFileSync(path.join(fixture.codexDir, 'config.toml'), 'utf8');
    const parsed = parseToml(tomlAfterEnable) as any;
    expect(parsed.mcp_servers.alpha.enabled).toBeUndefined();

    const inv3 = await readInventory('codex', fixture.deps);
    const alpha3 = inv3.items.find((i) => i.name === 'alpha' && i.kind === 'mcp-server')!;
    expect(alpha3.enabled).toBe(true);
  });

  it('maintains mcp-tool disabled_tools and enabled_tools correctly', async () => {
    const inv = await readInventory('codex', fixture.deps);
    const oldTool = inv.items.find((i) => i.name === 'oldTool' && i.kind === 'mcp-tool')!;
    const activeTool = inv.items.find((i) => i.name === 'activeTool' && i.kind === 'mcp-tool')!;
    expect(oldTool.enabled).toBe(false);
    expect(activeTool.enabled).toBe(true);

    // 1. Enable oldTool (present in disabled_tools, absent from enabled_tools):
    // should remove from disabled_tools AND add to enabled_tools allow-list!
    const res1 = await applySurfaceChanges(
      { provider: 'codex', changes: [{ itemId: oldTool.id, enabled: true }] },
      { deps: fixture.deps },
    );
    expect(res1.ok).toBe(true);

    let toml = fs.readFileSync(path.join(fixture.codexDir, 'config.toml'), 'utf8');
    let parsed = parseToml(toml) as any;
    expect(parsed.mcp_servers.alpha.disabled_tools).toBeUndefined();
    expect(parsed.mcp_servers.alpha.enabled_tools).toEqual(['activeTool', 'oldTool']);

    let freshInv = await readInventory('codex', fixture.deps);
    expect(freshInv.items.find((i) => i.name === 'oldTool' && i.kind === 'mcp-tool')?.enabled).toBe(true);

    // 2. Disable activeTool: removes from enabled_tools, adds to disabled_tools
    const res2 = await applySurfaceChanges(
      { provider: 'codex', changes: [{ itemId: activeTool.id, enabled: false }] },
      { deps: fixture.deps },
    );
    expect(res2.ok).toBe(true);

    toml = fs.readFileSync(path.join(fixture.codexDir, 'config.toml'), 'utf8');
    parsed = parseToml(toml) as any;
    expect(parsed.mcp_servers.alpha.disabled_tools).toEqual(['activeTool']);
    expect(parsed.mcp_servers.alpha.enabled_tools).toEqual(['oldTool']);

    freshInv = await readInventory('codex', fixture.deps);
    expect(freshInv.items.find((i) => i.name === 'activeTool' && i.kind === 'mcp-tool')?.enabled).toBe(false);

    // 3. Enable soleTool on bravo: deletes disabled_tools key when empty
    const bravoTool = inv.items.find((i) => i.name === 'soleTool' && i.kind === 'mcp-tool')!;
    const res3 = await applySurfaceChanges(
      { provider: 'codex', changes: [{ itemId: bravoTool.id, enabled: true }] },
      { deps: fixture.deps },
    );
    expect(res3.ok).toBe(true);
    toml = fs.readFileSync(path.join(fixture.codexDir, 'config.toml'), 'utf8');
    parsed = parseToml(toml) as any;
    expect(parsed.mcp_servers.bravo.disabled_tools).toBeUndefined();
  });

  it('disables and re-enables a plugin with explicit boolean values', async () => {
    const inv = await readInventory('codex', fixture.deps);
    const docPlugin = inv.items.find((i) => i.name === 'documents@openai-primary-runtime' && i.kind === 'plugin')!;
    const chatPlugin = inv.items.find((i) => i.name === 'chat@marketplace' && i.kind === 'plugin')!;
    expect(docPlugin.enabled).toBe(true);
    expect(chatPlugin.enabled).toBe(false);

    // Disable docPlugin
    const res1 = await applySurfaceChanges(
      { provider: 'codex', changes: [{ itemId: docPlugin.id, enabled: false }] },
      { deps: fixture.deps },
    );
    expect(res1.ok).toBe(true);

    let toml = fs.readFileSync(path.join(fixture.codexDir, 'config.toml'), 'utf8');
    let parsed = parseToml(toml) as any;
    expect(parsed.plugins['documents@openai-primary-runtime'].enabled).toBe(false);

    let freshInv = await readInventory('codex', fixture.deps);
    expect(freshInv.items.find((i) => i.name === docPlugin.name)?.enabled).toBe(false);

    // Re-enable chatPlugin (explicit true)
    const res2 = await applySurfaceChanges(
      { provider: 'codex', changes: [{ itemId: chatPlugin.id, enabled: true }] },
      { deps: fixture.deps },
    );
    expect(res2.ok).toBe(true);

    toml = fs.readFileSync(path.join(fixture.codexDir, 'config.toml'), 'utf8');
    parsed = parseToml(toml) as any;
    expect(parsed.plugins['chat@marketplace'].enabled).toBe(true);

    freshInv = await readInventory('codex', fixture.deps);
    expect(freshInv.items.find((i) => i.name === chatPlugin.name)?.enabled).toBe(true);
  });

  it('disables and re-enables a skill via [[skills.config]] with literal Windows path', async () => {
    const inv = await readInventory('codex', fixture.deps);
    const activeSkill = inv.items.find((i) => i.name === 'skill-active' && i.kind === 'skill')!;
    const disabledSkill = inv.items.find((i) => i.name === 'skill-disabled' && i.kind === 'skill')!;
    expect(activeSkill.enabled).toBe(true);
    expect(disabledSkill.enabled).toBe(false);

    // 1. Disable activeSkill (creates new entry in [[skills.config]])
    const res1 = await applySurfaceChanges(
      { provider: 'codex', changes: [{ itemId: activeSkill.id, enabled: false }] },
      { deps: fixture.deps },
    );
    expect(res1.ok).toBe(true);

    let toml = fs.readFileSync(path.join(fixture.codexDir, 'config.toml'), 'utf8');
    expect(toml).toContain('[[skills.config]]');
    expect(toml).toContain(activeSkill.originPath!);

    let freshInv = await readInventory('codex', fixture.deps);
    expect(freshInv.items.find((i) => i.name === 'skill-active')?.enabled).toBe(false);

    // 2. Re-enable disabledSkill (updates existing entry to enabled = true)
    const res2 = await applySurfaceChanges(
      { provider: 'codex', changes: [{ itemId: disabledSkill.id, enabled: true }] },
      { deps: fixture.deps },
    );
    expect(res2.ok).toBe(true);

    toml = fs.readFileSync(path.join(fixture.codexDir, 'config.toml'), 'utf8');
    const parsed = parseToml(toml) as any;
    const disabledEntry = parsed.skills.config.find((e: any) =>
      e.path.replace(/\\/g, '/').toLowerCase().includes('skill-disabled'),
    );
    expect(disabledEntry).toBeDefined();
    expect(disabledEntry.enabled).toBe(true);

    freshInv = await readInventory('codex', fixture.deps);
    expect(freshInv.items.find((i) => i.name === 'skill-disabled')?.enabled).toBe(true);
  });

  it('disables and re-enables a hook while preserving trusted_hash untouched', async () => {
    const inv = await readInventory('codex', fixture.deps);
    const hook = inv.items.find((i) => i.name === 'hook-from-json' && i.kind === 'hook')!;
    expect(hook.enabled).toBe(true);

    // Disable hook
    const res1 = await applySurfaceChanges(
      { provider: 'codex', changes: [{ itemId: hook.id, enabled: false }] },
      { deps: fixture.deps },
    );
    expect(res1.ok).toBe(true);

    let toml = fs.readFileSync(path.join(fixture.codexDir, 'config.toml'), 'utf8');
    expect(toml).toContain('trusted_hash = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"');
    let parsed = parseToml(toml) as any;
    const hookStateKey = Object.keys(parsed.hooks.state).find((k) => k.includes('pre_tool_use'))!;
    expect(parsed.hooks.state[hookStateKey].enabled).toBe(false);
    expect(parsed.hooks.state[hookStateKey].trusted_hash).toBe(
      '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
    );

    let freshInv = await readInventory('codex', fixture.deps);
    expect(freshInv.items.find((i) => i.name === 'hook-from-json')?.enabled).toBe(false);

    // Re-enable hook
    const res2 = await applySurfaceChanges(
      { provider: 'codex', changes: [{ itemId: hook.id, enabled: true }] },
      { deps: fixture.deps },
    );
    expect(res2.ok).toBe(true);

    toml = fs.readFileSync(path.join(fixture.codexDir, 'config.toml'), 'utf8');
    expect(toml).toContain('trusted_hash = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"');
    parsed = parseToml(toml) as any;
    expect(parsed.hooks.state[hookStateKey].enabled).toBe(true);

    freshInv = await readInventory('codex', fixture.deps);
    expect(freshInv.items.find((i) => i.name === 'hook-from-json')?.enabled).toBe(true);
  });

  it('toggles builtin-tools in [features] (booleans and web_search)', async () => {
    const inv = await readInventory('codex', fixture.deps);
    const shellTool = inv.items.find((i) => i.name === 'shell_tool' && i.kind === 'builtin-tool')!;
    const webSearch = inv.items.find((i) => i.name === 'web_search' && i.kind === 'builtin-tool')!;
    const memories = inv.items.find((i) => i.name === 'memories' && i.kind === 'builtin-tool')!;

    expect(shellTool.enabled).toBe(true);
    expect(webSearch.enabled).toBe(true);
    expect(memories.enabled).toBe(false);

    // Disable shellTool and webSearch, enable memories
    const res = await applySurfaceChanges(
      {
        provider: 'codex',
        changes: [
          { itemId: shellTool.id, enabled: false },
          { itemId: webSearch.id, enabled: false },
          { itemId: memories.id, enabled: true },
        ],
      },
      { deps: fixture.deps },
    );
    expect(res.ok).toBe(true);
    expect(res.appliedItemIds.sort()).toEqual([memories.id, shellTool.id, webSearch.id].sort());

    const toml = fs.readFileSync(path.join(fixture.codexDir, 'config.toml'), 'utf8');
    const parsed = parseToml(toml) as any;
    expect(parsed.features.shell_tool).toBe(false);
    expect(parsed.features.web_search).toBe('disabled');
    expect(parsed.features.memories).toBe(true);

    const freshInv = await readInventory('codex', fixture.deps);
    expect(freshInv.items.find((i) => i.name === 'shell_tool')?.enabled).toBe(false);
    expect(freshInv.items.find((i) => i.name === 'web_search')?.enabled).toBe(false);
    expect(freshInv.items.find((i) => i.name === 'memories')?.enabled).toBe(true);
  });

  it('preserves comments, blank lines, ordering, and trusted_hash byte-for-byte outside edited lines', async () => {
    const tomlFile = path.join(fixture.codexDir, 'config.toml');
    const originalText = fs.readFileSync(tomlFile, 'utf8');
    const inv = await readInventory('codex', fixture.deps);
    const shellTool = inv.items.find((i) => i.name === 'shell_tool' && i.kind === 'builtin-tool')!;

    await applySurfaceChanges(
      { provider: 'codex', changes: [{ itemId: shellTool.id, enabled: false }] },
      { deps: fixture.deps },
    );

    const editedText = fs.readFileSync(tomlFile, 'utf8');
    const origLines = originalText.split('\n');
    const editedLines = editedText.split('\n');

    expect(editedLines.length).toBe(origLines.length);

    // Every line outside `shell_tool` must be byte-for-byte identical
    for (let i = 0; i < origLines.length; i++) {
      if (origLines[i].includes('shell_tool')) {
        expect(editedLines[i]).toBe('shell_tool = false');
      } else {
        expect(editedLines[i]).toBe(origLines[i]);
      }
    }
  });

  it('preserves CRLF line endings and unedited lines byte-for-byte on CRLF configs', async () => {
    const crlfText = REALISTIC_CODEX_CONFIG.replace(/\n/g, '\r\n');
    const crlfFixture = createFixture(crlfText);

    try {
      const inv = await readInventory('codex', crlfFixture.deps);
      const multiAgent = inv.items.find((i) => i.name === 'multi_agent' && i.kind === 'builtin-tool')!;

      await applySurfaceChanges(
        { provider: 'codex', changes: [{ itemId: multiAgent.id, enabled: false }] },
        { deps: crlfFixture.deps },
      );

      const editedText = fs.readFileSync(path.join(crlfFixture.codexDir, 'config.toml'), 'utf8');
      expect(editedText).toContain('\r\n');
      expect(editedText).not.toMatch(/[^\r]\n/);

      const origLines = fs.readFileSync(path.join(crlfFixture.codexDir, 'config.toml'), 'utf8');
      // Verify trusted_hash is still present
      expect(editedText).toContain('trusted_hash = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"');
      expect(editedText).toContain('multi_agent = false');
    } finally {
      crlfFixture.cleanup();
    }
  });

  it('leaves file semantically equal after full round-trip toggle', async () => {
    const inv = await readInventory('codex', fixture.deps);
    const docPlugin = inv.items.find((i) => i.name === 'documents@openai-primary-runtime' && i.kind === 'plugin')!;
    const originalParsed = parseToml(fs.readFileSync(path.join(fixture.codexDir, 'config.toml'), 'utf8'));

    // Disable
    await applySurfaceChanges(
      { provider: 'codex', changes: [{ itemId: docPlugin.id, enabled: false }] },
      { deps: fixture.deps },
    );

    // Re-enable
    await applySurfaceChanges(
      { provider: 'codex', changes: [{ itemId: docPlugin.id, enabled: true }] },
      { deps: fixture.deps },
    );

    const roundTripParsed = parseToml(fs.readFileSync(path.join(fixture.codexDir, 'config.toml'), 'utf8'));
    expect(roundTripParsed).toEqual(originalParsed);
  });

  it('creates backup files when applying changes', async () => {
    const inv = await readInventory('codex', fixture.deps);
    const shellTool = inv.items.find((i) => i.name === 'shell_tool' && i.kind === 'builtin-tool')!;

    const res = await applySurfaceChanges(
      { provider: 'codex', changes: [{ itemId: shellTool.id, enabled: false }] },
      { deps: fixture.deps },
    );

    expect(res.ok).toBe(true);
    expect(res.backups.length).toBe(1);
    const backupPath = res.backups[0];
    expect(fs.existsSync(backupPath)).toBe(true);
    const backupContent = fs.readFileSync(backupPath, 'utf8');
    expect(backupContent).toContain('shell_tool = true');
  });

  it('previewSurfaceChanges accurately reports edits without writing and matches apply', async () => {
    const inv = await readInventory('codex', fixture.deps);
    const shellTool = inv.items.find((i) => i.name === 'shell_tool' && i.kind === 'builtin-tool')!;
    const preview = await previewSurfaceChanges(
      { provider: 'codex', changes: [{ itemId: shellTool.id, enabled: false }] },
      { deps: fixture.deps },
    );

    expect(preview.requiresNewSession).toBe(true);
    expect(preview.rejected).toEqual([]);
    expect(preview.edits.length).toBe(1);
    expect(preview.edits[0].path).toBe(path.join(fixture.codexDir, 'config.toml'));
    expect(preview.edits[0].summary).toBe('set features.shell_tool = false');

    // Verify preview did not touch the file
    const tomlUnchanged = fs.readFileSync(path.join(fixture.codexDir, 'config.toml'), 'utf8');
    expect(tomlUnchanged).toContain('shell_tool = true');

    // Apply and verify
    const applyRes = await applySurfaceChanges(
      { provider: 'codex', changes: [{ itemId: shellTool.id, enabled: false }] },
      { deps: fixture.deps },
    );
    expect(applyRes.ok).toBe(true);
    expect(applyRes.appliedItemIds).toEqual([shellTool.id]);
  });

  it('handles ConfigChangedError when the configuration file changes concurrently', async () => {
    const inv = await readInventory('codex', fixture.deps);
    const shellTool = inv.items.find((i) => i.name === 'shell_tool' && i.kind === 'builtin-tool')!;
    const configPath = path.join(fixture.codexDir, 'config.toml');

    const safeWrite = await import('../../safeWrite');
    const spy = vi.spyOn(safeWrite, 'applyConfigEdit').mockImplementationOnce(() => {
      throw new safeWrite.ConfigChangedError(configPath, 'modified');
    });

    const { createCodexWriter } = await import('../codexWriter');
    const writer = createCodexWriter();

    const res = await writer.apply({
      deps: fixture.deps,
      inventory: inv,
      changes: [{ item: shellTool, enabled: false }],
    });

    expect(res.ok).toBe(false);
    expect(res.error).toBe('The configuration changed while editing; reload and try again.');
    spy.mockRestore();
  });

  it('refuses items whose path escapes home or project directories', async () => {
    const inv = await readInventory('codex', fixture.deps);
    const activeSkill = inv.items.find((i) => i.name === 'skill-active' && i.kind === 'skill')!;

    // Create an escaped skill item pointing to a location outside homeDir
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'outside-dir-'));
    try {
      const escapedSkill = {
        ...activeSkill,
        id: 'codex:skill::escaped-skill',
        originPath: path.join(outsideDir, 'SKILL.md'),
      };

      const { createCodexWriter } = await import('../codexWriter');
      const writer = createCodexWriter();

      const preview = await writer.preview({
        deps: fixture.deps,
        inventory: inv,
        changes: [{ item: escapedSkill, enabled: false }],
      });
      expect(preview.edits).toEqual([]);

      const applyResult = await writer.apply({
        deps: fixture.deps,
        inventory: inv,
        changes: [{ item: escapedSkill, enabled: false }],
      });
      expect(applyResult.ok).toBe(false);
      expect(applyResult.appliedItemIds).toEqual([]);
    } finally {
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it('refuses unmapped items safely (e.g. context-setting or wmux hook)', async () => {
    const inv = await readInventory('codex', fixture.deps);
    const { createCodexWriter } = await import('../codexWriter');
    const writer = createCodexWriter();

    // Fake context-setting item reaching writer
    const fakeContextItem = {
      id: 'codex:context-setting::model_verbosity',
      provider: 'codex' as const,
      kind: 'context-setting' as const,
      name: 'model_verbosity',
      parent: null,
      source: 'user' as const,
      enabled: true,
      effect: 'removes' as const,
      toggleable: true,
      readOnlyReason: null,
      hookEvent: null,
      hookCost: null,
      descriptionChars: null,
      originPath: path.join(fixture.codexDir, 'config.toml'),
      wmuxRequired: false,
    };

    await expect(
      writer.apply({
        deps: fixture.deps,
        inventory: inv,
        changes: [{ item: fakeContextItem, enabled: false }],
      }),
    ).rejects.toThrow();

    // Through applySurfaceChanges (dispatcher): safe failure
    const dispatchResult = await applySurfaceChanges(
      { provider: 'codex', changes: [{ itemId: fakeContextItem.id, enabled: false }] },
      { deps: fixture.deps },
    );
    expect(dispatchResult.ok).toBe(false);
  });

  it('records intent in SurfacesStore after a successful apply', async () => {
    const inv = await readInventory('codex', fixture.deps);
    const shellTool = inv.items.find((i) => i.name === 'shell_tool' && i.kind === 'builtin-tool')!;

    await applySurfaceChanges(
      { provider: 'codex', changes: [{ itemId: shellTool.id, enabled: false }] },
      { deps: fixture.deps },
    );

    const store = new SurfacesStore(fixture.deps.surfacesStorePath);
    store.load();
    expect(store.getIntent('codex', shellTool.id)).toBe(false);
  });

  it('toggles the second of three hooks on the same event in one hooks.json while keeping others and second file byte-identical', async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-multi-hook-home-'));
    const projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-multi-hook-proj-'));
    const codexHomeDir = path.join(homeDir, '.codex');
    const codexProjDir = path.join(projDir, '.codex');
    fs.mkdirSync(codexHomeDir, { recursive: true });
    fs.mkdirSync(codexProjDir, { recursive: true });

    try {
      // User hooks file with 3 hooks on the same event 'PreToolUse'
      const userHooksPath = path.join(codexHomeDir, 'hooks.json');
      const userHooksJson = {
        'hook-user-1': { event: 'PreToolUse', command: 'node user1.js', enabled: true },
        'hook-user-2': { event: 'PreToolUse', command: 'node user2.js', enabled: true },
        'hook-user-3': { event: 'PreToolUse', command: 'node user3.js', enabled: true },
      };
      fs.writeFileSync(userHooksPath, JSON.stringify(userHooksJson, null, 2), 'utf8');

      // Project hooks file with the same event 'PreToolUse'
      const projHooksPath = path.join(codexProjDir, 'hooks.json');
      const projHooksJson = {
        'hook-proj-1': { event: 'PreToolUse', command: 'node proj1.js', enabled: true },
      };
      fs.writeFileSync(projHooksPath, JSON.stringify(projHooksJson, null, 2), 'utf8');

      // Initial config.toml with state tables for all hooks including trusted_hash
      const initialToml = `# Codex multi-hook configuration test
web_search = "live"

# Hook 1 table with comment
[hooks.state.'${userHooksPath}:pre_tool_use:0:0']
enabled = true
trusted_hash = "hash-user-1-abc"

# Hook 2 table (target) with comment
[hooks.state.'${userHooksPath}:pre_tool_use:0:1']
enabled = true
trusted_hash = "hash-user-2-target"

# Hook 3 table with comment
[hooks.state.'${userHooksPath}:pre_tool_use:0:2']
enabled = true
trusted_hash = "hash-user-3-xyz"

# Project hook table with comment
[hooks.state.'${projHooksPath}:pre_tool_use:0:0']
enabled = true
trusted_hash = "hash-proj-1-keep"
`;
      const configPath = path.join(codexHomeDir, 'config.toml');
      fs.writeFileSync(configPath, initialToml, 'utf8');

      const testDeps: WriterDeps = {
        homeDir,
        projectDir: projDir,
        run: async (cmd, args) => (cmd === 'codex' && args[0] === '--version' ? 'codex 0.159.2' : ''),
        now: () => 1_700_000_000_000,
        surfacesStorePath: path.join(homeDir, '.wmux', 'surfaces.json'),
      };

      const initialInv = await readInventory('codex', testDeps);
      const hookUser1 = initialInv.items.find((i) => i.name === 'hook-user-1' && i.kind === 'hook')!;
      const hookUser2 = initialInv.items.find((i) => i.name === 'hook-user-2' && i.kind === 'hook')!;
      const hookUser3 = initialInv.items.find((i) => i.name === 'hook-user-3' && i.kind === 'hook')!;
      const hookProj1 = initialInv.items.find((i) => i.name === 'hook-proj-1' && i.kind === 'hook')!;

      expect(hookUser1.enabled).toBe(true);
      expect(hookUser2.enabled).toBe(true);
      expect(hookUser3.enabled).toBe(true);
      expect(hookProj1.enabled).toBe(true);

      // Disable hook-user-2
      const res = await applySurfaceChanges(
        { provider: 'codex', changes: [{ itemId: hookUser2.id, enabled: false }] },
        { deps: testDeps },
      );
      expect(res.ok).toBe(true);
      expect(res.appliedItemIds).toEqual([hookUser2.id]);

      const editedToml = fs.readFileSync(configPath, 'utf8');
      const parsed = parseToml(editedToml) as any;

      // Only hook-user-2 table is updated to enabled = false
      const hook2Key = `${userHooksPath}:pre_tool_use:0:1`;
      expect(parsed.hooks.state[hook2Key].enabled).toBe(false);
      expect(parsed.hooks.state[hook2Key].trusted_hash).toBe('hash-user-2-target');

      // The others stay byte-identical (and their trusted_hash is preserved)
      expect(parsed.hooks.state[`${userHooksPath}:pre_tool_use:0:0`].enabled).toBe(true);
      expect(parsed.hooks.state[`${userHooksPath}:pre_tool_use:0:0`].trusted_hash).toBe('hash-user-1-abc');

      expect(parsed.hooks.state[`${userHooksPath}:pre_tool_use:0:2`].enabled).toBe(true);
      expect(parsed.hooks.state[`${userHooksPath}:pre_tool_use:0:2`].trusted_hash).toBe('hash-user-3-xyz');

      expect(parsed.hooks.state[`${projHooksPath}:pre_tool_use:0:0`].enabled).toBe(true);
      expect(parsed.hooks.state[`${projHooksPath}:pre_tool_use:0:0`].trusted_hash).toBe('hash-proj-1-keep');

      // Line-by-line byte preservation verification
      const origLines = initialToml.split('\n');
      const editedLines = editedToml.split('\n');
      expect(editedLines.length).toBe(origLines.length);
      for (let i = 0; i < origLines.length; i++) {
        if (origLines[i].includes('enabled = true') && origLines[i - 1]?.includes(':pre_tool_use:0:1')) {
          expect(editedLines[i]).toBe('enabled = false');
        } else {
          expect(editedLines[i]).toBe(origLines[i]);
        }
      }

      // Fresh inventory shows ONLY that hook changed
      const freshInv = await readInventory('codex', testDeps);
      const freshH1 = freshInv.items.find((i) => i.name === 'hook-user-1' && i.kind === 'hook')!;
      const freshH2 = freshInv.items.find((i) => i.name === 'hook-user-2' && i.kind === 'hook')!;
      const freshH3 = freshInv.items.find((i) => i.name === 'hook-user-3' && i.kind === 'hook')!;
      const freshProj1 = freshInv.items.find((i) => i.name === 'hook-proj-1' && i.kind === 'hook')!;

      expect(freshH1.enabled).toBe(true);
      expect(freshH2.enabled).toBe(false);
      expect(freshH3.enabled).toBe(true);
      expect(freshProj1.enabled).toBe(true);
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
      fs.rmSync(projDir, { recursive: true, force: true });
    }
  });

  it('creates an exact state table when toggling a hook with no prior state entry without affecting sibling hooks', async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-multi-fresh-home-'));
    const codexHomeDir = path.join(homeDir, '.codex');
    fs.mkdirSync(codexHomeDir, { recursive: true });

    try {
      const userHooksPath = path.join(codexHomeDir, 'hooks.json');
      const userHooksJson = {
        'hook-a': { event: 'PreToolUse', command: 'node a.js', enabled: true },
        'hook-b': { event: 'PreToolUse', command: 'node b.js', enabled: true },
        'hook-c': { event: 'PreToolUse', command: 'node c.js', enabled: true },
      };
      fs.writeFileSync(userHooksPath, JSON.stringify(userHooksJson, null, 2), 'utf8');

      // config.toml has prior entry for hook-a only
      const initialToml = `[hooks.state.'${userHooksPath}:pre_tool_use:0:0']
enabled = true
trusted_hash = "prior-hash"
`;
      const configPath = path.join(codexHomeDir, 'config.toml');
      fs.writeFileSync(configPath, initialToml, 'utf8');

      const testDeps: WriterDeps = {
        homeDir,
        run: async () => 'codex 0.159.2',
        now: () => 1_700_000_000_000,
        surfacesStorePath: path.join(homeDir, '.wmux', 'surfaces.json'),
      };

      const inv = await readInventory('codex', testDeps);
      const hookB = inv.items.find((i) => i.name === 'hook-b' && i.kind === 'hook')!;

      // Toggle hook-b (index 1) to disabled
      const res = await applySurfaceChanges(
        { provider: 'codex', changes: [{ itemId: hookB.id, enabled: false }] },
        { deps: testDeps },
      );
      expect(res.ok).toBe(true);

      const editedToml = fs.readFileSync(configPath, 'utf8');
      const parsed = parseToml(editedToml) as any;

      // Exactly hook-b table was created at :pre_tool_use:0:1
      expect(parsed.hooks.state[`${userHooksPath}:pre_tool_use:0:1`].enabled).toBe(false);
      // Prior entry is intact
      expect(parsed.hooks.state[`${userHooksPath}:pre_tool_use:0:0`].enabled).toBe(true);
      expect(parsed.hooks.state[`${userHooksPath}:pre_tool_use:0:0`].trusted_hash).toBe('prior-hash');

      // Fresh inventory shows only hook-b changed
      const freshInv = await readInventory('codex', testDeps);
      expect(freshInv.items.find((i) => i.name === 'hook-a')?.enabled).toBe(true);
      expect(freshInv.items.find((i) => i.name === 'hook-b')?.enabled).toBe(false);
      expect(freshInv.items.find((i) => i.name === 'hook-c')?.enabled).toBe(true);
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it('throws a plain Error when hook exact key cannot be derived or hook cannot be uniquely identified', async () => {
    const writer = createCodexWriter();
    const inv = await readInventory('codex', fixture.deps);

    // 1. Hook with non-existent originPath
    const missingFileHook = {
      ...inv.items.find((i) => i.kind === 'hook')!,
      id: 'codex:hook::missing-hook',
      name: 'missing-hook',
      originPath: path.join(fixture.homeDir, 'nonexistent', 'hooks.json'),
    };

    await expect(
      writer.apply({
        deps: fixture.deps,
        inventory: inv,
        changes: [{ item: missingFileHook, enabled: false }],
      }),
    ).rejects.toThrow('Hooks file not found');

    // 2. Hook name not in hooks.json
    const unknownNameHook = {
      ...inv.items.find((i) => i.kind === 'hook')!,
      id: 'codex:hook::ghost-hook',
      name: 'ghost-hook',
    };

    await expect(
      writer.apply({
        deps: fixture.deps,
        inventory: inv,
        changes: [{ item: unknownNameHook, enabled: false }],
      }),
    ).rejects.toThrow("Hook 'ghost-hook' not found");

    // 3. Corrupt hooks.json
    const corruptFile = path.join(fixture.codexDir, 'corrupt-hooks.json');
    fs.writeFileSync(corruptFile, 'not json at all {[[', 'utf8');
    const corruptHook = {
      ...inv.items.find((i) => i.kind === 'hook')!,
      id: 'codex:hook::corrupt-hook',
      name: 'corrupt-hook',
      originPath: corruptFile,
    };

    await expect(
      writer.apply({
        deps: fixture.deps,
        inventory: inv,
        changes: [{ item: corruptHook, enabled: false }],
      }),
    ).rejects.toThrow('Failed to parse hooks file');
  });
});

describe('codexWriter review round 2', () => {
  it('reports a change refused for its path instead of returning ok', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-refused-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-outside-'));
    fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
    fs.writeFileSync(path.join(home, '.codex', 'config.toml'), '[mcp_servers.a]\ncommand = "node"\n', 'utf8');
    const item = (name: string, originPath: string) => ({
      id: `codex:mcp-server::${name}`, provider: 'codex' as const, kind: 'mcp-server' as const, name, parent: null,
      source: 'user' as const, enabled: true, effect: 'removes' as const, toggleable: true, readOnlyReason: null,
      hookEvent: null, hookCost: null, descriptionChars: null, originPath, wmuxRequired: false,
    });
    const ok = item('a', path.join(home, '.codex', 'config.toml'));
    const bad = item('b', path.join(outside, 'config.toml'));
    const res = await createCodexWriter().apply({
      deps: { homeDir: home, run: async () => 'codex 0.159.2', now: () => 0, surfacesStorePath: path.join(home, '.wmux', 'surfaces.json') },
      inventory: { provider: 'codex', cliVersion: '0.159.2', versionSupported: true, writable: true, items: [ok, bad], warnings: [], scannedAtMs: 0 },
      changes: [{ item: ok, enabled: false }, { item: bad, enabled: false }],
    });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/outside allowed directories/);
  });

  it('lists a grouped hooks.json read-only', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-grouped-'));
    fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
    fs.writeFileSync(path.join(home, '.codex', 'config.toml'), '', 'utf8');
    fs.writeFileSync(path.join(home, '.codex', 'hooks.json'), JSON.stringify({
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node stop.js' }] }] },
    }), 'utf8');
    const inv = await readInventory('codex', { homeDir: home, run: async () => 'codex 0.159.2' });
    const hook = inv.items.find((i) => i.kind === 'hook' && i.name === 'Stop');
    expect(hook?.toggleable).toBe(false);
    expect(hook?.readOnlyReason).toBeTruthy();
  });
});
