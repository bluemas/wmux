import path from 'node:path';
import { cliVersionSupport, newerCliVersionWarning } from '../../../shared/tokenUsage/capabilities';
import type { HookCostHint, ProviderInventory, SurfaceSource } from '../../../shared/tokenUsage/surfaceTypes';
import {
  CODEX_HOOK_EVENTS,
  findCodexHooksBlock,
  isWmuxOwnedNotify,
} from '../../../shared/configIO';
import {
  addEffectiveWmuxTools,
  finishInventory,
  InventoryCollector,
  LIVE_TOOLS_WARNING,
  listSkills,
} from './collector';
import {
  normalizePath,
  queryCliVersion,
  safeParseJson,
  safeParseToml,
  safeReadFile,
} from './helpers';
import { codexHookStateKey, normalizeDriveAndSeparators } from '../writers/codex/planEdits';
import { LOCATION_SOURCE_ORDER, makeItem, type InventoryDeps } from './types';
import { listWmuxToolNames, type WmuxServerDeclaration } from './wmuxTools';

/** `[features]` keys listed as built-in tools, in display order. */
const FEATURE_TOOLS = ['shell_tool', 'multi_agent', 'memories', 'web_search'] as const;
/** Value settings shown read-only: the Codex writer has no edit for them. */
const CONTEXT_KEYS = ['model_verbosity', 'tool_output_token_limit', 'model_auto_compact_token_limit', 'model_reasoning_summary'];
const INJECTS_CONTEXT_EVENTS = ['UserPromptSubmit', 'SessionStart', 'SubagentStart', 'PreToolUse', 'PostToolUse'];

/** What config.toml says about entries listed elsewhere (skill folders, hooks.json handlers). */
interface CodexConfigState {
  disabledSkillPaths: Set<string>;
  hooksState: Map<string, boolean>;
  hasMcpServers: boolean;
}

export async function readCodexInventory(deps: InventoryDeps): Promise<ProviderInventory> {
  const c = new InventoryCollector();

  const cliVersion = await queryCliVersion('codex', deps.run);
  const support = cliVersionSupport('codex', cliVersion);
  const versionSupported = support !== 'unsupported';
  if (support === 'newer' && cliVersion) c.warnings.push(newerCliVersionWarning('codex', cliVersion));

  const configPath = path.join(deps.homeDir, '.codex', 'config.toml');
  const configText = await safeReadFile(configPath, deps, c.warnings);
  const parsed = configText ? safeParseToml<Record<string, unknown>>(configPath, configText, c.warnings) : null;

  const state: CodexConfigState = { disabledSkillPaths: new Set(), hooksState: new Map(), hasMcpServers: false };
  if (parsed && typeof parsed === 'object') {
    addConfigItems(parsed, configText, configPath, deps, c, state);
  }
  await addHooksFiles(deps, c, state.hooksState);
  await addSkills(deps, c, state.disabledSkillPaths);

  if (state.hasMcpServers) c.warnings.push(LIVE_TOOLS_WARNING);
  return finishInventory('codex', c, { cliVersion, versionSupported }, deps);
}

function addConfigItems(
  parsed: Record<string, unknown>,
  configText: string | null,
  configPath: string,
  deps: InventoryDeps,
  c: InventoryCollector,
  state: CodexConfigState,
): void {
  const declarations: WmuxServerDeclaration[] = [];
  state.hasMcpServers = addMcpServers(parsed.mcp_servers, configPath, c, declarations);
  addEffectiveWmuxTools(c, 'codex', declarations, deps);
  addPlugins(parsed.plugins, configPath, c);
  collectDisabledSkillPaths(parsed, path.dirname(configPath), state.disabledSkillPaths);
  collectHooksState(parsed, state.hooksState);
  if (configText) addWmuxManagedHooks(configText, configPath, c);
  addNotify(parsed.notify, configPath, c);
  addFeatures(parsed.features, configPath, c);
  addContextSettings(parsed, configPath, c);
}

/** `[mcp_servers.*]`. Returns whether any server was listed. */
function addMcpServers(
  mcpServers: unknown,
  configPath: string,
  c: InventoryCollector,
  declarations: WmuxServerDeclaration[],
): boolean {
  if (!mcpServers || typeof mcpServers !== 'object' || Array.isArray(mcpServers)) return false;
  let hasMcpServers = false;
  for (const [serverName, rawConf] of Object.entries(mcpServers)) {
    hasMcpServers = true;
    const conf = rawConf && typeof rawConf === 'object' ? (rawConf as Record<string, unknown>) : {};
    const isWmux = serverName === 'wmux';
    const source: SurfaceSource = isWmux ? 'wmux' : 'user';
    const serverItem = makeItem({
      provider: 'codex',
      kind: 'mcp-server',
      name: serverName,
      source,
      enabled: conf.enabled !== false,
      effect: 'removes',
      toggleable: true,
      originPath: configPath,
      wmuxRequired: isWmux,
    });
    c.add(serverItem);

    if (isWmux) {
      declarations.push({ source: 'user', serverItem, disabledNames: wmuxDisabledTools(conf), originPath: configPath });
      continue;
    }
    addToolRows(conf.disabled_tools, false, serverName, source, configPath, c);
    addToolRows(conf.enabled_tools, true, serverName, source, configPath, c);
  }
  return hasMcpServers;
}

function addToolRows(
  list: unknown,
  enabled: boolean,
  serverName: string,
  source: SurfaceSource,
  configPath: string,
  c: InventoryCollector,
): void {
  for (const tool of stringList(list) ?? []) {
    c.add(
      makeItem({
        provider: 'codex',
        kind: 'mcp-tool',
        name: tool,
        parent: serverName,
        source,
        enabled,
        effect: 'removes',
        toggleable: true,
        originPath: configPath,
      }),
    );
  }
}

/** wmux tools switched off: `disabled_tools`, plus every tool an `enabled_tools` allowlist leaves out. */
function wmuxDisabledTools(conf: Record<string, unknown>): Set<string> {
  const disabled = new Set<string>(stringList(conf.disabled_tools) ?? []);
  const enabledTools = stringList(conf.enabled_tools);
  if (enabledTools === null) return disabled;
  const enabledSet = new Set(enabledTools);
  for (const name of listWmuxToolNames()) {
    if (!enabledSet.has(name)) disabled.add(name);
  }
  return disabled;
}

/** The string entries of an array, or null when it is not an array. */
function stringList(value: unknown): string[] | null {
  return Array.isArray(value) ? (value as unknown[]).filter((x): x is string => typeof x === 'string') : null;
}

function addPlugins(plugins: unknown, configPath: string, c: InventoryCollector): void {
  if (!plugins || typeof plugins !== 'object' || Array.isArray(plugins)) return;
  for (const [pluginName, rawConf] of Object.entries(plugins)) {
    const conf = rawConf && typeof rawConf === 'object' ? (rawConf as Record<string, unknown>) : {};
    c.add(
      makeItem({
        provider: 'codex',
        kind: 'plugin',
        name: pluginName,
        source: 'user',
        enabled: conf.enabled !== false,
        effect: 'removes',
        toggleable: true,
        originPath: configPath,
      }),
    );
  }
}

/** A table nested as `parsed[table][key]`, or written with a dotted key `parsed["table.key"]`. */
function nestedTable(parsed: Record<string, unknown>, table: string, key: string): unknown {
  const outer = parsed[table];
  return outer && typeof outer === 'object' && key in outer
    ? (outer as Record<string, unknown>)[key]
    : parsed[`${table}.${key}`];
}

/** `[[skills.config]]` entries with `enabled = false`, as normalized paths. */
function collectDisabledSkillPaths(parsed: Record<string, unknown>, configDir: string, into: Set<string>): void {
  const skillsConfig = nestedTable(parsed, 'skills', 'config');
  if (!Array.isArray(skillsConfig)) return;
  for (const sc of skillsConfig) {
    if (sc && typeof sc === 'object' && typeof sc.path === 'string' && sc.enabled === false) {
      into.add(normalizePath(sc.path, configDir));
    }
  }
}

/** `[hooks.state]` entries that carry a boolean `enabled`. */
function collectHooksState(parsed: Record<string, unknown>, into: Map<string, boolean>): void {
  const hooksState = nestedTable(parsed, 'hooks', 'state');
  if (!hooksState || typeof hooksState !== 'object' || Array.isArray(hooksState)) return;
  for (const [stateKey, stateConf] of Object.entries(hooksState)) {
    if (!stateConf || typeof stateConf !== 'object') continue;
    const stateEnabled = (stateConf as Record<string, unknown>).enabled;
    if (typeof stateEnabled === 'boolean') into.set(stateKey, stateEnabled);
  }
}

/** One row per event of the wmux-managed hooks block, when the block is complete. */
function addWmuxManagedHooks(configText: string, configPath: string, c: InventoryCollector): void {
  const block = findCodexHooksBlock(configText);
  if (!block || 'unterminated' in block) return;
  for (const event of CODEX_HOOK_EVENTS) {
    c.add(
      makeItem({
        provider: 'codex',
        kind: 'hook',
        name: `wmux-${event.toLowerCase()}`,
        source: 'wmux',
        enabled: true,
        effect: 'removes',
        toggleable: true,
        hookEvent: event,
        hookCost: event === 'Stop' ? 'extra-turn' : 'injects-context',
        originPath: configPath,
        wmuxRequired: true,
      }),
    );
  }
}

function addNotify(notify: unknown, configPath: string, c: InventoryCollector): void {
  if (!Array.isArray(notify)) return;
  const isWmuxNotify = isWmuxOwnedNotify(notify as string[]);
  c.add(
    makeItem({
      provider: 'codex',
      kind: 'hook',
      name: 'codex-notify',
      source: isWmuxNotify ? 'wmux' : 'user',
      enabled: true,
      effect: 'removes',
      toggleable: true,
      hookEvent: 'TurnComplete',
      hookCost: 'none',
      originPath: configPath,
      wmuxRequired: isWmuxNotify,
    }),
  );
}

function addFeatures(features: unknown, configPath: string, c: InventoryCollector): void {
  if (!features || typeof features !== 'object' || Array.isArray(features)) return;
  const featMap = features as Record<string, unknown>;
  for (const name of FEATURE_TOOLS) {
    if (!(name in featMap)) continue;
    const value = featMap[name];
    // web_search takes "disabled" as well as false.
    const enabled = name === 'web_search' ? value !== 'disabled' && value !== false : value !== false;
    c.add(
      makeItem({
        provider: 'codex',
        kind: 'builtin-tool',
        name,
        source: 'builtin',
        enabled,
        effect: 'removes',
        toggleable: true,
        originPath: configPath,
      }),
    );
  }
}

function addContextSettings(parsed: Record<string, unknown>, configPath: string, c: InventoryCollector): void {
  for (const ck of CONTEXT_KEYS) {
    if (!(ck in parsed)) continue;
    c.add(
      makeItem({
        provider: 'codex',
        kind: 'context-setting',
        name: ck,
        source: 'user',
        // These are values, not switches, and the Codex writer has no edit for them.
        enabled: null,
        effect: 'removes',
        toggleable: false,
        readOnlyReason: 'Edit this value in config.toml.',
        originPath: configPath,
      }),
    );
  }
}

/** ~/.codex/hooks.json, then the project's .codex/hooks.json. */
async function addHooksFiles(deps: InventoryDeps, c: InventoryCollector, hooksState: Map<string, boolean>): Promise<void> {
  const hookFiles: Array<{ filePath: string; isProject: boolean }> = [
    { filePath: path.join(deps.homeDir, '.codex', 'hooks.json'), isProject: false },
  ];
  if (deps.projectDir) hookFiles.push({ filePath: path.join(deps.projectDir, '.codex', 'hooks.json'), isProject: true });

  for (const { filePath, isProject } of hookFiles) {
    const entries = await readHooksJsonEntries(filePath, deps, c);
    if (!entries) continue;
    for (const [handlerIdx, [hookName, rawConf]] of Object.entries(entries).entries()) {
      if (!rawConf || typeof rawConf !== 'object') continue;
      const source: SurfaceSource = isProject ? 'project' : 'user';
      if (Array.isArray(rawConf)) {
        addGroupedHook(hookName, source, filePath, c);
        continue;
      }
      addHook(hookName, rawConf as Record<string, unknown>, handlerIdx, source, filePath, hooksState, c);
    }
  }
}

/** The entries of a hooks.json: its `hooks` table when present, else the whole file. */
async function readHooksJsonEntries(
  filePath: string,
  deps: InventoryDeps,
  c: InventoryCollector,
): Promise<Record<string, unknown> | null> {
  const content = await safeReadFile(filePath, deps, c.warnings);
  if (!content) return null;
  const hooksJson = safeParseJson<Record<string, unknown>>(filePath, content, c.warnings);
  if (!hooksJson || typeof hooksJson !== 'object') return null;
  return (hooksJson.hooks && typeof hooksJson.hooks === 'object' && !Array.isArray(hooksJson.hooks))
    ? (hooksJson.hooks as Record<string, unknown>)
    : hooksJson;
}

/**
 * The grouped form (event -> groups[] -> hooks[]) has its own hooks.state keys, which the writer does
 * not build: list it, but read-only, rather than offer a switch that always fails.
 */
function addGroupedHook(hookName: string, source: SurfaceSource, filePath: string, c: InventoryCollector): void {
  c.add(
    makeItem({
      provider: 'codex',
      kind: 'hook',
      name: hookName,
      source,
      enabled: null,
      effect: 'removes',
      toggleable: false,
      readOnlyReason: 'Grouped hooks.json entries can only be edited in the file.',
      hookEvent: hookName,
      originPath: filePath,
    }),
  );
}

function codexHookCost(event: string | null): HookCostHint {
  if (event && INJECTS_CONTEXT_EVENTS.includes(event)) return 'injects-context';
  if (event === 'Stop' || event === 'SubagentStop') return 'extra-turn';
  return 'none';
}

function addHook(
  hookName: string,
  conf: Record<string, unknown>,
  handlerIdx: number,
  fileSource: SurfaceSource,
  filePath: string,
  hooksState: Map<string, boolean>,
  c: InventoryCollector,
): void {
  const event = typeof conf.event === 'string' ? conf.event : typeof conf.type === 'string' ? conf.type : null;
  const cmd = String(conf.command ?? conf.script ?? '');
  const isWmux = cmd.includes('wmux') || cmd.includes('.wmux');

  let enabled = conf.enabled !== false;
  // Match `hooks.state` on the exact key the writer uses; a loose match let one entry switch off
  // every hook with the same event in any file named hooks.json.
  if (event) {
    const exactKey = normalizeDriveAndSeparators(codexHookStateKey(filePath, event, handlerIdx));
    for (const [stateKey, stateVal] of hooksState.entries()) {
      if (normalizeDriveAndSeparators(stateKey) === exactKey) enabled = stateVal;
    }
  }

  c.add(
    makeItem({
      provider: 'codex',
      kind: 'hook',
      name: hookName,
      source: isWmux ? 'wmux' : fileSource,
      enabled,
      effect: 'removes',
      toggleable: true,
      hookEvent: event,
      hookCost: codexHookCost(event),
      originPath: filePath,
      wmuxRequired: isWmux,
    }),
  );
}

/** Skills from the user, project and built-in roots, in that order. */
async function addSkills(deps: InventoryDeps, c: InventoryCollector, disabledSkillPaths: Set<string>): Promise<void> {
  const skillRoots: Array<{ dirPath: string; source: SurfaceSource }> = [
    { dirPath: path.join(deps.homeDir, '.agents', 'skills'), source: 'user' },
  ];
  if (deps.projectDir) skillRoots.push({ dirPath: path.join(deps.projectDir, '.agents', 'skills'), source: 'project' });
  skillRoots.push({ dirPath: path.join(deps.homeDir, '.codex', 'skills', '.system'), source: 'builtin' });
  skillRoots.sort((a, b) => (LOCATION_SOURCE_ORDER[a.source] ?? 99) - (LOCATION_SOURCE_ORDER[b.source] ?? 99));

  for (const { dirPath, source } of skillRoots) {
    const isBuiltin = source === 'builtin';
    for (const s of await listSkills(dirPath, deps, c.warnings)) {
      const isDisabled = !isBuiltin
        && (disabledSkillPaths.has(normalizePath(s.mdPath)) || disabledSkillPaths.has(normalizePath(path.dirname(s.mdPath))));
      c.add(
        makeItem({
          provider: 'codex',
          kind: 'skill',
          name: s.name,
          source,
          enabled: !isDisabled,
          effect: 'removes',
          toggleable: !isBuiltin,
          readOnlyReason: isBuiltin ? 'Built-in skills cannot be disabled' : null,
          descriptionChars: s.descChars,
          originPath: s.mdPath,
        }),
      );
    }
  }
}
