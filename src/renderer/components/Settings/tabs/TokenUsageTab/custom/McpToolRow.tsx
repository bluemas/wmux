import type { SurfaceItem } from '../../../../../../shared/tokenUsage/surfaceTypes';
import { useT } from '../../../../../hooks/useT';
import Badge from '../../../../ui/Badge';
import Switch from '../../../../ui/Switch';

/** Whether a change for this item is staged, and the state shown for it (the staged one wins). */
export function itemState(item: SurfaceItem, stagedChanges?: Map<string, boolean>): { staged: boolean; enabled: boolean } {
  const staged = stagedChanges?.has(item.id) ?? false;
  return { staged, enabled: staged ? stagedChanges?.get(item.id) === true : item.enabled !== false };
}

export interface ItemToggleProps {
  item: SurfaceItem;
  enabled: boolean;
  onToggle?: (itemId: string) => void;
  testId: string;
}

/** A switch for a toggleable item when there is a handler; otherwise a badge with its state. */
export function ItemToggle({ item, enabled, onToggle, testId }: ItemToggleProps) {
  const t = useT();
  if (item.toggleable && onToggle) {
    return (
      <Switch
        checked={enabled}
        onCheckedChange={() => onToggle(item.id)}
        aria-label={t('settings.tokenUsage.toggleAria', { name: item.name })}
        data-testid={testId}
      />
    );
  }
  return (
    <Badge tone={enabled ? 'success' : 'neutral'}>
      {enabled ? t('settings.tokenUsage.enabled') : t('settings.tokenUsage.disabled')}
    </Badge>
  );
}

export interface McpToolRowProps {
  tool: SurfaceItem;
  onToggle?: (itemId: string) => void;
  stagedChanges?: Map<string, boolean>;
  rejectedFlags?: Map<string, string>;
  /** The wmux tools list hides the decorative arrow from screen readers; the MCP server list does not. */
  arrowAriaHidden?: boolean;
}

/** One MCP tool under its server: name, staged and rejected badges, read-only reason, toggle. */
export function McpToolRow({ tool, onToggle, stagedChanges, rejectedFlags, arrowAriaHidden }: McpToolRowProps) {
  const t = useT();
  const { staged, enabled } = itemState(tool, stagedChanges);
  const rejection = rejectedFlags?.get(tool.id);
  return (
    <div
      className="flex items-center justify-between text-[11px] py-1 border-t border-[var(--border-soft)]"
      data-testid={`mcp-tool-${tool.name}`}
      data-staged={staged ? 'true' : undefined}
    >
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-[var(--text-sub)]" aria-hidden={arrowAriaHidden ? 'true' : undefined}>↳</span>
        <span className="ui-code text-[var(--text-main)]">{tool.name}</span>
        {staged && <Badge tone="warning">{t('settings.tokenUsage.staged')}</Badge>}
        {rejection && <Badge tone="danger">{rejection}</Badge>}
        {tool.readOnlyReason && (
          <span className="text-[10px] text-[var(--text-sub)]">({tool.readOnlyReason})</span>
        )}
      </div>
      <div className="flex items-center gap-2">
        <ItemToggle item={tool} enabled={enabled} onToggle={onToggle} testId={`toggle-mcp-tool-${tool.name}`} />
      </div>
    </div>
  );
}
