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
  command: string;
  /**
   * Argv-shape matcher. Literal tokens match by equality; tokens wrapped in
   * angle brackets are classifier placeholders (e.g. `<branch>` for
   * "operand that looks like a branch name"). Classifier semantics live
   * with the provider — this schema only names them.
   */
  argMatch?: string[];
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

export interface NetworkRule {
  /** Host glob, e.g. 'api.github.com', '*.anthropic.com'. */
  host: string;
  methods: HttpMethod[];
  pathGlob: string;
  action: PolicyAction;
  /** Required when action === 'route'. */
  route?: RouteTarget;
}

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

export function evaluateNetwork(
  policy: DynamicPolicy | undefined,
  req: NetworkRequest,
): NetworkDecision {
  if (!policy) return { action: 'deny' };
  for (const rule of policy.network) {
    if (!hostMatches(rule.host, req.host)) continue;
    if (!methodMatches(rule.methods, req.method)) continue;
    if (!pathMatches(rule.pathGlob, req.path)) continue;
    return { action: rule.action, rule, route: rule.route };
  }
  return { action: 'deny' };
}

export interface ProcessRequest {
  command: string;
  argv: string[];
}

export interface ProcessDecision {
  action: 'allow' | 'deny';
  rule?: ProcessRule;
  reason?: string;
}

export function evaluateProcess(
  policy: StaticPolicy | undefined,
  req: ProcessRequest,
  classify: ArgClassifier = defaultArgClassifier,
): ProcessDecision {
  if (!policy) return { action: 'allow' };
  for (const rule of policy.process) {
    if (rule.command !== req.command) continue;
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
  if (pattern.endsWith('/**')) return path.startsWith(pattern.slice(0, -3));
  return false;
}

function argvMatches(pattern: string[], argv: string[], classify: ArgClassifier): boolean {
  if (pattern.length > argv.length) return false;
  return pattern.every((tok, i) => {
    if (tok.startsWith('<') && tok.endsWith('>')) return classify(tok, argv, i);
    return argv[i] === tok;
  });
}

/**
 * Default classifier covers the one shape Push already enforces today: a
 * `<branch>` operand is a bare token containing no '/' or '.' (mirrors the
 * heuristic in `sandbox_exec`'s `git checkout` / `git switch` guard).
 * Extend by passing a custom classifier to `evaluateProcess`.
 */
const defaultArgClassifier: ArgClassifier = (token, argv, index) => {
  const operand = argv[index];
  if (operand === undefined) return false;
  if (token === '<branch>') return !operand.includes('/') && !operand.includes('.');
  return false;
};
