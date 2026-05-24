/**
 * lib/git/policy.ts — the pure git-command policy oracle.
 *
 * `classifyGitCommand` is the single source of truth for what Push does
 * with a raw `sandbox_exec` git command line: let it run as-is
 * (`passthrough`), let it run as a sanctioned mutation (`allow`), steer it
 * onto a typed tool (`route`), or forbid it (`block`). The decision is a
 * pure function of the command string — it carries no session/branch
 * context (Protect Main lives in `lib/default-pre-hooks.ts`, which has the
 * branch reader it needs).
 *
 * This module consolidates the heuristic that previously lived in
 * `lib/git-mutation-detection.ts` (`detectBlockedGitCommand`) and the
 * checkout-vs-switch / `<branch>` classifier semantics sketched in
 * `lib/sandbox-policy.ts`. The legacy `detectBlockedGitCommand` is kept as
 * a thin adapter over `classifyGitCommand` (block/route ⇒ a label, else
 * null) so existing call-sites and the established label corpus keep
 * working byte-for-byte.
 *
 * Scope note (intentional, see PR plan): this oracle reproduces today's
 * block/allow/route decisions exactly — no behavior change. Two items from
 * the longer-term design are deliberately NOT yet enforced here:
 *   - `git reset --hard` / other history rewrites beyond rebase: still
 *     `allow` (today's behavior); promoting reset to `block` is a follow-up.
 *   - Protect Main: stays in the typed-tool pre-hook; folding it in would
 *     require the branch context this pure oracle doesn't take.
 */

// ---------------------------------------------------------------------------
// Decision vocabulary
// ---------------------------------------------------------------------------

/** Read-only git (or non-git) commands that run directly. */
export type GitReadFamily = 'status' | 'log' | 'diff' | 'show' | 'non-git';

/** Mutating-but-sanctioned raw git ops permitted to run as-is. */
export type GitAllowFamily = 'restore-file' | 'mutate';

/** Typed tools a `route` decision steers toward. */
export type GitRouteTarget = 'create_branch' | 'switch_branch' | 'commit' | 'push';

/** Hard-blocked operations (no typed tool, forbidden outright). */
export type GitBlockReason = 'no-local-merge' | 'history-rewrite';

export interface GitPassthroughDecision {
  kind: 'passthrough';
  family: GitReadFamily;
}

export interface GitAllowDecision {
  kind: 'allow';
  family: GitAllowFamily;
}

export interface GitRouteDecision {
  kind: 'route';
  to: GitRouteTarget;
  /** Best-effort extracted args (e.g. `{ name }`, `{ branch }`). */
  args: Record<string, string>;
  /**
   * Legacy `detectBlockedGitCommand` label (e.g. `"git commit"`,
   * `"git checkout <branch>"`). Carried so the `sandbox_exec` guard's
   * reason text and `default-pre-hooks` guidance stay identical.
   */
  label: string;
}

export interface GitBlockDecision {
  kind: 'block';
  reason: GitBlockReason;
  /** Legacy label, as on `GitRouteDecision`. */
  label: string;
}

export type GitDecision =
  | GitPassthroughDecision
  | GitAllowDecision
  | GitRouteDecision
  | GitBlockDecision;

// ---------------------------------------------------------------------------
// Shell tokenization (ported verbatim from git-mutation-detection.ts)
// ---------------------------------------------------------------------------

// Standalone shell operator: redirect introducer (`>`, `2>`, `>>`,
// `2>&1` is NOT one — that's a self-contained fd duplicate, handled
// by `FUSED_REDIRECT`). The hard constraint is: this token must consume
// the NEXT token as its target, so we must not match self-contained
// forms here or we'd skip a real argument.
const REDIRECT_INTRODUCER = /^(?:[0-9]*>{1,2}|<{1,3}-?)$/;
// Redirect fused to its target (or self-contained fd dup): `>/dev/null`,
// `2>/tmp/log`, `<input.txt`, `2>&1`. Self-contained — no trailing
// target token to skip.
const FUSED_REDIRECT = /^(?:[0-9]*[<>]|[0-9]*>{1,2}&[0-9-]*)/;
// Pipe / list separators. `&` is intentionally NOT a top-level separator
// here because it appears inside fd duplicates like `2>&1`.
const LIST_SEPARATOR_TOKEN = /^(?:&&|\|\|?|;)$/;

// Git global options that consume a separate argument token (e.g.
// `-C <path>`). When parsing past these to find the subcommand, the next
// token must be skipped along with the flag.
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

/**
 * Recognize a token as a `git` invocation. Catches both the bare `git`
 * form and absolute/relative path forms like `/usr/bin/git` or
 * `./bin/git` — without those, a model could bypass the guard by spelling
 * out git's executable path.
 */
function isGitToken(token: string): boolean {
  const lower = token.toLowerCase();
  if (lower === 'git') return true;
  if (lower.endsWith('/git')) return true;
  return false;
}

/**
 * Split a shell command on top-level list separators (`;`, `|`, `||`,
 * `&&`). Single `&` is intentionally NOT a separator (it appears inside fd
 * duplicates like `2>&1`). Quote handling is best-effort — embedded
 * separators inside quoted strings are treated as separators too, which
 * biases toward over-detection (safer for a guard).
 */
function splitOnListSeparators(command: string): string[] {
  return command
    .split(/(?:&&|\|\|?|;)/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Tokenize a single segment, dropping shell-side operator artifacts
 * (redirects, fd dups). The returned tokens read like a clean `argv` from
 * git's perspective.
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
 * Find a `git` invocation in `tokens`, skip its global options, and return
 * the subcommand + remaining args. Returns null when the segment isn't a
 * git invocation (or when global options consume all remaining tokens with
 * no subcommand).
 */
function parseGitInvocation(tokens: string[]): ParsedGitInvocation | null {
  const gitIdx = tokens.findIndex(isGitToken);
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
 * Return the flag tokens that appear before any `--` separator. Used to
 * scan for branch-create flags (`-b`/`-B`/`-c`/`-C`/`--create`) regardless
 * of position relative to other flags like `-q`/`--quiet`.
 */
function takeFlagsBeforeDoubleDash(rest: string[]): string[] {
  const flags: string[] = [];
  for (const t of rest) {
    if (t === '--') break;
    if (t.startsWith('-')) flags.push(t);
  }
  return flags;
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/**
 * Read-only subcommands surfaced as `passthrough`. Intentionally minimal —
 * the unambiguous read-only forms relevant today. Everything else
 * non-blocked falls to `allow`; the GitBackend (later PR) owns richer read
 * classification.
 */
const READ_FAMILIES = new Map<string, GitReadFamily>([
  ['status', 'status'],
  ['log', 'log'],
  ['diff', 'diff'],
  ['show', 'show'],
]);

/** First positional (non-flag) token — the branch name for create forms. */
function firstPositional(rest: string[]): string {
  return rest.find((t) => !t.startsWith('-')) ?? '';
}

/**
 * Classify `checkout` / `switch` once branch-create flags have been ruled
 * out. Mirrors the legacy `detectBlockedBranchCheckout` "allowed" cases
 * (file restore, detached/ref checkout, no positional) as `allow`, and its
 * blocked case (single bare operand) as a `switch_branch` route.
 */
function classifyCheckoutOrSwitch(subcommand: 'checkout' | 'switch', rest: string[]): GitDecision {
  const label = `git ${subcommand} <branch>`;

  // `--` is the explicit path separator only for `checkout` (which has a
  // file-restore mode). `git switch -- main` is still a branch switch (the
  // `--` is a no-op there per git's parser), so it must not bypass.
  if (subcommand === 'checkout' && rest.includes('--')) {
    return { kind: 'allow', family: 'restore-file' };
  }

  // Command substitution / backticks make the operand dynamic — treat as a
  // branch switch (fail safe; the typed tool is the only sound path).
  if (rest.some((t) => t.includes('$(') || t.includes('`'))) {
    return { kind: 'route', to: 'switch_branch', args: { branch: '' }, label };
  }

  const flagless = rest.filter((t) => !t.startsWith('-'));
  // No positional (e.g. `git switch --detach`, bare `git checkout`).
  if (flagless.length === 0) return { kind: 'allow', family: 'mutate' };
  // Multiple positionals → file-restore form: `git checkout <ref> <path>`.
  if (flagless.length > 1) return { kind: 'allow', family: 'restore-file' };

  const arg = flagless[0];
  // Ref expressions (HEAD, HEAD~1, branch^, branch@{upstream}, …) — detached
  // / ref checkout, allowed through.
  if (/^HEAD(?:[~^@].*)?$/i.test(arg)) return { kind: 'allow', family: 'mutate' };
  if (/[~^]/.test(arg) || arg.includes('@{')) return { kind: 'allow', family: 'mutate' };

  return { kind: 'route', to: 'switch_branch', args: { branch: arg }, label };
}

/** Classify a single already-parsed git invocation. */
function classifySegment(invocation: ParsedGitInvocation): GitDecision {
  const { subcommand, rest } = invocation;

  // Tier 1 — subcommand block list. commit/push/revert create commits and
  // route to the audited typed flow; merge/rebase/cherry-pick are forbidden.
  switch (subcommand) {
    case 'commit':
      return { kind: 'route', to: 'commit', args: {}, label: 'git commit' };
    case 'push':
      return { kind: 'route', to: 'push', args: {}, label: 'git push' };
    // `revert` writes a new commit; preserved as a route to the audited
    // commit flow (today it is blocked with commit/push guidance).
    case 'revert':
      return { kind: 'route', to: 'commit', args: {}, label: 'git revert' };
    case 'merge':
      return { kind: 'block', reason: 'no-local-merge', label: 'git merge' };
    case 'rebase':
      return { kind: 'block', reason: 'history-rewrite', label: 'git rebase' };
    case 'cherry-pick':
      return { kind: 'block', reason: 'history-rewrite', label: 'git cherry-pick' };
  }

  if (subcommand === 'checkout' || subcommand === 'switch') {
    // Branch-create variants: `checkout -b/-B`, `switch -c/-C/--create`.
    // Scan all flags before any `--` — they can appear in any order, and
    // checking only `rest[0]` would let the model bypass the dedicated
    // branch-create label and fall through to the branch-switch label.
    const flags = takeFlagsBeforeDoubleDash(rest);
    if (subcommand === 'checkout' && flags.some((f) => f === '-b' || f === '-B')) {
      return {
        kind: 'route',
        to: 'create_branch',
        args: { name: firstPositional(rest) },
        label: 'git checkout -b',
      };
    }
    if (
      subcommand === 'switch' &&
      flags.some((f) => f === '-c' || f === '-C' || f === '--create')
    ) {
      return {
        kind: 'route',
        to: 'create_branch',
        args: { name: firstPositional(rest) },
        label: 'git switch -c',
      };
    }
    return classifyCheckoutOrSwitch(subcommand, rest);
  }

  const readFamily = READ_FAMILIES.get(subcommand);
  if (readFamily) return { kind: 'passthrough', family: readFamily };

  // Everything else (add, fetch, stash, reset, restore, clean, pull, …) is
  // a mutating-but-sanctioned raw op, allowed to run as-is today.
  return { kind: 'allow', family: 'mutate' };
}

/**
 * Classify a raw shell command line containing zero or more git
 * invocations. A compound command (`a && git push`) is decided by its
 * most restrictive git segment, scanned left to right: the first segment
 * that yields `block` or `route` wins (matching the legacy
 * first-blocking-segment semantics). With no blocking segment, the first
 * git segment's read/allow decision is returned; with no git at all, a
 * `non-git` passthrough.
 */
export function classifyGitCommand(command: string): GitDecision {
  let firstNonBlocking: GitDecision | null = null;
  for (const segment of splitOnListSeparators(command)) {
    const invocation = parseGitInvocation(tokenizeSegment(segment));
    if (!invocation) continue;
    const decision = classifySegment(invocation);
    if (decision.kind === 'block' || decision.kind === 'route') return decision;
    if (!firstNonBlocking) firstNonBlocking = decision;
  }
  return firstNonBlocking ?? { kind: 'passthrough', family: 'non-git' };
}

/**
 * Legacy adapter: the guard label (`"git commit"`, `"git checkout
 * <branch>"`, …) for a blocked/routed command, or null when allowed
 * through. Equivalent to the old `git-mutation-detection.detectBlockedGitCommand`
 * — `block` and `route` decisions are the blocked set; `passthrough` and
 * `allow` are the let-through set.
 */
export function detectBlockedGitCommand(command: string): string | null {
  const decision = classifyGitCommand(command);
  return decision.kind === 'block' || decision.kind === 'route' ? decision.label : null;
}
