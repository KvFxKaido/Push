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
 * block/allow/route decisions exactly — no behavior change. A few items from
 * the longer-term design are deliberately NOT yet enforced here:
 *   - `git reset --hard` / other history rewrites beyond rebase: still
 *     `allow` (today's behavior); promoting reset to `block` is a follow-up.
 *   - `git checkout -` / `git switch -` (previous-branch shorthand): still
 *     `allow` (today's behavior) even though it changes branch — promoting
 *     it to a `switch_branch` route is a follow-up behavior change. Pinned
 *     in the drift corpus so the gap stays visible.
 *   - Protect Main: stays in the typed-tool pre-hook; folding it in would
 *     require the branch context this pure oracle doesn't take.
 *
 * Shell-parsing evasions (#987): interim hardening covers the cheap, high-value
 * vectors — a standalone `&` is now a separator (`git status & git push`), and
 * `tokenizeSegment` unwraps parens/quotes/leading-escape so `(git push)`,
 * `"git" push`, and `\git push` no longer hide the invocation. Residual vectors
 * remain (aliases / shell functions / variable-indirected git, and arbitrary
 * `eval`/`bash -c` nesting) and are NOT fully solvable by string parsing. The
 * transport boundary now strips persistent clone credentials from sandbox
 * remotes and injects GitHub auth transiently for typed PushGit network
 * operations, so this parser remains defense-in-depth rather than the
 * authority boundary.
 */

// ---------------------------------------------------------------------------
// Decision vocabulary
// ---------------------------------------------------------------------------

/** Read-only git (or non-git) commands that run directly. */
export type GitReadFamily = 'status' | 'log' | 'diff' | 'show' | 'non-git';

/** Mutating-but-sanctioned raw git ops permitted to run as-is. */
export type GitAllowFamily = 'restore-file' | 'mutate';

/**
 * Typed tools a `route` decision steers toward. `git revert` intentionally
 * maps to `'commit'` — it writes a commit and shares the audited commit
 * flow + guidance — so there is no separate `'revert'` target; code that
 * switches/logs/metrics on `to` will observe `'commit'` for reverts.
 */
export type GitRouteTarget = 'create_branch' | 'switch_branch' | 'commit' | 'push';

/** Hard-blocked operations (no typed tool, forbidden outright). */
export type GitBlockReason = 'no-local-merge' | 'history-rewrite' | 'remote-mutation';

export interface GitPassthroughDecision {
  kind: 'passthrough';
  family: GitReadFamily;
}

export interface GitAllowDecision {
  kind: 'allow';
  family: GitAllowFamily;
}

/**
 * A `route` decision. `args` is typed per `to` target so the typed
 * branch/commit tools (wired up in a later PR) get the right keys
 * statically rather than a stringly-typed bag.
 */
export type GitRouteDecision = {
  kind: 'route';
  /**
   * Legacy `detectBlockedGitCommand` label (e.g. `"git commit"`,
   * `"git checkout <branch>"`). Carried so the `sandbox_exec` guard's
   * reason text and `default-pre-hooks` guidance stay identical.
   */
  label: string;
} & (
  | { to: 'create_branch'; args: { name: string } }
  | { to: 'switch_branch'; args: { branch: string } }
  | { to: 'commit' | 'push'; args: Record<string, never> }
);

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
// Redirect operators can be glued to a command word or arg with no whitespace:
// `git>/tmp/log push`, `git push>/tmp/log`, `git&>/tmp/log push`. Bash still
// runs `git` / `push`; the redirect suffix is shell syntax, not part of argv.
const ATTACHED_REDIRECT_SUFFIX = /^(.+?)(?:&>>?|<>|<<|>>|<&|>&|[<>])(.*)$/;

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
 * `&&`, and a standalone `&`) and newlines. `sandbox_exec` runs under
 * `bash -c`, where a newline separates commands just like `;` — without
 * splitting on it, only the first invocation in `git status\ngit push`
 * would be classified and the `git push` would bypass the guard. A
 * standalone `&` (background / sequencing) is also a separator so
 * `git status & git push` doesn't hide the push (#987); the lookbehind /
 * lookahead exclude the `&` inside fd duplicates — both output (`2>&1`,
 * `>&-`) and input (`<&0`, `0<&-`) forms, hence `<` in the lookbehind — and
 * the `&>`/`&&` operators, so those aren't mis-split. (Without `<` excluded,
 * `git <&0 push` would split into `git <` (no subcommand → passthrough) and
 * reopen the raw-push / remote-mutation bypass.) Quote handling is
 * best-effort — embedded separators inside quoted strings are treated as
 * separators too, which biases toward over-detection (safer for a guard).
 */
function splitOnListSeparators(command: string): string[] {
  return command
    .split(/(?:&&|\|\|?|;|\r?\n|(?<![<>&])&(?![>&]))/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Strip shell wrapping a model could use to hide a git invocation from the
 * token scanner: subshell / group parens (`(git push)`, `{ git push; }`),
 * surrounding quotes (`"git"`, `'git'`), and a leading escape (`\git`, which
 * defeats a git *alias* but still runs the real git). Best-effort and biased
 * toward exposing the inner command — over-normalization at worst surfaces a
 * non-git token, which classifies as a harmless passthrough. Backticks are
 * deliberately left intact so command-substitution detection (`$(...)` /
 * backtick operands in checkout/switch) still fires downstream.
 */
function stripShellWrapping(token: string): string {
  return token
    .replace(/^[({]+/, '')
    .replace(/[)}]+$/, '')
    .replace(/['"]/g, '')
    .replace(/^\\+/, '');
}

function stripAttachedRedirect(token: string): { token: string; skipNext: boolean } {
  const match = token.match(ATTACHED_REDIRECT_SUFFIX);
  if (!match) return { token, skipNext: false };
  const [, prefix, target = ''] = match;
  return { token: prefix, skipNext: target.length === 0 };
}

/**
 * Tokenize a single segment, dropping shell-side operator artifacts
 * (redirects, fd dups), peeling redirect suffixes glued to command words, and
 * stripping shell wrapping (parens / quotes / leading escape) off each
 * surviving token. The returned tokens read like a clean `argv` from git's
 * perspective — so `(git push)`, `"git" push`, and `git>/tmp/log push` expose
 * the same `['git', 'push']` a bare `git push` would.
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
    const { token: withoutRedirect, skipNext } = stripAttachedRedirect(t);
    if (skipNext) i++;
    // Unwrap parens/quotes/escape AFTER the operator checks (those match raw
    // shell forms); a token that was pure wrapping (`(`, `"`) normalizes to
    // empty and is dropped.
    const normalized = stripShellWrapping(withoutRedirect);
    if (normalized) tokens.push(normalized);
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

/**
 * `git remote` operations that mutate remote identity/config. Blocked outright
 * (no typed tool, no `allowDirectGit` escape) because repointing `origin` —
 * e.g. `git remote set-url origin <other>` — silently redirects the
 * Gate-at-Push approved push to a different repository: HEAD, branch, and the
 * upstream *ref* (`origin/foo`) all stay unchanged, so the approval-time
 * destination pins don't catch it. The read-only forms (`git remote`,
 * `git remote -v`, `git remote show`, `git remote get-url`) are unaffected.
 */
const REMOTE_MUTATING_SUBCOMMANDS = new Set([
  'add',
  'rename',
  'remove',
  'rm',
  'set-url',
  'set-head',
  'set-branches',
]);

const CONFIG_OPTIONS_WITH_VALUE = new Set([
  '--file',
  '-f',
  '--blob',
  '--type',
  '--expiry-date',
  '--default',
]);

const CONFIG_MUTATING_FLAGS = new Set([
  '--add',
  '--replace-all',
  '--unset',
  '--unset-all',
  '--remove-section',
  '--rename-section',
]);

const CONFIG_MUTATING_ACTIONS = new Set(['set', 'unset', 'rename-section', 'remove-section']);
const CONFIG_READ_ACTIONS = new Set(['get', 'get-all', 'get-regexp', 'list']);

function configPositionals(rest: string[]): string[] {
  const positionals: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i];
    if (CONFIG_OPTIONS_WITH_VALUE.has(token)) {
      i++;
      continue;
    }
    if (token.startsWith('-')) continue;
    positionals.push(token);
  }
  return positionals;
}

function configKeyAffectsRemoteIdentity(token: string): boolean {
  const key = token.toLowerCase();
  return (
    /^remote\.[^.]+(?:\.|$)/.test(key) || /^url\..+\.(?:insteadOf|pushInsteadOf)$/i.test(token)
  );
}

function configMutatesRemoteIdentity(rest: string[]): boolean {
  const positionals = configPositionals(rest);
  if (!positionals.some(configKeyAffectsRemoteIdentity)) return false;

  const first = positionals[0]?.toLowerCase();
  if (CONFIG_READ_ACTIONS.has(first)) return false;
  if (CONFIG_MUTATING_ACTIONS.has(first)) return true;
  if (rest.some((token) => CONFIG_MUTATING_FLAGS.has(token.toLowerCase()))) return true;

  // Legacy set form: `git config remote.origin.url <value>`.
  return positionals.length >= 2 && configKeyAffectsRemoteIdentity(positionals[0]);
}

/**
 * The branch name for a create form (`-b`/`-c`/`--create <name>`). Tokens
 * after a `--` separator are positional regardless of a leading `-`, so an
 * explicitly-separated name (`-b -- <name>`) is extracted even when it
 * starts with a hyphen; otherwise the first non-flag token wins.
 */
function firstPositional(rest: string[]): string {
  const sepIdx = rest.indexOf('--');
  if (sepIdx !== -1 && sepIdx + 1 < rest.length) return rest[sepIdx + 1];
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
    // `revert` writes a new commit; intentionally lumped under the `commit`
    // route target (see GitRouteTarget) so it inherits the audited commit
    // flow + guidance, matching today's commit/push block behavior.
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

  // `git remote <mutation>` (set-url / add / rename / …) repoints or rewrites
  // remote identity, which evades the Gate-at-Push destination pins. Block the
  // mutating forms outright; read-only `git remote [-v|show|get-url]` falls
  // through to the allow path below.
  if (subcommand === 'remote') {
    const op = rest.find((t) => !t.startsWith('-'))?.toLowerCase();
    if (op && REMOTE_MUTATING_SUBCOMMANDS.has(op)) {
      return { kind: 'block', reason: 'remote-mutation', label: `git remote ${op}` };
    }
  }

  // `git config remote.origin.url ...`, `remote.origin.pushurl`, and
  // `url.*InsteadOf` rewrites are equivalent remote-identity mutations. A
  // push URL can differ from the fetch URL, so block the config route too.
  if (subcommand === 'config' && configMutatesRemoteIdentity(rest)) {
    return { kind: 'block', reason: 'remote-mutation', label: 'git config remote' };
  }

  const readFamily = READ_FAMILIES.get(subcommand);
  if (readFamily) return { kind: 'passthrough', family: readFamily };

  // Everything else (add, fetch, stash, reset, restore, clean, pull, …) is
  // a mutating-but-sanctioned raw op, allowed to run as-is today.
  return { kind: 'allow', family: 'mutate' };
}

/**
 * Restrictiveness rank for picking the decisive segment of a compound command.
 * Higher wins. A forbidden op (`block`: merge / rebase / cherry-pick) outranks
 * an always-gated route (push, branch create / switch), which outranks an
 * escapable route (commit / revert). This stops a later restricted segment from
 * being masked by an earlier escapable one. (The guard makes every `block`
 * unescapable, so surfacing any block in a chain denies the whole command.)
 */
function restrictivenessRank(decision: GitDecision): number {
  if (decision.kind === 'block') return 3;
  if (decision.kind === 'route') {
    // push / create_branch / switch_branch are always gated; commit is escapable.
    return decision.to === 'commit' ? 1 : 2;
  }
  return 0;
}

/**
 * Classify a raw shell command line containing zero or more git invocations.
 * A compound command (`a && git merge`) is decided by its MOST RESTRICTIVE git
 * segment (see {@link restrictivenessRank}), NOT the first block/route segment:
 * a forbidden op outranks an always-gated route, which outranks an escapable
 * one. This stops a later restricted segment from being masked by an earlier
 * escapable one — `git commit && git merge` surfaces the merge (#985), and
 * `git commit && git push` surfaces the push (Gate-at-Push). Ties resolve to the
 * first (left-to-right). With no block/route segment, the first git segment's
 * read/allow decision is returned; with no git at all, a `non-git` passthrough.
 */
export function classifyGitCommand(command: string): GitDecision {
  let best: GitDecision | null = null;
  let bestRank = -1;
  let firstNonBlocking: GitDecision | null = null;
  for (const segment of splitOnListSeparators(command)) {
    const invocation = parseGitInvocation(tokenizeSegment(segment));
    if (!invocation) continue;
    const decision = classifySegment(invocation);
    if (decision.kind === 'block' || decision.kind === 'route') {
      const rank = restrictivenessRank(decision);
      if (rank > bestRank) {
        best = decision;
        bestRank = rank;
      }
    } else if (!firstNonBlocking) {
      firstNonBlocking = decision;
    }
  }
  return best ?? firstNonBlocking ?? { kind: 'passthrough', family: 'non-git' };
}

/**
 * Classify an already-tokenized argv vector whose executable is `git` (or a
 * path ending in `/git`). Unlike `classifyGitCommand`, this does not scan later
 * argv entries for a `git` token, so callers that already used a shell parser
 * can safely avoid false positives like `echo "git push"`.
 */
export function classifyGitArgv(argv: readonly string[]): GitDecision {
  const first = argv[0];
  if (!first || !isGitToken(first)) return { kind: 'passthrough', family: 'non-git' };
  const invocation = parseGitInvocation([...argv]);
  return invocation ? classifySegment(invocation) : { kind: 'passthrough', family: 'non-git' };
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
