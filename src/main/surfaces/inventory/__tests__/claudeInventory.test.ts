import { describe, expect, it } from 'vitest';
import * as nodeFs from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { readClaudeInventory } from '../claudeInventory';
import { readInventory } from '../index';
import { applySurfaceChanges } from '../../writers';
import { SurfacesStore } from '../../safeWrite';
import type { InventoryDeps } from '../types';

describe('readClaudeInventory', () => {
  it('reads claude inventory with all required fixture scenarios', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-inventory-test-'));
    const projectDir = path.join(tempDir, 'my-project');

    try {
      const claudeHomeDir = path.join(tempDir, '.claude');
      const userSkillsDir = path.join(claudeHomeDir, 'skills');
      const pluginSkillsDir = path.join(claudeHomeDir, 'plugins', 'my-plugin', 'skills');
      const projectClaudeDir = path.join(projectDir, '.claude');

      await fs.mkdir(claudeHomeDir, { recursive: true });
      await fs.mkdir(userSkillsDir, { recursive: true });
      await fs.mkdir(pluginSkillsDir, { recursive: true });
      await fs.mkdir(projectClaudeDir, { recursive: true });

      // 1. ~/.claude.json
      const claudeJson = {
        mcpServers: {
          wmux: { command: 'node', args: ['wmux.js'] },
          'user-server': { command: 'node' },
          'globally-denied-server': { command: 'node' },
        },
        projects: {
          [projectDir]: {
            disabledMcpServers: ['project-disabled-server'],
            mcpServers: {
              'project-server': { command: 'node' },
              'project-disabled-server': { command: 'node' },
            },
          },
        },
      };
      await fs.writeFile(
        path.join(tempDir, '.claude.json'),
        JSON.stringify(claudeJson),
        'utf8',
      );

      // 2. ~/.claude/settings.json
      const settingsJson = {
        permissions: {
          deny: ['WebSearch', 'mcp__user-server__denied_tool'],
        },
        enabledPlugins: {
          'plugin-active': true,
          'plugin-disabled': false,
        },
        skillOverrides: {
          'disabled-skill': 'off',
          'active-skill': 'on',
        },
        deniedMcpServers: [{ serverName: 'globally-denied-server' }],
        hooks: {
          PreToolUse: [
            { type: 'prompt', name: 'prompt-hook', prompt: 'check tool' },
          ],
          Stop: [
            { type: 'command', name: 'stop-hook', command: 'node stop.js' },
          ],
          SessionStart: [
            { type: 'command', name: 'session-hook', command: 'node session.js' },
          ],
          PostInvocation: [
            { type: 'command', name: 'wmux-hook', command: 'node ~/.wmux/bridge.js' },
          ],
        },
        autoMemoryEnabled: true,
      };
      await fs.writeFile(
        path.join(claudeHomeDir, 'settings.json'),
        JSON.stringify(settingsJson),
        'utf8',
      );

      // 3. Skills on disk
      const disabledSkillDir = path.join(userSkillsDir, 'disabled-skill');
      await fs.mkdir(disabledSkillDir, { recursive: true });
      await fs.writeFile(
        path.join(disabledSkillDir, 'SKILL.md'),
        '---\nname: disabled-skill\ndescription: Disabled skill\n---\nBody',
        'utf8',
      );

      const activeSkillDir = path.join(userSkillsDir, 'active-skill');
      await fs.mkdir(activeSkillDir, { recursive: true });
      await fs.writeFile(
        path.join(activeSkillDir, 'SKILL.md'),
        '---\nname: active-skill\ndescription: Active skill\n---\nBody',
        'utf8',
      );

      // Plugin skill
      const pSkillDir = path.join(pluginSkillsDir, 'plugin-skill');
      await fs.mkdir(pSkillDir, { recursive: true });
      await fs.writeFile(
        path.join(pSkillDir, 'SKILL.md'),
        '---\nname: plugin-skill\ndescription: Plugin skill\n---\nBody',
        'utf8',
      );

      const deps: InventoryDeps = {
        homeDir: tempDir,
        projectDir,
        run: async (cmd, args) => {
          if (cmd === 'claude' && args[0] === '--version') {
            return '1.0.5';
          }
          throw new Error(`Unexpected command: ${cmd}`);
        },
      };

      const inventory = await readClaudeInventory(deps);

      expect(inventory.provider).toBe('claude');
      expect(inventory.cliVersion).toBe('1.0.5');
      expect(inventory.versionSupported).toBe(true);
      expect(inventory.writable).toBe(true);

      // MCP servers
      const wmuxServer = inventory.items.find((i) => i.name === 'wmux' && i.kind === 'mcp-server');
      expect(wmuxServer).toBeDefined();
      expect(wmuxServer?.source).toBe('wmux');
      expect(wmuxServer?.wmuxRequired).toBe(true);
      expect(wmuxServer?.enabled).toBe(true);

      const globalDenied = inventory.items.find((i) => i.name === 'globally-denied-server' && i.kind === 'mcp-server');
      expect(globalDenied?.enabled).toBe(false);

      const projDisabled = inventory.items.find((i) => i.name === 'project-disabled-server' && i.kind === 'mcp-server');
      expect(projDisabled?.enabled).toBe(false);

      const projServer = inventory.items.find((i) => i.name === 'project-server' && i.kind === 'mcp-server');
      expect(projServer?.enabled).toBe(true);
      expect(projServer?.source).toBe('project');

      const deniedTool = inventory.items.find((i) => i.name === 'denied_tool' && i.kind === 'mcp-tool');
      expect(deniedTool).toBeDefined();
      expect(deniedTool?.parent).toBe('user-server');
      expect(deniedTool?.enabled).toBe(false);

      // Bare tool from permissions.deny
      const webSearch = inventory.items.find((i) => i.name === 'WebSearch' && i.kind === 'builtin-tool');
      expect(webSearch).toBeDefined();
      expect(webSearch?.enabled).toBe(false);

      // Plugins
      const activePlugin = inventory.items.find((i) => i.name === 'plugin-active' && i.kind === 'plugin');
      expect(activePlugin?.enabled).toBe(true);

      const disabledPlugin = inventory.items.find((i) => i.name === 'plugin-disabled' && i.kind === 'plugin');
      expect(disabledPlugin?.enabled).toBe(false);

      // Skills: skillOverrides: off -> disabled
      const disabledSkill = inventory.items.find((i) => i.name === 'disabled-skill' && i.kind === 'skill');
      expect(disabledSkill?.enabled).toBe(false);
      expect(disabledSkill?.toggleable).toBe(true);

      const activeSkill = inventory.items.find((i) => i.name === 'active-skill' && i.kind === 'skill');
      expect(activeSkill?.enabled).toBe(true);

      // Plugin skills not toggleable
      const pluginSkill = inventory.items.find((i) => i.name === 'plugin-skill' && i.kind === 'skill');
      expect(pluginSkill).toBeDefined();
      expect(pluginSkill?.source).toBe('plugin');
      expect(pluginSkill?.toggleable).toBe(false);
      expect(pluginSkill?.readOnlyReason).toBe('Plugin skills cannot be toggled in Claude Code');

      // Hooks costs
      const promptHook = inventory.items.find((i) => i.name === 'prompt-hook' && i.kind === 'hook');
      expect(promptHook?.hookCost).toBe('calls-model');

      const stopHook = inventory.items.find((i) => i.name === 'stop-hook' && i.kind === 'hook');
      expect(stopHook?.hookCost).toBe('extra-turn');

      const sessionHook = inventory.items.find((i) => i.name === 'session-hook' && i.kind === 'hook');
      expect(sessionHook?.hookCost).toBe('injects-context');

      const wmuxHook = inventory.items.find((i) => i.name === 'wmux-hook' && i.kind === 'hook');
      expect(wmuxHook?.source).toBe('wmux');
      expect(wmuxHook?.wmuxRequired).toBe(true);

      // Context setting
      const autoMemory = inventory.items.find((i) => i.name === 'autoMemoryEnabled' && i.kind === 'context-setting');
      expect(autoMemory).toBeDefined();
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('handles malformed settings file with a warning', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-malformed-test-'));

    try {
      const claudeHomeDir = path.join(tempDir, '.claude');
      await fs.mkdir(claudeHomeDir, { recursive: true });
      await fs.writeFile(path.join(claudeHomeDir, 'settings.json'), 'not json {{{', 'utf8');

      const deps: InventoryDeps = {
        homeDir: tempDir,
        run: async () => '1.0.0',
      };

      const inventory = await readClaudeInventory(deps);
      expect(inventory.warnings.some((w) => w.includes('Failed to parse JSON'))).toBe(true);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('preserves same-named skills in user and project roots without dropping', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-dup-skills-home-'));
    const projDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-dup-skills-proj-'));

    try {
      const userSkillDir = path.join(tempDir, '.claude', 'skills', 'shared-skill');
      const projSkillDir = path.join(projDir, '.claude', 'skills', 'shared-skill');

      await fs.mkdir(userSkillDir, { recursive: true });
      await fs.mkdir(projSkillDir, { recursive: true });

      await fs.writeFile(
        path.join(userSkillDir, 'SKILL.md'),
        '---\nname: shared-skill\ndescription: User shared skill\n---\nBody',
        'utf8',
      );
      await fs.writeFile(
        path.join(projSkillDir, 'SKILL.md'),
        '---\nname: shared-skill\ndescription: Project shared skill\n---\nBody',
        'utf8',
      );

      const deps: InventoryDeps = {
        homeDir: tempDir,
        projectDir: projDir,
        run: async () => '1.0.0',
      };

      const inventory = await readClaudeInventory(deps);
      const sharedSkills = inventory.items.filter(
        (i) => i.name === 'shared-skill' && i.kind === 'skill',
      );

      expect(sharedSkills).toHaveLength(2);
      expect(sharedSkills[0].source).toBe('user');
      expect(sharedSkills[0].id).toBe('claude:skill::shared-skill');

      expect(sharedSkills[1].source).toBe('project');
      expect(sharedSkills[1].id).toBe('claude:skill::shared-skill@project');
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
      await fs.rm(projDir, { recursive: true, force: true });
    }
  });

  it('lists removed hooks from surfaces.json store as disabled with exact stored id', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-removed-hooks-test-'));
    try {
      const claudeHomeDir = path.join(tempDir, '.claude');
      const wmuxDir = path.join(tempDir, '.wmux');
      await fs.mkdir(claudeHomeDir, { recursive: true });
      await fs.mkdir(wmuxDir, { recursive: true });

      const settingsPath = path.join(claudeHomeDir, 'settings.json');
      await fs.writeFile(settingsPath, JSON.stringify({}), 'utf8');

      const store = new SurfacesStore(path.join(wmuxDir, 'surfaces.json'));
      store.removedHooks.add('claude', {
        id: 'claude:hook::custom-removed-hook',
        originPath: settingsPath,
        definition: {
          event: 'PreToolUse',
          handler: {
            type: 'command',
            name: 'custom-removed-hook',
            command: 'node verify.js',
          },
        },
      });
      store.save();

      const deps: InventoryDeps = {
        homeDir: tempDir,
        run: async () => '1.0.5',
      };

      const inventory = await readClaudeInventory(deps);
      const item = inventory.items.find((i) => i.id === 'claude:hook::custom-removed-hook');
      expect(item).toBeDefined();
      expect(item?.kind).toBe('hook');
      expect(item?.name).toBe('custom-removed-hook');
      expect(item?.enabled).toBe(false);
      expect(item?.toggleable).toBe(true);
      expect(item?.hookEvent).toBe('PreToolUse');
      expect(item?.hookCost).toBe('none');
      expect(item?.wmuxRequired).toBe(false);
      expect(item?.originPath).toBe(settingsPath);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  // 14 fsync'd writes across disable and enable (settings, backup, surfaces
  // store); loaded Windows disks can exceed 5 s.
  it('runs end-to-end with Claude writer: disable, read disabled, enable, read enabled', { timeout: 30_000 }, async () => {
    const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-e2e-home-'));
    const tempProj = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-e2e-proj-'));
    try {
      const claudeHomeDir = path.join(tempHome, '.claude');
      await fs.mkdir(claudeHomeDir, { recursive: true });

      const settingsPath = path.join(claudeHomeDir, 'settings.json');
      const initialSettings = {
        hooks: {
          PreToolUse: [
            {
              matcher: 'Bash',
              hooks: [
                { type: 'command', name: 'bash-guard', command: 'node guard.js' },
              ],
            },
          ],
        },
      };
      await fs.writeFile(settingsPath, JSON.stringify(initialSettings, null, 2), 'utf8');

      const invDeps: InventoryDeps = {
        homeDir: tempHome,
        projectDir: tempProj,
        run: async () => '1.0.5',
      };

      const writerDeps = {
        homeDir: tempHome,
        projectDir: tempProj,
        run: async () => '1.0.5',
        now: () => 1_000,
        surfacesStorePath: path.join(tempHome, '.wmux', 'surfaces.json'),
      };

      // 1. Initial inventory has live hook enabled
      const inv1 = await readInventory('claude', invDeps);
      const liveHook = inv1.items.find((i) => i.name === 'bash-guard' && i.kind === 'hook')!;
      expect(liveHook).toBeDefined();
      expect(liveHook.enabled).toBe(true);
      expect(liveHook.toggleable).toBe(true);

      // 2. Disable hook via applySurfaceChanges
      const disResult = await applySurfaceChanges(
        { provider: 'claude', changes: [{ itemId: liveHook.id, enabled: false }] },
        { deps: writerDeps },
      );
      expect(disResult.ok).toBe(true);
      expect(disResult.appliedItemIds).toContain(liveHook.id);

      // 3. Fresh readInventory lists it as disabled with the exact same id
      const inv2 = await readInventory('claude', invDeps);
      const disabledHook = inv2.items.find((i) => i.id === liveHook.id && i.kind === 'hook')!;
      expect(disabledHook).toBeDefined();
      expect(disabledHook.enabled).toBe(false);
      expect(disabledHook.toggleable).toBe(true);
      expect(disabledHook.name).toBe('bash-guard');

      // 4. Re-enable hook via applySurfaceChanges
      const enResult = await applySurfaceChanges(
        { provider: 'claude', changes: [{ itemId: disabledHook.id, enabled: true }] },
        { deps: writerDeps },
      );
      expect(enResult.ok).toBe(true);
      expect(enResult.appliedItemIds).toContain(disabledHook.id);

      // 5. Next inventory lists it once as enabled
      const inv3 = await readInventory('claude', invDeps);
      const matching = inv3.items.filter((i) => i.name === 'bash-guard' && i.kind === 'hook');
      expect(matching).toHaveLength(1);
      expect(matching[0].id).toBe(liveHook.id);
      expect(matching[0].enabled).toBe(true);
    } finally {
      await fs.rm(tempHome, { recursive: true, force: true });
      await fs.rm(tempProj, { recursive: true, force: true });
    }
  });

  it('records a warning and does not throw when surfaces store is corrupt or has newer version', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-corrupt-store-test-'));
    try {
      const wmuxDir = path.join(tempDir, '.wmux');
      await fs.mkdir(wmuxDir, { recursive: true });

      // Corrupt file
      await fs.writeFile(path.join(wmuxDir, 'surfaces.json'), 'not valid json {{{', 'utf8');
      const deps: InventoryDeps = {
        homeDir: tempDir,
        run: async () => '1.0.5',
      };

      const invCorrupt = await readClaudeInventory(deps);
      expect(invCorrupt.warnings.some((w) => w.includes('corrupt'))).toBe(true);

      // Newer version
      await fs.writeFile(path.join(wmuxDir, 'surfaces.json'), JSON.stringify({ version: 99 }), 'utf8');
      const invNewer = await readClaudeInventory(deps);
      expect(invNewer.warnings.some((w) => w.includes('unsupported') || w.includes('newer'))).toBe(true);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('never throws on a valid-version store with malformed removedHooks and leaves the file untouched', async () => {
    const goodEntry = {
      id: 'claude:hook::PreToolUse%3Ax',
      originPath: null,
      definition: { event: 'PreToolUse', groupMeta: {}, handler: { type: 'command', command: 'echo x' } },
    };
    const malformed: unknown[] = [
      { claude: { not: 'an array' } },
      { claude: 'a string' },
      { claude: [{ ...goodEntry, originPath: 42 }] },
      { claude: [{ originPath: null, definition: goodEntry.definition }] },
      { claude: [null, 'x', 7] },
    ];
    for (const removedHooks of malformed) {
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-malformed-store-'));
      try {
        const claudeDir = path.join(tempDir, '.claude');
        await fs.mkdir(claudeDir, { recursive: true });
        await fs.writeFile(
          path.join(claudeDir, 'settings.json'),
          JSON.stringify({ permissions: { deny: ['WebSearch'] } }),
          'utf8',
        );
        const wmuxDir = path.join(tempDir, '.wmux');
        await fs.mkdir(wmuxDir, { recursive: true });
        const storePath = path.join(wmuxDir, 'surfaces.json');
        await fs.writeFile(storePath, JSON.stringify({ version: 1, removedHooks }), 'utf8');
        const before = await fs.readFile(storePath, 'utf8');

        const inv = await readClaudeInventory({ homeDir: tempDir, run: async () => '1.0.5' });

        expect(inv.items.some((i) => i.kind === 'builtin-tool' && i.name === 'WebSearch')).toBe(true);
        expect(inv.warnings.length).toBeGreaterThan(0);
        expect(inv.items.filter((i) => i.kind === 'hook')).toEqual([]);
        expect(await fs.readFile(storePath, 'utf8')).toBe(before);
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    }
  });

  it('does not duplicate a stale store entry when hook is currently present in settings with deep-equal definition', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-stale-store-test-'));
    try {
      const claudeHomeDir = path.join(tempDir, '.claude');
      const wmuxDir = path.join(tempDir, '.wmux');
      await fs.mkdir(claudeHomeDir, { recursive: true });
      await fs.mkdir(wmuxDir, { recursive: true });

      const settingsPath = path.join(claudeHomeDir, 'settings.json');
      const settings = {
        hooks: {
          Stop: [
            { type: 'command', name: 'stop-hook', command: 'node stop.js' },
          ],
        },
      };
      await fs.writeFile(settingsPath, JSON.stringify(settings), 'utf8');

      // Stale store entry with a different id but deep-equal definition to the live hook
      const store = new SurfacesStore(path.join(wmuxDir, 'surfaces.json'));
      store.removedHooks.add('claude', {
        id: 'claude:hook::stale-different-id',
        originPath: settingsPath,
        definition: {
          event: 'Stop',
          handler: { type: 'command', name: 'stop-hook', command: 'node stop.js' },
        },
      });
      store.save();

      const deps: InventoryDeps = {
        homeDir: tempDir,
        run: async () => '1.0.5',
      };

      const inventory = await readClaudeInventory(deps);
      const stopHooks = inventory.items.filter((i) => i.name === 'stop-hook' && i.kind === 'hook');
      expect(stopHooks).toHaveLength(1);
      expect(stopHooks[0].enabled).toBe(true);
      expect(inventory.items.some((i) => i.id === 'claude:hook::stale-different-id')).toBe(false);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('never creates or modifies surfaces.json during inventory run', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-no-create-store-test-'));
    try {
      const storePath = path.join(tempDir, '.wmux', 'surfaces.json');
      const deps: InventoryDeps = {
        homeDir: tempDir,
        run: async () => '1.0.5',
      };

      // 1. surfaces.json does not exist before read
      expect(nodeFs.existsSync(storePath)).toBe(false);
      await readClaudeInventory(deps);
      expect(nodeFs.existsSync(storePath)).toBe(false);

      // 2. Existing surfaces.json is not modified
      await fs.mkdir(path.join(tempDir, '.wmux'), { recursive: true });
      const initialPayload = JSON.stringify({ version: 1, removedHooks: { claude: [] } }, null, 2);
      await fs.writeFile(storePath, initialPayload, 'utf8');

      await readClaudeInventory(deps);
      const afterContent = await fs.readFile(storePath, 'utf8');
      expect(afterContent).toBe(initialPayload);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('marks removed hooks read-only when CLI version is unsupported', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-unsupported-test-'));
    try {
      const claudeHomeDir = path.join(tempDir, '.claude');
      const wmuxDir = path.join(tempDir, '.wmux');
      await fs.mkdir(claudeHomeDir, { recursive: true });
      await fs.mkdir(wmuxDir, { recursive: true });

      const settingsPath = path.join(claudeHomeDir, 'settings.json');
      await fs.writeFile(settingsPath, JSON.stringify({}), 'utf8');

      const store = new SurfacesStore(path.join(wmuxDir, 'surfaces.json'));
      store.removedHooks.add('claude', {
        id: 'claude:hook::removed-unsupported',
        originPath: settingsPath,
        definition: {
          event: 'PreToolUse',
          handler: { type: 'command', name: 'unsupported-hook', command: 'node v.js' },
        },
      });
      store.save();

      const deps: InventoryDeps = {
        homeDir: tempDir,
        run: async () => {
          throw new Error('command not found');
        },
      };

      const inventory = await readClaudeInventory(deps);
      const item = inventory.items.find((i) => i.id === 'claude:hook::removed-unsupported');
      expect(item).toBeDefined();
      expect(item?.enabled).toBe(false);
      expect(item?.toggleable).toBe(false);
      expect(item?.readOnlyReason).toBe('CLI version not supported (read-only)');
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('loads removed hooks from custom surfacesStorePath in InventoryDeps', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-custom-store-path-test-'));
    try {
      const claudeHomeDir = path.join(tempDir, '.claude');
      const customStoreDir = path.join(tempDir, 'custom-store');
      await fs.mkdir(claudeHomeDir, { recursive: true });
      await fs.mkdir(customStoreDir, { recursive: true });

      const settingsPath = path.join(claudeHomeDir, 'settings.json');
      await fs.writeFile(settingsPath, JSON.stringify({}), 'utf8');

      const customStorePath = path.join(customStoreDir, 'custom-surfaces.json');
      const store = new SurfacesStore(customStorePath);
      store.removedHooks.add('claude', {
        id: 'claude:hook::custom-store-hook',
        originPath: settingsPath,
        definition: {
          event: 'SessionStart',
          handler: { type: 'command', name: 'custom-store-hook', command: 'node session.js' },
        },
      });
      store.save();

      const deps: InventoryDeps = {
        homeDir: tempDir,
        surfacesStorePath: customStorePath,
        run: async () => '1.0.5',
      };

      const inventory = await readClaudeInventory(deps);
      const item = inventory.items.find((i) => i.id === 'claude:hook::custom-store-hook');
      expect(item).toBeDefined();
      expect(item?.name).toBe('custom-store-hook');
      expect(item?.hookEvent).toBe('SessionStart');
      expect(item?.hookCost).toBe('injects-context');
      expect(item?.enabled).toBe(false);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});

