import type { ChatCard, ChatMessage } from '@/types';
import {
  Terminal,
  FileText,
  Search,
  Globe,
  Hammer,
  Wrench,
  GitPullRequest,
  GitCommit,
  GitBranch,
  CircleDot,
  Play,
  ListChecks,
  ShieldAlert,
  MessageCircleQuestion,
  NotebookPen,
  ListTodo,
  Brain,
  Package,
  Upload,
  Download,
} from 'lucide-react';
import { resolveToolName } from '@/lib/tool-registry';

/* ------------------------------------------------------------------ */
/*  ToolCallPair                                                      */
/* ------------------------------------------------------------------ */

export interface ToolCallPair {
  callMsg: ChatMessage;
  resultMsg: ChatMessage;
}

/* ------------------------------------------------------------------ */
/*  Pending-action cards (must stay visible, never collapsed)          */
/* ------------------------------------------------------------------ */

/**
 * A card that's awaiting a user decision and would be lost if it stayed
 * folded inside a collapsed `ToolCallSummary`. These get hoisted out of
 * the group and rendered prominently regardless of the group's collapsed
 * state. Once resolved (answer recorded / commit landed) the card folds
 * back into the group like any other tool output.
 */
export function isPendingActionCard(card: ChatCard): boolean {
  if (card.type === 'ask-user') {
    return !card.data.responseText || card.data.responseText.trim().length === 0;
  }
  if (card.type === 'commit-review') {
    // Visible through the whole commit lifecycle (pending → error → in-flight)
    // until it reaches a terminal state the user no longer needs to act on.
    return card.data.status !== 'committed' && card.data.status !== 'rejected';
  }
  return false;
}

export interface HoistedActionCard {
  card: ChatCard;
  messageId: string;
  /** Original index into `callMsg.cards` — required so card actions
   * (`ask-user-submit`, `commit-approve`) target the right card. */
  cardIndex: number;
}

/**
 * Pull every unresolved action card out of a tool group so the caller can
 * render it above/below the collapsed summary. Indices are the card's
 * position in its message's `cards` array, not a filtered position.
 */
export function collectPendingActionCards(items: ToolCallPair[]): HoistedActionCard[] {
  const hoisted: HoistedActionCard[] = [];
  for (const item of items) {
    const cards = item.callMsg.cards;
    if (!cards) continue;
    cards.forEach((card, cardIndex) => {
      if (isPendingActionCard(card)) {
        hoisted.push({ card, messageId: item.callMsg.id, cardIndex });
      }
    });
  }
  return hoisted;
}

/* ------------------------------------------------------------------ */
/*  Labels (pure — no React runtime except icon type)                  */
/* ------------------------------------------------------------------ */

type ToolLabel = {
  noun: string;
  verb: string;
  icon: React.ElementType;
};

// Keyed by CANONICAL tool name. `toolMeta.toolName` is the *public* name in
// production (getToolName → getToolPublicName: sandbox_exec → exec, etc.), so
// `getLabel` normalizes to canonical before lookup — otherwise public names
// miss and fall to "Used a tool".
const LABELS: Record<string, ToolLabel> = {
  // Read
  read_file: { noun: 'file', verb: 'Read', icon: FileText },
  sandbox_read_file: { noun: 'file', verb: 'Read', icon: FileText },
  // Search
  search_files: { noun: 'search', verb: 'Searched', icon: Search },
  grep_file: { noun: 'search', verb: 'Searched', icon: Search },
  sandbox_search: { noun: 'search', verb: 'Searched', icon: Search },
  sandbox_find_references: { noun: 'search', verb: 'Searched', icon: Search },
  web_search: { noun: 'search', verb: 'Searched', icon: Globe },
  // List
  list_directory: { noun: 'list', verb: 'Listed', icon: FileText },
  sandbox_list_dir: { noun: 'list', verb: 'Listed', icon: FileText },
  // Exec
  sandbox_exec: { noun: 'command', verb: 'Ran', icon: Terminal },
  // Write / edit
  sandbox_write_file: { noun: 'file', verb: 'Wrote', icon: FileText },
  sandbox_edit_file: { noun: 'file', verb: 'Edited', icon: FileText },
  sandbox_edit_range: { noun: 'file', verb: 'Edited', icon: FileText },
  sandbox_search_replace: { noun: 'file', verb: 'Edited', icon: FileText },
  sandbox_apply_patchset: { noun: 'file', verb: 'Edited', icon: FileText },
  // Delegate
  delegate_coder: { noun: 'task', verb: 'Delegated', icon: Hammer },
  delegate_explorer: { noun: 'task', verb: 'Delegated', icon: Hammer },
  plan_tasks: { noun: 'task', verb: 'Planned', icon: Hammer },
  // GitHub — PRs
  fetch_pr: { noun: 'PR', verb: 'Fetched', icon: GitPullRequest },
  list_prs: { noun: 'PR list', verb: 'Fetched', icon: GitPullRequest },
  create_pr: { noun: 'PR', verb: 'Opened', icon: GitPullRequest },
  merge_pr: { noun: 'PR', verb: 'Merged', icon: GitPullRequest },
  update_pull_request: { noun: 'PR', verb: 'Updated', icon: GitPullRequest },
  check_pr_mergeable: { noun: 'PR', verb: 'Checked', icon: GitPullRequest },
  find_existing_pr: { noun: 'PR', verb: 'Checked', icon: GitPullRequest },
  // GitHub — issues
  list_issues: { noun: 'issue list', verb: 'Fetched', icon: CircleDot },
  get_issue: { noun: 'issue', verb: 'Read', icon: CircleDot },
  create_issue: { noun: 'issue', verb: 'Opened', icon: CircleDot },
  update_issue: { noun: 'issue', verb: 'Updated', icon: CircleDot },
  add_issue_comment: { noun: 'comment', verb: 'Posted', icon: CircleDot },
  // GitHub — commits / branches
  list_commits: { noun: 'commit list', verb: 'Fetched', icon: GitCommit },
  list_commit_files: { noun: 'commit', verb: 'Inspected', icon: GitCommit },
  list_branches: { noun: 'branch list', verb: 'Fetched', icon: GitBranch },
  delete_branch: { noun: 'branch', verb: 'Deleted', icon: GitBranch },
  // GitHub — CI / workflows
  fetch_checks: { noun: 'CI report', verb: 'Fetched', icon: ListChecks },
  get_job_logs: { noun: 'CI log', verb: 'Read', icon: ListChecks },
  trigger_workflow: { noun: 'workflow', verb: 'Triggered', icon: Play },
  get_workflow_runs: { noun: 'run list', verb: 'Fetched', icon: Play },
  get_workflow_logs: { noun: 'workflow log', verb: 'Read', icon: Play },
  rerun_failed_jobs: { noun: 'CI run', verb: 'Reran', icon: Play },
  cancel_workflow_run: { noun: 'workflow', verb: 'Cancelled', icon: Play },
  // GitHub — security alerts (three scanners, one display shape)
  list_code_scanning_alerts: { noun: 'alert list', verb: 'Fetched', icon: ShieldAlert },
  list_dependabot_alerts: { noun: 'alert list', verb: 'Fetched', icon: ShieldAlert },
  list_secret_scanning_alerts: { noun: 'alert list', verb: 'Fetched', icon: ShieldAlert },
  // Sandbox — git / delivery
  sandbox_show_commit: { noun: 'commit', verb: 'Inspected', icon: GitCommit },
  sandbox_diff: { noun: 'diff', verb: 'Read', icon: FileText },
  sandbox_create_branch: { noun: 'branch', verb: 'Created', icon: GitBranch },
  sandbox_switch_branch: { noun: 'branch', verb: 'Switched', icon: GitBranch },
  sandbox_commit: { noun: 'change', verb: 'Committed', icon: GitCommit },
  prepare_push: { noun: 'push', verb: 'Prepared', icon: Upload },
  sandbox_push: { noun: 'branch', verb: 'Pushed', icon: Upload },
  promote_to_github: { noun: 'draft', verb: 'Promoted', icon: Upload },
  // Sandbox — verification / misc
  sandbox_run_tests: { noun: 'test suite', verb: 'Ran', icon: ListChecks },
  sandbox_check_types: { noun: 'typecheck', verb: 'Ran', icon: ListChecks },
  sandbox_verify_workspace: { noun: 'workspace', verb: 'Verified', icon: ListChecks },
  sandbox_read_symbols: { noun: 'symbol map', verb: 'Read', icon: Search },
  sandbox_download: { noun: 'file', verb: 'Downloaded', icon: Download },
  sandbox_save_draft: { noun: 'draft', verb: 'Saved', icon: FileText },
  // Scratchpad / todo
  set_scratchpad: { noun: 'scratchpad', verb: 'Updated', icon: NotebookPen },
  append_scratchpad: { noun: 'scratchpad', verb: 'Updated', icon: NotebookPen },
  read_scratchpad: { noun: 'scratchpad', verb: 'Read', icon: NotebookPen },
  todo_write: { noun: 'todo list', verb: 'Updated', icon: ListTodo },
  todo_read: { noun: 'todo list', verb: 'Read', icon: ListTodo },
  todo_clear: { noun: 'todo list', verb: 'Cleared', icon: ListTodo },
  // Interaction / artifacts / memory
  ask_user: { noun: 'question', verb: 'Asked', icon: MessageCircleQuestion },
  create_artifact: { noun: 'artifact', verb: 'Created', icon: Package },
  memory_grep: { noun: 'memory', verb: 'Recalled', icon: Brain },
  memory_expand: { noun: 'memory', verb: 'Recalled', icon: Brain },
  default: { noun: 'tool', verb: 'Used', icon: Wrench },
};

export function getLabel(toolName: string): ToolLabel {
  // Resolve public → canonical (resolveToolName accepts either form). Falls
  // back to the raw name, then the default, for tools not in the table.
  const canonical = resolveToolName(toolName) ?? toolName;
  return LABELS[canonical] ?? LABELS[toolName] ?? LABELS.default;
}

/* ------------------------------------------------------------------ */
/*  Summary-line builder                                               */
/* ------------------------------------------------------------------ */

/** Indefinite-article noun form for the summary line — "an issue list",
 *  "a command". Spelling-based vowel check is enough for the LABELS
 *  vocabulary (no "hour"/"user" style exceptions in the table). */
function withArticle(noun: string): string {
  return `${/^[aeiou]/i.test(noun) ? 'an' : 'a'} ${noun}`;
}

/** Plural noun form for the aggregated summary line. Bare 's'-append mangles
 *  several LABELS nouns (search → "searchs", push → "pushs", branch →
 *  "branchs", memory → "memorys"), so cover the two English rules the
 *  vocabulary actually hits: sibilant endings take "es", consonant+y takes
 *  "ies". Everything else appends "s". */
function pluralNoun(noun: string): string {
  if (/(?:s|sh|ch|x|z)$/i.test(noun)) return `${noun}es`;
  if (/[^aeiou]y$/i.test(noun)) return `${noun.slice(0, -1)}ies`;
  return `${noun}s`;
}

export function buildSummaryLine(items: ToolCallPair[]): string {
  // Single call → prefer the concrete target ("Read config.json", "Ran npm
  // test") over the generic noun ("Read a file") when we captured one. Falls
  // back to the noun form for tools with no useful target. Only applies to a
  // lone call — batches keep the aggregated "Read 3 files" form below.
  if (items.length === 1) {
    const item = items[0];
    const name = item.resultMsg.toolMeta?.toolName ?? item.callMsg.toolMeta?.toolName ?? 'unknown';
    const target = item.callMsg.toolMeta?.target ?? item.resultMsg.toolMeta?.target;
    const { verb, noun } = getLabel(name);
    return target ? `${verb} ${target}` : `${verb} ${withArticle(noun)}`;
  }

  const counts = new Map<string, number>();
  for (const item of items) {
    const name = item.resultMsg.toolMeta?.toolName ?? item.callMsg.toolMeta?.toolName ?? 'unknown';
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }

  const phrases: string[] = [];
  for (const [name, count] of counts) {
    const { noun, verb } = getLabel(name);
    phrases.push(`${verb} ${count} ${count > 1 ? pluralNoun(noun) : noun}`);
  }

  // Single tool → drop count, e.g. "Ran a command"
  if (phrases.length === 1) {
    const raw = phrases[0];
    const match = raw.match(/^(\w+) (\d+) (.+)$/);
    if (!match) return raw;
    const [, verb, cntStr, noun] = match;
    const cnt = Number(cntStr);
    if (Number.isNaN(cnt)) return raw;
    return cnt === 1 ? `${verb} ${withArticle(noun)}` : phrases[0];
  }

  return phrases.join(', ');
}

/* ------------------------------------------------------------------ */
/*  Message grouping                                                   */
/* ------------------------------------------------------------------ */

export function groupChatMessages(
  messages: readonly ChatMessage[],
): ({ type: 'text'; message: ChatMessage } | { type: 'toolGroup'; items: ToolCallPair[] })[] {
  const segments: ReturnType<typeof groupChatMessages> = [];
  let i = 0;
  while (i < messages.length) {
    const msg = messages[i];
    if (msg.role === 'assistant' && msg.isToolCall) {
      const pairs: ToolCallPair[] = [];
      while (i < messages.length) {
        const callMsg = messages[i];
        if (!(callMsg.role === 'assistant' && callMsg.isToolCall)) break;
        const resultMsg = messages[i + 1];
        if (!resultMsg || !(resultMsg.role === 'user' && resultMsg.isToolResult)) break;
        pairs.push({ callMsg, resultMsg });
        i += 2;
      }
      if (pairs.length > 0) {
        segments.push({ type: 'toolGroup', items: pairs });
        continue;
      }
    }
    // Orphan tool results (not immediately after their call) are dropped from surface
    if (msg.role === 'user' && msg.isToolResult) {
      i++;
      continue;
    }
    segments.push({ type: 'text', message: msg });
    i++;
  }
  return segments;
}
