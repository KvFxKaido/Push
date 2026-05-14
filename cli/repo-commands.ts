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
import type { CoderWorkingMemory } from '../lib/working-memory.ts';

/**
 * AGENTS.md is the required entry doc per the repo's startup contract, so
 * its hints take precedence over CLAUDE.md when both define the same kind.
 */
const HINT_FILES: readonly string[] = ['AGENTS.md', 'CLAUDE.md'];
const COMMAND_ROOT_MARKERS: readonly string[] = [
  'package.json',
  ...HINT_FILES,
  ...KNOWN_CONFIG_FILES,
];

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
  // Use map+filter instead of `push` inside Promise.all so the result order
  // is deterministic (matches KNOWN_CONFIG_FILES) regardless of stat timing.
  // Also stat for `isFile` — `fs.access` succeeds on directories too, which
  // would misclassify e.g. a `biome.json/` directory as a config file.
  const results = await Promise.all(
    KNOWN_CONFIG_FILES.map(async (name) => {
      try {
        const stat = await fs.stat(path.join(repoRoot, name));
        return stat.isFile() ? name : null;
      } catch {
        return null;
      }
    }),
  );
  return results.filter((name): name is string => name !== null);
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

async function hasFileMarker(dir: string, filenames: readonly string[]): Promise<boolean> {
  for (const filename of filenames) {
    try {
      const stat = await fs.stat(path.join(dir, filename));
      if (stat.isFile()) return true;
    } catch {
      // Keep looking; missing/unreadable markers are simply absent.
    }
  }
  return false;
}

async function hasGitMarker(dir: string): Promise<boolean> {
  try {
    await fs.access(path.join(dir, '.git'));
    return true;
  } catch {
    return false;
  }
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
 * Walk up from `start` looking for a `.git` entry (directory or file — the
 * latter handles git worktrees). Returns the first git root that also carries
 * command-discovery markers, or the nearest marker-bearing directory if an
 * empty ancestor `.git` would otherwise eclipse it. Falls back to `start`
 * when neither signal exists.
 *
 * This makes `loadRepoCommands` robust to the CLI being launched from a
 * subdirectory: we still read package.json / AGENTS.md / config files from
 * the actual repo root rather than the subdir.
 */
async function resolveRepoRoot(start: string): Promise<string> {
  let current = path.resolve(start);
  let nearestCommandRoot: string | null = null;
  while (true) {
    const hasCommandRootSignal = await hasFileMarker(current, COMMAND_ROOT_MARKERS);
    if (hasCommandRootSignal && !nearestCommandRoot) {
      nearestCommandRoot = current;
    }

    if (await hasGitMarker(current)) {
      if (hasCommandRootSignal) return current;
      if (nearestCommandRoot) return nearestCommandRoot;
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) return nearestCommandRoot ?? path.resolve(start);
    current = parent;
  }
}

/**
 * Per-process memo. Callers that hold a stable cwd for the session (CLI
 * boot, a single web Worker request) can rely on this; recomputation on a
 * fresh process is intentional for v1 — disk caching adds an invalidation
 * surface that's worse than a few ms of re-read.
 */
const memo = new Map<string, Promise<RepoCommands>>();

export async function loadRepoCommands(cwd: string): Promise<RepoCommands> {
  const repoRoot = await resolveRepoRoot(cwd);
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

/**
 * Seed `validationCommands` onto a session's working memory if not already
 * present. Mirrors the dedupe pattern of `ensureSystemPromptReady` in
 * `cli/engine.ts` so calling this multiple times for the same state is safe.
 *
 * The seeded field is system-managed: not parsed from `coder_update_state`
 * tool calls and not touched by `applyWorkingMemoryUpdate`, so models can
 * read it but cannot overwrite it.
 *
 * Discovery failures are swallowed — agents simply run without a populated
 * Validation line, which matches the pre-seeding behavior. We do not block
 * session start on this.
 *
 * Tolerates a missing or non-object `workingMemory` on the state (the
 * session-store schema types it as `unknown`, and pre-existing on-disk
 * sessions may not have it set). In that case we install a fresh empty
 * working-memory object before seeding.
 */
const _seedMap = new WeakMap<object, Promise<void>>();

interface SeedTarget {
  cwd: string;
  workingMemory?: unknown;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function ensureWorkingMemoryShape(state: SeedTarget): CoderWorkingMemory {
  if (!isPlainObject(state.workingMemory)) {
    state.workingMemory = {} as CoderWorkingMemory;
  }
  return state.workingMemory as CoderWorkingMemory;
}

export function ensureRepoCommandsSeeded(state: SeedTarget): Promise<void> {
  const workingMemory = ensureWorkingMemoryShape(state);
  if (workingMemory.validationCommands) return Promise.resolve();
  const cached = _seedMap.get(state);
  if (cached) return cached;
  const promise = loadRepoCommands(state.cwd)
    .then((commands) => {
      // Re-fetch the working-memory reference: the state object is the same,
      // but a concurrent mutation could have replaced .workingMemory entirely.
      const current = ensureWorkingMemoryShape(state);
      if (!current.validationCommands) {
        current.validationCommands = commands;
      }
    })
    .catch(() => {
      // Discovery is best-effort; never break the session.
    })
    .finally(() => {
      _seedMap.delete(state);
    });
  _seedMap.set(state, promise);
  return promise;
}
