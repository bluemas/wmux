import path from 'node:path';
import type { HookCostHint, ProviderInventory, SurfaceItem, SurfaceSource } from '../../../shared/tokenUsage/surfaceTypes';
import { SurfacesStore } from '../safeWrite';
import {
  addEffectiveWmuxTools,
  finishInventory,
  InventoryCollector,
  LIVE_TOOLS_WARNING,
  listSkills,
} from './collector';
import {
  hookFingerprint,
  hookItemId,
  normalizePath,
  queryCliVersion,
  safeParseJson,
  safeReaddir,
  safeReadFile,
} from './helpers';
import { makeItem, type InventoryDeps } from './types';
import type { WmuxServerDeclaration } from './wmuxTools';

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  const objA = a as Record<string, unknown>;
  const objB = b as Record<string, unknown>;
  const keysA = Object.keys(objA);
  const keysB = Object.keys(objB);
  if (keysA.length !== keysB.length) return false;
  for (const k of keysA) {
    if (!Object.prototype.hasOwnProperty.call(objB, k)) return false;
    if (!deepEqual(objA[k], objB[k])) return false;
  }
  return true;
}

/** `disable*` keys are inverted: `disableBundledSkills: true` means the feature is off. */
export function contextSettingEnabled(key: string, value: boolean): boolean {
  return key.startsWith('disable') ? !value : value;
}

const CONTEXT_KEYS = [
  'autoMemoryEnabled',
  'claudeMdExcludes',
  'skillListingBudgetFraction',
  'skillListingMaxDescChars',
  'autoCompactEnabled',
  'disableBundledSkills',
];
const INJECTS_CONTEXT_EVENTS = ['SessionStart', 'UserPromptSubmit', 'UserPromptExpansion'];
const MANAGED_HOOK_REASON = 'Managed hooks cannot be toggled';

interface LiveHookInfo {
  event: string;
  handler: Record<string, unknown>;
  groupMeta?: Record<string, unknown>;
  originPath: string;
}

/** What the settings files say, read in order (user, user local, project, project local). */
interface ClaudeSettings {
  deniedMcpServers: Set<string>;
  mcpToolDenies: Map<string, Set<string>>; // serverName -> Set<toolName>
  skillOverrides: Map<string, string>;
  // Which settings file holds each deny or override, so a change is written back to that file.
  deniedServerFile: Map<string, string>;
  toolDenyFile: Map<string, string>;
  skillOverrideFile: Map<string, string>;
  /** Set by the first file that disables all hooks; hooks read from that file on are listed as off. */
  disableAllHooks: boolean;
  liveHooks: LiveHookInfo[];
}

export async function readClaudeInventory(deps: InventoryDeps): Promise<ProviderInventory> {
  const c = new InventoryCollector();
  const cliVersion = await queryCliVersion('claude', deps.run);
  const versionSupported = cliVersion !== null;

  const settings: ClaudeSettings = {
    deniedMcpServers: new Set(),
    mcpToolDenies: new Map(),
    skillOverrides: new Map(),
    deniedServerFile: new Map(),
    toolDenyFile: new Map(),
    skillOverrideFile: new Map(),
    disableAllHooks: false,
    liveHooks: [],
  };
  for (const sp of settingsPaths(deps)) {
    const content = await safeReadFile(sp, deps, c.warnings);
    if (!content) continue;
    const parsed = safeParseJson<Record<string, unknown>>(sp, content, c.warnings);
    if (!parsed || typeof parsed !== 'object') continue;
    readSettingsFile(parsed, sp, settings, deps, c);
  }

  addRemovedHooks(deps, c, settings.liveHooks, versionSupported);
  const hasMcpServers = await addMcpServers(deps, c, settings);
  await addSkills(deps, c, settings.skillOverrides);
  if (hasMcpServers) c.warnings.push(LIVE_TOOLS_WARNING);

  for (const item of c.items) {
    const file = settingsFileFor(item, settings);
    if (file) item.settingsPath = file;
  }
  return finishInventory('claude', c, { cliVersion, versionSupported }, deps);
}

function settingsPaths(deps: InventoryDeps): string[] {
  const paths = [
    path.join(deps.homeDir, '.claude', 'settings.json'),
    path.join(deps.homeDir, '.claude', 'settings.local.json'),
  ];
  if (deps.projectDir) {
    paths.push(path.join(deps.projectDir, '.claude', 'settings.json'));
    paths.push(path.join(deps.projectDir, '.claude', 'settings.local.json'));
  }
  return paths;
}

function readSettingsFile(
  parsed: Record<string, unknown>,
  sp: string,
  s: ClaudeSettings,
  deps: InventoryDeps,
  c: InventoryCollector,
): void {
  if (parsed.disableAllHooks === true) s.disableAllHooks = true;
  collectDeniedServers(parsed.deniedMcpServers, sp, s);
  readPermissionDenies(parsed.permissions, sp, s, c);
  addPlugins(parsed.enabledPlugins, sp, c);
  collectSkillOverrides(parsed.skillOverrides, sp, s);
  addContextSettings(parsed, sp, c);
  addSettingsHooks(parsed.hooks, sp, s, deps, c);
}

function collectDeniedServers(denied: unknown, sp: string, s: ClaudeSettings): void {
  if (!Array.isArray(denied)) return;
  for (const d of denied) {
    if (!d || typeof d !== 'object') continue;
    const serverName = (d as { serverName?: unknown }).serverName;
    if (typeof serverName !== 'string') continue;
    s.deniedMcpServers.add(serverName);
    s.deniedServerFile.set(serverName, sp);
  }
}

/** `permissions.deny`: `mcp__<server>__<tool>` entries switch a tool off, any other entry is a built-in tool. */
function readPermissionDenies(permissions: unknown, sp: string, s: ClaudeSettings, c: InventoryCollector): void {
  if (!permissions || typeof permissions !== 'object') return;
  const deny = (permissions as { deny?: unknown }).deny;
  if (!Array.isArray(deny)) return;
  for (const item of deny) {
    if (typeof item !== 'string') continue;
    const mcpMatch = /^mcp__([a-zA-Z0-9_-]+)__(.+)$/.exec(item);
    if (!mcpMatch) {
      c.add(
        makeItem({
          provider: 'claude',
          kind: 'builtin-tool',
          name: item,
          source: 'builtin',
          enabled: false,
          effect: 'removes',
          toggleable: true,
          originPath: sp,
        }),
      );
      continue;
    }
    const [, server, tool] = mcpMatch;
    let set = s.mcpToolDenies.get(server);
    if (!set) {
      set = new Set<string>();
      s.mcpToolDenies.set(server, set);
    }
    set.add(tool);
    s.toolDenyFile.set(`${server}/${tool}`, sp);
  }
}

function addPlugins(plugins: unknown, sp: string, c: InventoryCollector): void {
  if (!plugins || typeof plugins !== 'object' || Array.isArray(plugins)) return;
  for (const [pluginName, val] of Object.entries(plugins)) {
    c.add(
      makeItem({
        provider: 'claude',
        kind: 'plugin',
        name: pluginName,
        source: 'user',
        enabled: val !== false,
        effect: 'removes',
        toggleable: true,
        originPath: sp,
      }),
    );
  }
}

function collectSkillOverrides(overrides: unknown, sp: string, s: ClaudeSettings): void {
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) return;
  for (const [k, v] of Object.entries(overrides)) {
    if (typeof v !== 'string') continue;
    s.skillOverrides.set(k, v);
    s.skillOverrideFile.set(k, sp);
  }
}

function addContextSettings(parsed: Record<string, unknown>, sp: string, c: InventoryCollector): void {
  for (const ck of CONTEXT_KEYS) {
    if (!(ck in parsed)) continue;
    const value = parsed[ck];
    // Only booleans can be switched: a number or list has no "off" value to write and restore.
    const isBoolean = typeof value === 'boolean';
    c.add(
      makeItem({
        provider: 'claude',
        kind: 'context-setting',
        name: ck,
        source: 'user',
        enabled: isBoolean ? contextSettingEnabled(ck, value) : null,
        effect: 'removes',
        toggleable: isBoolean,
        readOnlyReason: isBoolean ? null : 'Only on/off settings can be switched here; edit this value in settings.json.',
        originPath: sp,
      }),
    );
  }
}

/** `hooks.<event>`: a matcher group (`{ matcher, hooks: [...] }`) or a bare handler, alone or in a list. */
function addSettingsHooks(
  hooks: unknown,
  sp: string,
  s: ClaudeSettings,
  deps: InventoryDeps,
  c: InventoryCollector,
): void {
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) return;
  for (const [event, eventHooks] of Object.entries(hooks)) {
    const hookList: unknown[] = Array.isArray(eventHooks) ? eventHooks : [eventHooks];
    for (const hookDef of hookList) {
      if (hookDef && typeof hookDef === 'object') addHookDefinition(event, hookDef as Record<string, unknown>, sp, s, deps, c);
    }
  }
}

function addHookDefinition(
  event: string,
  groupOrHandler: Record<string, unknown>,
  sp: string,
  s: ClaudeSettings,
  deps: InventoryDeps,
  c: InventoryCollector,
): void {
  if (!Array.isArray(groupOrHandler.hooks)) {
    s.liveHooks.push({ event, handler: groupOrHandler, originPath: sp });
    addLiveHook(event, groupOrHandler, sp, undefined, s.disableAllHooks, deps, c);
    return;
  }
  const groupMeta: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(groupOrHandler)) {
    if (k !== 'hooks') groupMeta[k] = v;
  }
  for (const item of groupOrHandler.hooks) {
    if (!item || typeof item !== 'object') continue;
    const h = item as Record<string, unknown>;
    s.liveHooks.push({ event, handler: h, groupMeta, originPath: sp });
    addLiveHook(event, h, sp, groupMeta, s.disableAllHooks, deps, c);
  }
}

function claudeHookCost(type: string, event: string): HookCostHint {
  if (type === 'prompt' || type === 'agent') return 'calls-model';
  if (event === 'Stop' || event === 'SubagentStop') return 'extra-turn';
  if (INJECTS_CONTEXT_EVENTS.includes(event)) return 'injects-context';
  return 'none';
}

/** Name, source and cost of one hook handler, live or removed. */
function describeHook(event: string, h: Record<string, unknown>, originPath: string | null, deps: InventoryDeps) {
  const type = typeof h.type === 'string' ? h.type : 'command';
  const cmd = String(h.command ?? h.prompt ?? h.script ?? '');
  const isWmux = cmd.includes('wmux') || cmd.includes('.wmux');
  const isManaged = h.managed === true;
  const isProject = deps.projectDir && originPath
    ? normalizePath(originPath).startsWith(normalizePath(deps.projectDir))
    : false;
  const source: SurfaceSource = isWmux ? 'wmux' : isManaged ? 'managed' : isProject ? 'project' : 'user';
  return {
    name: (typeof h.name === 'string' && h.name) || `${event}-${type}`,
    source,
    isWmux,
    isManaged,
    hookCost: claudeHookCost(type, event),
  };
}

function addLiveHook(
  event: string,
  h: Record<string, unknown>,
  originPath: string,
  groupMeta: Record<string, unknown> | undefined,
  disableAllHooks: boolean,
  deps: InventoryDeps,
  c: InventoryCollector,
): void {
  const d = describeHook(event, h, originPath, deps);
  const fingerprint = hookFingerprint(event, groupMeta, h);
  c.add({
    ...makeItem({
      provider: 'claude',
      kind: 'hook',
      name: d.name,
      source: d.source,
      enabled: !disableAllHooks,
      effect: 'removes',
      toggleable: !d.isManaged,
      readOnlyReason: d.isManaged ? MANAGED_HOOK_REASON : null,
      hookEvent: event,
      hookCost: d.hookCost,
      hookFingerprint: fingerprint,
      originPath,
      wmuxRequired: d.isWmux,
    }),
    id: hookItemId(d.name, originPath, fingerprint),
  });
}

interface RemovedHook {
  id: string;
  event: string;
  handler: Record<string, unknown>;
  groupMeta: Record<string, unknown> | undefined;
  originPath: string | null;
}

/**
 * Hooks wmux removed from a settings file and keeps in surfaces.json, listed as off so they can be
 * switched back on. Read-only use of the store: a store that cannot be read adds no removed hook.
 */
function addRemovedHooks(
  deps: InventoryDeps,
  c: InventoryCollector,
  liveHooks: LiveHookInfo[],
  versionSupported: boolean,
): void {
  const store = new SurfacesStore(deps.surfacesStorePath ?? path.join(deps.homeDir, '.wmux', 'surfaces.json'));
  try {
    store.load();
  } catch {
    c.warnings.push('The surfaces store file is corrupt and could not be read.');
  }
  for (const w of store.warnings) c.warnOnce(storeWarning(w));

  const liveItemsCount = c.items.length;
  try {
    const rawClaude = (store as unknown as { removedHooksStore?: Record<string, unknown> }).removedHooksStore?.claude;
    if (rawClaude !== undefined && !Array.isArray(rawClaude)) {
      throw new Error('removedHooks.claude is not an array');
    }

    let hasInvalidEntries = false;
    for (const rawEntry of store.removedHooks.list('claude')) {
      const removed = parseRemovedHook(rawEntry);
      if (!removed) {
        hasInvalidEntries = true;
        continue;
      }
      if (c.seenIds.has(removed.id) || c.items.some((i) => i.id === removed.id)) continue;
      if (isStillLive(removed, liveHooks)) continue;
      c.addExact(removedHookItem(removed, deps, versionSupported));
    }
    if (hasInvalidEntries) c.warnOnce('One or more removed hooks in the surfaces store are invalid and were skipped.');
  } catch {
    c.truncate(liveItemsCount);
    c.warnOnce('The surfaces store could not be read.');
  }
}

function storeWarning(w: string): string {
  if (w.startsWith('Corrupt surfaces store')) return 'The surfaces store file is corrupt and could not be read.';
  if (w.startsWith('Unknown or unsupported surfaces store version')) return 'The surfaces store has an unsupported or newer version.';
  return 'The surfaces store could not be read.';
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** A stored removed hook, or null when the entry is malformed. */
function parseRemovedHook(rawEntry: unknown): RemovedHook | null {
  if (!isPlainObject(rawEntry)) return null;
  const { id, originPath, definition } = rawEntry;
  if (typeof id !== 'string' || id.trim() === '') return null;
  if (originPath !== undefined && originPath !== null && typeof originPath !== 'string') return null;
  if (!isPlainObject(definition)) return null;

  return {
    id,
    event: typeof definition.event === 'string' ? definition.event : 'PreToolUse',
    handler: removedHandler(definition),
    groupMeta: isPlainObject(definition.groupMeta) ? definition.groupMeta : undefined,
    originPath: typeof originPath === 'string' && originPath.trim().length > 0 ? originPath : null,
  };
}

function removedHandler(definition: Record<string, unknown>): Record<string, unknown> {
  if (isPlainObject(definition.handler)) return definition.handler;
  // Older entries stored the handler's fields next to `event` and `groupMeta`.
  const handler: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(definition)) {
    if (k !== 'event' && k !== 'groupMeta') handler[k] = v;
  }
  return handler;
}

/** The same handler is back in its settings file (same event, file and matcher group). */
function isStillLive(removed: RemovedHook, liveHooks: LiveHookInfo[]): boolean {
  return liveHooks.some((live) => {
    if (live.event !== removed.event) return false;
    if (removed.originPath && normalizePath(live.originPath) !== normalizePath(removed.originPath)) return false;
    if (!deepEqual(live.handler, removed.handler)) return false;
    if (removed.groupMeta === undefined) return live.groupMeta === undefined;
    return !!live.groupMeta && deepEqual(live.groupMeta, removed.groupMeta);
  });
}

function removedHookItem(removed: RemovedHook, deps: InventoryDeps, versionSupported: boolean): SurfaceItem {
  const d = describeHook(removed.event, removed.handler, removed.originPath, deps);
  const readOnlyReason = d.isManaged
    ? MANAGED_HOOK_REASON
    : (!versionSupported ? 'CLI version not supported (read-only)' : null);
  return {
    ...makeItem({
      provider: 'claude',
      kind: 'hook',
      name: d.name,
      source: d.source,
      enabled: false,
      effect: 'removes',
      toggleable: versionSupported && !d.isManaged,
      readOnlyReason,
      hookEvent: removed.event,
      hookCost: d.hookCost,
      hookFingerprint: hookFingerprint(removed.event, removed.groupMeta, removed.handler),
      originPath: removed.originPath,
      wmuxRequired: d.isWmux,
    }),
    id: removed.id,
  };
}

/** Projects in ~/.claude.json whose path is this project. */
function matchingProjects(parsedClaudeJson: Record<string, unknown> | null, projectDir: string | undefined): object[] {
  const projects = parsedClaudeJson?.projects;
  if (!projectDir || !projects || typeof projects !== 'object') return [];
  const normProjDir = normalizePath(projectDir);
  return Object.entries(projects as Record<string, unknown>)
    .filter(([projPath, projConf]) => normalizePath(projPath) === normProjDir && projConf && typeof projConf === 'object')
    .map(([, projConf]) => projConf as object);
}

/** A JSON file's content, or null when it is missing, empty or does not parse (the reason is a warning). */
async function readJson(filePath: string, deps: InventoryDeps, c: InventoryCollector): Promise<Record<string, unknown> | null> {
  const content = await safeReadFile(filePath, deps, c.warnings);
  return content ? safeParseJson<Record<string, unknown>>(filePath, content, c.warnings) : null;
}

function projectDisabledServers(projects: object[]): Set<string> {
  const disabled = new Set<string>();
  for (const projConf of projects) {
    const list = (projConf as { disabledMcpServers?: unknown }).disabledMcpServers;
    if (!Array.isArray(list)) continue;
    for (const name of list) {
      if (typeof name === 'string') disabled.add(name);
    }
  }
  return disabled;
}

function serverNames(servers: unknown): string[] {
  return servers && typeof servers === 'object' && !Array.isArray(servers) ? Object.keys(servers) : [];
}

/** User and project servers from ~/.claude.json, then the project's .mcp.json. Returns whether any was listed. */
async function addMcpServers(deps: InventoryDeps, c: InventoryCollector, s: ClaudeSettings): Promise<boolean> {
  const claudeJsonPath = path.join(deps.homeDir, '.claude.json');
  const parsedClaudeJson = await readJson(claudeJsonPath, deps, c);
  const projects = matchingProjects(parsedClaudeJson, deps.projectDir);

  const projectDisabled = projectDisabledServers(projects);

  const declarations: WmuxServerDeclaration[] = [];
  let hasMcpServers = false;
  const add = (serverName: string, source: SurfaceSource, originPath: string) => {
    hasMcpServers = true;
    const isDenied = s.deniedMcpServers.has(serverName) || projectDisabled.has(serverName);
    addMcpServer(serverName, source, originPath, isDenied, s, c, declarations);
  };

  for (const name of serverNames(parsedClaudeJson?.mcpServers)) add(name, 'user', claudeJsonPath);
  for (const projConf of projects) {
    for (const name of serverNames((projConf as { mcpServers?: unknown }).mcpServers)) add(name, 'project', claudeJsonPath);
  }
  if (deps.projectDir) {
    const projectMcpJsonPath = path.join(deps.projectDir, '.mcp.json');
    const parsedPMcp = await readJson(projectMcpJsonPath, deps, c);
    for (const name of serverNames(parsedPMcp?.mcpServers)) add(name, 'project', projectMcpJsonPath);
  }

  addEffectiveWmuxTools(c, 'claude', declarations, deps);
  return hasMcpServers;
}

function addMcpServer(
  serverName: string,
  source: SurfaceSource,
  originPath: string,
  isDenied: boolean,
  s: ClaudeSettings,
  c: InventoryCollector,
  declarations: WmuxServerDeclaration[],
): void {
  const isWmux = serverName === 'wmux';
  const finalSource: SurfaceSource = isWmux ? 'wmux' : source;
  const serverItem = makeItem({
    provider: 'claude',
    kind: 'mcp-server',
    name: serverName,
    source: finalSource,
    enabled: !isDenied,
    effect: 'removes',
    toggleable: true,
    originPath,
    wmuxRequired: isWmux,
  });
  c.add(serverItem);

  const deniedTools = s.mcpToolDenies.get(serverName);
  if (isWmux) {
    declarations.push({
      source: source as 'project' | 'user' | 'plugin',
      serverItem,
      disabledNames: deniedTools ?? new Set<string>(),
      originPath,
    });
    return;
  }
  for (const tool of deniedTools ?? []) {
    c.add(
      makeItem({
        provider: 'claude',
        kind: 'mcp-tool',
        name: tool,
        parent: serverName,
        source: finalSource,
        enabled: false,
        effect: 'removes',
        toggleable: true,
        originPath,
      }),
    );
  }
}

/** User and project skills (switchable through skillOverrides), then plugin skills (read-only). */
async function addSkills(deps: InventoryDeps, c: InventoryCollector, skillOverrides: Map<string, string>): Promise<void> {
  const roots: Array<{ dirPath: string; source: SurfaceSource }> = [
    { dirPath: path.join(deps.homeDir, '.claude', 'skills'), source: 'user' },
  ];
  if (deps.projectDir) roots.push({ dirPath: path.join(deps.projectDir, '.claude', 'skills'), source: 'project' });
  for (const { dirPath, source } of roots) {
    for (const s of await listSkills(dirPath, deps, c.warnings)) {
      const override = skillOverrides.get(s.name) ?? skillOverrides.get(s.dir);
      c.add(
        makeItem({
          provider: 'claude',
          kind: 'skill',
          name: s.name,
          source,
          enabled: override !== 'off',
          effect: 'removes',
          toggleable: true,
          descriptionChars: s.descChars,
          originPath: s.mdPath,
        }),
      );
    }
  }

  const pluginsDir = path.join(deps.homeDir, '.claude', 'plugins');
  for (const pdir of await safeReaddir(pluginsDir, deps)) {
    for (const s of await listSkills(path.join(pluginsDir, pdir, 'skills'), deps, c.warnings)) {
      c.add(
        makeItem({
          provider: 'claude',
          kind: 'skill',
          name: s.name,
          source: 'plugin',
          enabled: true,
          effect: 'removes',
          toggleable: false,
          readOnlyReason: 'Plugin skills cannot be toggled in Claude Code',
          descriptionChars: s.descChars,
          originPath: s.mdPath,
        }),
      );
    }
  }
}

/** The settings file holding the deny or override behind an item, so a change is written back there. */
function settingsFileFor(item: SurfaceItem, s: ClaudeSettings): string | undefined {
  switch (item.kind) {
    case 'mcp-server':
      return s.deniedServerFile.get(item.name);
    case 'mcp-tool':
      return s.toolDenyFile.get(`${item.parent}/${item.name}`);
    case 'skill':
      return s.skillOverrideFile.get(item.name)
        ?? (item.originPath ? s.skillOverrideFile.get(path.basename(path.dirname(item.originPath))) : undefined);
    default:
      return undefined;
  }
}
