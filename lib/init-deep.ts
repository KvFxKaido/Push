/**
 * init-deep — deterministic repo-bootstrap helper that proposes AGENTS.md
 * files for significant directories in a repository.
 *
 * Inspired by `oh-my-openagent`'s `/init-deep`. This is the MVP: pure,
 * deterministic, no model calls. It builds skeleton AGENTS.md files from
 * directory contents, manifest metadata, and README excerpts. Callers that
 * want richer summaries can pass enrichment through `overrides` later.
 *
 * The module is IO-free. Filesystem traversal and writing live in the CLI
 * adapter (`cli/init-deep.ts`); the logic here takes snapshots as input and
 * returns proposed files as output. This keeps the tests fully deterministic.
 */

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export interface InitDeepFileEntry {
  name: string;
  isDirectory: boolean;
}

export interface InitDeepDirHints {
  /** First non-empty paragraph of a README, trimmed to ~400 chars. */
  readmeExcerpt?: string;
  /** `name` field from a package.json in this directory, if present. */
  packageName?: string;
  /** `description` field from a package.json in this directory, if present. */
  packageDescription?: string;
}

export interface InitDeepDirSnapshot {
  /** Path relative to repo root, e.g. '.', 'app', 'app/src/lib'. */
  path: string;
  /** Immediate children (files and subdirectories). Unsorted is fine. */
  entries: InitDeepFileEntry[];
  hints?: InitDeepDirHints;
}

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------

export type InitDeepSignificance = 'root' | 'top-level' | 'source-group';

export interface InitDeepProposal {
  /** Path of the AGENTS.md file to write, relative to repo root. */
  path: string;
  /** Directory this proposal describes. */
  dir: string;
  significance: InitDeepSignificance;
  content: string;
}

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

/** Directory basenames we always skip during traversal and significance checks. */
export const INIT_DEEP_IGNORED_DIRS = new Set<string>([
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  'dist',
  'build',
  'out',
  '.next',
  '.nuxt',
  '.turbo',
  '.cache',
  'coverage',
  '.venv',
  'venv',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  'target',
  'vendor',
  '.idea',
  '.vscode',
]);

/**
 * Significance rules — deterministic, no heuristics beyond these checks:
 * - Root (`.`) is always significant.
 * - Any direct child of the root that is not an ignored dir AND contains
 *   child directories or manifest/README hints is a top-level group.
 * - A descendant named `src` or `lib` is a source group if it has at least
 *   three child entries total (files + subdirs).
 */
export function isSignificantDir(snapshot: InitDeepDirSnapshot): InitDeepSignificance | null {
  if (snapshot.path === '.' || snapshot.path === '') return 'root';

  const segments = snapshot.path.split('/').filter((s) => s.length > 0);
  const basename = segments[segments.length - 1];

  if (INIT_DEEP_IGNORED_DIRS.has(basename)) return null;

  // Top-level: exactly one segment deep.
  if (segments.length === 1) {
    const hasChildDirs = snapshot.entries.some(
      (e) => e.isDirectory && !INIT_DEEP_IGNORED_DIRS.has(e.name),
    );
    const hasHints = Boolean(
      snapshot.hints?.readmeExcerpt ||
        snapshot.hints?.packageName ||
        snapshot.hints?.packageDescription,
    );
    if (hasChildDirs || hasHints) return 'top-level';
    return null;
  }

  // Source group: a `src` or `lib` directory with enough content to describe.
  if ((basename === 'src' || basename === 'lib') && snapshot.entries.length >= 3) {
    return 'source-group';
  }

  return null;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function formatChildEntries(entries: InitDeepFileEntry[]): string {
  const dirs = entries
    .filter((e) => e.isDirectory && !INIT_DEEP_IGNORED_DIRS.has(e.name))
    .map((e) => e.name)
    .sort();
  const files = entries
    .filter((e) => !e.isDirectory)
    .map((e) => e.name)
    .sort();

  const sections: string[] = [];
  if (dirs.length > 0) {
    sections.push(`**Subdirectories:** ${dirs.map((d) => `\`${d}/\``).join(', ')}`);
  }
  if (files.length > 0) {
    const preview = files.slice(0, 12);
    const extra =
      files.length > preview.length ? ` _(+${files.length - preview.length} more)_` : '';
    sections.push(`**Files:** ${preview.map((f) => `\`${f}\``).join(', ')}${extra}`);
  }
  return sections.join('\n\n');
}

function summaryLine(snapshot: InitDeepDirSnapshot, significance: InitDeepSignificance): string {
  const hints = snapshot.hints ?? {};
  if (hints.packageDescription) return hints.packageDescription.trim();
  if (hints.readmeExcerpt) {
    const firstSentence = hints.readmeExcerpt.split(/(?<=[.!?])\s+/)[0]?.trim();
    if (firstSentence) return firstSentence;
  }
  if (significance === 'root') {
    return 'Repository root. See subdirectories for scoped context.';
  }
  if (significance === 'top-level') {
    return `Top-level \`${snapshot.path}\` directory.`;
  }
  return `Source group under \`${snapshot.path}\`.`;
}

/**
 * Render a single AGENTS.md file. The goal is to give an agent dropped into
 * this directory enough context to navigate without re-discovering structure.
 *
 * The generated file is intentionally marked as machine-generated so humans
 * know it is safe to replace or delete.
 */
export function renderAgentsMd(
  snapshot: InitDeepDirSnapshot,
  significance: InitDeepSignificance,
): string {
  const heading =
    significance === 'root' ? '# Repository Context' : `# \`${snapshot.path}\` Context`;

  const blocks: string[] = [heading];

  blocks.push('> Generated by `push init-deep`. Safe to edit, regenerate, or delete.');

  blocks.push(summaryLine(snapshot, significance));

  if (snapshot.hints?.packageName) {
    blocks.push(`**Package:** \`${snapshot.hints.packageName}\``);
  }

  const childBlock = formatChildEntries(snapshot.entries);
  if (childBlock) blocks.push(childBlock);

  if (snapshot.hints?.readmeExcerpt && significance === 'root') {
    blocks.push('---');
    blocks.push(snapshot.hints.readmeExcerpt.trim());
  }

  if (significance !== 'root') {
    blocks.push('_Parent context: see `AGENTS.md` in the repo root._');
  }

  return blocks.join('\n\n') + '\n';
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

export interface PlanInitDeepOptions {
  /**
   * Relative AGENTS.md paths that already exist on disk. Proposals for these
   * are still emitted but tagged so callers can decide whether to skip,
   * diff, or overwrite.
   */
  existing?: ReadonlySet<string>;
}

export interface PlanInitDeepResult {
  /** AGENTS.md files to write that do not yet exist. */
  toWrite: InitDeepProposal[];
  /** Proposals for directories that already have an AGENTS.md. */
  existing: InitDeepProposal[];
}

/**
 * Build a plan from directory snapshots. The caller is responsible for
 * applying the plan (writing files, prompting for overwrites).
 */
export function planInitDeep(
  snapshots: readonly InitDeepDirSnapshot[],
  options: PlanInitDeepOptions = {},
): PlanInitDeepResult {
  const existingSet = options.existing ?? new Set<string>();
  const toWrite: InitDeepProposal[] = [];
  const existing: InitDeepProposal[] = [];

  for (const snapshot of snapshots) {
    const significance = isSignificantDir(snapshot);
    if (significance === null) continue;

    const dir = snapshot.path === '' ? '.' : snapshot.path;
    const agentsPath = dir === '.' ? 'AGENTS.md' : `${dir}/AGENTS.md`;
    const proposal: InitDeepProposal = {
      path: agentsPath,
      dir,
      significance,
      content: renderAgentsMd(snapshot, significance),
    };

    if (existingSet.has(agentsPath)) {
      existing.push(proposal);
    } else {
      toWrite.push(proposal);
    }
  }

  // Stable order: root first, then by path.
  const sortProposals = (arr: InitDeepProposal[]): InitDeepProposal[] =>
    arr.sort((a, b) => {
      if (a.dir === '.') return -1;
      if (b.dir === '.') return 1;
      return a.dir.localeCompare(b.dir);
    });

  return {
    toWrite: sortProposals(toWrite),
    existing: sortProposals(existing),
  };
}
