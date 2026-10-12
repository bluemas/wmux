import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

import type { FirstRunStatus } from '../../shared/firstRun';
import { resolveClaudeExecutable } from '../claude/resolveClaudeExecutable';

/**
 * Read-only detector for Claude Code installation (via the shared
 * executable resolver) + wmux MCP registration.
 *
 * Stateless and pure — no instance fields, no caching. Always returns a
 * fully-populated `FirstRunStatus`. All filesystem errors (ENOENT, EACCES,
 * SyntaxError, etc.) collapse to `claudeFound:false / mcpRegistered:false`
 * so the wizard's failure path stays silent and uniform (D1).
 *
 * Path resolution is cross-platform via `os.homedir()`:
 *   - Linux/macOS: `/home/<user>/.claude.json`, `/home/<user>/.claude`
 *   - Windows:     `C:\Users\<user>\.claude.json`, `C:\Users\<user>\.claude`
 *
 * `claudeJsonPath` is always returned even when nothing exists — the UI
 * displays "expected at <path>" copy when registration is missing.
 *
 * See: progress.md (T2), decisions.md (D1).
 */
export class ClaudeDetector {
  /** Same resolver Moa spawns with, so "detected" here means Moa can run it. */
  constructor(private readonly resolveExecutable: () => string | null = resolveClaudeExecutable) {}

  async detect(): Promise<FirstRunStatus> {
    const home = os.homedir();
    const claudeJsonPath = path.join(home, '.claude.json');

    // Installed = an executable Moa can actually spawn. A leftover ~/.claude
    // folder without a binary is not an install, and a binary that has never
    // been run yet (no ~/.claude) still is one.
    let claudeFound = false;
    try {
      claudeFound = this.resolveExecutable() !== null;
    } catch {
      claudeFound = false;
    }
    if (!claudeFound) {
      return { claudeFound: false, mcpRegistered: false, claudeJsonPath };
    }

    const mcpRegistered = await this.checkMcpRegistered(claudeJsonPath);
    return { claudeFound: true, mcpRegistered, claudeJsonPath };
  }

  private async checkMcpRegistered(jsonPath: string): Promise<boolean> {
    let raw: string;
    try {
      raw = await fs.readFile(jsonPath, 'utf8');
    } catch {
      // ENOENT / EACCES / IO error → not registered.
      return false;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Malformed JSON — silently treat as not registered.
      return false;
    }

    if (parsed === null || typeof parsed !== 'object') return false;
    const mcpServers = (parsed as { mcpServers?: unknown }).mcpServers;
    if (mcpServers === null || typeof mcpServers !== 'object') return false;
    const wmux = (mcpServers as Record<string, unknown>).wmux;
    return Boolean(wmux);
  }
}
