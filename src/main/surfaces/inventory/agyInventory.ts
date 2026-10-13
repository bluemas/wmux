import path from 'node:path';
import { cliVersionSupport, newerCliVersionWarning } from '../../../shared/tokenUsage/capabilities';
import type { HookCostHint, ProviderInventory, SurfaceSource } from '../../../shared/tokenUsage/surfaceTypes';
import {
  addEffectiveWmuxTools,
  finishInventory,
  InventoryCollector,
  LIVE_TOOLS_WARNING,
  listSkills,
} from './collector';
import { queryCliVersion, safeParseJson, safeReaddir, safeReadFile } from './helpers';
import { LOCATION_SOURCE_ORDER, makeItem, type InventoryDeps } from './types';
import type { WmuxServerDeclaration } from './wmuxTools';

export async function readAgyInventory(deps: InventoryDeps): Promise<ProviderInventory> {
  const c = new InventoryCollector();

  const cliVersion = await queryCliVersion('agy', deps.run);
  const support = cliVersionSupport('agy', cliVersion);
  const versionSupported = support !== 'unsupported';
  if (support === 'newer' && cliVersion) c.warnings.push(newerCliVersionWarning('agy', cliVersion));

  const declarations: WmuxServerDeclaration[] = [];
  const hasMcpServers = await addMcpServers(deps, c, declarations);
  addEffectiveWmuxTools(c, 'agy', declarations, deps);
  if (hasMcpServers) c.warnings.push(LIVE_TOOLS_WARNING);

  const excluded = await readSkillExclusions(deps, c);
  await addSkillRoots(deps, c, excluded);
  const pluginHookFiles = await addPlugins(deps, c, excluded);
  await addBuiltinSkills(deps, c);

  const hookFiles: Array<{ filePath: string; source: SurfaceSource }> = [
    { filePath: path.join(deps.homeDir, '.gemini', 'config', 'hooks.json'), source: 'user' },
  ];
  if (deps.projectDir) hookFiles.push({ filePath: path.join(deps.projectDir, '.agents', 'hooks.json'), source: 'project' });
  for (const filePath of pluginHookFiles) hookFiles.push({ filePath, source: 'plugin' });
  for (const { filePath, source } of hookFiles) {
    await parseHooksFile(filePath, source, deps, c);
  }

  return finishInventory('agy', c, { cliVersion, versionSupported }, deps);
}

/** User then project `mcp_config.json`. Returns whether any server was listed. */
async function addMcpServers(
  deps: InventoryDeps,
  c: InventoryCollector,
  declarations: WmuxServerDeclaration[],
): Promise<boolean> {
  const mcpConfigs: Array<{ filePath: string; isProject: boolean }> = [
    { filePath: path.join(deps.homeDir, '.gemini', 'config', 'mcp_config.json'), isProject: false },
  ];
  if (deps.projectDir) mcpConfigs.push({ filePath: path.join(deps.projectDir, '.agents', 'mcp_config.json'), isProject: true });

  let hasMcpServers = false;
  for (const { filePath, isProject } of mcpConfigs) {
    const parsed = await readJson(filePath, deps, c);
    const servers = parsed?.mcpServers;
    if (!servers || typeof servers !== 'object' || Array.isArray(servers)) continue;
    for (const [serverName, rawConf] of Object.entries(servers)) {
      hasMcpServers = true;
      addMcpServer(serverName, rawConf, filePath, isProject, c, declarations);
    }
  }
  return hasMcpServers;
}

function addMcpServer(
  serverName: string,
  rawConf: unknown,
  filePath: string,
  isProject: boolean,
  c: InventoryCollector,
  declarations: WmuxServerDeclaration[],
): void {
  const conf = rawConf && typeof rawConf === 'object' ? (rawConf as Record<string, unknown>) : {};
  const isWmux = serverName === 'wmux';
  const source: SurfaceSource = isWmux ? 'wmux' : isProject ? 'project' : 'user';
  const serverItem = makeItem({
    provider: 'agy',
    kind: 'mcp-server',
    name: serverName,
    source,
    enabled: conf.disabled !== true,
    effect: 'removes',
    toggleable: true,
    originPath: filePath,
    wmuxRequired: isWmux,
  });
  c.add(serverItem);

  const disabledTools = Array.isArray(conf.disabledTools)
    ? (conf.disabledTools as unknown[]).filter((x): x is string => typeof x === 'string')
    : [];
  if (isWmux) {
    declarations.push({
      source: isProject ? 'project' : 'user',
      serverItem,
      disabledNames: new Set<string>(disabledTools),
      originPath: filePath,
    });
    return;
  }
  for (const tool of disabledTools) {
    c.add(
      makeItem({
        provider: 'agy',
        kind: 'mcp-tool',
        name: tool,
        parent: serverName,
        source,
        enabled: false,
        effect: 'removes',
        toggleable: true,
        originPath: filePath,
        wmuxRequired: false,
      }),
    );
  }
}

/** Skill directory names and skill names excluded by the user and project `skills.json`. */
async function readSkillExclusions(deps: InventoryDeps, c: InventoryCollector): Promise<Set<string>> {
  const excluded = new Set<string>();
  const skillsJsonPaths = [path.join(deps.homeDir, '.gemini', 'config', 'skills.json')];
  if (deps.projectDir) skillsJsonPaths.push(path.join(deps.projectDir, '.agents', 'skills.json'));

  const addStrings = (list: unknown) => {
    if (!Array.isArray(list)) return;
    for (const ex of list) {
      if (typeof ex === 'string') excluded.add(ex);
    }
  };
  for (const sjp of skillsJsonPaths) {
    const parsed = await readJson(sjp, deps, c);
    if (!parsed) continue;
    addStrings(parsed.exclude);
    if (!Array.isArray(parsed.entries)) continue;
    for (const entry of parsed.entries) {
      if (entry && typeof entry === 'object') addStrings((entry as Record<string, unknown>).exclude);
    }
  }
  return excluded;
}

async function addSkillRoots(deps: InventoryDeps, c: InventoryCollector, excluded: Set<string>): Promise<void> {
  const skillRoots: Array<{ dirPath: string; source: SurfaceSource }> = [
    { dirPath: path.join(deps.homeDir, '.gemini', 'config', 'skills'), source: 'user' },
    { dirPath: path.join(deps.homeDir, '.gemini', 'antigravity-cli', 'skills'), source: 'user' },
  ];
  if (deps.projectDir) skillRoots.push({ dirPath: path.join(deps.projectDir, '.agents', 'skills'), source: 'project' });
  skillRoots.sort((a, b) => (LOCATION_SOURCE_ORDER[a.source] ?? 99) - (LOCATION_SOURCE_ORDER[b.source] ?? 99));

  for (const { dirPath, source } of skillRoots) {
    await addExcludableSkills(dirPath, source, deps, c, excluded);
  }
}

async function addExcludableSkills(
  dirPath: string,
  source: SurfaceSource,
  deps: InventoryDeps,
  c: InventoryCollector,
  excluded: Set<string>,
): Promise<void> {
  for (const s of await listSkills(dirPath, deps, c.warnings)) {
    c.add(
      makeItem({
        provider: 'agy',
        kind: 'skill',
        name: s.name,
        source,
        enabled: !(excluded.has(s.dir) || excluded.has(s.name)),
        effect: 'removes',
        toggleable: true,
        descriptionChars: s.descChars,
        originPath: s.mdPath,
      }),
    );
  }
}

/** Plugins from the user and project plugin roots, with their skills. Returns each plugin's hooks.json path. */
async function addPlugins(deps: InventoryDeps, c: InventoryCollector, excluded: Set<string>): Promise<string[]> {
  const parsedConfig = await readJson(path.join(deps.homeDir, '.gemini', 'config', 'config.json'), deps, c);
  const pluginsState = (parsedConfig?.plugins && typeof parsedConfig.plugins === 'object')
    ? (parsedConfig.plugins as Record<string, Record<string, unknown>>)
    : {};

  const pluginRoots: Array<{ dirPath: string; isProject: boolean }> = [
    { dirPath: path.join(deps.homeDir, '.gemini', 'config', 'plugins'), isProject: false },
    { dirPath: path.join(deps.homeDir, '.gemini', 'antigravity-cli', 'plugins'), isProject: false },
  ];
  if (deps.projectDir) pluginRoots.push({ dirPath: path.join(deps.projectDir, '.agents', 'plugins'), isProject: true });

  const pluginHookFiles: string[] = [];
  for (const { dirPath, isProject } of pluginRoots) {
    for (const pdir of await safeReaddir(dirPath, deps)) {
      const pluginJsonPath = path.join(dirPath, pdir, 'plugin.json');
      const pcontent = await safeReadFile(pluginJsonPath, deps, c.warnings);
      if (pcontent === null) continue;
      const pjson = safeParseJson<Record<string, unknown>>(pluginJsonPath, pcontent, c.warnings);

      c.add(
        makeItem({
          provider: 'agy',
          kind: 'plugin',
          name: (pjson?.name as string) || pdir,
          source: isProject ? 'project' : 'user',
          enabled: pluginEnabled(pluginsState[pdir], pjson),
          effect: 'removes',
          toggleable: true,
          originPath: pluginJsonPath,
        }),
      );
      await addExcludableSkills(path.join(dirPath, pdir, 'skills'), 'plugin', deps, c, excluded);
      pluginHookFiles.push(path.join(dirPath, pdir, 'hooks.json'));
    }
  }
  return pluginHookFiles;
}

/** `config.json` plugins.<dir>.enabled wins; otherwise the manifest's own `disabled`. */
function pluginEnabled(stateEntry: Record<string, unknown> | undefined, pjson: Record<string, unknown> | null): boolean {
  if (stateEntry && typeof stateEntry === 'object' && typeof stateEntry.enabled === 'boolean') return stateEntry.enabled;
  return !(pjson && pjson.disabled === true);
}

async function addBuiltinSkills(deps: InventoryDeps, c: InventoryCollector): Promise<void> {
  const builtinSkillsDir = path.join(deps.homeDir, '.gemini', 'antigravity-cli', 'builtin', 'skills');
  for (const s of await listSkills(builtinSkillsDir, deps, c.warnings)) {
    c.add(
      makeItem({
        provider: 'agy',
        kind: 'skill',
        name: s.name,
        source: 'builtin',
        enabled: true,
        effect: 'removes',
        toggleable: false,
        readOnlyReason: 'Built-in skills cannot be disabled',
        descriptionChars: s.descChars,
        originPath: s.mdPath,
      }),
    );
  }
}

async function readJson(filePath: string, deps: InventoryDeps, c: InventoryCollector): Promise<Record<string, unknown> | null> {
  const content = await safeReadFile(filePath, deps, c.warnings);
  if (!content) return null;
  const parsed = safeParseJson<Record<string, unknown>>(filePath, content, c.warnings);
  return parsed && typeof parsed === 'object' ? parsed : null;
}

function agyHookCost(event: string | null): HookCostHint {
  if (event === 'PreInvocation' || event === 'PostInvocation') return 'injects-context';
  if (event === 'Stop') return 'extra-turn';
  return 'none';
}

async function parseHooksFile(
  filePath: string,
  defaultSource: SurfaceSource,
  deps: InventoryDeps,
  c: InventoryCollector,
): Promise<void> {
  const parsed = await readJson(filePath, deps, c);
  if (!parsed) return;

  const entries = (parsed.hooks && typeof parsed.hooks === 'object' && !Array.isArray(parsed.hooks))
    ? (parsed.hooks as Record<string, unknown>)
    : parsed;

  for (const [hookName, rawConf] of Object.entries(entries)) {
    if (!rawConf || typeof rawConf !== 'object') continue;
    const conf = rawConf as Record<string, unknown>;
    const event = typeof conf.event === 'string' ? conf.event : typeof conf.type === 'string' ? conf.type : null;
    const cmd = String(conf.command ?? conf.script ?? '');
    const isWmux = cmd.includes('wmux') || cmd.includes('.wmux');

    c.add(
      makeItem({
        provider: 'agy',
        kind: 'hook',
        name: hookName,
        source: isWmux ? 'wmux' : defaultSource,
        enabled: conf.enabled !== false,
        effect: 'removes',
        toggleable: true,
        hookEvent: event,
        hookCost: agyHookCost(event),
        originPath: filePath,
        wmuxRequired: isWmux,
      }),
    );
  }
}
