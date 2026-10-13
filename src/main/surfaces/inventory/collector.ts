import path from 'node:path';
import type { ProviderInventory, SurfaceItem, SurfaceProviderId } from '../../../shared/tokenUsage/surfaceTypes';
import { parseSkillFrontmatter, safeReaddir, safeReadFile } from './helpers';
import { allocateUniqueItemId, type InventoryDeps } from './types';
import { resolveEffectiveWmuxServer, wmuxToolItems, type WmuxServerDeclaration } from './wmuxTools';

export const LIVE_TOOLS_WARNING = 'Full MCP tool list requires live tools/list (config only records tool overrides).';
const UNSUPPORTED_REASON = 'CLI version not supported (read-only)';

/** The items and warnings one provider reader builds, with ids kept unique as items arrive. */
export class InventoryCollector {
  readonly items: SurfaceItem[] = [];
  readonly warnings: string[] = [];
  readonly seenIds = new Set<string>();

  /** Add an item; an id already taken gets a source suffix (see allocateUniqueItemId). */
  add(item: SurfaceItem): void {
    const uniqueId = allocateUniqueItemId(this.seenIds, item.id, item.source);
    this.items.push(uniqueId !== item.id ? { ...item, id: uniqueId } : item);
  }

  /** Add an item under its own id, which the caller has checked is free. */
  addExact(item: SurfaceItem): void {
    this.seenIds.add(item.id);
    this.items.push(item);
  }

  warnOnce(message: string): void {
    if (!this.warnings.includes(message)) this.warnings.push(message);
  }

  /** Drop every item added after the first `count`, and the ids they held. */
  truncate(count: number): void {
    this.items.length = count;
    this.seenIds.clear();
    for (const it of this.items) this.seenIds.add(it.id);
  }
}

/** The tool rows of the wmux server that wins among its declarations, plus the warning when several compete. */
export function addEffectiveWmuxTools(
  c: InventoryCollector,
  provider: SurfaceProviderId,
  declarations: WmuxServerDeclaration[],
  deps: InventoryDeps,
): void {
  const effective = resolveEffectiveWmuxServer(declarations);
  if (!effective) return;
  if (effective.warning) c.warnings.push(effective.warning);
  for (const toolItem of wmuxToolItems(provider, effective.effective.serverItem, effective.effective.disabledNames, deps)) {
    if (!c.seenIds.has(toolItem.id)) c.add(toolItem);
  }
}

export interface SkillEntry {
  /** The skill's directory name. */
  dir: string;
  mdPath: string;
  /** Frontmatter `name`, else the directory name. */
  name: string;
  /** Characters the skill listing spends on it: name plus description. */
  descChars: number;
}

/** Every `<dirPath>/<skill>/SKILL.md` that can be read, in directory order. */
export async function listSkills(dirPath: string, deps: InventoryDeps, warnings: string[]): Promise<SkillEntry[]> {
  const skills: SkillEntry[] = [];
  for (const dir of await safeReaddir(dirPath, deps)) {
    const mdPath = path.join(dirPath, dir, 'SKILL.md');
    const content = await safeReadFile(mdPath, deps, warnings);
    if (content === null) continue;
    const fm = parseSkillFrontmatter(content);
    const name = fm.name || dir;
    skills.push({ dir, mdPath, name, descChars: name.length + (fm.description ?? '').length });
  }
  return skills;
}

/** The provider result. An unsupported CLI version leaves every row visible but read-only. */
export function finishInventory(
  provider: SurfaceProviderId,
  c: InventoryCollector,
  version: { cliVersion: string | null; versionSupported: boolean },
  deps: InventoryDeps,
): ProviderInventory {
  if (!version.versionSupported) {
    for (const item of c.items) {
      if (!item.toggleable) continue;
      item.toggleable = false;
      item.readOnlyReason = UNSUPPORTED_REASON;
    }
  }
  return {
    provider,
    cliVersion: version.cliVersion,
    versionSupported: version.versionSupported,
    writable: version.versionSupported,
    items: c.items,
    warnings: c.warnings,
    scannedAtMs: deps.now ? deps.now() : Date.now(),
  };
}
