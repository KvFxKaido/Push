/**
 * Git mutation detection — pure heuristics for blocking direct git ops in
 * `sandbox_exec`. Shared between web and CLI surfaces so both report the
 * same boundaries to the model.
 *
 * Two-tier detection:
 *
 * Tier 1 (`GIT_MUTATION_PATTERNS`) — anchored substrings for write-style
 * verbs (commit, push, merge, rebase, checkout -b, switch -c). These must
 * go through the audited flow regardless of operand shape.
 *
 * Tier 2 (`detectBlockedBranchCheckout`) — heuristic single-positional
 * detection for `git checkout <branch>` / `git switch <branch>` so the
 * tracked branch stays in sync with sandbox HEAD. Per CLAUDE.md the
 * detection is best-effort: bare names are caught; slash/dot operands
 * pass through for `checkout` (file-restore form) but not for `switch`
 * (branch-only). Use the typed `create_branch` / `switch_branch` tools
 * for branch ops.
 *
 * Returns the matched label (e.g. `"git commit"`, `"git switch <branch>"`)
 * or null when the command is allowed through.
 */

const GIT_MUTATION_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\bgit\s+commit\b/i, label: 'git commit' },
  { pattern: /\bgit\s+push\b/i, label: 'git push' },
  { pattern: /\bgit\s+merge\b/i, label: 'git merge' },
  { pattern: /\bgit\s+rebase\b/i, label: 'git rebase' },
  { pattern: /\bgit\s+checkout\s+-b\b/i, label: 'git checkout -b' },
  { pattern: /\bgit\s+switch\s+-c\b/i, label: 'git switch -c' },
];

// Standalone shell operator: redirect introducer (`>`, `2>`, `>>`, `2>&1`,
// `<<`, `<<<`) that consumes the NEXT token as its target. The
// "single positional" heuristic disregards these AND their target;
// otherwise `git checkout main > log.txt` reads as three positionals and
// slips past the guard via the multi-positional file-restore skip.
const REDIRECT_INTRODUCER = /^(?:[0-9]*[<>]+&?[-0-9]*|<<-?|<<<)$/;
// Redirect fused to its target with no whitespace, e.g. `>/dev/null`.
const FUSED_REDIRECT = /^[0-9]*[<>]/;
// Pipe / list separators.
const LIST_SEPARATOR_TOKEN = /^(?:&&|\|\|?|;|&)$/;

function detectBlockedBranchCheckout(command: string): string | null {
  const re = /\bgit\s+(checkout|switch)\s+([^\n;|&]+)/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(command)) !== null) {
    const subcommand = match[1].toLowerCase();
    const rawTokens = match[2].trim().split(/\s+/).filter(Boolean);
    if (rawTokens.length === 0) continue;
    // Command substitution / backticks make the operand dynamic — block
    // defensively rather than try to expand.
    if (rawTokens.some((t) => t.includes('$(') || t.includes('`'))) {
      return `git ${subcommand} <branch>`;
    }
    // Strip shell-side tokens (redirects, fd dups, etc.). A standalone
    // redirect introducer consumes the NEXT token as its target; a fused
    // redirect is self-contained.
    const tokens: string[] = [];
    for (let i = 0; i < rawTokens.length; i++) {
      const t = rawTokens[i];
      if (LIST_SEPARATOR_TOKEN.test(t)) continue;
      if (REDIRECT_INTRODUCER.test(t)) {
        i++;
        continue;
      }
      if (FUSED_REDIRECT.test(t)) continue;
      tokens.push(t);
    }
    if (tokens.length === 0) continue;
    if (tokens.some((t) => t.startsWith('-'))) continue;
    if (tokens.length > 1) continue;
    const arg = tokens[0];
    if (/^HEAD(?:[~^@].*)?$/i.test(arg)) continue;
    if (/[~^]/.test(arg) || arg.includes('@{')) continue;
    if (subcommand === 'checkout' && (arg.includes('/') || arg.includes('.'))) continue;
    return `git ${subcommand} <branch>`;
  }
  return null;
}

export function detectBlockedGitCommand(command: string): string | null {
  for (const { pattern, label } of GIT_MUTATION_PATTERNS) {
    if (pattern.test(command)) return label;
  }
  return detectBlockedBranchCheckout(command);
}
