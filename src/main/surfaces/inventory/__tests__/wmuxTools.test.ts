import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { CORE_TOOL_SURFACE } from '../../../../shared/coreSurface';
import { applySurfaceChanges, type WriterDeps } from '../../writers';
import { readInventory } from '../index';
import { makeItem, type InventoryDeps } from '../types';
import { listWmuxToolNames, resolveEffectiveWmuxServer, wmuxToolItems } from '../wmuxTools';

function makeDeps(homeDir: string, projectDir?: string): InventoryDeps & WriterDeps {
  return {
    homeDir,
    projectDir,
    now: () => 1_000,
    run: async (cmd: string) => {
      if (cmd === 'codex') return '0.159.2';
      if (cmd === 'agy') return '1.2.14';
      return '1.0.5';
    },
    surfacesStorePath: path.join(homeDir, '.wmux', 'surfaces.json'),
  };
}

describe('wmuxTools helper', () => {
  it('listWmuxToolNames returns CORE_TOOL_SURFACE', () => {
    const list = listWmuxToolNames();
    expect(list).toEqual(CORE_TOOL_SURFACE);
    expect(list.length).toBeGreaterThan(0);
  });

  it('wmuxToolItems builds one mcp-tool per tool with correct defaults', () => {
    const serverItem = makeItem({
      provider: 'claude',
      kind: 'mcp-server',
      name: 'wmux',
      source: 'wmux',
      enabled: true,
      effect: 'removes',
      toggleable: true,
      originPath: '/home/user/.claude.json',
      wmuxRequired: true,
    });

    const items = wmuxToolItems('claude', serverItem, new Set(['terminal_send']));
    expect(items).toHaveLength(CORE_TOOL_SURFACE.length);

    for (const item of items) {
      expect(item.provider).toBe('claude');
      expect(item.kind).toBe('mcp-tool');
      expect(item.parent).toBe('wmux');
      expect(item.source).toBe('wmux');
      expect(item.wmuxRequired).toBe(false);
      expect(item.toggleable).toBe(true);
      expect(item.effect).toBe('removes');
      expect(item.originPath).toBe('/home/user/.claude.json');
      if (item.name === 'terminal_send') {
        expect(item.enabled).toBe(false);
      } else {
        expect(item.enabled).toBe(true);
      }
    }

    const ids = new Set(items.map((i) => i.id));
    expect(ids.size).toBe(items.length);
  });

  it('resolveEffectiveWmuxServer enforces project > user > plugin precedence and deterministic warning', () => {
    expect(resolveEffectiveWmuxServer([])).toBeNull();

    const dummyItem = makeItem({
      provider: 'claude',
      kind: 'mcp-server',
      name: 'wmux',
      source: 'wmux',
      enabled: true,
      effect: 'removes',
      toggleable: true,
      originPath: '/home/.claude.json',
      wmuxRequired: true,
    });

    const userDecl = {
      source: 'user' as const,
      serverItem: { ...dummyItem, originPath: '/user/config.json' },
      disabledNames: new Set<string>(),
      originPath: '/user/config.json',
    };
    const projDecl = {
      source: 'project' as const,
      serverItem: { ...dummyItem, originPath: '/proj/config.json' },
      disabledNames: new Set<string>(['terminal_send']),
      originPath: '/proj/config.json',
    };
    const pluginDecl = {
      source: 'plugin' as const,
      serverItem: { ...dummyItem, originPath: '/plugin/config.json' },
      disabledNames: new Set<string>(),
      originPath: '/plugin/config.json',
    };

    // Single declaration -> no warning
    const single = resolveEffectiveWmuxServer([userDecl]);
    expect(single?.effective.source).toBe('user');
    expect(single?.warning).toBeNull();

    // User + Project -> Project wins, warning produced
    const projWins = resolveEffectiveWmuxServer([userDecl, projDecl]);
    expect(projWins?.effective.source).toBe('project');
    expect(projWins?.effective.originPath).toBe('/proj/config.json');
    expect(projWins?.warning).toBe('wmux is declared in several places; tool switches apply to project');

    // User + Plugin -> User wins, warning produced
    const userWins = resolveEffectiveWmuxServer([pluginDecl, userDecl]);
    expect(userWins?.effective.source).toBe('user');
    expect(userWins?.warning).toBe('wmux is declared in several places; tool switches apply to user');
  });
});

describe('provider inventory wmux tools', () => {
  it('claude: wmux tools enabled by default, disabled via permissions.deny, no duplicates, no tools if no server', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-wmux-test-'));
    try {
      const deps = makeDeps(tempDir);

      // Scenario A: No wmux server in config
      await fs.writeFile(path.join(tempDir, '.claude.json'), JSON.stringify({ mcpServers: {} }), 'utf8');
      const invA = await readInventory('claude', deps);
      expect(invA.items.filter((i) => i.parent === 'wmux')).toHaveLength(0);

      // Scenario B: wmux server present + 1 tool disabled in ~/.claude/settings.json
      await fs.writeFile(
        path.join(tempDir, '.claude.json'),
        JSON.stringify({ mcpServers: { wmux: { command: 'node', args: ['wmux.js'] } } }),
        'utf8',
      );
      await fs.mkdir(path.join(tempDir, '.claude'), { recursive: true });
      await fs.writeFile(
        path.join(tempDir, '.claude', 'settings.json'),
        JSON.stringify({
          permissions: {
            deny: ['mcp__wmux__terminal_send'],
          },
        }),
        'utf8',
      );

      const invB = await readInventory('claude', deps);
      const wmuxTools = invB.items.filter((i) => i.kind === 'mcp-tool' && i.parent === 'wmux');
      expect(wmuxTools).toHaveLength(CORE_TOOL_SURFACE.length);

      const toolNames = wmuxTools.map((t) => t.name);
      expect(new Set(toolNames).size).toBe(wmuxTools.length);

      const terminalSend = wmuxTools.find((t) => t.name === 'terminal_send');
      expect(terminalSend?.enabled).toBe(false);

      const terminalRead = wmuxTools.find((t) => t.name === 'terminal_read');
      expect(terminalRead?.enabled).toBe(true);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('codex: wmux tools enabled by default, disabled via disabled_tools or enabled_tools allowlist, no duplicates, no server -> no tools', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-wmux-test-'));
    try {
      const deps = makeDeps(tempDir);
      const codexDir = path.join(tempDir, '.codex');
      await fs.mkdir(codexDir, { recursive: true });

      // Scenario A: No wmux server
      await fs.writeFile(path.join(codexDir, 'config.toml'), '', 'utf8');
      const invA = await readInventory('codex', deps);
      expect(invA.items.filter((i) => i.parent === 'wmux')).toHaveLength(0);

      // Scenario B: wmux server with disabled_tools
      const tomlB = `[mcp_servers.wmux]\ncommand = "node"\nargs = ["wmux.js"]\ndisabled_tools = ["terminal_send"]\n`;
      await fs.writeFile(path.join(codexDir, 'config.toml'), tomlB, 'utf8');

      const invB = await readInventory('codex', deps);
      const wmuxToolsB = invB.items.filter((i) => i.kind === 'mcp-tool' && i.parent === 'wmux');
      expect(wmuxToolsB).toHaveLength(CORE_TOOL_SURFACE.length);
      expect(new Set(wmuxToolsB.map((t) => t.name)).size).toBe(wmuxToolsB.length);

      const sendB = wmuxToolsB.find((t) => t.name === 'terminal_send');
      expect(sendB?.enabled).toBe(false);
      const readB = wmuxToolsB.find((t) => t.name === 'terminal_read');
      expect(readB?.enabled).toBe(true);

      // Scenario C: wmux server with enabled_tools allow-list
      const tomlC = `[mcp_servers.wmux]\ncommand = "node"\nargs = ["wmux.js"]\nenabled_tools = ["terminal_read", "terminal_send"]\n`;
      await fs.writeFile(path.join(codexDir, 'config.toml'), tomlC, 'utf8');

      const invC = await readInventory('codex', deps);
      const wmuxToolsC = invC.items.filter((i) => i.kind === 'mcp-tool' && i.parent === 'wmux');
      expect(wmuxToolsC).toHaveLength(CORE_TOOL_SURFACE.length);
      expect(new Set(wmuxToolsC.map((t) => t.name)).size).toBe(wmuxToolsC.length);

      const readC = wmuxToolsC.find((t) => t.name === 'terminal_read');
      expect(readC?.enabled).toBe(true);
      const sendC = wmuxToolsC.find((t) => t.name === 'terminal_send');
      expect(sendC?.enabled).toBe(true);
      const keyC = wmuxToolsC.find((t) => t.name === 'terminal_send_key');
      expect(keyC?.enabled).toBe(false);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('agy: wmux tools enabled by default, disabled via disabledTools, no duplicates, no server -> no tools', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-wmux-test-'));
    try {
      const deps = makeDeps(tempDir);
      const agyDir = path.join(tempDir, '.gemini', 'config');
      await fs.mkdir(agyDir, { recursive: true });

      // Scenario A: No wmux server
      await fs.writeFile(path.join(agyDir, 'mcp_config.json'), JSON.stringify({ mcpServers: {} }), 'utf8');
      const invA = await readInventory('agy', deps);
      expect(invA.items.filter((i) => i.parent === 'wmux')).toHaveLength(0);

      // Scenario B: wmux server with disabledTools
      const configB = {
        mcpServers: {
          wmux: {
            command: 'node',
            args: ['wmux.js'],
            disabledTools: ['terminal_send'],
          },
        },
      };
      await fs.writeFile(path.join(agyDir, 'mcp_config.json'), JSON.stringify(configB), 'utf8');

      const invB = await readInventory('agy', deps);
      const wmuxToolsB = invB.items.filter((i) => i.kind === 'mcp-tool' && i.parent === 'wmux');
      expect(wmuxToolsB).toHaveLength(CORE_TOOL_SURFACE.length);
      expect(new Set(wmuxToolsB.map((t) => t.name)).size).toBe(wmuxToolsB.length);

      const sendB = wmuxToolsB.find((t) => t.name === 'terminal_send');
      expect(sendB?.enabled).toBe(false);
      const readB = wmuxToolsB.find((t) => t.name === 'terminal_read');
      expect(readB?.enabled).toBe(true);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('claude: wmux declared in user and project config yields exactly one row per tool and one warning', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-wmux-multi-'));
    const projDir = path.join(tempDir, 'my-project');
    try {
      const deps = makeDeps(tempDir, projDir);
      await fs.mkdir(projDir, { recursive: true });

      // User config (~/.claude.json) declares wmux
      await fs.writeFile(
        path.join(tempDir, '.claude.json'),
        JSON.stringify({ mcpServers: { wmux: { command: 'node', args: ['user-wmux.js'] } } }),
        'utf8',
      );

      // Project config (<proj>/.mcp.json) also declares wmux
      await fs.writeFile(
        path.join(projDir, '.mcp.json'),
        JSON.stringify({ mcpServers: { wmux: { command: 'node', args: ['proj-wmux.js'] } } }),
        'utf8',
      );

      const inv = await readInventory('claude', deps);
      const wmuxTools = inv.items.filter((i) => i.kind === 'mcp-tool' && i.parent === 'wmux');

      // Exactly one row per tool
      expect(wmuxTools).toHaveLength(CORE_TOOL_SURFACE.length);
      const names = wmuxTools.map((t) => t.name);
      expect(new Set(names).size).toBe(CORE_TOOL_SURFACE.length);

      // Exactly one warning with source word "project"
      const wmuxWarnings = inv.warnings.filter((w) => w.includes('wmux is declared in several places'));
      expect(wmuxWarnings).toEqual(['wmux is declared in several places; tool switches apply to project']);

      // Effective server is project, so tools are attached to project config
      const expectedOrigin = path.join(projDir, '.mcp.json');
      for (const tool of wmuxTools) {
        expect(tool.originPath).toBe(expectedOrigin);
      }
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('agy: wmux declared in user and project config yields exactly one row per tool and one warning', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-wmux-multi-'));
    const projDir = path.join(tempDir, 'my-project');
    try {
      const deps = makeDeps(tempDir, projDir);
      const userAgyDir = path.join(tempDir, '.gemini', 'config');
      const projAgyDir = path.join(projDir, '.agents');
      await fs.mkdir(userAgyDir, { recursive: true });
      await fs.mkdir(projAgyDir, { recursive: true });

      // User config (~/.gemini/config/mcp_config.json) declares wmux
      await fs.writeFile(
        path.join(userAgyDir, 'mcp_config.json'),
        JSON.stringify({
          mcpServers: {
            wmux: { command: 'node', args: ['user-wmux.js'], disabledTools: ['terminal_send'] },
          },
        }),
        'utf8',
      );

      // Project config (<proj>/.agents/mcp_config.json) also declares wmux
      await fs.writeFile(
        path.join(projAgyDir, 'mcp_config.json'),
        JSON.stringify({
          mcpServers: {
            wmux: { command: 'node', args: ['proj-wmux.js'], disabledTools: ['terminal_read'] },
          },
        }),
        'utf8',
      );

      const inv = await readInventory('agy', deps);
      const wmuxTools = inv.items.filter((i) => i.kind === 'mcp-tool' && i.parent === 'wmux');

      // Exactly one row per tool
      expect(wmuxTools).toHaveLength(CORE_TOOL_SURFACE.length);
      const names = wmuxTools.map((t) => t.name);
      expect(new Set(names).size).toBe(CORE_TOOL_SURFACE.length);

      // Exactly one warning with source word "project"
      const wmuxWarnings = inv.warnings.filter((w) => w.includes('wmux is declared in several places'));
      expect(wmuxWarnings).toEqual(['wmux is declared in several places; tool switches apply to project']);

      // Effective server is project: originPath points to project file, terminal_read is disabled (from project), terminal_send is enabled
      const expectedOrigin = path.join(projAgyDir, 'mcp_config.json');
      for (const tool of wmuxTools) {
        expect(tool.originPath).toBe(expectedOrigin);
      }
      const readTool = wmuxTools.find((t) => t.name === 'terminal_read');
      const sendTool = wmuxTools.find((t) => t.name === 'terminal_send');
      expect(readTool?.enabled).toBe(false);
      expect(sendTool?.enabled).toBe(true);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});

// Each case runs the real writers twice: 8-12 fsync'd writes (config, backup,
// surfaces store); loaded Windows disks can exceed 5 s.
describe('end to end with writers over fixture homes', { timeout: 30_000 }, () => {
  it('claude: disable two wmux tools, reload inventory, re-enable and restore', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-e2e-'));
    try {
      const deps = makeDeps(tempDir);
      await fs.mkdir(path.join(tempDir, '.claude'), { recursive: true });
      await fs.writeFile(
        path.join(tempDir, '.claude.json'),
        JSON.stringify({ mcpServers: { wmux: { command: 'node', args: ['wmux.js'] } } }),
        'utf8',
      );
      await fs.writeFile(path.join(tempDir, '.claude', 'settings.json'), JSON.stringify({}), 'utf8');

      const inv1 = await readInventory('claude', deps);
      const tool1 = inv1.items.find((i) => i.kind === 'mcp-tool' && i.parent === 'wmux' && i.name === 'terminal_read')!;
      const tool2 = inv1.items.find((i) => i.kind === 'mcp-tool' && i.parent === 'wmux' && i.name === 'terminal_send')!;
      expect(tool1.enabled).toBe(true);
      expect(tool2.enabled).toBe(true);

      const applyRes1 = await applySurfaceChanges(
        {
          provider: 'claude',
          changes: [
            { itemId: tool1.id, enabled: false },
            { itemId: tool2.id, enabled: false },
          ],
        },
        { deps },
      );
      expect(applyRes1.ok).toBe(true);

      const inv2 = await readInventory('claude', deps);
      const tool1After = inv2.items.find((i) => i.id === tool1.id)!;
      const tool2After = inv2.items.find((i) => i.id === tool2.id)!;
      expect(tool1After.enabled).toBe(false);
      expect(tool2After.enabled).toBe(false);

      const otherTools = inv2.items.filter((i) => i.kind === 'mcp-tool' && i.parent === 'wmux' && i.id !== tool1.id && i.id !== tool2.id);
      for (const t of otherTools) {
        expect(t.enabled).toBe(true);
      }

      const applyRes2 = await applySurfaceChanges(
        {
          provider: 'claude',
          changes: [
            { itemId: tool1.id, enabled: true },
            { itemId: tool2.id, enabled: true },
          ],
        },
        { deps },
      );
      expect(applyRes2.ok).toBe(true);

      const inv3 = await readInventory('claude', deps);
      const tool1Restored = inv3.items.find((i) => i.id === tool1.id)!;
      const tool2Restored = inv3.items.find((i) => i.id === tool2.id)!;
      expect(tool1Restored.enabled).toBe(true);
      expect(tool2Restored.enabled).toBe(true);

      const settingsRaw = await fs.readFile(path.join(tempDir, '.claude', 'settings.json'), 'utf8');
      const settings = JSON.parse(settingsRaw);
      expect(settings.permissions?.deny ?? []).toEqual([]);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('codex: disable two wmux tools, reload inventory, re-enable and restore', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-e2e-'));
    try {
      const deps = makeDeps(tempDir);
      const codexDir = path.join(tempDir, '.codex');
      await fs.mkdir(codexDir, { recursive: true });
      await fs.writeFile(
        path.join(codexDir, 'config.toml'),
        `[mcp_servers.wmux]\ncommand = "node"\nargs = ["wmux.js"]\n`,
        'utf8',
      );

      const inv1 = await readInventory('codex', deps);
      const tool1 = inv1.items.find((i) => i.kind === 'mcp-tool' && i.parent === 'wmux' && i.name === 'terminal_read')!;
      const tool2 = inv1.items.find((i) => i.kind === 'mcp-tool' && i.parent === 'wmux' && i.name === 'terminal_send')!;
      expect(tool1.enabled).toBe(true);
      expect(tool2.enabled).toBe(true);

      const applyRes1 = await applySurfaceChanges(
        {
          provider: 'codex',
          changes: [
            { itemId: tool1.id, enabled: false },
            { itemId: tool2.id, enabled: false },
          ],
        },
        { deps },
      );
      expect(applyRes1.ok).toBe(true);

      const inv2 = await readInventory('codex', deps);
      const tool1After = inv2.items.find((i) => i.id === tool1.id)!;
      const tool2After = inv2.items.find((i) => i.id === tool2.id)!;
      expect(tool1After.enabled).toBe(false);
      expect(tool2After.enabled).toBe(false);

      const otherTools = inv2.items.filter((i) => i.kind === 'mcp-tool' && i.parent === 'wmux' && i.id !== tool1.id && i.id !== tool2.id);
      for (const t of otherTools) {
        expect(t.enabled).toBe(true);
      }

      const applyRes2 = await applySurfaceChanges(
        {
          provider: 'codex',
          changes: [
            { itemId: tool1.id, enabled: true },
            { itemId: tool2.id, enabled: true },
          ],
        },
        { deps },
      );
      expect(applyRes2.ok).toBe(true);

      const inv3 = await readInventory('codex', deps);
      const tool1Restored = inv3.items.find((i) => i.id === tool1.id)!;
      const tool2Restored = inv3.items.find((i) => i.id === tool2.id)!;
      expect(tool1Restored.enabled).toBe(true);
      expect(tool2Restored.enabled).toBe(true);

      const configRaw = await fs.readFile(path.join(codexDir, 'config.toml'), 'utf8');
      expect(configRaw).not.toContain('disabled_tools');
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('agy: disable two wmux tools, reload inventory, re-enable and restore', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-e2e-'));
    try {
      const deps = makeDeps(tempDir);
      const agyDir = path.join(tempDir, '.gemini', 'config');
      await fs.mkdir(agyDir, { recursive: true });
      await fs.writeFile(
        path.join(agyDir, 'mcp_config.json'),
        JSON.stringify({ mcpServers: { wmux: { command: 'node', args: ['wmux.js'] } } }),
        'utf8',
      );

      const inv1 = await readInventory('agy', deps);
      const tool1 = inv1.items.find((i) => i.kind === 'mcp-tool' && i.parent === 'wmux' && i.name === 'terminal_read')!;
      const tool2 = inv1.items.find((i) => i.kind === 'mcp-tool' && i.parent === 'wmux' && i.name === 'terminal_send')!;
      expect(tool1.enabled).toBe(true);
      expect(tool2.enabled).toBe(true);

      const applyRes1 = await applySurfaceChanges(
        {
          provider: 'agy',
          changes: [
            { itemId: tool1.id, enabled: false },
            { itemId: tool2.id, enabled: false },
          ],
        },
        { deps },
      );
      expect(applyRes1.ok).toBe(true);

      const inv2 = await readInventory('agy', deps);
      const tool1After = inv2.items.find((i) => i.id === tool1.id)!;
      const tool2After = inv2.items.find((i) => i.id === tool2.id)!;
      expect(tool1After.enabled).toBe(false);
      expect(tool2After.enabled).toBe(false);

      const otherTools = inv2.items.filter((i) => i.kind === 'mcp-tool' && i.parent === 'wmux' && i.id !== tool1.id && i.id !== tool2.id);
      for (const t of otherTools) {
        expect(t.enabled).toBe(true);
      }

      const applyRes2 = await applySurfaceChanges(
        {
          provider: 'agy',
          changes: [
            { itemId: tool1.id, enabled: true },
            { itemId: tool2.id, enabled: true },
          ],
        },
        { deps },
      );
      expect(applyRes2.ok).toBe(true);

      const inv3 = await readInventory('agy', deps);
      const tool1Restored = inv3.items.find((i) => i.id === tool1.id)!;
      const tool2Restored = inv3.items.find((i) => i.id === tool2.id)!;
      expect(tool1Restored.enabled).toBe(true);
      expect(tool2Restored.enabled).toBe(true);

      const mcpRaw = await fs.readFile(path.join(agyDir, 'mcp_config.json'), 'utf8');
      const mcp = JSON.parse(mcpRaw);
      expect(mcp.mcpServers.wmux.disabledTools).toBeUndefined();
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});
