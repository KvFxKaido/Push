/**
 * repo-commands — derive a repository's validation contract (test, lint,
 * typecheck, format, build, check) from boot-time signals so coding agents
 * don't have to ask the user how to run the checks.
 *
 * This module is pure: it takes a snapshot of root-level signals and returns
 * a structured `RepoCommands` record with provenance. Filesystem traversal
 * lives in the CLI adapter (`cli/repo-commands.ts`).
 *
 * Resolution priority per kind (independent across kinds):
 *   1. AGENTS.md / CLAUDE.md fenced-block hint    → explicit, agents-md
 *   2. package.json#scripts named match           → explicit | heuristic, package-script
 *   3. Config file inference (vitest.config.*, …) → heuristic, config-file
 *
 * `check` is additive — it never replaces `test`/`lint`/`typecheck`. Agents
 * can choose between targeted commands and the umbrella.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RepoCommandKind = 'test' | 'lint' | 'typecheck' | 'format' | 'build' | 'check';

export type RepoCommandSource = 'agents-md' | 'package-script' | 'config-file';

export type RepoCommandConfidence = 'explicit' | 'heuristic';

export interface RepoCommand {
  command: string;
  source: RepoCommandSource;
  confidence: RepoCommandConfidence;
}

export interface RepoCommands {
  test?: RepoCommand;
  lint?: RepoCommand;
  typecheck?: RepoCommand;
  format?: RepoCommand;
  build?: RepoCommand;
  check?: RepoCommand;
}

export interface AgentsMdHint {
  kind: RepoCommandKind;
  command: string;
}

export interface RepoCommandsSnapshot {
  /** package.json#scripts at the repo root, if a package.json exists. */
  packageScripts?: Record<string, string>;
  /** Basenames of root-level config files we recognize (case-sensitive). */
  configFiles?: readonly string[];
  /** Pre-parsed AGENTS.md / CLAUDE.md hints in priority order (AGENTS first). */
  agentsMdHints?: readonly AgentsMdHint[];
}

export const REPO_COMMAND_KINDS: readonly RepoCommandKind[] = [
  'test',
  'lint',
  'typecheck',
  'format',
  'build',
  'check',
];

// ---------------------------------------------------------------------------
// Script-name matching
// ---------------------------------------------------------------------------

/**
 * Per-kind preferred script names, ordered by preference. The first script
 * whose name equals an entry wins. An exact match on the kind itself counts
 * as `explicit`; any other match is `heuristic`.
 *
 * Keep these small and predictable. Repos with idiosyncratic names should
 * use an AGENTS.md hint to opt in explicitly.
 */
const SCRIPT_PREFERENCES: Record<RepoCommandKind, readonly string[]> = {
  test: ['test', 'test:unit', 'test:ci', 'tests'],
  lint: ['lint', 'lint:check'],
  typecheck: ['typecheck', 'type-check', 'tsc', 'check:types'],
  // Validation is non-mutating, so prefer the check variant. `format` (the
  // write script in most setups, including this repo) is only used when no
  // dedicated check script exists.
  format: ['format:check', 'format', 'fmt'],
  build: ['build'],
  check: ['check', 'validate', 'verify', 'ci'],
};

function matchPackageScript(
  kind: RepoCommandKind,
  scripts: Record<string, string> | undefined,
): RepoCommand | undefined {
  if (!scripts) return undefined;
  for (const candidate of SCRIPT_PREFERENCES[kind]) {
    if (Object.prototype.hasOwnProperty.call(scripts, candidate)) {
      const confidence: RepoCommandConfidence = candidate === kind ? 'explicit' : 'heuristic';
      return {
        command: `npm run ${candidate}`,
        source: 'package-script',
        confidence,
      };
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Config-file inference
// ---------------------------------------------------------------------------

/**
 * Recognized root-level config files. Adapter callers pass basenames they
 * found; we match against this list when inferring a command. Order matters
 * for kinds with multiple options — first hit wins.
 */
export const KNOWN_CONFIG_FILES: readonly string[] = [
  'vitest.config.ts',
  'vitest.config.js',
  'vitest.config.mjs',
  'vitest.config.mts',
  'jest.config.ts',
  'jest.config.js',
  'jest.config.mjs',
  'jest.config.cjs',
  'biome.json',
  'biome.jsonc',
  'eslint.config.js',
  'eslint.config.mjs',
  'eslint.config.cjs',
  'eslint.config.ts',
  '.eslintrc',
  '.eslintrc.js',
  '.eslintrc.cjs',
  '.eslintrc.json',
  '.eslintrc.yaml',
  '.eslintrc.yml',
  'tsconfig.json',
  'pyproject.toml',
  'Makefile',
];

function hasAny(configFiles: readonly string[] | undefined, names: readonly string[]): boolean {
  if (!configFiles?.length) return false;
  const set = new Set(configFiles);
  return names.some((n) => set.has(n));
}

function inferFromConfig(
  kind: RepoCommandKind,
  configFiles: readonly string[] | undefined,
): RepoCommand | undefined {
  if (!configFiles?.length) return undefined;

  const heuristic = (command: string): RepoCommand => ({
    command,
    source: 'config-file',
    confidence: 'heuristic',
  });

  switch (kind) {
    case 'test':
      if (
        hasAny(configFiles, [
          'vitest.config.ts',
          'vitest.config.js',
          'vitest.config.mjs',
          'vitest.config.mts',
        ])
      ) {
        return heuristic('npx vitest run');
      }
      if (
        hasAny(configFiles, [
          'jest.config.ts',
          'jest.config.js',
          'jest.config.mjs',
          'jest.config.cjs',
        ])
      ) {
        return heuristic('npx jest');
      }
      return undefined;
    case 'lint':
      if (hasAny(configFiles, ['biome.json', 'biome.jsonc'])) {
        return heuristic('npx biome check .');
      }
      if (
        hasAny(configFiles, [
          'eslint.config.js',
          'eslint.config.mjs',
          'eslint.config.cjs',
          'eslint.config.ts',
          '.eslintrc',
          '.eslintrc.js',
          '.eslintrc.cjs',
          '.eslintrc.json',
          '.eslintrc.yaml',
          '.eslintrc.yml',
        ])
      ) {
        return heuristic('npx eslint .');
      }
      return undefined;
    case 'typecheck':
      if (hasAny(configFiles, ['tsconfig.json'])) {
        return heuristic('npx tsc --noEmit');
      }
      return undefined;
    case 'format':
      if (hasAny(configFiles, ['biome.json', 'biome.jsonc'])) {
        return heuristic('npx biome format .');
      }
      return undefined;
    case 'build':
    case 'check':
      // No safe inference without an explicit script. `check` is additive
      // and `build` is too project-specific to guess.
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// AGENTS.md hint parsing
// ---------------------------------------------------------------------------

const HINT_DIRECTIVE = /^#\s*(test|lint|typecheck|format|build|check)\s*:\s*$/i;

/**
 * Parse fenced ```bash (or ```sh / ```shell) blocks that contain `# kind:`
 * directives. The next non-blank, non-comment line after a directive is the
 * command. Multiple directives can share one fenced block.
 *
 * Example:
 *   ```bash
 *   # test:
 *   npm run test:unit
 *   # lint:
 *   npx biome check .
 *   ```
 *
 * First hit per kind wins (so AGENTS.md ordering is meaningful).
 */
export function parseAgentsMdHints(markdown: string): AgentsMdHint[] {
  if (!markdown) return [];
  const fenceRegex = /```(?:bash|sh|shell)\b[^\n]*\n([\s\S]*?)\n?```/gi;
  const hints: AgentsMdHint[] = [];
  const seen = new Set<RepoCommandKind>();

  let match: RegExpExecArray | null;
  while ((match = fenceRegex.exec(markdown)) !== null) {
    const block = match[1];
    const lines = block.split('\n');
    let pendingKind: RepoCommandKind | null = null;

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;

      const directive = line.match(HINT_DIRECTIVE);
      if (directive) {
        pendingKind = directive[1].toLowerCase() as RepoCommandKind;
        continue;
      }

      // Skip other comment lines without consuming the pending kind.
      if (line.startsWith('#')) continue;

      if (pendingKind && !seen.has(pendingKind)) {
        hints.push({ kind: pendingKind, command: line });
        seen.add(pendingKind);
      }
      pendingKind = null;
    }
  }

  return hints;
}

// ---------------------------------------------------------------------------
// Derivation
// ---------------------------------------------------------------------------

function findHint(
  kind: RepoCommandKind,
  hints: readonly AgentsMdHint[] | undefined,
): RepoCommand | undefined {
  if (!hints?.length) return undefined;
  const hit = hints.find((h) => h.kind === kind);
  if (!hit) return undefined;
  return { command: hit.command, source: 'agents-md', confidence: 'explicit' };
}

/**
 * Derive the repo's validation contract from a boot-time snapshot. Pure:
 * given the same inputs, returns the same outputs. Each kind is resolved
 * independently so partial AGENTS.md overrides still let other kinds fall
 * through to package scripts and config files.
 */
export function deriveRepoCommands(snapshot: RepoCommandsSnapshot): RepoCommands {
  const result: RepoCommands = {};
  for (const kind of REPO_COMMAND_KINDS) {
    const resolved =
      findHint(kind, snapshot.agentsMdHints) ??
      matchPackageScript(kind, snapshot.packageScripts) ??
      inferFromConfig(kind, snapshot.configFiles);
    if (resolved) result[kind] = resolved;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * Compact one-line render for injection into [CODER_STATE]. Returns an empty
 * string when no commands resolved, so callers can decide whether to emit a
 * line at all.
 *
 * Shape: `test=npm run test:unit [agents-md]; typecheck=npx tsc --noEmit [config-file]`
 */
export function formatRepoCommands(commands: RepoCommands): string {
  const parts: string[] = [];
  for (const kind of REPO_COMMAND_KINDS) {
    const value = commands[kind];
    if (!value) continue;
    parts.push(`${kind}=${value.command} [${value.source}]`);
  }
  return parts.join('; ');
}
