import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
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

const MANIFEST_FILES = [
  'package.json',
  'Cargo.toml',
  'pyproject.toml',
  'go.mod',
  'Gemfile',
  'pom.xml',
];

// ─── Git info ───────────────────────────────────────────────────

async function getGitInfo(cwd) {
  try {
    const { stdout } = await execFileAsync('git', ['status', '--short', '--branch'], {
      cwd,
      timeout: 5000,
    });
    const lines = stdout.trimEnd().split('\n');
    const headerLine = lines[0] || '';

    // Header looks like: "## main...origin/main" or "## main" or "## HEAD (no branch)"
    let branch = '(unknown)';
    const branchMatch = headerLine.match(/^## (.+?)(?:\.\.\.|$)/);
    if (branchMatch) {
      branch = branchMatch[1].trim();
    }

    const dirty = lines.slice(1).filter((l) => l.trim().length > 0);
    const dirtyFiles = dirty.map((l) => l.trim().replace(/^[A-Z?!]{1,2}\s+/, ''));

    return { branch, dirtyFiles };
  } catch {
    return null;
  }
}

// ─── Top-level tree ─────────────────────────────────────────────

async function getTree(cwd) {
  try {
    const entries = await fs.readdir(cwd, { withFileTypes: true });
    const filtered = entries.filter((e) => !IGNORED_ENTRIES.has(e.name));

    const dirs = filtered.filter((e) => e.isDirectory()).map((e) => e.name).sort();
    const files = filtered.filter((e) => !e.isDirectory()).map((e) => e.name).sort();

    const combined = [
      ...dirs.map((d) => `  d ${d}/`),
      ...files.map((f) => `  f ${f}`),
    ];

    return combined.slice(0, MAX_TREE_ENTRIES);
  } catch {
    return [];
  }
}

// ─── Manifest detection ─────────────────────────────────────────

async function summarizePackageJson(cwd) {
  try {
    const raw = await fs.readFile(path.join(cwd, 'package.json'), 'utf8');
    const pkg = JSON.parse(raw);
    const name = pkg.name || '(unnamed)';
    const version = pkg.version || '(no version)';
    const depCount = Object.keys(pkg.dependencies || {}).length;
    return `package.json \u2014 ${name}@${version}, ${depCount} dependencies`;
  } catch {
    return null;
  }
}

async function summarizeCargoToml(cwd) {
  try {
    const raw = await fs.readFile(path.join(cwd, 'Cargo.toml'), 'utf8');
    const nameMatch = raw.match(/^name\s*=\s*"(.+?)"/m);
    const versionMatch = raw.match(/^version\s*=\s*"(.+?)"/m);
    const name = nameMatch ? nameMatch[1] : '(unnamed)';
    const version = versionMatch ? versionMatch[1] : '(no version)';
    return `Cargo.toml \u2014 ${name}@${version}`;
  } catch {
    return null;
  }
}

async function summarizePyprojectToml(cwd) {
  try {
    const raw = await fs.readFile(path.join(cwd, 'pyproject.toml'), 'utf8');
    const nameMatch = raw.match(/^name\s*=\s*"(.+?)"/m);
    const versionMatch = raw.match(/^version\s*=\s*"(.+?)"/m);
    const name = nameMatch ? nameMatch[1] : '(unnamed)';
    const version = versionMatch ? versionMatch[1] : '(no version)';
    return `pyproject.toml \u2014 ${name}@${version}`;
  } catch {
    return null;
  }
}

async function summarizeGoMod(cwd) {
  try {
    const raw = await fs.readFile(path.join(cwd, 'go.mod'), 'utf8');
    const modMatch = raw.match(/^module\s+(.+)$/m);
    const mod = modMatch ? modMatch[1].trim() : '(unnamed)';
    return `go.mod \u2014 ${mod}`;
  } catch {
    return null;
  }
}

async function summarizeGemfile(cwd) {
  try {
    await fs.access(path.join(cwd, 'Gemfile'));
    return 'Gemfile \u2014 Ruby project';
  } catch {
    return null;
  }
}

async function summarizePomXml(cwd) {
  try {
    await fs.access(path.join(cwd, 'pom.xml'));
    return 'pom.xml \u2014 Maven project';
  } catch {
    return null;
  }
}

const MANIFEST_SUMMARIZERS = [
  ['package.json', summarizePackageJson],
  ['Cargo.toml', summarizeCargoToml],
  ['pyproject.toml', summarizePyprojectToml],
  ['go.mod', summarizeGoMod],
  ['Gemfile', summarizeGemfile],
  ['pom.xml', summarizePomXml],
];

async function getManifestSummary(cwd) {
  const results = await Promise.all(
    MANIFEST_SUMMARIZERS.map(([, fn]) => fn(cwd)),
  );
  return results.filter(Boolean);
}

// ─── buildWorkspaceSnapshot ─────────────────────────────────────

export async function buildWorkspaceSnapshot(cwd) {
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

    const parts = ['[Workspace Snapshot]'];

    if (gitInfo) {
      const dirtyCount = gitInfo.dirtyFiles.length;
      const branchLine = dirtyCount > 0
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

const INSTRUCTION_FILES = [
  '.push/instructions.md',
  'AGENTS.md',
  'CLAUDE.md',
];

// ─── loadMemory ────────────────────────────────────────────────

export async function loadMemory(cwd) {
  try {
    const fullPath = path.join(cwd, MEMORY_PATH);
    let content = await fs.readFile(fullPath, 'utf8');
    if (content.length > MAX_MEMORY_CHARS) {
      content = content.slice(0, MAX_MEMORY_CHARS);
    }
    return content.trim() || null;
  } catch {
    return null;
  }
}

// ─── loadProjectInstructions ────────────────────────────────────

export async function loadProjectInstructions(cwd) {
  for (const relPath of INSTRUCTION_FILES) {
    try {
      const fullPath = path.join(cwd, relPath);
      let content = await fs.readFile(fullPath, 'utf8');
      if (content.length > MAX_INSTRUCTIONS_CHARS) {
        content = content.slice(0, MAX_INSTRUCTIONS_CHARS);
      }
      return { file: relPath, content };
    } catch (err) {
      if (err.code === 'ENOENT') continue;
      // Unexpected error — skip this file, try next
      continue;
    }
  }
  return null;
}
