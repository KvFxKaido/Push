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

/** Skill names must be lowercase alphanumeric with optional hyphens, no leading/trailing hyphen */
const NAME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

/** Commands that skills cannot shadow */
export const RESERVED_COMMANDS = new Set([
  'help', 'exit', 'quit', 'new', 'session', 'model', 'provider', 'skills', 'config',
]);

/**
 * @typedef {{ name: string, description: string, promptTemplate: string, source: 'builtin'|'workspace', filePath: string }} Skill
 */

/**
 * Parse a single .md file into a Skill, or return null if invalid.
 */
function parseSkillFile(raw, name, source, filePath) {
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

  return { name, description, promptTemplate, source, filePath };
}

/**
 * Scan a directory for .md skill files.
 * Returns a Map<name, Skill>. Silently skips files with invalid names or parse failures.
 */
async function scanDir(dir, source) {
  /** @type {Map<string, Skill>} */
  const skills = new Map();

  let entries;
  try {
    entries = await fs.readdir(dir);
  } catch (err) {
    if (err.code === 'ENOENT') return skills;
    throw err;
  }

  for (const entry of entries) {
    if (!entry.endsWith('.md')) continue;

    const name = entry.slice(0, -3);
    if (!NAME_RE.test(name)) continue;
    if (RESERVED_COMMANDS.has(name)) continue;

    const filePath = path.join(dir, entry);
    try {
      const raw = await fs.readFile(filePath, 'utf8');
      const skill = parseSkillFile(raw, name, source, filePath);
      if (skill) skills.set(name, skill);
    } catch {
      // Skip unreadable files
    }
  }

  return skills;
}

/**
 * Load all skills — built-in first, then workspace (which overrides built-in by name).
 * @param {string} workspaceRoot — absolute path to workspace root
 * @returns {Promise<Map<string, Skill>>}
 */
export async function loadSkills(workspaceRoot) {
  const builtin = await scanDir(BUILTIN_DIR, 'builtin');
  const workspaceDir = path.join(workspaceRoot, WORKSPACE_DIR);
  const workspace = await scanDir(workspaceDir, 'workspace');

  // Workspace wins — overlay onto builtin map
  const merged = new Map(builtin);
  for (const [name, skill] of workspace) {
    merged.set(name, skill);
  }
  return merged;
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
