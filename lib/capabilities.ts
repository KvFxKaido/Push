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
  | 'git:draft' // Quick-save uncommitted changes as a WIP commit
  | 'git:branch' // Create a new branch and switch to it
  | 'pr:read' // Read PRs, check mergeability, find existing PRs
  | 'pr:write' // Create or merge PRs, delete branches, edit PR metadata
  | 'issue:read' // Read issues and their comments
  | 'issue:write' // Open/update issues, comment on issues or PRs
  | 'workflow:read' // List and view workflow runs, logs, and job output
  | 'workflow:trigger' // Trigger/re-run/cancel workflow runs
  | 'security:read' // Read code-scanning, Dependabot, and secret-scanning alerts
  | 'delegate:coder' // Delegate work to the Coder agent
  | 'delegate:explorer' // Delegate investigation to the Explorer agent
  | 'scratchpad' // Read/write the session scratchpad
  | 'todo' // Read/write the model's structured todo list
  | 'web:search' // Search the web for current information
  | 'web:fetch' // Fetch a specific public URL and read its content
  | 'user:ask' // Ask the user a structured question
  | 'artifacts:write' // Create renderable artifacts (HTML/React/Mermaid/file-tree)
  | 'memory:read'; // Search/recall persisted typed-memory records (verbatim)

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
  'issue:read',
  'issue:write',
  'workflow:read',
  'workflow:trigger',
  'security:read',
  'delegate:coder',
  'delegate:explorer',
  'scratchpad',
  'todo',
  'web:search',
  'web:fetch',
  'user:ask',
  'artifacts:write',
  'memory:read',
];

// ---------------------------------------------------------------------------
// Provider capability profile — model-wire degradation policy
// ---------------------------------------------------------------------------

export type PushToolCallingMode = 'native' | 'json-text' | 'none';
export type PushStructuredOutputMode = 'strict' | 'best-effort' | 'none';
export type PushContextTier = 'small' | 'medium' | 'large';
export type PushOpenAIWire = 'responses' | 'chat-completions';

/**
 * Provider/model capability profile for the Push Protocol model-wire layer.
 *
 * This is intentionally distinct from the tool/role permission `Capability`
 * vocabulary above: role capabilities decide what an agent may do; this profile
 * decides how the provider adapter should degrade a request for a given
 * provider+model route.
 */
export interface PushCapabilityProfile {
  /** Native tool/function calling when available; otherwise permanent text dispatch. */
  toolCalling: PushToolCallingMode;
  /** True when native tool-call fragments can arrive incrementally while buffered. */
  streamingTools: boolean;
  /** True when the model route can inspect image inputs. */
  multimodal: boolean;
  /** Native/provider-enforced structured-output strength. */
  structuredOutput: PushStructuredOutputMode;
  /** OpenAI-family request/stream dialect for this provider+model route. */
  openaiWire: PushOpenAIWire;
  /** True when the request route consumes `LlmMessage.contentBlocks`. */
  contentBlocks: boolean;
  /** True when signed reasoning blocks can round-trip on this route. */
  reasoningBlocks: boolean;
  /** Coarse context bucket for UI/degradation decisions. */
  context: PushContextTier;
}

export const DEFAULT_PUSH_CAPABILITY_PROFILE: PushCapabilityProfile = {
  toolCalling: 'json-text',
  streamingTools: false,
  multimodal: false,
  structuredOutput: 'none',
  openaiWire: 'chat-completions',
  contentBlocks: false,
  reasoningBlocks: false,
  context: 'medium',
};

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
  get_job_logs: ['workflow:read'],
  list_issues: ['issue:read'],
  get_issue: ['issue:read'],
  list_code_scanning_alerts: ['security:read'],
  list_dependabot_alerts: ['security:read'],
  list_secret_scanning_alerts: ['security:read'],

  // GitHub mutating tools
  trigger_workflow: ['workflow:trigger'],
  get_workflow_runs: ['workflow:read'],
  get_workflow_logs: ['workflow:read'],
  create_pr: ['pr:write'],
  merge_pr: ['pr:write'],
  delete_branch: ['pr:write'],
  update_pull_request: ['pr:write'],
  add_issue_comment: ['issue:write'],
  create_issue: ['issue:write'],
  update_issue: ['issue:write'],
  rerun_failed_jobs: ['workflow:trigger'],
  cancel_workflow_run: ['workflow:trigger'],

  // Sandbox read-only tools
  sandbox_read_file: ['repo:read'],
  sandbox_search: ['repo:read'],
  sandbox_find_references: ['repo:read'],
  sandbox_list_dir: ['repo:read'],
  sandbox_diff: ['repo:read'],
  sandbox_show_commit: ['repo:read'],
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
  sandbox_commit: ['git:commit'],
  prepare_push: ['git:push'],
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

  // Web fetch (CLI-native, `cli/tools.ts`). Distinct capability from
  // `web:search` so a deployment can grant search without arbitrary
  // URL retrieval (or vice versa) — search returns provider-curated
  // snippets, fetch reads any public page the model names.
  //
  // Deliberately NOT in `lib/tool-registry.ts` yet: web advertising is
  // source-filtered off the registry, so a bare entry would either be
  // advertised on web with no executor (source 'web-search') or add a
  // dead source enum ahead of its executor. The registry entry lands
  // with the web-surface slice. Role-grant consumers today are the CLI
  // paths (lead/Explorer/daemon Coder via `executeToolCall`); the web
  // Coder binding (`lib/coder-agent-bindings.ts`) never sees the tool
  // because the web surface doesn't advertise or detect it.
  fetch_url: ['web:fetch'],

  // Memory retrieval (read-only). Available to every role: the model can grep
  // persisted records by substring and expand them to verbatim text.
  memory_grep: ['memory:read'],
  memory_expand: ['memory:read'],

  // Ask user
  ask_user: ['user:ask'],

  // Artifacts. Granted to orchestrator and coder. The CLI Coder path
  // (`makeDaemonCoderToolExec` in cli/pushd/delegation-execution.ts) plumbs `role: 'coder'`
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
  // surfaces — see `cli/pushd/delegation-execution.ts:makeDaemonExplorerToolExec` for the
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
  // CLI-native switch tool — same capability as create. The CLI gate
  // canonicalizes the `switch_branch` / `sandbox_switch_branch` aliases to
  // this name before the lookup (see CLI_TOOL_ALIASES in cli/tools.ts).
  git_switch_branch: ['git:branch'],
  lsp_diagnostics: ['repo:read'],
  save_memory: ['scratchpad'],
  write_file: ['repo:write'],
  edit_file: ['repo:write'],
  undo_edit: ['repo:write'],
  exec: ['sandbox:exec'],
  exec_start: ['sandbox:exec'],
  // exec_poll / exec_wait / exec_list_sessions are read-verbs over exec-family
  // objects. Assigned `sandbox:exec` (not `repo:read`) because Explorer can
  // never poll or wait on a session it could not have started — `exec_start`
  // requires `sandbox:exec` and `makeDaemonExplorerToolExec` passes `allowExec:
  // false` as a second line of defense. Coherent with the family;
  // functionally removes Explorer access to these tools (intentional
  // behavior change — see PR description for rationale).
  exec_poll: ['sandbox:exec'],
  exec_wait: ['sandbox:exec'],
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
// Execution mode — cloud sandbox vs paired daemon
// ---------------------------------------------------------------------------

/**
 * Where the tool call is being executed.
 *
 *   - `cloud`        — cloud sandbox provider (Cloudflare Container, Modal,
 *                      etc.). The orchestrator has a direct-edit lane
 *                      (repo:write + git:commit/push) for small, localized
 *                      changes, but delegates anything needing shell/exec
 *                      to the Coder via `delegate_coder` — `sandbox:exec`
 *                      is NOT in its grant.
 *   - `local-daemon` — a paired pushd daemon reached through Worker relay.
 *                      There is no second hop, the daemon tool protocol
 *                      explicitly forbids delegation, and the user reviews
 *                      diffs themselves. The orchestrator wields sandbox
 *                      tools directly here.
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
 * Optional inputs that refine the effective grant within a mode without being
 * a new mode. Passed alongside `mode` to `getEffectiveCapabilities` /
 * `roleCanUseTool` / `roleHasCapability` / `enforceRoleCapability`.
 *
 * - `remoteGitHubAvailable`: in `local-daemon` mode, signals that a real
 *   GitHub remote is reachable (the CLI resolved a token and talks to
 *   api.github.com directly), so the remote-only strip (`pr:write`,
 *   `workflow:trigger`) should NOT apply. "No remote" is a property of the
 *   sandbox daemon path, not of local-daemon mode itself. Defaults to false,
 *   preserving the historical strip for every caller that doesn't opt in.
 */
export interface CapabilityModeOpts {
  remoteGitHubAvailable?: boolean;
}

/**
 * Canonical mapping from a workspace mode (`'repo' | 'scratch' | 'chat'
 * | 'relay'`) to the `ExecutionMode` policy input.
 *
 * Kept here, in the capability layer, so the prompt builder and the
 * runtime context cannot drift: both call this and get the same answer
 * for the same input. The string union is intentionally loose so this
 * file does not pull in the web-only `WorkspaceMode` type; the
 * drift-detector test in `capabilities.test.ts` pins the full enum.
 */
export function workspaceModeToExecutionMode(mode: string | null | undefined): ExecutionMode {
  return mode === 'relay' ? 'local-daemon' : 'cloud';
}

/**
 * Capabilities the orchestrator picks up *only* in `local-daemon` mode, on
 * top of the shared base grant. `repo:write` is already in the base grant
 * (the cloud direct-edit lane), so it isn't repeated here.
 *
 * Daemon-only additions:
 *   - `git:branch` — the CLI/daemon operates on the user's REAL local working
 *     tree (not an ephemeral sandbox), so creating/switching branches locally
 *     is a no-remote operation the orchestrator can do directly. This is what
 *     makes the inline (non-delegated) CLI session able to use
 *     `git_create_branch` / `git_switch_branch` that `TOOL_PROTOCOL` advertises
 *     (Codex P2 on PR #700). `git:commit` stays in the base grant for the same
 *     reason — only the genuinely remote-bound `git:push` is stripped below.
 *   - `sandbox:download` — kept daemon-only. It also authorizes
 *     `promote_to_github` (create-repo + push), so it stays OUT of the cloud lead
 *     grant where it would skip the approval prompt; the daemon path retains its
 *     pre-existing behavior.
 *
 * Note: `sandbox:exec`/`test` used to live here too, but the Coder Delegation
 * Collapse (2026-06-04) moved them into the base `ROLE_CAPABILITIES.orchestrator`
 * grant below (the lead runs commands directly in cloud now), so they're no
 * longer daemon-only. `git:branch` and `sandbox:download` are NOT redundant —
 * they remain daemon-only (see the orchestrator grant comment for the
 * download/promote_to_github rationale).
 */
const LOCAL_DAEMON_ORCHESTRATOR_EXTRA: ReadonlySet<Capability> = new Set<Capability>([
  'git:branch',
  'sandbox:download',
]);

/**
 * Remote-bound git ops the orchestrator carries in `cloud` mode (its
 * direct-edit lane) but must drop in `local-daemon` mode: a paired session
 * cannot push without a remote, so the daemon tool protocol declares push
 * unavailable. Only `git:push` is remote-bound — `git:commit` and `git:branch`
 * operate on the local working tree and are KEPT (commit via the base grant,
 * branch via `LOCAL_DAEMON_ORCHESTRATOR_EXTRA`). Stripped only for the
 * orchestrator — the coder keeps its full git grant in local-daemon.
 */
const LOCAL_DAEMON_ORCHESTRATOR_REMOTE_GIT: ReadonlySet<Capability> = new Set<Capability>([
  'git:push',
]);

/**
 * Remote-bound capabilities that no role can use in `local-daemon` mode.
 * The paired pushd session has no GitHub remote wired up, so
 * `create_pr` / `merge_pr` / `delete_branch` / `trigger_workflow` would fail
 * at the transport layer even if the model emitted them. Strip them from the
 * local-daemon effective grant so the runtime denial is on the capability
 * check, not on a network error.
 *
 * Applied system-wide (every role) rather than only on `orchestrator` —
 * "no remote" is a property of the execution mode, not a property of the
 * role. Previously this only stripped `orchestrator` because that was the
 * only mode-aware path; now `coder` is also stripped, which matters if a
 * future cloud → local-daemon delegation ever lands. (Follow-up to PR #559
 * review feedback.)
 *
 * The static `ROLE_CAPABILITIES` entries encode the cloud grants (the
 * dominant surface today); `getEffectiveCapabilities` subtracts this set
 * for `local-daemon`.
 */
const LOCAL_DAEMON_REMOTE_ONLY_CAPS: ReadonlySet<Capability> = new Set<Capability>([
  'pr:write',
  'issue:write',
  'workflow:trigger',
]);

// ---------------------------------------------------------------------------
// Role → Capability grants
// ---------------------------------------------------------------------------

/** The set of capabilities each role is granted. */
export const ROLE_CAPABILITIES: Readonly<Record<AgentRole, ReadonlySet<Capability>>> = {
  orchestrator: new Set<Capability>([
    'repo:read',
    // The orchestrator is the single capable lead (Coder Delegation Collapse,
    // 2026-06-04): it edits, runs commands/tests, and ships directly instead of
    // hopping to a separate Coder. `sandbox:exec`/`test` (the exec boundary that
    // used to force delegation) are now the lead's. NOT `sandbox:download` — that
    // capability also authorizes `promote_to_github` (create-repo + push), which
    // must stay an explicit, gated action, so it's left to the local-daemon extra
    // where it pre-existed. `delegate:coder` is RETAINED — the CLI/daemon
    // task-graph + headless paths still use it, and it stays as an explicit
    // detached-work escape hatch — but the collapsed lead's prompt no longer
    // routes through it. In local-daemon mode `git:push` is stripped (no remote).
    // See `getEffectiveCapabilities`.
    'repo:write',
    'sandbox:exec',
    'sandbox:test',
    'git:commit',
    'git:push',
    'pr:read',
    'pr:write',
    'issue:read',
    'issue:write',
    'workflow:read',
    'workflow:trigger',
    'security:read',
    'delegate:coder',
    'delegate:explorer',
    'scratchpad',
    'todo',
    'web:search',
    'web:fetch',
    'user:ask',
    'artifacts:write',
    'memory:read',
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
  explorer: new Set<Capability>([
    'repo:read',
    'pr:read',
    'issue:read',
    'workflow:read',
    'security:read',
    'web:search',
    'web:fetch',
    'memory:read',
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
    'git:branch',
    'pr:read',
    'pr:write',
    'issue:read',
    'issue:write',
    'workflow:read',
    'workflow:trigger',
    'security:read',
    'scratchpad',
    'todo',
    'web:search',
    'web:fetch',
    'user:ask',
    'artifacts:write',
    'memory:read',
    // `delegate:explorer` is part of the lead-capable superset, NOT something
    // a delegated sub-Coder ever reaches: the inline lead threads `'delegate'`
    // into its `extraToolSources` so `delegate_explorer` clears the source
    // gate and this capability check; a delegated Coder leaves that set empty,
    // so the same call is refused at the source gate before capabilities are
    // consulted. `delegate:coder` is deliberately absent — the lead does its
    // own coding and must not spawn a sub-Coder. Mirrors how this grant
    // already carries `pr:write` / `workflow:trigger` / `user:ask` /
    // `artifacts:write` for the lead while delegated Coders never use them.
    'delegate:explorer',
  ]),

  // Reviewer grants include `web:search` because the deep-reviewer
  // protocol (`lib/deep-reviewer-agent.ts`) emits web-search tool calls
  // when it needs current docs / advisories context. The mismatch was
  // flagged in `app/src/lib/agent-loop-utils.ts:60-62` as the reason
  // deep-reviewer didn't opt in to runtime role enforcement; closed
  // here so the kernel-promoted role check below can be turned on for
  // every read-only agent including deep-reviewer.
  reviewer: new Set<Capability>([
    'repo:read',
    'pr:read',
    'issue:read',
    // workflow:read lets the reviewer read CI runs/logs/job output for the PR
    // under review. Required because the reviewer advertises every read-only
    // GitHub tool (`getToolPublicNames({ source: 'github', readOnly: true })`),
    // which includes get_workflow_runs/get_workflow_logs/get_job_logs — without
    // the grant those dead-end on ROLE_CAPABILITY_DENIED (the
    // registry-exposes-it-so-grant-it invariant noted on the explorer block).
    'workflow:read',
    'security:read',
    'web:search',
    'web:fetch',
    'memory:read',
  ]),

  auditor: new Set<Capability>(['repo:read', 'memory:read']),
};

/**
 * Resolve the effective capability set for a role in a given execution
 * mode. `cloud` returns the static grant from ROLE_CAPABILITIES; in
 * `local-daemon` mode:
 *
 *   - Every role drops the remote-only caps (`pr:write`,
 *     `workflow:trigger`) — a paired sandbox session has no GitHub remote, so
 *     these would fail at the transport layer for any role. Enforced at
 *     the capability boundary, not as a runtime network error.
 *
 *     **Exception:** when `opts.remoteGitHubAvailable` is set (the CLI has a
 *     GitHub token and talks to api.github.com directly — see
 *     `cli/github-runtime.ts`), the remote-only strip is skipped. The "no
 *     remote" assumption is a property of the *sandbox* daemon path, not of
 *     `local-daemon` mode per se; a token-bearing CLI genuinely has a remote.
 *     Default (`false`) preserves the historical strip for every existing
 *     caller, so sandbox-backed local-daemon sessions are unaffected.
 *   - The orchestrator additionally picks up the daemon-orchestrator
 *     extras (exec, test, download, branch) so it can wield sandbox tools
 *     and local branch ops directly (no Coder hop on the paired pushd path),
 *     and drops only the remote-bound `git:push` from the cloud direct-edit
 *     lane. `git:commit` + `git:branch` are local working-tree ops the daemon
 *     can do without a remote, so they're kept.
 *
 * Reviewer/auditor have no remote-only caps to drop, so their effective
 * grant matches their static grant in both modes. Coder's grant changes
 * in local-daemon: it loses pr:write + workflow:trigger but keeps
 * everything else — relevant if a cloud → local-daemon Coder delegation
 * ever lands. Explorer is similarly unaffected (no pr:write to drop).
 */
export function getEffectiveCapabilities(
  role: AgentRole,
  mode: ExecutionMode = 'cloud',
  opts: { remoteGitHubAvailable?: boolean } = {},
): ReadonlySet<Capability> {
  const base = ROLE_CAPABILITIES[role];
  if (!base) return new Set<Capability>();
  if (mode !== 'local-daemon') return base;
  const result = new Set<Capability>();
  for (const cap of base) {
    // The remote-only strip is skipped when a real GitHub remote is reachable
    // (token-bearing CLI). Otherwise pr:write / workflow:trigger are dropped.
    if (!opts.remoteGitHubAvailable && LOCAL_DAEMON_REMOTE_ONLY_CAPS.has(cap)) continue;
    result.add(cap);
  }
  if (role === 'orchestrator') {
    for (const cap of LOCAL_DAEMON_ORCHESTRATOR_EXTRA) result.add(cap);
    for (const cap of LOCAL_DAEMON_ORCHESTRATOR_REMOTE_GIT) result.delete(cap);
  }
  return result;
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
  opts: CapabilityModeOpts = {},
): boolean {
  return getEffectiveCapabilities(role, mode, opts).has(capability);
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
  opts: CapabilityModeOpts = {},
): boolean {
  const required = getToolCapabilities(canonicalToolName);
  if (required.length === 0) return true; // Unknown tool — fail-open
  const granted = getEffectiveCapabilities(role, mode, opts);
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
  opts: CapabilityModeOpts = {},
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
  if (!roleCanUseTool(role, canonicalToolName, mode, opts)) {
    const required = getToolCapabilities(canonicalToolName);
    const granted = Array.from(getEffectiveCapabilities(role, mode, opts));
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
  'git:draft': 'save WIP commits',
  'git:branch': 'create branches',
  'pr:read': 'read pull requests',
  'pr:write': 'create/merge pull requests',
  'issue:read': 'read issues',
  'issue:write': 'create/comment on issues',
  'workflow:read': 'view CI/CD runs',
  'workflow:trigger': 'trigger workflows',
  'security:read': 'read security alerts',
  'delegate:coder': 'delegate to Coder',
  'delegate:explorer': 'delegate to Explorer',
  scratchpad: 'use scratchpad',
  todo: 'track its todo list',
  'web:search': 'search the web',
  'web:fetch': 'fetch web pages',
  'user:ask': 'ask questions',
  'artifacts:write': 'create artifacts',
  'memory:read': 'recall prior memory',
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
