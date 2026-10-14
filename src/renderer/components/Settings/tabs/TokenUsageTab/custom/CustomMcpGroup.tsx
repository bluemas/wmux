import { useMemo } from 'react';
import type { SurfaceItem } from '../../../../../../shared/tokenUsage/surfaceTypes';
import { useT } from '../../../../../hooks/useT';
import Badge from '../../../../ui/Badge';
import { ItemToggle, itemState, McpToolRow } from './McpToolRow';

export interface CustomMcpGroupProps {
  servers: SurfaceItem[];
  tools: SurfaceItem[];
  allServers?: SurfaceItem[];
  allTools?: SurfaceItem[];
  onToggle?: (itemId: string) => void;
  stagedChanges?: Map<string, boolean>;
  rejectedFlags?: Map<string, string>;
}

export function CustomMcpGroup({
  servers,
  tools,
  allServers,
  allTools,
  onToggle,
  stagedChanges,
  rejectedFlags,
}: CustomMcpGroupProps) {
  const t = useT();
  const displayServers = useMemo(() => {
    const list: Array<{ server: SurfaceItem; dimmed: boolean }> = [];
    const seenServerNames = new Set<string>();

    for (const server of servers) {
      seenServerNames.add(server.name);
      list.push({ server, dimmed: false });
    }

    for (const tool of tools) {
      if (tool.parent && !seenServerNames.has(tool.parent)) {
        seenServerNames.add(tool.parent);
        const parentServer = allServers?.find((s) => s.name === tool.parent) ?? {
          id: `${tool.provider}:mcp-server::${tool.parent}`,
          provider: tool.provider,
          kind: 'mcp-server' as const,
          name: tool.parent,
          parent: null,
          source: tool.source,
          enabled: true,
          effect: 'removes' as const,
          toggleable: false,
          readOnlyReason: null,
          hookEvent: null,
          hookCost: null,
          descriptionChars: null,
          originPath: null,
          wmuxRequired: false,
        };
        list.push({ server: parentServer, dimmed: true });
      }
    }

    return list;
  }, [servers, tools, allServers]);

  if (displayServers.length === 0) return null;

  return (
    <div className="flex flex-col gap-2 my-4" data-testid="token-custom-mcp-group">
      <span className="text-[10px] font-semibold tracking-wider uppercase text-[var(--text-sub)]">
        {t('settings.tokenUsage.mcpServersHeader', { count: displayServers.length })}
      </span>
      <div className="rounded-[12px] border border-[var(--border-soft)] bg-[var(--bg-surface)] overflow-hidden divide-y divide-[var(--border-soft)]">
        {displayServers.map(({ server, dimmed }) => {
          const serverTools = tools.filter((t) => t.parent === server.name);
          const allServerTools = allTools ? allTools.filter((t) => t.parent === server.name) : serverTools;
          const stagedToolsCount = allServerTools.filter((t) => stagedChanges?.has(t.id)).length;
          const { staged: isServerStaged, enabled: isServerEnabled } = itemState(server, stagedChanges);
          const isWmux = server.wmuxRequired || server.source === 'wmux';
          const serverRejection = rejectedFlags?.get(server.id);

          return (
            <div
              key={server.id}
              className="flex flex-col"
              data-testid={`mcp-server-${server.name}`}
              data-staged={isServerStaged ? 'true' : undefined}
            >
              <div
                className={`flex items-center justify-between px-3 py-2 text-[13px] ${dimmed ? 'opacity-60' : ''}`}
                data-testid={`mcp-server-header-${server.name}`}
              >
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-medium text-[var(--text-main)]">{server.name}</span>
                  <Badge tone="neutral">{server.source}</Badge>
                  {stagedToolsCount > 0 && (
                    <span className="text-[11px] text-[var(--text-sub)]">
                      {stagedToolsCount === 1 ? t('settings.tokenUsage.stagedToolOne') : t('settings.tokenUsage.stagedToolMany', { count: stagedToolsCount })}
                    </span>
                  )}
                  {isWmux && (
                    <Badge tone="warning">{t('settings.tokenUsage.neededByWmux')}</Badge>
                  )}
                  {isServerStaged && <Badge tone="warning">{t('settings.tokenUsage.staged')}</Badge>}
                  {serverRejection && (
                    <Badge tone="danger">{serverRejection}</Badge>
                  )}
                  {server.readOnlyReason && (
                    <span className="text-[11px] text-[var(--text-sub)]">({server.readOnlyReason})</span>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <ItemToggle
                    item={server}
                    enabled={isServerEnabled}
                    onToggle={onToggle}
                    testId={`toggle-mcp-server-${server.name}`}
                  />
                </div>
              </div>

              {serverTools.length > 0 && (
                <div className="pl-6 pr-3 pb-2 pt-0 flex flex-col gap-1">
                  {serverTools.map((tool) => (
                    <McpToolRow
                      key={tool.id}
                      tool={tool}
                      onToggle={onToggle}
                      stagedChanges={stagedChanges}
                      rejectedFlags={rejectedFlags}
                    />
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
