/**
 * tool-display — the single source of truth for user-facing tool *labels*
 * (verb + noun) across surfaces. The web layers its own icon map on top and
 * the CLI/TUI renders the compact title; both read the verb/noun from here so
 * "Read a file" / "Ran a command" never drift between surfaces.
 *
 * Keyed by CANONICAL tool name. Public names (`sandbox_exec` → `exec`, etc.)
 * are normalized through `resolveToolName` before lookup, so either form works.
 * Icons are deliberately absent — they are a React concern and stay web-local.
 */

import { resolveToolName } from './tool-registry.js';

export interface ToolVerbNoun {
  /** Singular noun for the thing acted on ("file", "command", "PR"). */
  noun: string;
  /** Past-tense verb for the action ("Read", "Ran", "Edited"). */
  verb: string;
}

/** Canonical-name → {verb, noun}. `default` covers unknown tools. */
export const TOOL_VERB_NOUN: Record<string, ToolVerbNoun> = {
  // Read
  read_file: { noun: 'file', verb: 'Read' },
  sandbox_read_file: { noun: 'file', verb: 'Read' },
  // Search
  search_files: { noun: 'search', verb: 'Searched' },
  grep_file: { noun: 'search', verb: 'Searched' },
  sandbox_search: { noun: 'search', verb: 'Searched' },
  sandbox_find_references: { noun: 'search', verb: 'Searched' },
  web_search: { noun: 'search', verb: 'Searched' },
  // List
  list_directory: { noun: 'list', verb: 'Listed' },
  sandbox_list_dir: { noun: 'list', verb: 'Listed' },
  // Exec
  sandbox_exec: { noun: 'command', verb: 'Ran' },
  // Write / edit
  sandbox_write_file: { noun: 'file', verb: 'Wrote' },
  sandbox_edit_file: { noun: 'file', verb: 'Edited' },
  sandbox_edit_range: { noun: 'file', verb: 'Edited' },
  sandbox_search_replace: { noun: 'file', verb: 'Edited' },
  sandbox_apply_patchset: { noun: 'file', verb: 'Edited' },
  // Delegate
  delegate_coder: { noun: 'task', verb: 'Delegated' },
  delegate_explorer: { noun: 'task', verb: 'Delegated' },
  plan_tasks: { noun: 'task', verb: 'Planned' },
  // GitHub — PRs
  fetch_pr: { noun: 'PR', verb: 'Fetched' },
  list_prs: { noun: 'PR list', verb: 'Fetched' },
  create_pr: { noun: 'PR', verb: 'Opened' },
  merge_pr: { noun: 'PR', verb: 'Merged' },
  update_pull_request: { noun: 'PR', verb: 'Updated' },
  check_pr_mergeable: { noun: 'PR', verb: 'Checked' },
  find_existing_pr: { noun: 'PR', verb: 'Checked' },
  // GitHub — issues
  list_issues: { noun: 'issue list', verb: 'Fetched' },
  get_issue: { noun: 'issue', verb: 'Read' },
  create_issue: { noun: 'issue', verb: 'Opened' },
  update_issue: { noun: 'issue', verb: 'Updated' },
  add_issue_comment: { noun: 'comment', verb: 'Posted' },
  // GitHub — commits / branches
  list_commits: { noun: 'commit list', verb: 'Fetched' },
  list_commit_files: { noun: 'commit', verb: 'Inspected' },
  list_branches: { noun: 'branch list', verb: 'Fetched' },
  delete_branch: { noun: 'branch', verb: 'Deleted' },
  // GitHub — CI / workflows
  fetch_checks: { noun: 'CI report', verb: 'Fetched' },
  get_job_logs: { noun: 'CI log', verb: 'Read' },
  trigger_workflow: { noun: 'workflow', verb: 'Triggered' },
  get_workflow_runs: { noun: 'run list', verb: 'Fetched' },
  get_workflow_logs: { noun: 'workflow log', verb: 'Read' },
  rerun_failed_jobs: { noun: 'CI run', verb: 'Reran' },
  cancel_workflow_run: { noun: 'workflow', verb: 'Cancelled' },
  // GitHub — security alerts (three scanners, one display shape)
  list_code_scanning_alerts: { noun: 'alert list', verb: 'Fetched' },
  list_dependabot_alerts: { noun: 'alert list', verb: 'Fetched' },
  list_secret_scanning_alerts: { noun: 'alert list', verb: 'Fetched' },
  // Sandbox — git / delivery
  sandbox_show_commit: { noun: 'commit', verb: 'Inspected' },
  sandbox_diff: { noun: 'diff', verb: 'Read' },
  sandbox_create_branch: { noun: 'branch', verb: 'Created' },
  sandbox_switch_branch: { noun: 'branch', verb: 'Switched' },
  sandbox_commit: { noun: 'change', verb: 'Committed' },
  prepare_push: { noun: 'push', verb: 'Prepared' },
  sandbox_push: { noun: 'branch', verb: 'Pushed' },
  promote_to_github: { noun: 'draft', verb: 'Promoted' },
  // Sandbox — verification / misc
  sandbox_run_tests: { noun: 'test suite', verb: 'Ran' },
  sandbox_check_types: { noun: 'typecheck', verb: 'Ran' },
  sandbox_verify_workspace: { noun: 'workspace', verb: 'Verified' },
  sandbox_read_symbols: { noun: 'symbol map', verb: 'Read' },
  sandbox_download: { noun: 'file', verb: 'Downloaded' },
  sandbox_save_draft: { noun: 'draft', verb: 'Saved' },
  // Scratchpad / todo
  set_scratchpad: { noun: 'scratchpad', verb: 'Updated' },
  append_scratchpad: { noun: 'scratchpad', verb: 'Updated' },
  read_scratchpad: { noun: 'scratchpad', verb: 'Read' },
  todo_write: { noun: 'todo list', verb: 'Updated' },
  todo_read: { noun: 'todo list', verb: 'Read' },
  todo_clear: { noun: 'todo list', verb: 'Cleared' },
  // Interaction / artifacts / memory
  ask_user: { noun: 'question', verb: 'Asked' },
  create_artifact: { noun: 'artifact', verb: 'Created' },
  memory_grep: { noun: 'memory', verb: 'Recalled' },
  memory_expand: { noun: 'memory', verb: 'Recalled' },
  default: { noun: 'tool', verb: 'Used' },
};

/**
 * Resolve a tool name (public or canonical) to its {verb, noun}. Falls back to
 * the raw name, then the `default` entry, for tools not in the table.
 */
export function getToolVerbNoun(toolName: string): ToolVerbNoun {
  const canonical = resolveToolName(toolName) ?? toolName;
  return TOOL_VERB_NOUN[canonical] ?? TOOL_VERB_NOUN[toolName] ?? TOOL_VERB_NOUN.default;
}

/** Indefinite-article noun form — "an issue list", "a command". Spelling-based
 *  vowel check is enough for the vocabulary above (no "hour"/"user" cases). */
export function withArticle(noun: string): string {
  return `${/^[aeiou]/i.test(noun) ? 'an' : 'a'} ${noun}`;
}

/** Plural noun form for aggregated summaries. Covers the two English rules the
 *  vocabulary actually hits: sibilant endings take "es", consonant+y takes
 *  "ies"; everything else appends "s" (bare "s" would mangle search/push/branch). */
export function pluralNoun(noun: string): string {
  if (/(?:s|sh|ch|x|z)$/i.test(noun)) return `${noun}es`;
  if (/[^aeiou]y$/i.test(noun)) return `${noun.slice(0, -1)}ies`;
  return `${noun}s`;
}

/**
 * Compact one-line title for a settled tool call — the collapsed-state label.
 * Prefers the concrete `target` the runtime emits (path, command, query) so
 * the row reads "Read README.md" / "Ran a command"; falls back to the article
 * + noun ("Read a file") when no target is available.
 */
export function formatToolTitle(toolName: string, target?: string | null): string {
  const { verb, noun } = getToolVerbNoun(toolName);
  const trimmed = typeof target === 'string' ? target.trim() : '';
  return trimmed ? `${verb} ${trimmed}` : `${verb} ${withArticle(noun)}`;
}
