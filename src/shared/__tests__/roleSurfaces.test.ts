import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CORE_TOOL_SURFACE } from '../coreSurface';
import { ORCH_ROLES } from '../orchestratorRole';
import { UNLISTED_TOOLS_SET } from '../unlistedTools';
import { ROLE_TOOL_SURFACES, parseRoleArg, roleArgValue } from '../roleSurfaces';

const baseline = JSON.parse(
  readFileSync(path.resolve(__dirname, '../../../scripts/mcp-protocol-baseline.json'), 'utf8'),
) as { profiles: { core: { toolNames: string[] } } };

describe('role surfaces', () => {
  it('has one entry per orchestrator role', () => {
    expect(Object.keys(ROLE_TOOL_SURFACES).sort()).toEqual([...ORCH_ROLES].sort());
  });

  it('every name is a LISTED core tool (no stale or unlisted name)', () => {
    const core = new Set(CORE_TOOL_SURFACE);
    const listedCore = new Set(baseline.profiles.core.toolNames);
    for (const [role, names] of Object.entries(ROLE_TOOL_SURFACES)) {
      for (const name of names) {
        expect(core.has(name), `${role}: ${name} not in CORE_TOOL_SURFACE`).toBe(true);
        expect(listedCore.has(name), `${role}: ${name} not in the core tools/list baseline`).toBe(true);
        expect(UNLISTED_TOOLS_SET.has(name), `${role}: ${name} is unlisted`).toBe(false);
      }
      expect(new Set(names).size, `${role} has duplicates`).toBe(names.length);
    }
  });

  it('parses --role=<Role>; last one wins; unknown names are reported', () => {
    expect(parseRoleArg(['node', 'x'])).toEqual({ kind: 'none' });
    expect(parseRoleArg(['--role=Reviewer'])).toEqual({ kind: 'role', role: 'Reviewer' });
    expect(parseRoleArg(['--role=Planner', '--role=Builder'])).toEqual({ kind: 'role', role: 'Builder' });
    expect(parseRoleArg(['--role=reviewer'])).toEqual({ kind: 'unknown', value: 'reviewer' });
    expect(parseRoleArg(['--role=toString'])).toEqual({ kind: 'unknown', value: 'toString' });
    expect(parseRoleArg(['--role='])).toEqual({ kind: 'none' });
    expect(roleArgValue(['--core', '--role=Tester'])).toBe('Tester');
  });
});

describe('fan-out worker surfaces', () => {
  it('give Builder and Tester every wmux tool the worker preamble names', async () => {
    const { WORKER_DELIVERY_PREAMBLE } = await import('../../main/worktask/FanOutService');
    const { FANOUT_WORKER_DISALLOWED_TOOLS } = await import('../workerLaunch');
    // `send_message` is named only to say how tasks arrive; workers may not call it.
    const forbidden = new Set(FANOUT_WORKER_DISALLOWED_TOOLS.map((t) => t.replace('mcp__wmux__', '')));
    const named = [...WORKER_DELIVERY_PREAMBLE.matchAll(/`([a-z0-9_]+)`/g)]
      .map((m) => m[1])
      .filter((n) => CORE_TOOL_SURFACE.includes(n) && !forbidden.has(n));
    expect(named.length).toBeGreaterThan(0);
    for (const role of ['Builder', 'Tester'] as const) {
      expect(named.filter((n) => !ROLE_TOOL_SURFACES[role].includes(n))).toEqual([]);
    }
  });
});
