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
  | 'user:ask'; // Ask the user a structured question

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
  ]),

  reviewer: new Set<Capability>(['repo:read', 'pr:read']),

  auditor: new Set<Capability>(['repo:read']),
};

/**
 * Check whether a role grants a specific capability.
 */
export function roleHasCapability(role: AgentRole, capability: Capability): boolean {
  return ROLE_CAPABILITIES[role]?.has(capability) ?? false;
}

/**
 * Check whether a role can use a specific tool (by canonical name).
 * Returns true only if the role grants ALL capabilities the tool requires.
 */
export function roleCanUseTool(role: AgentRole, canonicalToolName: string): boolean {
  const required = getToolCapabilities(canonicalToolName);
  if (required.length === 0) return true; // Unknown tool — fail-open
  const granted = ROLE_CAPABILITIES[role];
  if (!granted) return false;
  return required.every((cap) => granted.has(cap));
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
