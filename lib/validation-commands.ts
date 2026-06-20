// Parse per-kind validation-command overrides from project-instruction text
// (AGENTS.md / CLAUDE.md). The contract is documented in AGENTS.md
// ("Validation commands"): a repo overrides a derived command for a given
// kind by adding a fenced `bash`/`sh`/`shell` block containing a leading
// `# <kind>:` directive on the line before the command, e.g.
//
//   ```bash
//   # test:
//   TMPDIR=/tmp npm run test:cli && npm run test:mcp:github
//   # typecheck:
//   npm run typecheck:tsgo
//   ```
//
// The override beats commands derived from package.json scripts / config files.
// This parser is the single source of truth for reading those directives so the
// web and CLI surfaces can't drift on the format.

export type ValidationKind = 'test' | 'lint' | 'typecheck' | 'format' | 'build' | 'check';

const KNOWN_KINDS: readonly string[] = ['test', 'lint', 'typecheck', 'format', 'build', 'check'];

// A fenced block whose info string starts with bash/sh/shell. Non-greedy body
// capture so multiple blocks in one document are each considered.
const FENCE_RE = /```(?:bash|sh|shell)[^\n]*\n([\s\S]*?)```/gi;

// A `# kind: [inline command]` directive line. Only a single bare token before
// the colon counts as a directive, so prose comments like `# note the foo:` are
// not mistaken for directives.
const DIRECTIVE_RE = /^#\s*([a-z][\w-]*)\s*:(.*)$/i;

/**
 * Extract the override command for `kind` from one fenced block's body.
 * The command is the inline remainder of the `# kind:` line (if any) plus the
 * following lines, terminated by the next directive or a blank line.
 */
function extractKindCommand(block: string, kind: ValidationKind): string | null {
  const lines = block.split(/\r?\n/);
  let collecting = false;
  const collected: string[] = [];

  for (const line of lines) {
    const directive = line.match(DIRECTIVE_RE);
    if (directive) {
      // The next directive of any kind ends the command we're collecting.
      if (collecting) break;
      if (directive[1].toLowerCase() === kind) {
        collecting = true;
        const inline = directive[2].trim();
        if (inline) collected.push(inline);
      }
      continue;
    }
    if (collecting) {
      // A blank line after the command body ends the directive.
      if (line.trim() === '') {
        if (collected.length > 0) break;
        continue;
      }
      collected.push(line.trim());
    }
  }

  const command = collected.join('\n').trim();
  return command || null;
}

/**
 * Parse the override command for `kind` from project-instruction text. Returns
 * the first match across all fenced bash/sh/shell blocks, or `null` when no
 * override is declared. Directives outside a fenced block are ignored so a
 * `# test:` mention in prose can never be misread as a command.
 */
export function parseValidationCommandOverride(text: string, kind: ValidationKind): string | null {
  if (!text || !KNOWN_KINDS.includes(kind)) return null;
  FENCE_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = FENCE_RE.exec(text)) !== null) {
    const command = extractKindCommand(match[1], kind);
    if (command) return command;
  }
  return null;
}

/**
 * Resolve the first override command for `kind` across an ordered list of
 * instruction sources (e.g. [AGENTS.md, CLAUDE.md]) — earlier sources win,
 * matching the documented "AGENTS.md beats CLAUDE.md" precedence.
 */
export function resolveValidationCommandOverride(
  sources: readonly string[],
  kind: ValidationKind,
): string | null {
  for (const source of sources) {
    const command = parseValidationCommandOverride(source, kind);
    if (command) return command;
  }
  return null;
}
