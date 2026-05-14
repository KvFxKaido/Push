/**
 * Capability-based permission system.
 *
 * Tools declare which capabilities they require. Roles grant a fixed set
 * of capabilities. At runtime the CapabilityLedger tracks declared vs
 * actually-used capabilities for audit, approval UI, and delegation contracts.
 *
 * Capability names use colon-delimited namespaces:
 *   <domain>:<action>   e.g. "repo:read", "git:push"
 */

import type { AgentRole } from './runtime-contract.js';

// ---------------------------------------------------------------------------
// Capability type
// ---------------------------------------------------------------------------

/**
 * A named, fine-grained permission that a tool requires and a role may grant.
 *
 * Granularity is intentionally coarser than individual tool names but finer
 * than "this role has these tools." Each capability maps to a meaningful
 * user-facing verb so approval prompts can say
 *   "Allow this run to read code, edit files, and execute tests"
 * rather than listing raw tool names.
 */
export type Capability =
  | 'repo:read' // Read files, directories, search code, list branches/commits/checks
  | 'repo:write' // Edit, write, or delete files in the sandbox workspace
  | 'sandbox:exec' // Execute arbitrary shell commands in the sandbox
  | 'sandbox:test' // Run tests or type-checking
  | 'sandbox:download' // Download or promote workspace artifacts
  | 'git:commit' // Create commits (prepare + auditor review)
  | 'git:push' // Push commits to the remote
  | 'git:draft' // Quick-save uncommitted changes to a draft branch
  | 'git:branch' // Create a new branch and switch to it
  | 'pr:read' // Read PRs, check mergeability, find existing PRs
  | 'pr:write' // Create or merge PRs, delete branches
  | 'workflow:read' // List and view workflow runs and logs
  | 'workflow:trigger' // Trigger a workflow dispatch event
  | 'delegate:coder' // Delegate work to the Coder agent
  | 'delegate:explorer' // Delegate investigation to the Explorer agent
  | 'scratchpad' // Read/write the session scratchpad
  | 'todo' // Read/write the model's structured todo list
  | 'web:search' // Search the web for current information
  | 'user:ask' // Ask the user a structured question
  | 'artifacts:write'; // Create renderable artifacts (HTML/React/Mermaid/file-tree)

/** All known capabilities (for validation/iteration). */
export const ALL_CAPABILITIES: readonly Capability[] = [
  'repo:read',
  'repo:write',
  'sandbox:exec',
  'sandbox:test',
  'sandbox:download',
  'git:commit',
  'git:push',
  'git:draft',
  'git:branch',
  'pr:read',
  'pr:write',
  'workflow:read',
  'workflow:trigger',
  'delegate:coder',
  'delegate:explorer',
  'scratchpad',
  'todo',
  'web:search',
  'user:ask',
  'artifacts:write',
];

// ---------------------------------------------------------------------------
// Tool → Capability mapping
// ---------------------------------------------------------------------------

/**
 * Maps each canonical tool name to the capabilities it requires.
 * A tool may require multiple capabilities when it spans domains.
 */
export const TOOL_CAPABILITIES: Readonly<Record<string, readonly Capability[]>> = {
  // GitHub read-only tools
  fetch_pr: ['pr:read'],
  list_prs: ['pr:read'],
  list_commits: ['repo:read'],
  read_file: ['repo:read'],
  grep_file: ['repo:read'],
  list_directory: ['repo:read'],
  list_branches: ['repo:read'],
  fetch_checks: ['repo:read'],
  search_files: ['repo:read'],
  list_commit_files: ['repo:read'],
  check_pr_mergeable: ['pr:read'],
  find_existing_pr: ['pr:read'],

  // GitHub mutating tools
  trigger_workflow: ['workflow:trigger'],
  get_workflow_runs: ['workflow:read'],
  get_workflow_logs: ['workflow:read'],
  create_pr: ['pr:write'],
  merge_pr: ['pr:write'],
  delete_branch: ['pr:write'],

  // Sandbox read-only tools
  sandbox_read_file: ['repo:read'],
  sandbox_search: ['repo:read'],
  sandbox_find_references: ['repo:read'],
  sandbox_list_dir: ['repo:read'],
  sandbox_diff: ['repo:read'],
  sandbox_read_symbols: ['repo:read'],

  // Sandbox mutating tools
  sandbox_exec: ['sandbox:exec'],
  sandbox_edit_range: ['repo:write'],
  sandbox_search_replace: ['repo:write'],
  sandbox_edit_file: ['repo:write'],
  sandbox_write_file: ['repo:write'],
  sandbox_apply_patchset: ['repo:write'],
  sandbox_run_tests: ['sandbox:test'],
  sandbox_check_types: ['sandbox:test'],
  sandbox_verify_workspace: ['sandbox:test'],
  sandbox_prepare_commit: ['git:commit'],
  sandbox_push: ['git:push'],
  sandbox_download: ['sandbox:download'],
  sandbox_save_draft: ['git:draft'],
  sandbox_create_branch: ['git:branch'],
  sandbox_switch_branch: ['git:branch'],
  promote_to_github: ['sandbox:download'],

  // Delegation tools
  delegate_coder: ['delegate:coder'],
  delegate_explorer: ['delegate:explorer'],
  plan_tasks: ['delegate:coder', 'delegate:explorer'],

  // Scratchpad tools
  set_scratchpad: ['scratchpad'],
  append_scratchpad: ['scratchpad'],
  read_scratchpad: ['scratchpad'],

  // Todo tools
  todo_write: ['todo'],
  todo_read: ['todo'],
  todo_clear: ['todo'],

  // Web search
  web_search: ['web:search'],

  // Ask user
  ask_user: ['user:ask'],

  // Artifacts. Granted to orchestrator and coder. The CLI Coder path
  // (`makeDaemonCoderToolExec` in cli/pushd.ts) plumbs `role: 'coder'`
  // through to the cli/tools.ts dispatch, which uses `roleCanUseTool`
  // as a defense-in-depth check before persisting. The web Coder
  // (lib/coder-agent-bindings.ts) is still gated on its own kernel
  // source filter — granting the capability there is a separate PR
  // because the kernel needs an `executeArtifactToolCall` service
  // injection to actually run the call.
  create_artifact: ['artifacts:write'],

  // CLI-native tools (daemon tool surface in `cli/tools.ts`). These names
  // are distinct from the sandbox family above because the CLI dispatches
  // against the local workspace via `executeToolCall`, not the sandbox
  // API. Added 2026-04-18 so `roleCanUseTool` is authoritative on both
  // surfaces — see `cli/pushd.ts:makeDaemonExplorerToolExec` for the
  // enforcement swap that motivated these entries.
  //
  // Omitted deliberately:
  // - `coder_update_state`: handled pre-executor on both surfaces, never
  //   reaches the daemon tool-exec boundary. Adding an entry would be
  //   noise.
  // - `read_file` / `search_files` / `web_search` / `ask_user`: already
  //   mapped above; the CLI dispatch reuses those canonical names.
  list_dir: ['repo:read'],
  read_symbols: ['repo:read'],
  read_symbol: ['repo:read'],
  git_status: ['repo:read'],
  git_diff: ['repo:read'],
  git_commit: ['git:commit'],
  git_create_branch: ['git:branch'],
  lsp_diagnostics: ['repo:read'],
  save_memory: ['scratchpad'],
  write_file: ['repo:write'],
  edit_file: ['repo:write'],
  undo_edit: ['repo:write'],
  exec: ['sandbox:exec'],
  exec_start: ['sandbox:exec'],
  // exec_poll / exec_list_sessions are read-verbs over exec-family objects.
  // Assigned `sandbox:exec` (not `repo:read`) because Explorer can never
  // poll a session it could not have started — `exec_start` requires
  // `sandbox:exec` and `makeDaemonExplorerToolExec` passes `allowExec:
  // false` as a second line of defense. Coherent with the family;
  // functionally removes Explorer access to these two tools (intentional
  // behavior change — see PR description for rationale).
  exec_poll: ['sandbox:exec'],
  exec_write: ['sandbox:exec'],
  exec_stop: ['sandbox:exec'],
  exec_list_sessions: ['sandbox:exec'],
};

/**
 * Look up the capabilities required by a canonical tool name.
 * Returns an empty array for unknown tools (fail-open for forward compat).
 *
 * Uses `Object.hasOwn` so that inherited `Object.prototype` keys like
 * `__proto__`, `constructor`, `toString`, `valueOf`, `hasOwnProperty`,
 * and `isPrototypeOf` do NOT resolve to prototype members. Without
 * this guard, a model-supplied tool name matching a prototype key
 * would either (a) crash `roleCanUseTool` because the prototype value
 * isn't an array (`.every` is undefined — hits `__proto__`,
 * `constructor`, `hasOwnProperty`) or (b) silently return `true` and
 * grant access because the prototype function's `.length` is 0 so
 * `roleCanUseTool`'s fail-open branch fires (hits `toString`,
 * `valueOf`, `isPrototypeOf`). Codex review on PR #331 caught the
 * crash path; the silent-grant path is adjacent. Both are closed
 * here.
 */
export function getToolCapabilities(canonicalName: string): readonly Capability[] {
  if (!Object.hasOwn(TOOL_CAPABILITIES, canonicalName)) return [];
  return TOOL_CAPABILITIES[canonicalName];
}

/**
 * Return true iff the given canonical tool name has an own-property
 * entry in `TOOL_CAPABILITIES`. Intended for callers that want
 * fail-closed behavior on unmapped names (daemon Explorer gate) —
 * `roleCanUseTool` is fail-open by design, so callers that need
 * strict enforcement must compose this check explicitly.
 */
export function isCapabilityMapped(canonicalName: string): boolean {
  return Object.hasOwn(TOOL_CAPABILITIES, canonicalName);
}

// ---------------------------------------------------------------------------
// Execution mode — cloud sandbox vs paired local daemon
// ---------------------------------------------------------------------------

/**
 * Where the tool call is being executed.
 *
 *   - `cloud`        — cloud sandbox provider (Cloudflare Container, Modal,
 *                      etc.). The orchestrator delegates writes/exec to the
 *                      Coder via `delegate_coder`; direct file mutations
 *                      and shell are NOT in the orchestrator's grant.
 *   - `local-daemon` — a paired pushd daemon on the user's machine, reached
 *                      over loopback (`kind: 'local-pc'`) or Worker relay
 *                      (`kind: 'relay'`). There is no second hop, the
 *                      local-pc tool protocol explicitly forbids
 *                      delegation, and the user reviews diffs themselves.
 *                      The orchestrator wields sandbox tools directly here.
 *
 * Passed as the third argument to `roleCanUseTool` / `enforceRoleCapability`.
 * Defaults to `'cloud'` everywhere so existing callers stay correct without
 * a churn pass.
 *
 * Surfaces resolve the mode at a single seam — web via
 * `getExecutionMode(context)` in `tool-execution-runtime.ts` (which
 * reads `context.executionMode` populated by the round loop from
 * `workspaceContext.mode`); CLI via a local constant in `cli/tools.ts`
 * since pushd is the daemon by definition today.
 *
 * `workspaceModeToExecutionMode` is the canonical mapping from
 * `WorkspaceMode` to `ExecutionMode`. Prompt builder and runtime both
 * funnel through it; the drift-detector tests in
 * `capabilities.test.ts` pin that single source of truth.
 *
 * Why named-mode and not raw binding-presence: the policy input must be a
 * named contract, not "did something happen to set a binding." Future
 * relay/binding shapes for non-local reasons must not silently widen the
 * orchestrator's grant.
 */
export type ExecutionMode = 'cloud' | 'local-daemon';

/**
 * Canonical mapping from a workspace mode (`'repo' | 'scratch' | 'chat'
 * | 'local-pc' | 'relay'`) to the `ExecutionMode` policy input.
 *
 * Kept here, in the capability layer, so the prompt builder and the
 * runtime context cannot drift: both call this and get the same answer
 * for the same input. The string union is intentionally loose so this
 * file does not pull in the web-only `WorkspaceMode` type; the
 * drift-detector test in `capabilities.test.ts` pins the full enum.
 */
export function workspaceModeToExecutionMode(mode: string | null | undefined): ExecutionMode {
  return mode === 'local-pc' || mode === 'relay' ? 'local-daemon' : 'cloud';
}

/**
 * Capabilities orchestrator picks up in `local-daemon` mode. Mirrors the
 * coder grant minus the remote-bound git ops (commit/push/branch/draft)
 * and PR ops, which the local-pc tool protocol already declares
 * unavailable (no remote wired up).
 */
const LOCAL_DAEMON_ORCHESTRATOR_EXTRA: ReadonlySet<Capability> = new Set<Capability>([
  'sandbox:exec',
  'repo:write',
  'sandbox:test',
  'sandbox:download',
]);

// ---------------------------------------------------------------------------
// Role → Capability grants
// ---------------------------------------------------------------------------

/** The set of capabilities each role is granted. */
export const ROLE_CAPABILITIES: Readonly<Record<AgentRole, ReadonlySet<Capability>>> = {
  orchestrator: new Set<Capability>([
    'repo:read',
    'pr:read',
    'workflow:read',
    'delegate:coder',
    'delegate:explorer',
    'scratchpad',
    'todo',
    'web:search',
    'user:ask',
    'artifacts:write',
  ]),

  // Explorer is the read-only investigator. The grant is intentionally
  // wider than just `repo:read` because `EXPLORER_ALLOWED_TOOLS` (built
  // from `{ source: 'github', readOnly: true }` + `{ source: 'sandbox',
  // readOnly: true }`) already exposes PR inspection (`fetch_pr`,
  // `list_prs`, `check_pr_mergeable`, `find_existing_pr`) and CI
  // inspection (`get_workflow_runs`, `get_workflow_logs`) — all of
  // which require `pr:read` / `workflow:read`. Leaving the grant at
  // just `repo:read` used to be safe because the runtime did not
  // enforce capabilities; after the step-6 runtime invariant lands
  // the grant has to match what the registry actually exposes, or
  // PR-focused investigations fail with ROLE_CAPABILITY_DENIED.
  explorer: new Set<Capability>(['repo:read', 'pr:read', 'workflow:read', 'web:search']),

  coder: new Set<Capability>([
    'repo:read',
    'repo:write',
    'sandbox:exec',
    'sandbox:test',
    'sandbox:download',
    'git:commit',
    'git:push',
    'git:draft',
    'git:branch',
    'pr:read',
    'pr:write',
    'workflow:read',
    'workflow:trigger',
    'scratchpad',
    'todo',
    'web:search',
    'user:ask',
    'artifacts:write',
  ]),

  // Reviewer grants include `web:search` because the deep-reviewer
  // protocol (`lib/deep-reviewer-agent.ts`) emits web-search tool calls
  // when it needs current docs / advisories context. The mismatch was
  // flagged in `app/src/lib/agent-loop-utils.ts:60-62` as the reason
  // deep-reviewer didn't opt in to runtime role enforcement; closed
  // here so the kernel-promoted role check below can be turned on for
  // every read-only agent including deep-reviewer.
  reviewer: new Set<Capability>(['repo:read', 'pr:read', 'web:search']),

  auditor: new Set<Capability>(['repo:read']),
};

/**
 * Resolve the effective capability set for a role in a given execution
 * mode. `cloud` returns the static grant from ROLE_CAPABILITIES; in
 * `local-daemon` mode the orchestrator picks up the daemon extras
 * (exec, write, test, download).
 *
 * Other roles are unchanged across modes: coder already has those,
 * explorer stays read-only by intent, reviewer/auditor are diff-only.
 */
export function getEffectiveCapabilities(
  role: AgentRole,
  mode: ExecutionMode = 'cloud',
): ReadonlySet<Capability> {
  const base = ROLE_CAPABILITIES[role];
  if (!base) return new Set<Capability>();
  if (role === 'orchestrator' && mode === 'local-daemon') {
    return new Set<Capability>([...base, ...LOCAL_DAEMON_ORCHESTRATOR_EXTRA]);
  }
  return base;
}

/**
 * Check whether a role grants a specific capability. Optional mode lets
 * callers ask about the effective grant in a particular execution mode;
 * defaults to `cloud` so existing call sites keep their current meaning.
 */
export function roleHasCapability(
  role: AgentRole,
  capability: Capability,
  mode: ExecutionMode = 'cloud',
): boolean {
  return getEffectiveCapabilities(role, mode).has(capability);
}

/**
 * Check whether a role can use a specific tool (by canonical name).
 * Returns true only if the role grants ALL capabilities the tool requires
 * in the given execution mode.
 */
export function roleCanUseTool(
  role: AgentRole,
  canonicalToolName: string,
  mode: ExecutionMode = 'cloud',
): boolean {
  const required = getToolCapabilities(canonicalToolName);
  if (required.length === 0) return true; // Unknown tool — fail-open
  const granted = getEffectiveCapabilities(role, mode);
  if (granted.size === 0) return false;
  return required.every((cap) => granted.has(cap));
}

/**
 * Structured outcome of a kernel-level role capability check. Returned by
 * `enforceRoleCapability` so per-surface bindings can map the three failure
 * shapes onto their own envelope types (Web's `StructuredToolError` with
 * `type`, CLI's `structuredError` with `code`) without re-deriving the
 * required/granted formatting.
 */
export type RoleCapabilityCheck =
  | { ok: true }
  | {
      ok: false;
      type: 'ROLE_REQUIRED' | 'ROLE_INVALID' | 'ROLE_CAPABILITY_DENIED';
      message: string;
      detail: string;
    };

const KNOWN_AGENT_ROLES: ReadonlySet<AgentRole> = new Set<AgentRole>(
  Object.keys(ROLE_CAPABILITIES) as AgentRole[],
);

function isKnownAgentRole(value: unknown): value is AgentRole {
  return typeof value === 'string' && KNOWN_AGENT_ROLES.has(value as AgentRole);
}

/**
 * The kernel-level role enforcement primitive. Three failure modes:
 *
 *   - `ROLE_REQUIRED` — the binding constructed an execution context
 *     without declaring a role at all (undefined / null / empty
 *     string). The runtime refuses execution rather than silently
 *     skipping the capability check, which is the binding-dependent
 *     failure mode the OpenCode silent-failure audit called out
 *     (#3 in the inventory).
 *
 *   - `ROLE_INVALID` — a value WAS supplied but it's not a known
 *     `AgentRole`. Distinguished from `ROLE_REQUIRED` so the diagnostic
 *     surfaced to operators and the model is accurate: the caller
 *     declared something, it just wasn't recognized. Common cause is
 *     a JS caller passing a malformed string the type system couldn't
 *     catch.
 *
 *   - `ROLE_CAPABILITY_DENIED` — role is a valid `AgentRole` but the
 *     role's grant does not include the tool's required capabilities.
 *     Returns the same `required` / `granted` detail the inline web/CLI
 *     denials already format, so per-surface error envelopes stay
 *     consistent.
 *
 * Callers pass the canonical tool name (post-`resolveToolName`). Unmapped
 * tool names follow `roleCanUseTool`'s fail-open semantics for
 * forward-compat — only `ROLE_REQUIRED` / `ROLE_INVALID` are fail-closed
 * because the "binding wired the wrong thing" diagnosis is independent
 * of the specific tool. Surfaces that want stricter behavior (e.g. the
 * CLI daemon Explorer gate) compose `isCapabilityMapped` separately.
 *
 * Accepts `unknown` for `role` so JS callers and untrusted external
 * input can be validated by the helper rather than by every binding —
 * keeps the "single source of truth" invariant.
 */
export function enforceRoleCapability(
  role: unknown,
  canonicalToolName: string,
  mode: ExecutionMode = 'cloud',
): RoleCapabilityCheck {
  if (role === undefined || role === null || role === '') {
    return {
      ok: false,
      type: 'ROLE_REQUIRED',
      message: `Tool "${canonicalToolName}" denied: no role declared on the tool-execution context.`,
      detail:
        'Every tool-execution context must declare a role (orchestrator|coder|explorer|reviewer|auditor). The runtime kernel refuses execution when role is missing so capability enforcement cannot silently skip.',
    };
  }
  if (!isKnownAgentRole(role)) {
    const sample = typeof role === 'string' ? `"${role}"` : Object.prototype.toString.call(role);
    return {
      ok: false,
      type: 'ROLE_INVALID',
      message: `Tool "${canonicalToolName}" denied: declared role ${sample} is not a recognized agent role.`,
      detail: `Recognized roles: ${Array.from(KNOWN_AGENT_ROLES).join(', ')}. A typo or stale enum value in a JS caller usually causes this; TypeScript callers are protected by the AgentRole type.`,
    };
  }
  if (!roleCanUseTool(role, canonicalToolName, mode)) {
    const required = getToolCapabilities(canonicalToolName);
    const granted = Array.from(getEffectiveCapabilities(role, mode));
    return {
      ok: false,
      type: 'ROLE_CAPABILITY_DENIED',
      message: `Role "${role}" is not allowed to use tool "${canonicalToolName}".`,
      detail: `Required: ${required.join(', ') || '(none)'} | Granted: ${granted.join(', ') || '(none)'} | Mode: ${mode}`,
    };
  }
  return { ok: true };
}

/**
 * Format a `RoleCapabilityCheck` denial into the canonical "[Tool
 * Blocked]" text envelope that surfaces to the model. Pulled into the
 * helper so all surfaces (web runtime, CLI kernel, Coder bindings)
 * emit byte-identical denial bodies — the original goal of extracting
 * `enforceRoleCapability` was a single source of truth, and a
 * per-surface format-by-hand step undermined that. Codex/Copilot
 * review on the initial PR caught the drift.
 *
 * Returns the full denial text only; callers stitch the structured
 * error envelope around it.
 */
export function formatRoleCapabilityDenial(
  toolName: string,
  check: Exclude<RoleCapabilityCheck, { ok: true }>,
): string {
  return `[Tool Blocked — ${toolName}] ${check.message}\n\n${check.detail}`;
}

// ---------------------------------------------------------------------------
// Human-readable capability labels (for approval UI)
// ---------------------------------------------------------------------------

/** Short human-readable labels for each capability, suitable for approval prompts. */
export const CAPABILITY_LABELS: Readonly<Record<Capability, string>> = {
  'repo:read': 'read code',
  'repo:write': 'edit files',
  'sandbox:exec': 'execute commands',
  'sandbox:test': 'run tests',
  'sandbox:download': 'download workspace',
  'git:commit': 'create commits',
  'git:push': 'push to remote',
  'git:draft': 'save draft branches',
  'git:branch': 'create branches',
  'pr:read': 'read pull requests',
  'pr:write': 'create/merge pull requests',
  'workflow:read': 'view CI/CD runs',
  'workflow:trigger': 'trigger workflows',
  'delegate:coder': 'delegate to Coder',
  'delegate:explorer': 'delegate to Explorer',
  scratchpad: 'use scratchpad',
  todo: 'track its todo list',
  'web:search': 'search the web',
  'user:ask': 'ask questions',
  'artifacts:write': 'create artifacts',
};

/**
 * Format a set of capabilities as a human-readable summary.
 * Example: "read code, edit 3 files, execute commands, and create commits"
 */
export function formatCapabilities(capabilities: ReadonlySet<Capability>): string {
  const labels = Array.from(capabilities)
    .map((cap) => CAPABILITY_LABELS[cap])
    .filter(Boolean);
  if (labels.length === 0) return 'no special permissions';
  if (labels.length === 1) return labels[0];
  if (labels.length === 2) return `${labels[0]} and ${labels[1]}`;
  return `${labels.slice(0, -1).join(', ')}, and ${labels[labels.length - 1]}`;
}

// ---------------------------------------------------------------------------
// CapabilityLedger — runtime tracking of declared vs used capabilities
// ---------------------------------------------------------------------------

export interface CapabilityLedgerSnapshot {
  /** Capabilities declared at run start (the budget). */
  declared: Capability[];
  /** Capabilities actually exercised during the run. */
  used: Capability[];
  /** Capabilities declared but never used. */
  unused: Capability[];
  /** Capabilities used but not declared (policy violation). */
  exceeded: Capability[];
}

/**
 * Tracks capability usage for a single agent run (delegation).
 * Created at delegation time with the declared set, then updated
 * as tools execute.
 */
export class CapabilityLedger {
  private readonly declared: ReadonlySet<Capability>;
  private readonly used = new Set<Capability>();

  constructor(declaredCapabilities: ReadonlySet<Capability> | Capability[]) {
    this.declared =
      declaredCapabilities instanceof Set ? declaredCapabilities : new Set(declaredCapabilities);
  }

  /** Record that a tool was used, adding its required capabilities to the used set. */
  recordToolUse(canonicalToolName: string): void {
    for (const cap of getToolCapabilities(canonicalToolName)) {
      this.used.add(cap);
    }
  }

  /** Check whether a tool's required capabilities are within the declared set. */
  isToolAllowed(canonicalToolName: string): boolean {
    const required = getToolCapabilities(canonicalToolName);
    if (required.length === 0) return true;
    return required.every((cap) => this.declared.has(cap));
  }

  /** Get capabilities a tool would need that aren't in the declared set. */
  getMissingCapabilities(canonicalToolName: string): Capability[] {
    const required = getToolCapabilities(canonicalToolName);
    return required.filter((cap) => !this.declared.has(cap));
  }

  /** Snapshot for audit logging or post-run review. */
  snapshot(): CapabilityLedgerSnapshot {
    const declared = Array.from(this.declared);
    const used = Array.from(this.used);
    const unused = declared.filter((cap) => !this.used.has(cap));
    const exceeded = used.filter((cap) => !this.declared.has(cap));
    return { declared, used, unused, exceeded };
  }

  /** Human-readable summary of declared capabilities. */
  formatDeclared(): string {
    return formatCapabilities(this.declared);
  }

  /** Human-readable summary of used capabilities. */
  formatUsed(): string {
    return formatCapabilities(this.used);
  }
}
