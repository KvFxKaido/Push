/**
 * sandbox-policy.ts
 *
 * Provider-agnostic policy describing what a sandbox is allowed to do.
 * Schema borrowed from OpenShell's static-vs-dynamic split: static rules
 * lock at container creation; dynamic rules can be hot-reloaded on a live
 * sandbox. Providers translate this schema into their native primitives
 * (Cloudflare firewall rules, Modal network config, etc.) — this module
 * defines no enforcement of its own.
 *
 * Layer note: orthogonal to `lib/verification-policy.ts`. Verification
 * policy is an *agent obligation* surfaced via prompt injection; this
 * file is an *OS-level isolation* policy enforced by the sandbox host.
 */

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------

export type PolicyAction = 'allow' | 'deny' | 'route';

/**
 * Where to redirect a `route` decision. The credential-stripping bit is the
 * point of the inference-routing case: caller's API key is dropped, the
 * backend's key is injected by the provider before egress.
 */
export interface RouteTarget {
  backend: string;
  stripCallerAuth: boolean;
}

// ---------------------------------------------------------------------------
// Static — fixed at sandbox creation. Changing requires recreating the box.
// ---------------------------------------------------------------------------

export interface FilesystemRule {
  /** Glob anchored at workspace root, e.g. '/workspace/**', '/tmp/**'. */
  pathGlob: string;
  mode: 'rw' | 'ro' | 'none';
}

export interface ProcessRule {
  /** Exact command match, or `'*'` for any command (use when the predicate scans the raw line itself). */
  command: string;
  /**
   * Argv-shape matcher. Literal tokens match by equality; tokens wrapped in
   * angle brackets are classifier placeholders (e.g. `<branch>` for
   * "operand that looks like a branch name"). Classifier semantics live
   * with the provider — this schema only names them.
   */
  argMatch?: string[];
  /**
   * Richer matcher for cases the simple pattern language can't express
   * (shell tokenization, redirect filtering, ref-expression carve-outs,
   * variable-arity scans). Return a non-null string to fire the rule;
   * the string becomes the decision's `reason`, overriding `rule.reason`.
   * Return `null` to skip. Takes precedence over `argMatch`.
   */
  predicate?: (req: ProcessRequest) => string | null;
  action: 'allow' | 'deny';
  reason?: string;
}

export interface StaticPolicy {
  filesystem: FilesystemRule[];
  process: ProcessRule[];
}

// ---------------------------------------------------------------------------
// Dynamic — hot-reloadable via applyPolicy() on a live sandbox.
// ---------------------------------------------------------------------------

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | '*';

interface NetworkRuleBase {
  /** Host glob, e.g. 'api.github.com', '*.anthropic.com'. */
  host: string;
  methods: HttpMethod[];
  pathGlob: string;
}

/** Discriminated on `action` so `route` is required iff action === 'route'. */
export type NetworkRule =
  | (NetworkRuleBase & { action: 'allow' | 'deny' })
  | (NetworkRuleBase & { action: 'route'; route: RouteTarget });

export interface InferenceRule {
  provider: string;
  route: RouteTarget;
}

export interface DynamicPolicy {
  network: NetworkRule[];
  inference: InferenceRule[];
}

// ---------------------------------------------------------------------------
// Combined
// ---------------------------------------------------------------------------

export interface SandboxPolicy {
  static: StaticPolicy;
  dynamic?: DynamicPolicy;
}

// ---------------------------------------------------------------------------
// Pure deciders — host-side reference implementation.
// Providers may delegate here, or compile to native rules (firewall, eBPF,
// gateway config) and skip per-call evaluation. Both paths must agree.
// ---------------------------------------------------------------------------

export interface NetworkRequest {
  host: string;
  method: string;
  path: string;
}

export interface NetworkDecision {
  action: PolicyAction;
  rule?: NetworkRule;
  route?: RouteTarget;
}

/**
 * Default-deny on missing policy: callers wiring this in should expect to
 * fail closed and opt into a permissive rollout flag explicitly. Network
 * egress is the higher-blast-radius layer, so the safer default lives here.
 */
export function evaluateNetwork(
  policy: DynamicPolicy | undefined,
  req: NetworkRequest,
): NetworkDecision {
  if (!policy) return { action: 'deny' };
  for (const rule of policy.network) {
    if (!hostMatches(rule.host, req.host)) continue;
    if (!methodMatches(rule.methods, req.method)) continue;
    if (!pathMatches(rule.pathGlob, req.path)) continue;
    return rule.action === 'route'
      ? { action: 'route', rule, route: rule.route }
      : { action: rule.action, rule };
  }
  return { action: 'deny' };
}

export interface ProcessRequest {
  command: string;
  argv: string[];
  /**
   * Raw shell command line, when the caller can't pre-parse to argv
   * (e.g. `sandbox_exec` receives a free-form shell string). Predicates
   * that need to inspect shell-level structure (redirects, command
   * substitution, separators) read this.
   */
  raw?: string;
}

export interface ProcessDecision {
  action: 'allow' | 'deny';
  rule?: ProcessRule;
  reason?: string;
}

/**
 * Default-allow on missing policy: process rules are intended as a denylist
 * layered over today's `sandbox_exec`, which is itself default-allow with
 * specific blocks. A no-policy box must keep working; the safer default
 * sits at the network layer.
 */
export function evaluateProcess(
  policy: StaticPolicy | undefined,
  req: ProcessRequest,
  classify: ArgClassifier = defaultArgClassifier,
): ProcessDecision {
  if (!policy) return { action: 'allow' };
  for (const rule of policy.process) {
    if (rule.command !== '*' && rule.command !== req.command) continue;
    if (rule.predicate) {
      const reason = rule.predicate(req);
      if (reason === null) continue;
      return { action: rule.action, rule, reason };
    }
    if (rule.argMatch && !argvMatches(rule.argMatch, req.argv, classify)) continue;
    return { action: rule.action, rule, reason: rule.reason };
  }
  return { action: 'allow' };
}

// ---------------------------------------------------------------------------
// Provider translation — each provider exports an implementation. The bundle
// types are provider-specific (e.g. CF firewall JSON, Modal NetworkPolicy).
// ---------------------------------------------------------------------------

export interface PolicyTranslator<TStaticBundle, TDynamicBundle> {
  compileStatic(p: StaticPolicy): TStaticBundle;
  compileDynamic(p: DynamicPolicy): TDynamicBundle;
}

// ---------------------------------------------------------------------------
// Matchers — minimal reference impls. Promote to a shared glob module when a
// second caller needs them.
// ---------------------------------------------------------------------------

export type ArgClassifier = (token: string, argv: string[], index: number) => boolean;

function hostMatches(pattern: string, host: string): boolean {
  if (pattern === host) return true;
  if (pattern.startsWith('*.')) return host.endsWith(pattern.slice(1));
  return false;
}

function methodMatches(allowed: HttpMethod[], method: string): boolean {
  const m = method.toUpperCase();
  return allowed.some((a) => a === '*' || a === m);
}

function pathMatches(pattern: string, path: string): boolean {
  if (pattern === '/**' || pattern === '**') return true;
  if (pattern === path) return true;
  if (pattern.endsWith('/**')) {
    // Require a '/' boundary so '/api/**' doesn't match '/api-internal'.
    const prefix = pattern.slice(0, -3);
    return path === prefix || path.startsWith(`${prefix}/`);
  }
  return false;
}

/**
 * Exact-length match. `argMatch` describes the full argv shape; trailing
 * positionals must be expressed explicitly (e.g. with a future `<rest>`
 * wildcard) rather than allowed implicitly. This is what lets Push
 * distinguish `git checkout main` (bare branch — blockable) from
 * `git checkout main file.ts` (file restore — must pass).
 */
function argvMatches(pattern: string[], argv: string[], classify: ArgClassifier): boolean {
  if (pattern.length !== argv.length) return false;
  return pattern.every((tok, i) => {
    if (tok.startsWith('<') && tok.endsWith('>')) return classify(tok, argv, i);
    return argv[i] === tok;
  });
}

/**
 * Default classifier dispatches by command so it can reproduce the
 * different branch heuristics `sandbox_exec` enforces today:
 *   - `git checkout <branch>`: bare token, no '/' or '.' (file-restore forms
 *     like `feat/foo` and `src/utils` are deliberately allowed through).
 *   - `git switch <branch>`: slash-shaped names like `feat/foo` ARE blocked
 *     because `switch` is branch-only; only '.'-containing tokens pass.
 * Caller can pass a custom `ArgClassifier` to `evaluateProcess` to override.
 *
 * NB: even with this dispatch, the simple pattern language can't fully
 * capture sandbox_exec's variable-arity scan-all-operands logic. Wiring
 * sandbox_exec to this schema will require either a richer pattern (e.g.
 * `<rest:branch>`) or a per-rule predicate hook.
 */
const defaultArgClassifier: ArgClassifier = (token, argv, index) => {
  const operand = argv[index];
  if (operand === undefined) return false;
  if (token !== '<branch>') return false;
  const cmd = argv[0] ?? '';
  if (cmd === 'switch') return !operand.includes('.');
  return !operand.includes('/') && !operand.includes('.');
};
