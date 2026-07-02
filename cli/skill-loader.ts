/**
 * Skill loader — discovers and parses .md skill files from built-in and workspace directories.
 *
 * A skill is a .md file: filename = skill name, first # heading = description, body = prompt template.
 * At invocation time `{{args}}` and `$ARGUMENTS` are replaced with the full user input, and
 * `$0`–`$9` / `$ARGUMENTS[N]` with individual 0-based arguments (shell-style quoting; missing
 * positions become empty). `\$…` escapes a token; templates that reference no token get
 * non-empty input appended as `ARGUMENTS: <value>`. See interpolateSkill for the full contract.
 *
 * Skills may optionally declare YAML frontmatter to constrain visibility:
 *   ---
 *   description: Optional override for the # heading text
 *   argument-hint: "[file] [notes]"   # shown in /skills next to the command name
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
import { ALL_CAPABILITIES, type Capability } from '../lib/capabilities.js';

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
  'clear',
  'session',
  'resume',
  'model',
  'provider',
  'skills',
  'config',
  'compact',
  'copy',
  'theme',
  'spinner',
  'checkpoint',
  'worktree',
  'revert',
  'unrevert',
  'children',
  'remote',
  'handoff',
  'daemon',
  'debug',
]);

type SkillSource = 'builtin' | 'workspace' | 'claude';

/** Operating-system platforms a skill may target. */
export type SkillPlatform = 'linux' | 'macos' | 'windows';

const ALL_PLATFORMS: readonly SkillPlatform[] = ['linux', 'macos', 'windows'];

/**
 * Skill-lint diagnostics.
 *
 * `error` — the skill file is **dropped** (never loaded); the author would otherwise see it
 * silently vanish from `/skills`. `warning` — the skill loads, but a declared constraint was
 * ignored or degraded (e.g. a typo'd capability dropped fail-open).
 *
 * Diagnostics are produced by the *same* code paths the loader uses to drop/degrade files, so the
 * linter can never disagree with the loader about what is droppable. Each `code` pairs 1:1 with a
 * silent early-exit branch in `scanDir`/`parseSkillFile`/`parseFrontmatter`.
 */
export type SkillDiagnosticSeverity = 'error' | 'warning';

export type SkillDiagnosticCode =
  | 'invalid-name'
  | 'reserved-name'
  | 'unreadable'
  | 'missing-description'
  | 'empty-body'
  | 'malformed-frontmatter'
  | 'unknown-capability'
  | 'invalid-platform';

export interface SkillDiagnostic {
  /** Absolute path to the offending file. */
  filePath: string;
  /** Skill name derived from the filename (may itself be invalid for `invalid-name`). */
  name: string;
  source: SkillSource;
  severity: SkillDiagnosticSeverity;
  code: SkillDiagnosticCode;
  /** Human-readable explanation of what's wrong and the consequence. */
  message: string;
}

/**
 * Per-file diagnostic context. When present, the parse/scan helpers push diagnostics into it;
 * when absent (the default load path), they stay silent and behavior is byte-for-byte unchanged.
 */
interface DiagSink {
  diagnostics: SkillDiagnostic[];
  filePath: string;
  name: string;
  source: SkillSource;
}

function pushDiag(
  sink: DiagSink | undefined,
  severity: SkillDiagnosticSeverity,
  code: SkillDiagnosticCode,
  message: string,
): void {
  if (!sink) return;
  sink.diagnostics.push({
    filePath: sink.filePath,
    name: sink.name,
    source: sink.source,
    severity,
    code,
    message,
  });
}

export interface Skill {
  name: string;
  description: string;
  promptTemplate?: string;
  promptTemplateLoaded?: boolean;
  source: SkillSource;
  filePath: string;
  /** Short usage hint for the command's arguments, e.g. "[file] [notes]". Display-only. */
  argumentHint?: string;
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
  /** When provided, scan collects lint diagnostics for every dropped/degraded file into it. */
  diagnostics?: SkillDiagnostic[];
}

interface SkillFrontmatter {
  description?: string;
  argumentHint?: string;
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
function parseFrontmatter(
  raw: string,
  sink?: DiagSink,
): {
  frontmatter: SkillFrontmatter | null;
  remainder: string;
} {
  if (!raw.startsWith('---\n') && !raw.startsWith('---\r\n')) {
    return { frontmatter: null, remainder: raw };
  }
  const lines = raw.split(/\r?\n/);
  // Line 0 is the opening fence; find the closing fence.
  let closeIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      closeIdx = i;
      break;
    }
  }
  if (closeIdx === -1) {
    pushDiag(
      sink,
      'warning',
      'malformed-frontmatter',
      "opening '---' frontmatter fence has no closing '---'; frontmatter ignored and the whole file parsed as body",
    );
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
    } else if (key === 'argument-hint' || key === 'argument_hint') {
      fm.argumentHint = unquote(value);
    } else if (key === 'requires_capabilities' || key === 'requires-capabilities') {
      const arr = parseInlineArray(value);
      if (!arr) {
        pushDiag(
          sink,
          'warning',
          'malformed-frontmatter',
          `'${key}' must be an inline array like [git:push, repo:write]; value ignored`,
        );
      } else {
        // Validate against the known capability set; unknown entries are dropped so
        // a typo (`git:pus`) doesn't become an unmeetable constraint that silently hides
        // the skill. Mirrors how `platforms` filters to known values — fail-open by design.
        const valid = arr.filter((v): v is Capability =>
          (ALL_CAPABILITIES as readonly string[]).includes(v),
        );
        const dropped = arr.filter((v) => !(ALL_CAPABILITIES as readonly string[]).includes(v));
        if (dropped.length > 0) {
          pushDiag(
            sink,
            'warning',
            'unknown-capability',
            `unknown capabilit${dropped.length === 1 ? 'y' : 'ies'} dropped (constraint ignored fail-open): ${dropped.join(', ')}`,
          );
        }
        if (valid.length > 0) fm.requiresCapabilities = valid;
      }
    } else if (key === 'platforms') {
      const arr = parseInlineArray(value);
      if (!arr) {
        pushDiag(
          sink,
          'warning',
          'malformed-frontmatter',
          "'platforms' must be an inline array like [linux, macos]; value ignored",
        );
      } else {
        const valid = arr.filter((v): v is SkillPlatform =>
          (ALL_PLATFORMS as readonly string[]).includes(v),
        );
        const dropped = arr.filter((v) => !(ALL_PLATFORMS as readonly string[]).includes(v));
        if (dropped.length > 0) {
          pushDiag(
            sink,
            'warning',
            'invalid-platform',
            `unknown platform${dropped.length === 1 ? '' : 's'} dropped: ${dropped.join(', ')} (valid: ${ALL_PLATFORMS.join(', ')})`,
          );
        }
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
  // Split on commas at depth 0 only — commas inside "…" or '…' stay attached to their entry.
  const parts: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  for (const ch of inner) {
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === ',') {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts.map((s) => unquote(s.trim())).filter((s) => s.length > 0);
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
  sink?: DiagSink,
): Skill | null {
  const includePromptTemplate = options.includePromptTemplate !== false;
  const { frontmatter, remainder } = parseFrontmatter(raw, sink);
  // Split on CRLF or LF so a skill file saved with Windows line endings (e.g. a
  // user-authored .push/skills/*.md) still parses — otherwise the trailing \r
  // defeats the `^# (.+)$` heading match (JS `.` excludes \r), the description
  // comes back empty, and the skill is silently dropped.
  const lines = remainder.split(/\r?\n/);

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
  if (!description) {
    pushDiag(
      sink,
      'error',
      'missing-description',
      "no '# Heading' line and no frontmatter 'description'; skill skipped",
    );
    return null;
  }

  const promptTemplate = lines.slice(bodyStart).join('\n').trim();
  if (!promptTemplate) {
    pushDiag(
      sink,
      'error',
      'empty-body',
      'has a description but no body/prompt content below it; skill skipped',
    );
    return null;
  }

  const skill: Skill = { name, description, source, filePath };
  if (frontmatter?.argumentHint) {
    skill.argumentHint = frontmatter.argumentHint;
  }
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
      const filePath = path.join(currentDir, entry.name);
      const sink: DiagSink | undefined = options.diagnostics
        ? { diagnostics: options.diagnostics, filePath, name, source }
        : undefined;
      if (!NAME_RE.test(name)) {
        pushDiag(
          sink,
          'error',
          'invalid-name',
          `derived skill name '${name}' must be lowercase alphanumeric with internal hyphens (no leading/trailing hyphen); file skipped`,
        );
        continue;
      }
      if (RESERVED_COMMANDS.has(name)) {
        pushDiag(
          sink,
          'error',
          'reserved-name',
          `'${name}' is a reserved built-in command and cannot be shadowed by a skill; file skipped`,
        );
        continue;
      }

      try {
        const raw = await fs.readFile(filePath, 'utf8');
        const skill = parseSkillFile(
          raw,
          name,
          source,
          filePath,
          { includePromptTemplate: eagerPromptTemplate },
          sink,
        );
        if (skill) skills.set(name, skill);
      } catch {
        pushDiag(sink, 'error', 'unreadable', 'file could not be read');
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
export async function loadSkills(
  workspaceRoot: string,
  opts: { diagnostics?: SkillDiagnostic[] } = {},
): Promise<Map<string, Skill>> {
  const { diagnostics } = opts;
  const builtin = await scanDir(BUILTIN_DIR, 'builtin', {
    eagerPromptTemplate: true,
    diagnostics,
  });
  const claudeCommandsDir = path.join(workspaceRoot, CLAUDE_COMMANDS_DIR);
  const claude = await scanDir(claudeCommandsDir, 'claude', {
    recursive: true,
    eagerPromptTemplate: false,
    diagnostics,
  });
  const workspaceDir = path.join(workspaceRoot, WORKSPACE_DIR);
  const workspace = await scanDir(workspaceDir, 'workspace', {
    eagerPromptTemplate: false,
    diagnostics,
  });

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

const SEVERITY_ORDER: Record<SkillDiagnosticSeverity, number> = { error: 0, warning: 1 };

/**
 * Lint every skill directory the loader would scan, returning the diagnostics for files that are
 * dropped (errors) or degraded (warnings) — the problems `loadSkills` otherwise swallows silently.
 *
 * Runs the real load path with diagnostic collection enabled, so the linter and loader can never
 * disagree about what is droppable. Results are sorted errors-first, then by file path.
 */
export async function lintSkills(workspaceRoot: string): Promise<SkillDiagnostic[]> {
  const diagnostics: SkillDiagnostic[] = [];
  await loadSkills(workspaceRoot, { diagnostics });
  diagnostics.sort(
    (a, b) =>
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
      a.filePath.localeCompare(b.filePath) ||
      a.code.localeCompare(b.code),
  );
  return diagnostics;
}

/**
 * Build the structured ops-log lines for a set of diagnostics — one JSON object per line, paired
 * `skill_lint_dropped` (error) / `skill_lint_degraded` (warning) events. This is the single home for
 * the event names + levels so the REPL/headless surfaces can't drift from each other; each surface
 * decides where to write them (stderr is safe on a line-based REPL, but NOT inside a full-screen TUI
 * render — the TUI surfaces diagnostics in-app instead, via the `/skills` footer and `/skills lint`).
 */
export function skillDiagnosticLogLines(diagnostics: SkillDiagnostic[]): string[] {
  return diagnostics.map((d) =>
    JSON.stringify({
      level: d.severity === 'error' ? 'warn' : 'info',
      event: d.severity === 'error' ? 'skill_lint_dropped' : 'skill_lint_degraded',
      code: d.code,
      name: d.name,
      source: d.source,
      filePath: d.filePath,
      message: d.message,
    }),
  );
}

/**
 * One-line summary hint for the `/skills` listing footer, or null when there's nothing to report.
 * Plain text (no color, no surrounding parens) so each surface can wrap it in its own styling.
 */
export function skillDiagnosticSummaryLine(diagnostics: SkillDiagnostic[]): string | null {
  if (diagnostics.length === 0) return null;
  const errors = diagnostics.filter((d) => d.severity === 'error').length;
  const detail = errors > 0 ? `, ${errors} skipped` : '';
  return `${diagnostics.length} skill file(s) have problems${detail} — /skills lint`;
}

/**
 * Render lint diagnostics as plain text (no terminal color — callers add styling). Returns a
 * single line when there's nothing to report so the caller can print it unconditionally.
 */
export function formatSkillDiagnostics(diagnostics: SkillDiagnostic[]): string {
  if (diagnostics.length === 0) return 'No skill problems found.';
  const lines: string[] = [];
  for (const d of diagnostics) {
    lines.push(`${d.severity === 'error' ? 'error' : 'warning'}: ${d.filePath}`);
    lines.push(`  [${d.code}] ${d.message}`);
  }
  const errors = diagnostics.filter((d) => d.severity === 'error').length;
  const warnings = diagnostics.length - errors;
  lines.push('');
  lines.push(`${errors} error(s), ${warnings} warning(s).`);
  return lines.join('\n');
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
  skill.argumentHint = parsed.argumentHint;
  skill.promptTemplate = parsed.promptTemplate;
  skill.promptTemplateLoaded = true;
  return skill.promptTemplate;
}

/**
 * Split a skill argument string into indexed arguments using shell-style quoting:
 * whitespace separates arguments, but `"…"` / `'…'` group a multi-word value into one.
 * An unclosed quote is tolerated fail-open (the rest of the string joins the last word).
 */
function splitSkillArguments(argString: string): string[] {
  const words: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let inWord = false;
  for (const ch of argString) {
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      inWord = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (inWord || current.length > 0) {
        words.push(current);
        current = '';
        inWord = false;
      }
      continue;
    }
    current += ch;
    inWord = true;
  }
  if (inWord || current.length > 0) words.push(current);
  return words;
}

/**
 * Substitute argument tokens in a skill template with the given arguments string,
 * following the Claude Code substitution contract (`.claude/commands` files are loaded
 * verbatim, so their tokens must behave identically here) plus Push-native `{{args}}`:
 *
 *   `{{args}}` / `$ARGUMENTS`  → the full argument string as typed
 *   `$ARGUMENTS[N]`            → the N-th argument, 0-based, shell-style quoting
 *   `$N` (`$0`–`$9`)           → shorthand for `$ARGUMENTS[N]`; missing positions → empty
 *
 * A single backslash escapes a token — `\$1`, `\$ARGUMENTS`, `\{{args}}` — emitting it
 * literally minus the backslash, so templates that embed shell/positional syntax as
 * *content* (e.g. an `echo $1` example) can opt out. A doubled backslash (`\\$1`) keeps
 * both backslashes and still expands the token. A backslash before any other `$` is left
 * unchanged. If the template references no argument token at all, non-empty arguments are
 * appended as `ARGUMENTS: <value>` so typed input is never silently dropped. Everything
 * happens in one pass over the template, so token-shaped text inside the user's own
 * arguments is never re-expanded.
 */
export function interpolateSkill(template: string, args: string): string {
  const argString = args || '';
  const words = splitSkillArguments(argString);
  let consumedArgs = false;
  const result = template.replace(
    /(?<!\\)\\(\{\{args\}\}|\$ARGUMENTS\[\d+\]|\$ARGUMENTS\b|\$\d(?!\d))|\{\{args\}\}|\$ARGUMENTS\[(\d+)\]|\$ARGUMENTS\b|\$(\d)(?!\d)/g,
    (_match, escaped?: string, bracketIndex?: string, digit?: string) => {
      if (escaped !== undefined) return escaped;
      consumedArgs = true;
      if (bracketIndex !== undefined) return words[Number(bracketIndex)] ?? '';
      if (digit !== undefined) return words[Number(digit)] ?? '';
      return argString;
    },
  );
  if (!consumedArgs && argString) {
    return `${result.trim()}\n\nARGUMENTS: ${argString}`;
  }
  return result.trim();
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
