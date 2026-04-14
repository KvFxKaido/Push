export type ToolRegistrySource =
  | 'github'
  | 'sandbox'
  | 'delegate'
  | 'scratchpad'
  | 'web-search'
  | 'ask-user';

export interface ToolSpec {
  canonicalName: string;
  publicName: string;
  aliases?: readonly string[];
  source: ToolRegistrySource;
  readOnly: boolean;
  statusLabel: string;
  protocolSignature: string;
  protocolDescription: string;
  exampleJson: string;
}

const TOOL_SPECS: readonly ToolSpec[] = [
  {
    canonicalName: 'fetch_pr',
    publicName: 'pr',
    source: 'github',
    readOnly: true,
    statusLabel: 'Fetching from GitHub...',
    protocolSignature: 'pr(repo, pr)',
    protocolDescription:
      'Fetch full PR details with diff, review comments, and top-level conversation comments',
    exampleJson: '{"tool": "pr", "args": {"repo": "owner/repo", "pr": 42}}',
  },
  {
    canonicalName: 'list_prs',
    publicName: 'prs',
    source: 'github',
    readOnly: true,
    statusLabel: 'Fetching from GitHub...',
    protocolSignature: 'prs(repo, state?)',
    protocolDescription: 'List PRs (default state: "open")',
    exampleJson: '{"tool": "prs", "args": {"repo": "owner/repo"}}',
  },
  {
    canonicalName: 'list_commits',
    publicName: 'commits',
    source: 'github',
    readOnly: true,
    statusLabel: 'Fetching from GitHub...',
    protocolSignature: 'commits(repo, count?)',
    protocolDescription: 'List recent commits (default: 10, max: 30)',
    exampleJson: '{"tool": "commits", "args": {"repo": "owner/repo"}}',
  },
  {
    canonicalName: 'read_file',
    publicName: 'repo_read',
    source: 'github',
    readOnly: true,
    statusLabel: 'Fetching from GitHub...',
    protocolSignature: 'repo_read(repo, path, branch?, start_line?, end_line?)',
    protocolDescription: 'Read a single file from GitHub; supports line ranges for large files',
    exampleJson: '{"tool": "repo_read", "args": {"repo": "owner/repo", "path": "src/app.ts"}}',
  },
  {
    canonicalName: 'grep_file',
    publicName: 'repo_grep',
    source: 'github',
    readOnly: true,
    statusLabel: 'Fetching from GitHub...',
    protocolSignature: 'repo_grep(repo, path, pattern, branch?)',
    protocolDescription: 'Search within a single GitHub file with line context',
    exampleJson:
      '{"tool": "repo_grep", "args": {"repo": "owner/repo", "path": "src/app.ts", "pattern": "buildPrompt"}}',
  },
  {
    canonicalName: 'list_directory',
    publicName: 'repo_ls',
    source: 'github',
    readOnly: true,
    statusLabel: 'Fetching from GitHub...',
    protocolSignature: 'repo_ls(repo, path?, branch?)',
    protocolDescription: 'List files and folders in a GitHub directory',
    exampleJson: '{"tool": "repo_ls", "args": {"repo": "owner/repo", "path": "src"}}',
  },
  {
    canonicalName: 'list_branches',
    publicName: 'branches',
    source: 'github',
    readOnly: true,
    statusLabel: 'Fetching from GitHub...',
    protocolSignature: 'branches(repo)',
    protocolDescription: 'List branches with default/protected status',
    exampleJson: '{"tool": "branches", "args": {"repo": "owner/repo"}}',
  },
  {
    canonicalName: 'fetch_checks',
    publicName: 'checks',
    source: 'github',
    readOnly: true,
    statusLabel: 'Fetching from GitHub...',
    protocolSignature: 'checks(repo, ref?)',
    protocolDescription: 'Get CI/CD status for a commit or branch',
    exampleJson: '{"tool": "checks", "args": {"repo": "owner/repo", "ref": "main"}}',
  },
  {
    canonicalName: 'search_files',
    publicName: 'repo_search',
    source: 'github',
    readOnly: true,
    statusLabel: 'Fetching from GitHub...',
    protocolSignature: 'repo_search(repo, query, path?, branch?)',
    protocolDescription: 'Search code/text across the GitHub repo',
    exampleJson: '{"tool": "repo_search", "args": {"repo": "owner/repo", "query": "buildPrompt"}}',
  },
  {
    canonicalName: 'list_commit_files',
    publicName: 'commit_files',
    source: 'github',
    readOnly: true,
    statusLabel: 'Fetching from GitHub...',
    protocolSignature: 'commit_files(repo, ref)',
    protocolDescription: 'List files changed in a commit without the full diff',
    exampleJson: '{"tool": "commit_files", "args": {"repo": "owner/repo", "ref": "HEAD"}}',
  },
  {
    canonicalName: 'trigger_workflow',
    publicName: 'workflow_run',
    source: 'github',
    readOnly: false,
    statusLabel: 'Fetching from GitHub...',
    protocolSignature: 'workflow_run(repo, workflow, ref?, inputs?)',
    protocolDescription: 'Trigger a workflow_dispatch event',
    exampleJson:
      '{"tool": "workflow_run", "args": {"repo": "owner/repo", "workflow": "deploy.yml"}}',
  },
  {
    canonicalName: 'get_workflow_runs',
    publicName: 'workflow_runs',
    source: 'github',
    readOnly: true,
    statusLabel: 'Fetching from GitHub...',
    protocolSignature: 'workflow_runs(repo, workflow?, branch?, status?, count?)',
    protocolDescription: 'List recent GitHub Actions runs',
    exampleJson: '{"tool": "workflow_runs", "args": {"repo": "owner/repo"}}',
  },
  {
    canonicalName: 'get_workflow_logs',
    publicName: 'workflow_logs',
    source: 'github',
    readOnly: true,
    statusLabel: 'Fetching from GitHub...',
    protocolSignature: 'workflow_logs(repo, run_id)',
    protocolDescription: 'Get job-level and step-level details for a workflow run',
    exampleJson: '{"tool": "workflow_logs", "args": {"repo": "owner/repo", "run_id": 123456789}}',
  },
  {
    canonicalName: 'create_pr',
    publicName: 'pr_create',
    source: 'github',
    readOnly: false,
    statusLabel: 'Fetching from GitHub...',
    protocolSignature: 'pr_create(repo, title, body, head, base)',
    protocolDescription: 'Create a pull request',
    exampleJson:
      '{"tool": "pr_create", "args": {"repo": "owner/repo", "title": "Add feature", "body": "Summary", "head": "feature-branch", "base": "main"}}',
  },
  {
    canonicalName: 'merge_pr',
    publicName: 'pr_merge',
    source: 'github',
    readOnly: false,
    statusLabel: 'Fetching from GitHub...',
    protocolSignature: 'pr_merge(repo, pr_number, merge_method?)',
    protocolDescription: 'Merge a pull request',
    exampleJson: '{"tool": "pr_merge", "args": {"repo": "owner/repo", "pr_number": 42}}',
  },
  {
    canonicalName: 'delete_branch',
    publicName: 'branch_delete',
    source: 'github',
    readOnly: false,
    statusLabel: 'Fetching from GitHub...',
    protocolSignature: 'branch_delete(repo, branch_name)',
    protocolDescription: 'Delete a branch',
    exampleJson:
      '{"tool": "branch_delete", "args": {"repo": "owner/repo", "branch_name": "feature-branch"}}',
  },
  {
    canonicalName: 'check_pr_mergeable',
    publicName: 'pr_check',
    source: 'github',
    readOnly: true,
    statusLabel: 'Fetching from GitHub...',
    protocolSignature: 'pr_check(repo, pr_number)',
    protocolDescription: 'Check whether a PR can be merged',
    exampleJson: '{"tool": "pr_check", "args": {"repo": "owner/repo", "pr_number": 42}}',
  },
  {
    canonicalName: 'find_existing_pr',
    publicName: 'pr_find',
    source: 'github',
    readOnly: true,
    statusLabel: 'Fetching from GitHub...',
    protocolSignature: 'pr_find(repo, head_branch, base_branch?)',
    protocolDescription: 'Find an open PR for a branch',
    exampleJson:
      '{"tool": "pr_find", "args": {"repo": "owner/repo", "head_branch": "feature-branch"}}',
  },
  {
    canonicalName: 'delegate_coder',
    publicName: 'coder',
    source: 'delegate',
    readOnly: false,
    statusLabel: 'Delegating to Coder...',
    protocolSignature:
      'coder(task?, tasks?, files?, acceptanceCriteria?, declaredCapabilities?, intent?, deliverable?, knownContext?, constraints?)',
    protocolDescription: 'Delegate coding work to the Coder agent',
    exampleJson:
      '{"tool": "coder", "args": {"task": "Implement the requested change", "files": ["src/app.ts"], "declaredCapabilities": ["repo:read", "repo:write", "sandbox:test"], "deliverable": "Ship the fix with passing tests", "knownContext": ["Explorer found the bug in src/app.ts:84"]}}',
  },
  {
    canonicalName: 'delegate_explorer',
    publicName: 'explorer',
    source: 'delegate',
    readOnly: false,
    statusLabel: 'Delegating to Explorer...',
    protocolSignature: 'explorer(task, files?, intent?, deliverable?, knownContext?, constraints?)',
    protocolDescription: 'Delegate read-only investigation to the Explorer agent',
    exampleJson:
      '{"tool": "explorer", "args": {"task": "Trace the auth flow", "files": ["src/auth.ts"], "deliverable": "Return the refresh trigger with file and line references"}}',
  },
  {
    canonicalName: 'plan_tasks',
    publicName: 'plan_tasks',
    source: 'delegate',
    readOnly: false,
    statusLabel: 'Executing task graph...',
    protocolSignature: 'plan_tasks(tasks)',
    protocolDescription:
      'Execute a dependency-aware task graph with parallel Explorer and sequential Coder dispatch',
    exampleJson:
      '{"tool": "plan_tasks", "args": {"tasks": [{"id": "explore-auth", "agent": "explorer", "task": "Trace auth flow", "files": ["src/auth.ts"], "dependsOn": []}, {"id": "fix-auth", "agent": "coder", "task": "Fix the auth bug", "dependsOn": ["explore-auth"], "deliverable": "Auth tests pass"}]}}',
  },
  {
    canonicalName: 'sandbox_exec',
    publicName: 'exec',
    source: 'sandbox',
    readOnly: false,
    statusLabel: 'Executing in sandbox...',
    protocolSignature: 'exec(command, workdir?)',
    protocolDescription: 'Run a shell command in the sandbox',
    exampleJson: '{"tool": "exec", "args": {"command": "npm test"}}',
  },
  {
    canonicalName: 'sandbox_read_file',
    publicName: 'read',
    aliases: ['read_sandbox_file'],
    source: 'sandbox',
    readOnly: true,
    statusLabel: 'Reading file...',
    protocolSignature: 'read(path, start_line?, end_line?)',
    protocolDescription: 'Read a sandbox file; supports line ranges for large files',
    exampleJson: '{"tool": "read", "args": {"path": "/workspace/src/app.ts"}}',
  },
  {
    canonicalName: 'sandbox_search',
    publicName: 'search',
    aliases: ['search_sandbox'],
    source: 'sandbox',
    readOnly: true,
    statusLabel: 'Sandbox operation...',
    protocolSignature: 'search(query, path?)',
    protocolDescription: 'Search file contents in the sandbox with rg/grep',
    exampleJson: '{"tool": "search", "args": {"query": "buildPrompt"}}',
  },
  {
    canonicalName: 'sandbox_find_references',
    publicName: 'refs',
    source: 'sandbox',
    readOnly: true,
    statusLabel: 'Sandbox operation...',
    protocolSignature: 'refs(symbol, scope?)',
    protocolDescription: 'Find references to a symbol name',
    exampleJson: '{"tool": "refs", "args": {"symbol": "buildPrompt"}}',
  },
  {
    canonicalName: 'sandbox_edit_range',
    publicName: 'edit_range',
    source: 'sandbox',
    readOnly: false,
    statusLabel: 'Sandbox operation...',
    protocolSignature: 'edit_range(path, start_line, end_line, content, expected_version?)',
    protocolDescription: 'Replace a contiguous line range',
    exampleJson:
      '{"tool": "edit_range", "args": {"path": "/workspace/src/app.ts", "start_line": 10, "end_line": 12, "content": "replacement"}}',
  },
  {
    canonicalName: 'sandbox_search_replace',
    publicName: 'replace',
    source: 'sandbox',
    readOnly: false,
    statusLabel: 'Sandbox operation...',
    protocolSignature: 'replace(path, search, replace, expected_version?)',
    protocolDescription: 'Replace a unique substring match in one file',
    exampleJson:
      '{"tool": "replace", "args": {"path": "/workspace/src/app.ts", "search": "oldValue", "replace": "newValue"}}',
  },
  {
    canonicalName: 'sandbox_edit_file',
    publicName: 'edit',
    source: 'sandbox',
    readOnly: false,
    statusLabel: 'Sandbox operation...',
    protocolSignature: 'edit(path, edits, expected_version?)',
    protocolDescription: 'Edit a file using hashline refs',
    exampleJson:
      '{"tool": "edit", "args": {"path": "/workspace/src/app.ts", "edits": [{"op": "replace_line", "ref": "abc1234", "content": "replacement"}]}}',
  },
  {
    canonicalName: 'sandbox_write_file',
    publicName: 'write',
    source: 'sandbox',
    readOnly: false,
    statusLabel: 'Writing file...',
    protocolSignature: 'write(path, content, expected_version?)',
    protocolDescription: 'Write or overwrite a file in the sandbox',
    exampleJson:
      '{"tool": "write", "args": {"path": "/workspace/src/app.ts", "content": "file content"}}',
  },
  {
    canonicalName: 'sandbox_list_dir',
    publicName: 'ls',
    aliases: ['list_sandbox_dir'],
    source: 'sandbox',
    readOnly: true,
    statusLabel: 'Listing directory...',
    protocolSignature: 'ls(path?)',
    protocolDescription: 'List files and folders in a sandbox directory',
    exampleJson: '{"tool": "ls", "args": {"path": "/workspace"}}',
  },
  {
    canonicalName: 'sandbox_diff',
    publicName: 'diff',
    source: 'sandbox',
    readOnly: true,
    statusLabel: 'Getting diff...',
    protocolSignature: 'diff()',
    protocolDescription: 'Get the git diff of all uncommitted changes',
    exampleJson: '{"tool": "diff", "args": {}}',
  },
  {
    canonicalName: 'sandbox_prepare_commit',
    publicName: 'commit',
    aliases: ['sandbox_commit'],
    source: 'sandbox',
    readOnly: false,
    statusLabel: 'Reviewing commit...',
    protocolSignature: 'commit(message)',
    protocolDescription: 'Prepare a commit for review and auditor approval',
    exampleJson: '{"tool": "commit", "args": {"message": "fix: update validation flow"}}',
  },
  {
    canonicalName: 'sandbox_push',
    publicName: 'push',
    source: 'sandbox',
    readOnly: false,
    statusLabel: 'Pushing to remote...',
    protocolSignature: 'push()',
    protocolDescription: 'Retry a failed push after approval',
    exampleJson: '{"tool": "push", "args": {}}',
  },
  {
    canonicalName: 'sandbox_run_tests',
    publicName: 'test',
    source: 'sandbox',
    readOnly: false,
    statusLabel: 'Sandbox operation...',
    protocolSignature: 'test(framework?)',
    protocolDescription: 'Run the test suite',
    exampleJson: '{"tool": "test", "args": {"framework": "vitest"}}',
  },
  {
    canonicalName: 'sandbox_check_types',
    publicName: 'typecheck',
    source: 'sandbox',
    readOnly: false,
    statusLabel: 'Sandbox operation...',
    protocolSignature: 'typecheck()',
    protocolDescription: 'Run the project type checker',
    exampleJson: '{"tool": "typecheck", "args": {}}',
  },
  {
    canonicalName: 'sandbox_verify_workspace',
    publicName: 'verify',
    source: 'sandbox',
    readOnly: false,
    statusLabel: 'Sandbox operation...',
    protocolSignature: 'verify()',
    protocolDescription:
      'Install dependencies if needed, then run available typecheck/test commands',
    exampleJson: '{"tool": "verify", "args": {}}',
  },
  {
    canonicalName: 'sandbox_download',
    publicName: 'download',
    source: 'sandbox',
    readOnly: false,
    statusLabel: 'Sandbox operation...',
    protocolSignature: 'download(path?)',
    protocolDescription: 'Download workspace files as a tar.gz archive',
    exampleJson: '{"tool": "download", "args": {"path": "/workspace"}}',
  },
  {
    canonicalName: 'sandbox_save_draft',
    publicName: 'draft',
    source: 'sandbox',
    readOnly: false,
    statusLabel: 'Sandbox operation...',
    protocolSignature: 'draft(message?, branch_name?)',
    protocolDescription: 'Quick-save all uncommitted changes to a draft branch',
    exampleJson: '{"tool": "draft", "args": {"message": "WIP: checkpoint"}}',
  },
  {
    canonicalName: 'promote_to_github',
    publicName: 'promote',
    source: 'sandbox',
    readOnly: false,
    statusLabel: 'Promoting sandbox to GitHub...',
    protocolSignature: 'promote(repo_name, description?, private?)',
    protocolDescription: 'Create a GitHub repo and push the current sandbox branch',
    exampleJson: '{"tool": "promote", "args": {"repo_name": "new-repo"}}',
  },
  {
    canonicalName: 'sandbox_read_symbols',
    publicName: 'symbols',
    source: 'sandbox',
    readOnly: true,
    statusLabel: 'Sandbox operation...',
    protocolSignature: 'symbols(path)',
    protocolDescription: 'Extract a symbol index from a source file',
    exampleJson: '{"tool": "symbols", "args": {"path": "/workspace/src/app.ts"}}',
  },
  {
    canonicalName: 'sandbox_apply_patchset',
    publicName: 'patch',
    source: 'sandbox',
    readOnly: false,
    statusLabel: 'Sandbox operation...',
    protocolSignature: 'patch(edits, dryRun?, diagnostics?, checks?, rollbackOnFailure?)',
    protocolDescription: 'Apply a multi-file hashline or line-range patchset transactionally',
    exampleJson:
      '{"tool": "patch", "args": {"edits": [{"path": "/workspace/src/app.ts", "start_line": 10, "end_line": 12, "content": "replacement"}]}}',
  },
  {
    canonicalName: 'set_scratchpad',
    publicName: 'scratch_set',
    source: 'scratchpad',
    readOnly: false,
    statusLabel: 'Updating scratchpad...',
    protocolSignature: 'scratch_set(content)',
    protocolDescription: 'Replace the entire scratchpad content',
    exampleJson: '{"tool": "scratch_set", "content": "## Notes\\n- Item one"}',
  },
  {
    canonicalName: 'append_scratchpad',
    publicName: 'scratch_add',
    source: 'scratchpad',
    readOnly: false,
    statusLabel: 'Updating scratchpad...',
    protocolSignature: 'scratch_add(content)',
    protocolDescription: 'Append content to the scratchpad',
    exampleJson: '{"tool": "scratch_add", "content": "## More notes\\n- Item two"}',
  },
  {
    canonicalName: 'read_scratchpad',
    publicName: 'scratch_read',
    source: 'scratchpad',
    readOnly: true,
    statusLabel: 'Updating scratchpad...',
    protocolSignature: 'scratch_read()',
    protocolDescription: 'Read the current scratchpad content',
    exampleJson: '{"tool": "scratch_read"}',
  },
  {
    canonicalName: 'web_search',
    publicName: 'web',
    source: 'web-search',
    readOnly: true,
    statusLabel: 'Searching the web...',
    protocolSignature: 'web(query)',
    protocolDescription: 'Search the web for current information',
    exampleJson: '{"tool": "web", "args": {"query": "React 19 release notes"}}',
  },
  {
    canonicalName: 'ask_user',
    publicName: 'ask',
    source: 'ask-user',
    readOnly: false,
    statusLabel: 'Processing...',
    protocolSignature: 'ask(question, options, multiSelect?)',
    protocolDescription: 'Ask the user a structured question with options',
    exampleJson:
      '{"tool": "ask", "args": {"question": "Which option?", "options": [{"id": "a", "label": "Option A"}]}}',
  },
] as const;

const TOOL_SPEC_BY_CANONICAL_NAME = new Map<string, ToolSpec>();
const TOOL_SPEC_BY_RECOGNIZED_NAME = new Map<string, ToolSpec>();

for (const spec of TOOL_SPECS) {
  TOOL_SPEC_BY_CANONICAL_NAME.set(spec.canonicalName, spec);
  TOOL_SPEC_BY_RECOGNIZED_NAME.set(spec.canonicalName, spec);
  TOOL_SPEC_BY_RECOGNIZED_NAME.set(spec.publicName, spec);
  for (const alias of spec.aliases ?? []) {
    TOOL_SPEC_BY_RECOGNIZED_NAME.set(alias, spec);
  }
}

export const KNOWN_PUBLIC_TOOL_NAMES = TOOL_SPECS.map((spec) => spec.publicName);
export const KNOWN_TOOL_INPUT_NAMES = Array.from(TOOL_SPEC_BY_RECOGNIZED_NAME.keys());

export function getAllToolSpecs(): readonly ToolSpec[] {
  return TOOL_SPECS;
}

export function getToolSpec(name: string | null | undefined): ToolSpec | null {
  if (!name) return null;
  return TOOL_SPEC_BY_RECOGNIZED_NAME.get(name.trim()) ?? null;
}

export function getToolSpecByCanonicalName(name: string | null | undefined): ToolSpec | null {
  if (!name) return null;
  return TOOL_SPEC_BY_CANONICAL_NAME.get(name.trim()) ?? null;
}

export function resolveToolName(name: string | null | undefined): string | null {
  return getToolSpec(name)?.canonicalName ?? null;
}

export function getToolPublicName(name: string | null | undefined): string {
  return getToolSpec(name)?.publicName ?? (name?.trim() || '');
}

export function getToolSourceFromName(name: string | null | undefined): ToolRegistrySource | null {
  return getToolSpec(name)?.source ?? null;
}

export function isReadOnlyToolName(name: string | null | undefined): boolean {
  return Boolean(getToolSpec(name)?.readOnly);
}

/**
 * Sandbox tools that mutate files in-place but carry no side effects outside
 * the workspace. These are safe to batch within a single turn: the dispatcher
 * runs them sequentially as one mutation transaction before any trailing
 * side-effecting call (exec, commit, push, delegate, etc.).
 *
 * Kept deliberately narrow — only pure file writes/edits belong here. Tools
 * that run commands, touch git state, or cross the sandbox boundary stay in
 * the "trailing side-effect" slot so the one-side-effect-per-turn rule still
 * holds. Scratchpad writes are handled separately (they don't touch files).
 */
const FILE_MUTATION_CANONICAL_NAMES: ReadonlySet<string> = new Set([
  'sandbox_write_file',
  'sandbox_edit_file',
  'sandbox_edit_range',
  'sandbox_search_replace',
  'sandbox_apply_patchset',
]);

export function isFileMutationToolName(name: string | null | undefined): boolean {
  const canonical = resolveToolName(name);
  if (!canonical) return false;
  return FILE_MUTATION_CANONICAL_NAMES.has(canonical);
}

export function getToolStatusLabelFromName(name: string | null | undefined): string | null {
  return getToolSpec(name)?.statusLabel ?? null;
}

export function getToolArgHint(name: string | null | undefined): string | null {
  return getToolSpec(name)?.exampleJson ?? null;
}

export function getToolProtocolEntries(source: ToolRegistrySource): readonly ToolSpec[] {
  return TOOL_SPECS.filter((spec) => spec.source === source);
}

export function getToolCanonicalNames(options?: {
  source?: ToolRegistrySource;
  readOnly?: boolean;
}): string[] {
  return TOOL_SPECS.filter((spec) => (options?.source ? spec.source === options.source : true))
    .filter((spec) => (options?.readOnly !== undefined ? spec.readOnly === options.readOnly : true))
    .map((spec) => spec.canonicalName);
}

export function getToolPublicNames(options?: {
  source?: ToolRegistrySource;
  readOnly?: boolean;
}): string[] {
  return TOOL_SPECS.filter((spec) => (options?.source ? spec.source === options.source : true))
    .filter((spec) => (options?.readOnly !== undefined ? spec.readOnly === options.readOnly : true))
    .map((spec) => spec.publicName);
}

export function getRecognizedToolNames(options?: { source?: ToolRegistrySource }): string[] {
  if (!options?.source) return [...KNOWN_TOOL_INPUT_NAMES];
  return TOOL_SPECS.filter((spec) => spec.source === options.source).flatMap((spec) => [
    spec.canonicalName,
    spec.publicName,
    ...(spec.aliases ?? []),
  ]);
}

export function escapeToolNameForRegex(name: string): string {
  return name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Get the capabilities required by a tool (by canonical name).
 * Bridge to capabilities.ts for convenience. Does NOT resolve aliases
 * or public names — callers must pass the canonical tool name.
 */
export { getToolCapabilities as getToolRequiredCapabilities } from './capabilities.js';
