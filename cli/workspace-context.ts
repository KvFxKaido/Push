import { promisify } from 'node:util';
import { promises as fs, type Dirent } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

const execFileAsync = promisify(execFile);

const IGNORED_ENTRIES = new Set([
  '.git', 'node_modules', '.push', '__pycache__', '.next', 'dist', 'build', '.cache',
]);

const MAX_TREE_ENTRIES = 40;
const MAX_INSTRUCTIONS_CHARS = 8000;
const MAX_MEMORY_CHARS = 4000;
const MEMORY_PATH = '.push/memory.md';

const MANIFEST_FILES: readonly string[] = [
  'package.json',
  'Cargo.toml',
  'pyproject.toml',
  'go.mod',
  'Gemfile',
  'pom.xml',
];

// ─── Types ──────────────────────────────────────────────────────

export interface GitInfo {
  branch: string;
  dirtyFiles: string[];
  ahead: number;
  behind: number;
}

export interface ProjectInstructions {
  file: string;
  content: string;
}

type ManifestSummarizer = (cwd: string) => Promise<string | null>;

// ─── Git info ───────────────────────────────────────────────────

export async function getGitInfo(cwd: string): Promise<GitInfo | null> {
  try {
    const { stdout } = await execFileAsync('git', ['status', '--short', '--branch'], {
      cwd,
      timeout: 5000,
    });
    const lines: string[] = stdout.trimEnd().split('\n');
    const headerLine: string = lines[0] || '';

    // Header looks like: "## main...origin/main [ahead 2, behind 1]" or "## main" or "## HEAD (no branch)"
    let branch = '(unknown)';
    const branchMatch: RegExpMatchArray | null = headerLine.match(/^## (.+?)(?:\.\.\.|$)/);
    if (branchMatch) {
      branch = branchMatch[1].trim();
    }

    // Parse ahead/behind from the full header line
    let ahead = 0;
    let behind = 0;
    const aheadMatch: RegExpMatchArray | null = headerLine.match(/\[ahead\s+(\d+)/);
    const behindMatch: RegExpMatchArray | null = headerLine.match(/behind\s+(\d+)\]/);
    if (aheadMatch) ahead = parseInt(aheadMatch[1], 10);
    if (behindMatch) behind = parseInt(behindMatch[1], 10);

    const dirty: string[] = lines.slice(1).filter((l) => l.trim().length > 0);
    const dirtyFiles: string[] = dirty.map((l) => l.trim().replace(/^[A-Z?!]{1,2}\s+/, ''));

    return { branch, dirtyFiles, ahead, behind };
  } catch {
    return null;
  }
}

// ─── Top-level tree ─────────────────────────────────────────────

async function getTree(cwd: string): Promise<string[]> {
  try {
    const entries: Dirent[] = await fs.readdir(cwd, { withFileTypes: true });
    const filtered: Dirent[] = entries.filter((e: Dirent) => !IGNORED_ENTRIES.has(e.name));

    const dirs: string[] = filtered.filter((e: Dirent) => e.isDirectory()).map((e: Dirent) => e.name).sort();
    const files: string[] = filtered.filter((e: Dirent) => !e.isDirectory()).map((e: Dirent) => e.name).sort();

    const combined: string[] = [
      ...dirs.map((d) => `  d ${d}/`),
      ...files.map((f) => `  f ${f}`),
    ];

    return combined.slice(0, MAX_TREE_ENTRIES);
  } catch {
    return [];
  }
}

// ─── Manifest detection ─────────────────────────────────────────

async function summarizePackageJson(cwd: string): Promise<string | null> {
  try {
    const raw: string = await fs.readFile(path.join(cwd, 'package.json'), 'utf8');
    const pkg: Record<string, unknown> = JSON.parse(raw);
    const name: string = (pkg.name as string) || '(unnamed)';
    const version: string = (pkg.version as string) || '(no version)';
    const depCount: number = Object.keys((pkg.dependencies as Record<string, unknown>) || {}).length;
    return `package.json \u2014 ${name}@${version}, ${depCount} dependencies`;
  } catch {
    return null;
  }
}

async function summarizeCargoToml(cwd: string): Promise<string | null> {
  try {
    const raw: string = await fs.readFile(path.join(cwd, 'Cargo.toml'), 'utf8');
    const nameMatch: RegExpMatchArray | null = raw.match(/^name\s*=\s*"(.+?)"/m);
    const versionMatch: RegExpMatchArray | null = raw.match(/^version\s*=\s*"(.+?)"/m);
    const name: string = nameMatch ? nameMatch[1] : '(unnamed)';
    const version: string = versionMatch ? versionMatch[1] : '(no version)';
    return `Cargo.toml \u2014 ${name}@${version}`;
  } catch {
    return null;
  }
}

async function summarizePyprojectToml(cwd: string): Promise<string | null> {
  try {
    const raw: string = await fs.readFile(path.join(cwd, 'pyproject.toml'), 'utf8');
    const nameMatch: RegExpMatchArray | null = raw.match(/^name\s*=\s*"(.+?)"/m);
    const versionMatch: RegExpMatchArray | null = raw.match(/^version\s*=\s*"(.+?)"/m);
    const name: string = nameMatch ? nameMatch[1] : '(unnamed)';
    const version: string = versionMatch ? versionMatch[1] : '(no version)';
    return `pyproject.toml \u2014 ${name}@${version}`;
  } catch {
    return null;
  }
}

async function summarizeGoMod(cwd: string): Promise<string | null> {
  try {
    const raw: string = await fs.readFile(path.join(cwd, 'go.mod'), 'utf8');
    const modMatch: RegExpMatchArray | null = raw.match(/^module\s+(.+)$/m);
    const mod: string = modMatch ? modMatch[1].trim() : '(unnamed)';
    return `go.mod \u2014 ${mod}`;
  } catch {
    return null;
  }
}

async function summarizeGemfile(cwd: string): Promise<string | null> {
  try {
    await fs.access(path.join(cwd, 'Gemfile'));
    return 'Gemfile \u2014 Ruby project';
  } catch {
    return null;
  }
}

async function summarizePomXml(cwd: string): Promise<string | null> {
  try {
    await fs.access(path.join(cwd, 'pom.xml'));
    return 'pom.xml \u2014 Maven project';
  } catch {
    return null;
  }
}

const MANIFEST_SUMMARIZERS: readonly [string, ManifestSummarizer][] = [
  ['package.json', summarizePackageJson],
  ['Cargo.toml', summarizeCargoToml],
  ['pyproject.toml', summarizePyprojectToml],
  ['go.mod', summarizeGoMod],
  ['Gemfile', summarizeGemfile],
  ['pom.xml', summarizePomXml],
];

async function getManifestSummary(cwd: string): Promise<string[]> {
  const results: (string | null)[] = await Promise.all(
    MANIFEST_SUMMARIZERS.map(([, fn]) => fn(cwd)),
  );
  return results.filter((r): r is string => Boolean(r));
}

// ─── buildWorkspaceSnapshot ─────────────────────────────────────

export async function buildWorkspaceSnapshot(cwd: string): Promise<string> {
  try {
    const [gitInfo, tree, manifests] = await Promise.all([
      getGitInfo(cwd),
      getTree(cwd),
      getManifestSummary(cwd),
    ]);

    // If there's truly nothing to report, return empty
    if (!gitInfo && tree.length === 0 && manifests.length === 0) {
      return '';
    }

    const parts: string[] = ['[Workspace Snapshot]'];

    if (gitInfo) {
      const dirtyCount: number = gitInfo.dirtyFiles.length;
      const branchLine: string = dirtyCount > 0
        ? `Branch: ${gitInfo.branch} (${dirtyCount} dirty file${dirtyCount === 1 ? '' : 's'})`
        : `Branch: ${gitInfo.branch}`;
      parts.push(branchLine);

      if (dirtyCount > 0) {
        parts.push(`Dirty: ${gitInfo.dirtyFiles.join(', ')}`);
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

// ─── loadProjectInstructions ────────────────────────────────────

const INSTRUCTION_FILES: readonly string[] = [
  '.push/instructions.md',
  'AGENTS.md',
  'CLAUDE.md',
  'GEMINI.md',
];

// ─── loadMemory ────────────────────────────────────────────────

export async function loadMemory(cwd: string): Promise<string | null> {
  try {
    const fullPath: string = path.join(cwd, MEMORY_PATH);
    let content: string = await fs.readFile(fullPath, 'utf8');
    if (content.length > MAX_MEMORY_CHARS) {
      content = content.slice(0, MAX_MEMORY_CHARS);
    }
    return content.trim() || null;
  } catch {
    return null;
  }
}

// ─── loadProjectInstructions ────────────────────────────────────

export async function loadProjectInstructions(cwd: string): Promise<ProjectInstructions | null> {
  for (const relPath of INSTRUCTION_FILES) {
    try {
      const fullPath: string = path.join(cwd, relPath);
      let content: string = await fs.readFile(fullPath, 'utf8');
      if (content.length > MAX_INSTRUCTIONS_CHARS) {
        content = content.slice(0, MAX_INSTRUCTIONS_CHARS);
      }
      return { file: relPath, content };
    } catch {
      continue;
    }
  }
  return null;
}
