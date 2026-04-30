/**
 * CLI adapter for repo-commands — reads root-level signals from disk and
 * feeds them into the pure derivation in `lib/repo-commands.ts`.
 *
 * The pure module owns priority rules and provenance. This file owns IO:
 * reading package.json, listing config-file basenames, and pulling AGENTS.md
 * / CLAUDE.md hints.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import {
  KNOWN_CONFIG_FILES,
  deriveRepoCommands,
  parseAgentsMdHints,
  type AgentsMdHint,
  type RepoCommands,
  type RepoCommandsSnapshot,
} from '../lib/repo-commands.ts';

/**
 * AGENTS.md is the required entry doc per the repo's startup contract, so
 * its hints take precedence over CLAUDE.md when both define the same kind.
 */
const HINT_FILES: readonly string[] = ['AGENTS.md', 'CLAUDE.md'];

async function readPackageScripts(repoRoot: string): Promise<Record<string, string> | undefined> {
  try {
    const raw = await fs.readFile(path.join(repoRoot, 'package.json'), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.scripts === 'object' && parsed.scripts !== null) {
      const scripts: Record<string, string> = {};
      for (const [name, value] of Object.entries(parsed.scripts)) {
        if (typeof value === 'string') scripts[name] = value;
      }
      return Object.keys(scripts).length > 0 ? scripts : undefined;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

async function listConfigFiles(repoRoot: string): Promise<string[]> {
  const present: string[] = [];
  await Promise.all(
    KNOWN_CONFIG_FILES.map(async (name) => {
      try {
        await fs.access(path.join(repoRoot, name));
        present.push(name);
      } catch {
        // Not present.
      }
    }),
  );
  return present;
}

async function collectAgentsMdHints(repoRoot: string): Promise<AgentsMdHint[]> {
  const hints: AgentsMdHint[] = [];
  for (const filename of HINT_FILES) {
    let content: string;
    try {
      content = await fs.readFile(path.join(repoRoot, filename), 'utf8');
    } catch {
      continue;
    }
    for (const hint of parseAgentsMdHints(content)) {
      // First file wins per kind, matching the priority of AGENTS over CLAUDE.
      if (!hints.some((h) => h.kind === hint.kind)) hints.push(hint);
    }
  }
  return hints;
}

/**
 * Build a snapshot from disk for `deriveRepoCommands`. Exposed so tests and
 * future callers (e.g. the web bundle's Node-side discovery path) can reuse
 * it independently from `loadRepoCommands`.
 */
export async function buildRepoCommandsSnapshot(repoRoot: string): Promise<RepoCommandsSnapshot> {
  const [packageScripts, configFiles, agentsMdHints] = await Promise.all([
    readPackageScripts(repoRoot),
    listConfigFiles(repoRoot),
    collectAgentsMdHints(repoRoot),
  ]);
  return {
    packageScripts,
    configFiles,
    agentsMdHints,
  };
}

/**
 * Per-process memo. Callers that hold a stable cwd for the session (CLI
 * boot, a single web Worker request) can rely on this; recomputation on a
 * fresh process is intentional for v1 — disk caching adds an invalidation
 * surface that's worse than a few ms of re-read.
 */
const memo = new Map<string, Promise<RepoCommands>>();

export async function loadRepoCommands(cwd: string): Promise<RepoCommands> {
  const repoRoot = path.resolve(cwd);
  const cached = memo.get(repoRoot);
  if (cached) return cached;
  const promise = buildRepoCommandsSnapshot(repoRoot).then(deriveRepoCommands);
  memo.set(repoRoot, promise);
  try {
    return await promise;
  } catch (err) {
    memo.delete(repoRoot);
    throw err;
  }
}

/** Clear the per-process memo. Exposed for tests. */
export function resetRepoCommandsMemo(): void {
  memo.clear();
}
