/**
 * Skill loader — discovers and parses .md skill files from built-in and workspace directories.
 *
 * A skill is a .md file: filename = skill name, first # heading = description, body = prompt template.
 * {{args}} in the template is replaced with user input at invocation time.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Built-in skills live alongside this module */
const BUILTIN_DIR = path.join(__dirname, 'skills');

/** Workspace skills override built-in skills of the same name */
const WORKSPACE_DIR = '.push/skills';
const CLAUDE_COMMANDS_DIR = '.claude/commands';

/** Skill names must be lowercase alphanumeric with optional hyphens, no leading/trailing hyphen */
const NAME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

/** Commands that skills cannot shadow */
export const RESERVED_COMMANDS = new Set([
  'help', 'exit', 'quit', 'new', 'session', 'model', 'provider', 'skills', 'config', 'compact',
]);

/**
 * @typedef {{ name: string, description: string, promptTemplate?: string, promptTemplateLoaded?: boolean, source: 'builtin'|'workspace'|'claude', filePath: string }} Skill
 */

/**
 * Parse a single .md file into a Skill, or return null if invalid.
 */
function parseSkillFile(raw, name, source, filePath, options = {}) {
  const includePromptTemplate = options.includePromptTemplate !== false;
  const lines = raw.split('\n');

  // First # heading = description
  let description = '';
  let bodyStart = 0;
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^# (.+)$/);
    if (match) {
      description = match[1].trim();
      bodyStart = i + 1;
      break;
    }
  }

  if (!description) return null;

  const promptTemplate = lines.slice(bodyStart).join('\n').trim();
  if (!promptTemplate) return null;

  const skill = { name, description, source, filePath };
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
async function scanDir(dir, source, options = {}) {
  const recursive = options.recursive === true;
  const eagerPromptTemplate = options.eagerPromptTemplate !== false;
  /** @type {Map<string, Skill>} */
  const skills = new Map();

  async function walk(currentDir, relPrefix = '') {
    let entries;
    try {
      entries = await fs.readdir(currentDir, { withFileTypes: true });
    } catch (err) {
      if (err.code === 'ENOENT') return;
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
      const name = recursive
        ? relStem.split(path.sep).join('-')
        : relStem;
      if (!NAME_RE.test(name)) continue;
      if (RESERVED_COMMANDS.has(name)) continue;

      const filePath = path.join(currentDir, entry.name);
      try {
        const raw = await fs.readFile(filePath, 'utf8');
        const skill = parseSkillFile(raw, name, source, filePath, { includePromptTemplate: eagerPromptTemplate });
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
 * @param {string} workspaceRoot — absolute path to workspace root
 * @returns {Promise<Map<string, Skill>>}
 */
export async function loadSkills(workspaceRoot) {
  const builtin = await scanDir(BUILTIN_DIR, 'builtin', { eagerPromptTemplate: true });
  const claudeCommandsDir = path.join(workspaceRoot, CLAUDE_COMMANDS_DIR);
  const claude = await scanDir(claudeCommandsDir, 'claude', { recursive: true, eagerPromptTemplate: false });
  const workspaceDir = path.join(workspaceRoot, WORKSPACE_DIR);
  const workspace = await scanDir(workspaceDir, 'workspace', { eagerPromptTemplate: false });

  // Precedence: builtin < Claude commands < Push workspace skills
  const merged = new Map(builtin);
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
 * @param {Skill} skill
 * @returns {Promise<string>}
 */
export async function getSkillPromptTemplate(skill) {
  if (!skill || typeof skill !== 'object') {
    throw new Error('Invalid skill object');
  }
  if (typeof skill.promptTemplate === 'string' && skill.promptTemplate.length > 0) {
    skill.promptTemplateLoaded = true;
    return skill.promptTemplate;
  }

  const raw = await fs.readFile(skill.filePath, 'utf8');
  const parsed = parseSkillFile(raw, skill.name, skill.source, skill.filePath, { includePromptTemplate: true });
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
 * @param {string} template — the prompt template
 * @param {string} args — user-supplied arguments (may be empty)
 * @returns {string}
 */
export function interpolateSkill(template, args) {
  return template.replace(/\{\{args\}\}/g, args || '').trim();
}
