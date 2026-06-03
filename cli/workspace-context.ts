import { promises as fs, type Dirent } from 'node:fs';
import path from 'node:path';
import { GitInfo, MANIFEST_PARSERS } from '../lib/repo-awareness.js';
import { resolveProjectInstructions } from '../lib/project-instructions-source.js';
import { createLocalGitBackend } from './git-backend.js';

const IGNORED_ENTRIES = new Set([
  '.git',
  'node_modules',
  '.push',
  '__pycache__',
  '.next',
  'dist',
  'build',
  '.cache',
]);

const MAX_TREE_ENTRIES = 40;
const MAX_MEMORY_CHARS = 4000;
const MEMORY_PATH = '.push/memory.md';
const STRUCTURED_MEMORY_PATH = '.push/memory.json';
const MAX_STRUCTURED_ENTRIES = 20;

// ─── Types ──────────────────────────────────────

export interface ProjectInstructions {
  file: string;
  content: string;
}

// ─── Git info ───────────────────────────────────

export async function getGitInfo(cwd: string): Promise<GitInfo | null> {
  try {
    return await createLocalGitBackend(cwd).status();
  } catch {
    return null;
  }
}

// ─── Top-level tree ─────────────────────────────────────

async function getTree(cwd: string): Promise<string[]> {
  try {
    const entries: Dirent[] = await fs.readdir(cwd, { withFileTypes: true });
    const filtered: Dirent[] = entries.filter((e: Dirent) => !IGNORED_ENTRIES.has(e.name));

    const dirs: string[] = filtered
      .filter((e: Dirent) => e.isDirectory())
      .map((e: Dirent) => e.name)
      .sort();
    const files: string[] = filtered
      .filter((e: Dirent) => !e.isDirectory())
      .map((e: Dirent) => e.name)
      .sort();

    const combined: string[] = [...dirs.map((d) => `  d ${d}/`), ...files.map((f) => `  f ${f}`)];

    return combined.slice(0, MAX_TREE_ENTRIES);
  } catch {
    return [];
  }
}

// ─── Manifest detection ───────────────────────────────────

async function getManifestSummary(cwd: string): Promise<string[]> {
  const results: string[] = [];
  for (const [filename, parser] of Object.entries(MANIFEST_PARSERS)) {
    try {
      const fullPath = path.join(cwd, filename);
      const content = await fs.readFile(fullPath, 'utf8');
      const summary = parser(content);
      if (summary) results.push(summary);
    } catch {
      // Skip if file doesn't exist or can't be read
    }
  }
  return results;
}

// ─── buildWorkspaceSnapshot ──────────────────────────────────────

export async function buildWorkspaceSnapshot(cwd: string): Promise<string> {
  try {
    const [gitInfo, tree, manifests] = await Promise.all([
      getGitInfo(cwd),
      getTree(cwd),
      getManifestSummary(cwd),
    ]);

    if (!gitInfo && tree.length === 0 && manifests.length === 0) {
      return '';
    }

    const parts: string[] = ['[Workspace Snapshot]'];

    if (gitInfo) {
      const dirtyFiles = [
        ...gitInfo.modified,
        ...gitInfo.added,
        ...gitInfo.deleted,
        ...gitInfo.untracked,
        ...gitInfo.renamed,
        ...gitInfo.copied,
        ...gitInfo.conflicted,
      ];
      const dirtyCount = dirtyFiles.length;
      const branchLine: string =
        dirtyCount > 0
          ? `Branch: ${gitInfo.branch} (${dirtyCount} dirty file${dirtyCount === 1 ? '' : 's'})`
          : `Branch: ${gitInfo.branch}`;
      parts.push(branchLine);

      if (dirtyCount > 0) {
        parts.push(`Dirty: ${dirtyFiles.join(', ')}`);
      }
    }

    if (tree.length > 0) {
      parts.push('');
      parts.push('Tree:');
      parts.push(...tree);
    }

    if (manifests.length > 0) {
      parts.push('');
      for (const m of manifests) {
        parts.push(`Manifest: ${m}`);
      }
    }

    return parts.join('\n');
  } catch {
    return '';
  }
}

// ─── loadMemory ─────────────────────────────────────────────

export async function loadMemory(cwd: string): Promise<string | null> {
  const parts: string[] = [];
  try {
    const jsonPath: string = path.join(cwd, STRUCTURED_MEMORY_PATH);
    const raw: string = await fs.readFile(jsonPath, 'utf8');
    const entries = JSON.parse(raw);
    if (Array.isArray(entries) && entries.length > 0) {
      const recent = entries.slice(-MAX_STRUCTURED_ENTRIES).reverse();
      const lines: string[] = [];
      for (const e of recent) {
        if (!e || typeof e !== 'object') continue;
        const type = typeof e.type === 'string' ? e.type.trim() : '';
        const content = typeof e.content === 'string' ? e.content.trim() : '';
        if (!type || !content) continue;
        const rawTags = Array.isArray(e.tags) ? e.tags : [];
        const tags = rawTags.filter(
          (t: unknown): t is string => typeof t === 'string' && t.trim().length > 0,
        );
        const rawFiles = Array.isArray(e.files) ? e.files : [];
        const files = rawFiles.filter(
          (f: unknown): f is string => typeof f === 'string' && f.trim().length > 0,
        );
        const tagStr = tags.length > 0 ? ` [${tags.join(', ')}]` : '';
        const fileStr = files.length > 0 ? ` (${files.join(', ')})` : '';
        lines.push(`- [${type}] ${content}${tagStr}${fileStr}`);
      }
      if (lines.length > 0) {
        parts.push('[Structured Memory]\n' + lines.join('\n'));
      }
    }
  } catch {
    /* no structured memory */
  }

  try {
    const fullPath: string = path.join(cwd, MEMORY_PATH);
    let content: string = await fs.readFile(fullPath, 'utf8');
    if (content.length > MAX_MEMORY_CHARS) {
      content = content.slice(0, MAX_MEMORY_CHARS);
    }
    if (content.trim()) {
      parts.push(content.trim());
    }
  } catch {
    /* no free-text memory */
  }

  return parts.length > 0 ? parts.join('\n\n') : null;
}

// ─── loadProjectInstructions ──────────────────────────────

// Candidate order and precedence live in the shared resolver
// (`lib/project-instructions-source.ts`) so the CLI can't drift from the two
// web acquisition paths. Returns raw content — the injection site
// (`enrichCliBuilder` → `formatProjectInstructionsBlock`) is the single place
// that caps and escapes, so there's no per-surface pre-slice here.
export async function loadProjectInstructions(cwd: string): Promise<ProjectInstructions | null> {
  const raw = await resolveProjectInstructions((filename) =>
    fs.readFile(path.join(cwd, filename), 'utf8').catch(() => null),
  );
  return raw ? { file: raw.filename, content: raw.content } : null;
}
