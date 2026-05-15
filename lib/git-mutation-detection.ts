/**
 * Git mutation detection — pure heuristics for blocking direct git ops
 * in `sandbox_exec`. Shared between web and CLI surfaces so both report
 * the same boundaries to the model.
 *
 * Two-tier detection:
 *
 * Tier 1 — subcommand-based block list. After stripping git's global
 * options (`-C`, `-c`, `--git-dir`, `--work-tree`, …) we look at the
 * first non-option token. If it's `commit`, `push`, `merge`, `rebase`,
 * or `cherry-pick`, block. Special-cases `checkout -b` / `switch -c`
 * since those create branches.
 *
 * Tier 2 — single-positional `checkout` / `switch` detection so that
 * branch swaps go through the typed `sandbox_switch_branch` tool and
 * Push's tracked branch stays in sync with sandbox HEAD. Single-
 * positional `git checkout <X>` and `git switch <X>` are both
 * symmetrically blocked regardless of operand shape; users get
 * unambiguous file restore via `git checkout -- <path>` (two-arg form
 * with explicit `--`).
 *
 * Returns the matched label (e.g. `"git commit"`, `"git switch <branch>"`)
 * or null when the command is allowed through.
 */

// Standalone shell operator: redirect introducer (`>`, `2>`, `>>`,
// `2>&1`, `<<`, `<<<`) that consumes the NEXT token as its target.
const REDIRECT_INTRODUCER = /^(?:[0-9]*[<>]+&?[-0-9]*|<<-?|<<<)$/;
// Redirect fused to its target with no whitespace, e.g. `>/dev/null`.
const FUSED_REDIRECT = /^[0-9]*[<>]/;
// Pipe / list separators (defense-in-depth — the outer segment split
// already terminates on these).
const LIST_SEPARATOR_TOKEN = /^(?:&&|\|\|?|;|&)$/;

// Git global options that consume a separate argument token (e.g.
// `-C <path>`, `--git-dir <path>`). When parsing past these to find
// the subcommand, the next token must be skipped along with the flag.
const GLOBAL_OPTIONS_WITH_VALUE = new Set([
  '-C',
  '-c',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--exec-path',
  '--super-prefix',
]);

// Standalone-flag global options that don't consume a value.
const GLOBAL_FLAGS_STANDALONE = new Set([
  '-p',
  '--paginate',
  '-P',
  '--no-pager',
  '--bare',
  '--no-replace-objects',
  '--literal-pathspecs',
  '--no-literal-pathspecs',
  '--glob-pathspecs',
  '--noglob-pathspecs',
  '--icase-pathspecs',
  '--no-optional-locks',
  '--no-advice',
  '--list-cmds',
  '--help',
]);

// Subcommands whose mere invocation should be blocked (no operand check).
const BLOCKED_GIT_SUBCOMMANDS = new Map<string, string>([
  ['commit', 'git commit'],
  ['push', 'git push'],
  ['merge', 'git merge'],
  ['rebase', 'git rebase'],
  ['cherry-pick', 'git cherry-pick'],
]);

/**
 * Split a shell command on top-level list separators (`;`, `|`, `||`,
 * `&&`, `&`). Quote handling is best-effort — embedded separators
 * inside quoted strings are treated as separators too, which biases
 * toward over-detection (safer for a guard).
 */
function splitOnListSeparators(command: string): string[] {
  return command
    .split(/(?:&&|\|\|?|;|&)/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Tokenize a single segment and return the tokens that aren't shell-side
 * operator artifacts (redirects, fd dups). The returned tokens should
 * read like a clean `argv` from git's perspective.
 */
function tokenizeSegment(segment: string): string[] {
  const raw = segment.trim().split(/\s+/).filter(Boolean);
  const tokens: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    const t = raw[i];
    if (LIST_SEPARATOR_TOKEN.test(t)) continue;
    if (REDIRECT_INTRODUCER.test(t)) {
      i++; // skip the redirect's target
      continue;
    }
    if (FUSED_REDIRECT.test(t)) continue;
    tokens.push(t);
  }
  return tokens;
}

interface ParsedGitInvocation {
  /** The git subcommand, e.g. `"commit"`, `"checkout"`, `"switch"`. */
  subcommand: string;
  /** Tokens after the subcommand. */
  rest: string[];
}

/**
 * Find a `git` invocation in `tokens`, skip its global options, and
 * return the subcommand + remaining args. Returns null when the
 * segment isn't a git invocation (or when global options consume all
 * remaining tokens with no subcommand).
 *
 * Handles:
 *   - `git commit`                          → { subcommand: 'commit' }
 *   - `git -C path commit`                  → { subcommand: 'commit' }
 *   - `git -c user.name=x commit`           → { subcommand: 'commit' }
 *   - `git --git-dir=.git push`             → { subcommand: 'push' }
 *   - `git --no-pager checkout main`        → { subcommand: 'checkout', rest: ['main'] }
 *   - `git -C path checkout -b feature`     → { subcommand: 'checkout', rest: ['-b', 'feature'] }
 *   - Command-substitution operands (`$(…)`, `\`…\``) are treated as
 *     dynamic and force the caller to fail safe.
 */
function parseGitInvocation(tokens: string[]): ParsedGitInvocation | null {
  const gitIdx = tokens.findIndex((t) => t.toLowerCase() === 'git');
  if (gitIdx === -1) return null;

  let i = gitIdx + 1;
  while (i < tokens.length) {
    const t = tokens[i];

    // `--name=value` form — single token consumed.
    if (t.startsWith('--') && t.includes('=')) {
      i++;
      continue;
    }
    // `--name` form that takes a following value.
    if (GLOBAL_OPTIONS_WITH_VALUE.has(t)) {
      i += 2;
      continue;
    }
    // `--name` standalone flag.
    if (GLOBAL_FLAGS_STANDALONE.has(t)) {
      i++;
      continue;
    }
    // Any other `--…` we don't recognize — assume standalone to avoid
    // accidentally consuming the subcommand as its value.
    if (t.startsWith('--')) {
      i++;
      continue;
    }
    // Short flag we don't know — same treatment.
    if (t.startsWith('-') && t.length > 1) {
      i++;
      continue;
    }
    // First non-option token is the subcommand.
    return { subcommand: t.toLowerCase(), rest: tokens.slice(i + 1) };
  }
  return null;
}

/**
 * Detect plain `git checkout <branch>` / `git switch <branch>` after
 * stripping global options. Both subcommands are now treated
 * symmetrically: any single-positional bare operand is blocked
 * because the syntax doesn't disambiguate branch from path.
 *
 * Users wanting a file restore should use the explicit two-arg form:
 *   git checkout -- <path>
 *   git checkout HEAD <path>
 *
 * Users wanting a branch switch should use `sandbox_switch_branch`.
 */
function detectBlockedBranchCheckout(invocation: ParsedGitInvocation): string | null {
  const { subcommand, rest } = invocation;
  if (subcommand !== 'checkout' && subcommand !== 'switch') return null;

  // `--` is the explicit "what follows is a path" separator. Anything
  // after it is a file restore, never a branch. Let it pass.
  if (rest.includes('--')) return null;

  // Command substitution / backticks make the operand dynamic — block.
  if (rest.some((t) => t.includes('$(') || t.includes('`'))) {
    return `git ${subcommand} <branch>`;
  }

  // Strip any further flags — flagged forms (`-b`, `-c`, `--detach`,
  // …) are handled either by Tier 1's `checkout -b` / `switch -c`
  // patterns or are detached-checkout / no-branch-change flows.
  const flagless = rest.filter((t) => !t.startsWith('-'));
  if (flagless.length === 0) return null;

  // Multiple positional → file-restore form: `git checkout main path`.
  if (flagless.length > 1) return null;

  const arg = flagless[0];
  // Ref expressions (HEAD, HEAD~1, branch^, branch@{upstream}, …)
  if (/^HEAD(?:[~^@].*)?$/i.test(arg)) return null;
  if (/[~^]/.test(arg) || arg.includes('@{')) return null;

  return `git ${subcommand} <branch>`;
}

export function detectBlockedGitCommand(command: string): string | null {
  for (const segment of splitOnListSeparators(command)) {
    const tokens = tokenizeSegment(segment);
    const invocation = parseGitInvocation(tokens);
    if (!invocation) continue;

    // Tier 1 — subcommand block list.
    const tier1Label = BLOCKED_GIT_SUBCOMMANDS.get(invocation.subcommand);
    if (tier1Label) return tier1Label;

    // Branch-create variants: `checkout -b` / `switch -c`.
    if (invocation.subcommand === 'checkout' && invocation.rest[0] === '-b') {
      return 'git checkout -b';
    }
    if (invocation.subcommand === 'switch' && invocation.rest[0] === '-c') {
      return 'git switch -c';
    }

    // Tier 2 — single-positional branch detection.
    const tier2Label = detectBlockedBranchCheckout(invocation);
    if (tier2Label) return tier2Label;
  }
  return null;
}
