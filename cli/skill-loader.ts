/**
 * Skill loader — discovers and parses .md skill files from built-in and workspace directories.
 *
 * A skill is a .md file: filename = skill name, first # heading = description, body = prompt template.
 * {{args}} in the template is replaced with user input at invocation time.
 *
 * Skills may optionally declare YAML frontmatter to constrain visibility:
 *   ---
 *   description: Optional override for the # heading text
 *   requires_capabilities: [repo:write, sandbox:exec]
 *   platforms: [linux, macos]
 *   ---
 *   # Heading still acts as fallback description
 *   …body…
 *
 * Frontmatter is optional and additive — skills without it behave exactly as before.
 * Malformed frontmatter is treated as no constraints (fail-open) so a typo never silently
 * loses a skill from the listing.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Capability } from '../lib/capabilities.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Built-in skills live alongside this module */
const BUILTIN_DIR: string = path.join(__dirname, 'skills');

/** Workspace skills override built-in skills of the same name */
const WORKSPACE_DIR = '.push/skills';
const CLAUDE_COMMANDS_DIR = '.claude/commands';

/** Skill names must be lowercase alphanumeric with optional hyphens, no leading/trailing hyphen */
const NAME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

/** Commands that skills cannot shadow */
export const RESERVED_COMMANDS: Set<string> = new Set([
  'help',
  'exit',
  'quit',
  'new',
  'session',
  'model',
  'provider',
  'skills',
  'config',
  'compact',
  'copy',
  'theme',
  'spinner',
  'checkpoint',
]);

type SkillSource = 'builtin' | 'workspace' | 'claude';

/** Operating-system platforms a skill may target. */
export type SkillPlatform = 'linux' | 'macos' | 'windows';

const ALL_PLATFORMS: readonly SkillPlatform[] = ['linux', 'macos', 'windows'];

export interface Skill {
  name: string;
  description: string;
  promptTemplate?: string;
  promptTemplateLoaded?: boolean;
  source: SkillSource;
  filePath: string;
  /** Capabilities the skill's workflow expects; if any is missing from the runtime, hide it. */
  requiresCapabilities?: Capability[];
  /** OS platforms this skill is valid on; if the current platform isn't listed, hide it. */
  platforms?: SkillPlatform[];
}

interface ParseOptions {
  includePromptTemplate?: boolean;
}

interface ScanOptions {
  recursive?: boolean;
  eagerPromptTemplate?: boolean;
}

interface SkillFrontmatter {
  description?: string;
  requiresCapabilities?: Capability[];
  platforms?: SkillPlatform[];
}

/**
 * Strip a leading YAML frontmatter block (`---\n…---\n`) from raw skill text.
 *
 * Returns `{ frontmatter, remainder }`. Malformed frontmatter (unclosed fence, unparseable
 * lines) is treated as no frontmatter: `frontmatter` is `null` and `remainder` is the
 * original input — the body parser then runs on the whole file. Fail-open by design.
 *
 * Supported value shapes:
 *   key: value              → scalar string
 *   key: [a, b, c]          → inline array (quoted or bare entries)
 *
 * Comment lines (`# …` outside quoted values) and blank lines are tolerated.
 */
function parseFrontmatter(raw: string): {
  frontmatter: SkillFrontmatter | null;
  remainder: string;
} {
  if (!raw.startsWith('---\n') && !raw.startsWith('---\r\n')) {
    return { frontmatter: null, remainder: raw };
  }
  const lines = raw.split('\n');
  // Line 0 is the opening fence; find the closing fence.
  let closeIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      closeIdx = i;
      break;
    }
  }
  if (closeIdx === -1) {
    return { frontmatter: null, remainder: raw };
  }

  const fm: SkillFrontmatter = {};
  for (let i = 1; i < closeIdx; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();
    if (!key || !value) continue;

    if (key === 'description') {
      fm.description = unquote(value);
    } else if (key === 'requires_capabilities' || key === 'requires-capabilities') {
      const arr = parseInlineArray(value);
      if (arr) fm.requiresCapabilities = arr as Capability[];
    } else if (key === 'platforms') {
      const arr = parseInlineArray(value);
      if (arr) {
        const valid = arr.filter((v): v is SkillPlatform =>
          (ALL_PLATFORMS as readonly string[]).includes(v),
        );
        if (valid.length > 0) fm.platforms = valid;
      }
    }
    // Unknown keys silently ignored — forward compatibility for skills authored against
    // richer frontmatter shapes (e.g. agentskills.io standard).
  }

  const remainder = lines.slice(closeIdx + 1).join('\n');
  return { frontmatter: fm, remainder };
}

function unquote(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function parseInlineArray(value: string): string[] | null {
  if (!value.startsWith('[') || !value.endsWith(']')) return null;
  const inner = value.slice(1, -1).trim();
  if (!inner) return [];
  return inner
    .split(',')
    .map((s) => unquote(s.trim()))
    .filter((s) => s.length > 0);
}

/**
 * Parse a single .md file into a Skill, or return null if invalid.
 */
function parseSkillFile(
  raw: string,
  name: string,
  source: SkillSource,
  filePath: string,
  options: ParseOptions = {},
): Skill | null {
  const includePromptTemplate = options.includePromptTemplate !== false;
  const { frontmatter, remainder } = parseFrontmatter(raw);
  const lines = remainder.split('\n');

  // First # heading = description (frontmatter `description` overrides if present)
  let headingDescription = '';
  let bodyStart = 0;
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^# (.+)$/);
    if (match) {
      headingDescription = match[1].trim();
      bodyStart = i + 1;
      break;
    }
  }

  const description = (frontmatter?.description ?? '').trim() || headingDescription;
  if (!description) return null;

  const promptTemplate = lines.slice(bodyStart).join('\n').trim();
  if (!promptTemplate) return null;

  const skill: Skill = { name, description, source, filePath };
  if (frontmatter?.requiresCapabilities && frontmatter.requiresCapabilities.length > 0) {
    skill.requiresCapabilities = frontmatter.requiresCapabilities;
  }
  if (frontmatter?.platforms && frontmatter.platforms.length > 0) {
    skill.platforms = frontmatter.platforms;
  }
  if (includePromptTemplate) {
    skill.promptTemplate = promptTemplate;
    skill.promptTemplateLoaded = true;
  } else {
    skill.promptTemplateLoaded = false;
  }
  return skill;
}

/**
 * Scan a directory for .md skill files.
 * Returns a Map<name, Skill>. Silently skips files with invalid names or parse failures.
 */
async function scanDir(
  dir: string,
  source: SkillSource,
  options: ScanOptions = {},
): Promise<Map<string, Skill>> {
  const recursive = options.recursive === true;
  const eagerPromptTemplate = options.eagerPromptTemplate !== false;
  const skills: Map<string, Skill> = new Map();

  async function walk(currentDir: string, relPrefix: string = ''): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(currentDir, { withFileTypes: true });
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }

    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!recursive) continue;
        const nextPrefix = relPrefix ? path.join(relPrefix, entry.name) : entry.name;
        await walk(path.join(currentDir, entry.name), nextPrefix);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;

      const relFile = relPrefix ? path.join(relPrefix, entry.name) : entry.name;
      const relStem = relFile.slice(0, -3);
      const name = recursive ? relStem.split(path.sep).join('-') : relStem;
      if (!NAME_RE.test(name)) continue;
      if (RESERVED_COMMANDS.has(name)) continue;

      const filePath = path.join(currentDir, entry.name);
      try {
        const raw = await fs.readFile(filePath, 'utf8');
        const skill = parseSkillFile(raw, name, source, filePath, {
          includePromptTemplate: eagerPromptTemplate,
        });
        if (skill) skills.set(name, skill);
      } catch {
        // Skip unreadable files
      }
    }
  }

  await walk(dir);

  return skills;
}

/**
 * Load all skills — built-in first, then workspace (which overrides built-in by name).
 * @param workspaceRoot — absolute path to workspace root
 */
export async function loadSkills(workspaceRoot: string): Promise<Map<string, Skill>> {
  const builtin = await scanDir(BUILTIN_DIR, 'builtin', { eagerPromptTemplate: true });
  const claudeCommandsDir = path.join(workspaceRoot, CLAUDE_COMMANDS_DIR);
  const claude = await scanDir(claudeCommandsDir, 'claude', {
    recursive: true,
    eagerPromptTemplate: false,
  });
  const workspaceDir = path.join(workspaceRoot, WORKSPACE_DIR);
  const workspace = await scanDir(workspaceDir, 'workspace', { eagerPromptTemplate: false });

  // Precedence: builtin < Claude commands < Push workspace skills
  const merged: Map<string, Skill> = new Map(builtin);
  for (const [name, skill] of claude) {
    merged.set(name, skill);
  }
  for (const [name, skill] of workspace) {
    merged.set(name, skill);
  }
  return merged;
}

/**
 * Load a skill template on demand (used for third-party skills).
 * Mutates the skill object in place so subsequent invocations are cached in memory.
 */
export async function getSkillPromptTemplate(skill: Skill): Promise<string> {
  if (!skill || typeof skill !== 'object') {
    throw new Error('Invalid skill object');
  }
  if (typeof skill.promptTemplate === 'string' && skill.promptTemplate.length > 0) {
    skill.promptTemplateLoaded = true;
    return skill.promptTemplate;
  }

  const raw = await fs.readFile(skill.filePath, 'utf8');
  const parsed = parseSkillFile(raw, skill.name, skill.source, skill.filePath, {
    includePromptTemplate: true,
  });
  if (!parsed || typeof parsed.promptTemplate !== 'string' || !parsed.promptTemplate) {
    throw new Error(`Invalid skill file: ${skill.filePath}`);
  }

  skill.description = parsed.description;
  skill.promptTemplate = parsed.promptTemplate;
  skill.promptTemplateLoaded = true;
  return skill.promptTemplate;
}

/**
 * Replace {{args}} in a skill template with the given arguments string.
 */
export function interpolateSkill(template: string, args: string): string {
  return template.replace(/\{\{args\}\}/g, args || '').trim();
}

/**
 * Map `process.platform` to the skill-frontmatter platform vocabulary.
 * Unrecognized platforms (e.g. `aix`, `sunos`) map to undefined — callers should treat
 * those as "no platform filtering" (every skill visible) since the user is on an
 * unsupported OS regardless of what skills declare.
 */
export function getCurrentSkillPlatform(): SkillPlatform | undefined {
  switch (process.platform) {
    case 'linux':
      return 'linux';
    case 'darwin':
      return 'macos';
    case 'win32':
      return 'windows';
    default:
      return undefined;
  }
}

export interface SkillFilterEnv {
  /** Current OS; if undefined, platform filtering is disabled. */
  platform?: SkillPlatform;
  /** Capabilities available in the current runtime context; if undefined, capability filtering is disabled. */
  availableCapabilities?: ReadonlySet<Capability>;
}

/**
 * Return only the skills whose declared constraints are satisfied by `env`.
 *
 * A skill is **visible** iff:
 *   • it declares no `platforms`, or `env.platform` is one of them; AND
 *   • it declares no `requiresCapabilities`, or every required capability is in
 *     `env.availableCapabilities`.
 *
 * Filtering is additive and skipped per-axis when `env` doesn't provide the axis —
 * passing `{}` returns every skill unchanged, matching pre-frontmatter behavior.
 */
export function filterSkillsForEnvironment(
  skills: Map<string, Skill>,
  env: SkillFilterEnv,
): Map<string, Skill> {
  const result: Map<string, Skill> = new Map();
  for (const [name, skill] of skills) {
    if (skill.platforms && env.platform !== undefined) {
      if (!skill.platforms.includes(env.platform)) continue;
    }
    if (skill.requiresCapabilities && env.availableCapabilities !== undefined) {
      const missing = skill.requiresCapabilities.some(
        (cap) => !env.availableCapabilities!.has(cap),
      );
      if (missing) continue;
    }
    result.set(name, skill);
  }
  return result;
}
