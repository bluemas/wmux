// @vitest-environment jsdom
// Characterization of CustomMcpGroup and CustomWmuxToolsGroup: each scenario
// renders a group and compares its exact HTML with a recorded golden file in
// ./fixtures/custom-groups, so the rows can be shared without changing a single
// attribute, class, test id or label. Covers every row state: enabled,
// disabled, staged either way, rejected, read-only with a reason, not
// toggleable, no onToggle, wmux-required servers, dimmed parent servers and
// staged-tool counts.
//
// Re-record only on purpose: WMUX_RECORD_CUSTOM_GROUPS=1 npx vitest run <this file>

import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { SurfaceItem } from '../../../../../../shared/tokenUsage/surfaceTypes';
import { CustomMcpGroup } from '../custom/CustomMcpGroup';
import { CustomWmuxToolsGroup } from '../custom/CustomWmuxToolsGroup';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const RECORD = process.env.WMUX_RECORD_CUSTOM_GROUPS === '1';
const GOLDEN_DIR = path.join(__dirname, 'fixtures', 'custom-groups');

function item(kind: 'mcp-server' | 'mcp-tool', name: string, o: Partial<SurfaceItem> = {}): SurfaceItem {
  return {
    id: `claude:${kind}:${o.parent ?? ''}:${name}`,
    provider: 'claude',
    kind,
    name,
    parent: null,
    source: 'user',
    enabled: true,
    effect: 'removes',
    toggleable: true,
    readOnlyReason: null,
    hookEvent: null,
    hookCost: null,
    descriptionChars: null,
    originPath: '/home/.claude.json',
    wmuxRequired: false,
    ...o,
  };
}

const tool = (parent: string, name: string, o: Partial<SurfaceItem> = {}) => item('mcp-tool', name, { parent, ...o });

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  document.body.removeChild(container);
});

async function render(element: ReturnType<typeof createElement>): Promise<string> {
  await act(async () => {
    root.render(element);
  });
  // One element per line, so a golden diff points at the row that changed.
  return container.innerHTML.replace(/></g, '>\n<') + '\n';
}

function golden(name: string, html: string): void {
  const file = path.join(GOLDEN_DIR, `${name}.html`);
  if (RECORD) {
    fs.mkdirSync(GOLDEN_DIR, { recursive: true });
    fs.writeFileSync(file, html);
    return;
  }
  expect(html).toBe(fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n'));
}

const toolStates = (parent: string) => [
  tool(parent, 'plain'),
  tool(parent, 'disabled', { enabled: false }),
  tool(parent, 'unknown-state', { enabled: null }),
  tool(parent, 'staged-off'),
  tool(parent, 'staged-on', { enabled: false }),
  tool(parent, 'rejected'),
  tool(parent, 'read-only', { toggleable: false, readOnlyReason: 'Managed by policy' }),
  tool(parent, 'read-only-off', { toggleable: false, enabled: false }),
];

const staged = (parent: string) =>
  new Map<string, boolean>([
    [tool(parent, 'staged-off').id, false],
    [tool(parent, 'staged-on').id, true],
  ]);

const rejected = (parent: string) => new Map<string, string>([[tool(parent, 'rejected').id, 'Already in the requested state.']]);

describe('Custom tab groups characterization', () => {
  it('MCP group: every server and tool state, with a toggle handler', async () => {
    const servers = [
      item('mcp-server', 'srv'),
      item('mcp-server', 'srv-off', { enabled: false }),
      item('mcp-server', 'srv-staged'),
      item('mcp-server', 'srv-rejected', { source: 'project' }),
      item('mcp-server', 'srv-ro', { toggleable: false, readOnlyReason: 'Set by your organization' }),
      item('mcp-server', 'wmux', { source: 'wmux', wmuxRequired: true }),
    ];
    const tools = [...toolStates('srv'), tool('srv-off', 'one'), tool('wmux', 'terminal_read')];
    const stagedChanges = new Map([...staged('srv'), [servers[2].id, false]]);
    const rejectedFlags = new Map([...rejected('srv'), [servers[3].id, 'Item not found; the configuration changed since it was listed.']]);
    golden('mcp-all-states', await render(createElement(CustomMcpGroup, {
      servers, tools, allTools: tools, stagedChanges, rejectedFlags, onToggle: () => undefined,
    })));
  });

  it('MCP group: no toggle handler, dimmed parents, staged-tool counts', async () => {
    const tools = [tool('hidden', 'a'), tool('hidden', 'b'), tool('listed', 'c'), tool('ghost', 'd')];
    const allTools = [...tools, tool('hidden', 'filtered-out'), tool('listed', 'filtered-too')];
    const stagedChanges = new Map<string, boolean>([
      [tool('hidden', 'a').id, false],
      [tool('hidden', 'filtered-out').id, true],
      [tool('listed', 'filtered-too').id, false],
    ]);
    golden('mcp-readonly-dimmed', await render(createElement(CustomMcpGroup, {
      servers: [item('mcp-server', 'listed')],
      tools,
      allServers: [item('mcp-server', 'hidden', { enabled: false, source: 'project' })],
      allTools,
      stagedChanges,
    })));
    golden('mcp-empty', await render(createElement(CustomMcpGroup, { servers: [], tools: [] })));
  });

  it('wmux tools group: every tool state, with and without a toggle handler', async () => {
    const tools = toolStates('wmux');
    golden('wmux-all-states', await render(createElement(CustomWmuxToolsGroup, {
      tools, allTools: tools, stagedChanges: staged('wmux'), rejectedFlags: rejected('wmux'), onToggle: () => undefined,
    })));
    golden('wmux-no-handler', await render(createElement(CustomWmuxToolsGroup, { tools, allTools: tools })));
    golden('wmux-empty', await render(createElement(CustomWmuxToolsGroup, { tools: [], allTools: tools })));
  });
});
