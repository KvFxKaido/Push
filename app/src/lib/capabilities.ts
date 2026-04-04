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
  | 'repo:read'          // Read files, directories, search code, list branches/commits/checks
  | 'repo:write'         // Edit, write, or delete files in the sandbox workspace
  | 'sandbox:exec'       // Execute arbitrary shell commands in the sandbox
  | 'sandbox:test'       // Run tests or type-checking
  | 'sandbox:download'   // Download or promote workspace artifacts
  | 'git:commit'         // Create commits (prepare + auditor review)
  | 'git:push'           // Push commits to the remote
  | 'git:draft'          // Quick-save uncommitted changes to a draft branch
  | 'pr:read'            // Read PRs, check mergeability, find existing PRs
  | 'pr:write'           // Create or merge PRs, delete branches
  | 'workflow:read'      // List and view workflow runs and logs
  | 'workflow:trigger'   // Trigger a workflow dispatch event
  | 'delegate:coder'     // Delegate work to the Coder agent
  | 'delegate:explorer'  // Delegate investigation to the Explorer agent
  | 'scratchpad'         // Read/write the session scratchpad
  | 'web:search'         // Search the web for current information
  | 'user:ask';          // Ask the user a structured question

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
  'pr:read',
  'pr:write',
  'workflow:read',
  'workflow:trigger',
  'delegate:coder',
  'delegate:explorer',
  'scratchpad',
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
  fetch_pr:          ['pr:read'],
  list_prs:          ['pr:read'],
  list_commits:      ['repo:read'],
  read_file:         ['repo:read'],
  grep_file:         ['repo:read'],
  list_directory:    ['repo:read'],
  list_branches:     ['repo:read'],
  fetch_checks:      ['repo:read'],
  search_files:      ['repo:read'],
  list_commit_files: ['repo:read'],
  check_pr_mergeable: ['pr:read'],
  find_existing_pr:  ['pr:read'],

  // GitHub mutating tools
  trigger_workflow:  ['workflow:trigger'],
  get_workflow_runs: ['workflow:read'],
  get_workflow_logs: ['workflow:read'],
  create_pr:         ['pr:write'],
  merge_pr:          ['pr:write'],
  delete_branch:     ['pr:write'],

  // Sandbox read-only tools
  sandbox_read_file:     ['repo:read'],
  sandbox_search:        ['repo:read'],
  sandbox_find_references: ['repo:read'],
  sandbox_list_dir:      ['repo:read'],
  sandbox_diff:          ['repo:read'],
  sandbox_read_symbols:  ['repo:read'],

  // Sandbox mutating tools
  sandbox_exec:          ['sandbox:exec'],
  sandbox_edit_range:    ['repo:write'],
  sandbox_search_replace: ['repo:write'],
  sandbox_edit_file:     ['repo:write'],
  sandbox_write_file:    ['repo:write'],
  sandbox_apply_patchset: ['repo:write'],
  sandbox_run_tests:     ['sandbox:test'],
  sandbox_check_types:   ['sandbox:test'],
  sandbox_prepare_commit: ['git:commit'],
  sandbox_push:          ['git:push'],
  sandbox_download:      ['sandbox:download'],
  sandbox_save_draft:    ['git:draft'],
  promote_to_github:     ['sandbox:download'],

  // Delegation tools
  delegate_coder:    ['delegate:coder'],
  delegate_explorer: ['delegate:explorer'],
  plan_tasks:        ['delegate:coder', 'delegate:explorer'],

  // Scratchpad tools
  set_scratchpad:    ['scratchpad'],
  append_scratchpad: ['scratchpad'],
  read_scratchpad:   ['scratchpad'],

  // Web search
  web_search:        ['web:search'],

  // Ask user
  ask_user:          ['user:ask'],
};

/**
 * Look up the capabilities required by a canonical tool name.
 * Returns an empty array for unknown tools (fail-open for forward compat).
 */
export function getToolCapabilities(canonicalName: string): readonly Capability[] {
  return TOOL_CAPABILITIES[canonicalName] ?? [];
}

// ---------------------------------------------------------------------------
// Role → Capability grants
// ---------------------------------------------------------------------------

import type { AgentRole } from '@/types';

/** The set of capabilities each role is granted. */
export const ROLE_CAPABILITIES: Readonly<Record<AgentRole, ReadonlySet<Capability>>> = {
  orchestrator: new Set<Capability>([
    'repo:read',
    'pr:read',
    'workflow:read',
    'delegate:coder',
    'delegate:explorer',
    'scratchpad',
    'web:search',
    'user:ask',
  ]),

  explorer: new Set<Capability>([
    'repo:read',
    'web:search',
  ]),

  coder: new Set<Capability>([
    'repo:read',
    'repo:write',
    'sandbox:exec',
    'sandbox:test',
    'sandbox:download',
    'git:commit',
    'git:push',
    'git:draft',
    'pr:read',
    'pr:write',
    'workflow:read',
    'workflow:trigger',
    'scratchpad',
    'web:search',
    'user:ask',
  ]),

  reviewer: new Set<Capability>([
    'repo:read',
    'pr:read',
  ]),

  auditor: new Set<Capability>([
    'repo:read',
  ]),
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
  'repo:read':          'read code',
  'repo:write':         'edit files',
  'sandbox:exec':       'execute commands',
  'sandbox:test':       'run tests',
  'sandbox:download':   'download workspace',
  'git:commit':         'create commits',
  'git:push':           'push to remote',
  'git:draft':          'save draft branches',
  'pr:read':            'read pull requests',
  'pr:write':           'create/merge pull requests',
  'workflow:read':      'view CI/CD runs',
  'workflow:trigger':   'trigger workflows',
  'delegate:coder':     'delegate to Coder',
  'delegate:explorer':  'delegate to Explorer',
  'scratchpad':         'use scratchpad',
  'web:search':         'search the web',
  'user:ask':           'ask questions',
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
    this.declared = declaredCapabilities instanceof Set
      ? declaredCapabilities
      : new Set(declaredCapabilities);
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
