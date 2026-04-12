/**
 * CLI adapter for `push init-deep` — walks a repository on disk, builds
 * `InitDeepDirSnapshot`s, and applies the plan produced by the shared module
 * in `lib/init-deep.ts`.
 *
 * All policy (which directories count, how to render) lives in the shared
 * module. This file owns filesystem IO only.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import {
  INIT_DEEP_IGNORED_DIRS,
  planInitDeep,
  type InitDeepDirSnapshot,
  type InitDeepFileEntry,
  type InitDeepDirHints,
  type InitDeepProposal,
} from '../lib/init-deep.ts';

/**
 * Max depth we traverse below the repo root. Four levels reaches
 * `app/src/lib`-style nested source groups (root -> app -> src -> lib)
 * while keeping init-deep fast and the generated output scoped.
 */
const MAX_DEPTH = 4;

const README_MAX_CHARS = 400;

export interface InitDeepRunOptions {
  cwd: string;
  dryRun: boolean;
  force: boolean;
}

export interface InitDeepRunResult {
  written: InitDeepProposal[];
  skipped: InitDeepProposal[];
  plannedButExisting: InitDeepProposal[];
  significantDirs: number;
}

async function readPackageHints(absDir: string): Promise<Partial<InitDeepDirHints>> {
  const pkgPath = path.join(absDir, 'package.json');
  try {
    const raw = await fs.readFile(pkgPath, 'utf8');
    const parsed = JSON.parse(raw);
    const hints: Partial<InitDeepDirHints> = {};
    if (typeof parsed.name === 'string' && parsed.name.trim()) {
      hints.packageName = parsed.name.trim();
    }
    if (typeof parsed.description === 'string' && parsed.description.trim()) {
      hints.packageDescription = parsed.description.trim();
    }
    return hints;
  } catch {
    return {};
  }
}

async function readReadmeHint(absDir: string): Promise<string | undefined> {
  // Try a short list of common names in order.
  const candidates = ['README.md', 'README.mdx', 'readme.md', 'README', 'README.txt'];
  for (const name of candidates) {
    try {
      const raw = await fs.readFile(path.join(absDir, name), 'utf8');
      // First non-empty paragraph, skipping headings.
      const paragraphs = raw
        .split(/\n{2,}/)
        .map((p) => p.trim())
        .filter((p) => p.length > 0 && !p.startsWith('#'));
      if (paragraphs.length === 0) continue;
      const excerpt = paragraphs[0];
      return excerpt.length > README_MAX_CHARS
        ? excerpt.slice(0, README_MAX_CHARS).trimEnd() + '…'
        : excerpt;
    } catch {
      // File not present — try the next candidate.
    }
  }
  return undefined;
}

async function buildSnapshot(
  repoRoot: string,
  relativeDir: string,
): Promise<InitDeepDirSnapshot | null> {
  const absDir = path.join(repoRoot, relativeDir);
  let rawEntries: import('node:fs').Dirent[];
  try {
    rawEntries = await fs.readdir(absDir, { withFileTypes: true });
  } catch {
    return null;
  }

  const entries: InitDeepFileEntry[] = rawEntries
    .filter((e) => !e.name.startsWith('.') || e.name === '.github')
    .map((e) => ({ name: e.name, isDirectory: e.isDirectory() }));

  const [packageHints, readmeExcerpt] = await Promise.all([
    readPackageHints(absDir),
    readReadmeHint(absDir),
  ]);

  const hints: InitDeepDirHints = {};
  if (packageHints.packageName) hints.packageName = packageHints.packageName;
  if (packageHints.packageDescription) hints.packageDescription = packageHints.packageDescription;
  if (readmeExcerpt) hints.readmeExcerpt = readmeExcerpt;

  return {
    path: relativeDir === '' ? '.' : relativeDir,
    entries,
    hints: Object.keys(hints).length > 0 ? hints : undefined,
  };
}

async function collectSnapshots(repoRoot: string): Promise<InitDeepDirSnapshot[]> {
  const snapshots: InitDeepDirSnapshot[] = [];
  // BFS queue walked via an index so the traversal stays O(n) — `Array#shift`
  // would be O(queue.length) per pop and noticeable on larger repos.
  const queue: { relative: string; depth: number }[] = [{ relative: '', depth: 0 }];

  for (let cursor = 0; cursor < queue.length; cursor++) {
    const { relative, depth } = queue[cursor];
    const snapshot = await buildSnapshot(repoRoot, relative);
    if (!snapshot) continue;
    snapshots.push(snapshot);

    if (depth >= MAX_DEPTH) continue;

    for (const entry of snapshot.entries) {
      if (!entry.isDirectory) continue;
      if (INIT_DEEP_IGNORED_DIRS.has(entry.name)) continue;
      if (entry.name.startsWith('.') && entry.name !== '.github') continue;
      queue.push({
        relative: relative === '' ? entry.name : `${relative}/${entry.name}`,
        depth: depth + 1,
      });
    }
  }

  return snapshots;
}

async function collectExistingAgentsMd(
  repoRoot: string,
  proposals: readonly InitDeepProposal[],
): Promise<Set<string>> {
  const existing = new Set<string>();
  await Promise.all(
    proposals.map(async (proposal) => {
      try {
        await fs.access(path.join(repoRoot, proposal.path));
        existing.add(proposal.path);
      } catch {
        // Not present — nothing to add.
      }
    }),
  );
  return existing;
}

/**
 * Run the init-deep flow against a real filesystem. Callers are responsible
 * for printing results; this function returns the structured outcome and
 * does not write to stdout.
 *
 * Throws when the root directory is missing, unreadable, or not a directory
 * — otherwise a typo like `--cwd /bad/path` would silently succeed with an
 * empty plan and mislead users into thinking init-deep had nothing to do.
 */
export async function runInitDeep(options: InitDeepRunOptions): Promise<InitDeepRunResult> {
  const repoRoot = path.resolve(options.cwd);

  try {
    const rootStat = await fs.stat(repoRoot);
    if (!rootStat.isDirectory()) {
      throw new Error(`init-deep: ${repoRoot} is not a directory`);
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ENOENT') {
      throw new Error(`init-deep: directory does not exist: ${repoRoot}`);
    }
    if (code === 'EACCES' || code === 'EPERM') {
      throw new Error(`init-deep: cannot read directory: ${repoRoot}`);
    }
    throw err;
  }

  const snapshots = await collectSnapshots(repoRoot);

  // First pass: plan without "existing" knowledge to get the full list of
  // candidate paths. Second pass: re-plan with the existing set so the
  // caller sees proposals split correctly.
  const initialPlan = planInitDeep(snapshots);
  const candidateProposals = [...initialPlan.toWrite, ...initialPlan.existing];
  const existingSet = await collectExistingAgentsMd(repoRoot, candidateProposals);
  const plan = planInitDeep(snapshots, { existing: existingSet });

  const significantDirs = plan.toWrite.length + plan.existing.length;

  // When --force is set, existing files are treated as writes. Otherwise
  // they are skipped (reported but not touched).
  const writeTargets: InitDeepProposal[] = options.force
    ? [...plan.toWrite, ...plan.existing]
    : plan.toWrite;
  const skipTargets: InitDeepProposal[] = options.force ? [] : plan.existing;

  if (!options.dryRun) {
    for (const proposal of writeTargets) {
      const absPath = path.join(repoRoot, proposal.path);
      await fs.mkdir(path.dirname(absPath), { recursive: true });
      await fs.writeFile(absPath, proposal.content, 'utf8');
    }
  }

  return {
    // `written` reports intended writes in both modes so the CLI can preview
    // them in --dry-run. Only the filesystem side-effect is skipped.
    written: writeTargets,
    skipped: skipTargets,
    plannedButExisting: plan.existing,
    significantDirs,
  };
}
