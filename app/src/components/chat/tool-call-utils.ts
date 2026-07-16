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
import { getToolVerbNoun, pluralNoun, withArticle } from '@/lib/tool-display';

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

// Icons stay web-local (a React concern); the verb/noun vocabulary lives in
// `lib/tool-display` as the single cross-surface source of truth so the CLI and
// web never drift. Keyed by CANONICAL tool name — `getLabel` normalizes the
// public name (`sandbox_exec` → `exec`, etc.) before lookup.
const TOOL_ICONS: Record<string, React.ElementType> = {
  read_file: FileText,
  sandbox_read_file: FileText,
  search_files: Search,
  grep_file: Search,
  sandbox_search: Search,
  sandbox_find_references: Search,
  web_search: Globe,
  list_directory: FileText,
  sandbox_list_dir: FileText,
  sandbox_exec: Terminal,
  sandbox_write_file: FileText,
  sandbox_edit_file: FileText,
  sandbox_edit_range: FileText,
  sandbox_search_replace: FileText,
  sandbox_apply_patchset: FileText,
  delegate_coder: Hammer,
  delegate_explorer: Hammer,
  plan_tasks: Hammer,
  fetch_pr: GitPullRequest,
  list_prs: GitPullRequest,
  create_pr: GitPullRequest,
  merge_pr: GitPullRequest,
  update_pull_request: GitPullRequest,
  check_pr_mergeable: GitPullRequest,
  find_existing_pr: GitPullRequest,
  list_issues: CircleDot,
  get_issue: CircleDot,
  create_issue: CircleDot,
  update_issue: CircleDot,
  add_issue_comment: CircleDot,
  list_commits: GitCommit,
  list_commit_files: GitCommit,
  list_branches: GitBranch,
  delete_branch: GitBranch,
  fetch_checks: ListChecks,
  get_job_logs: ListChecks,
  trigger_workflow: Play,
  get_workflow_runs: Play,
  get_workflow_logs: Play,
  rerun_failed_jobs: Play,
  cancel_workflow_run: Play,
  list_code_scanning_alerts: ShieldAlert,
  list_dependabot_alerts: ShieldAlert,
  list_secret_scanning_alerts: ShieldAlert,
  sandbox_show_commit: GitCommit,
  sandbox_diff: FileText,
  sandbox_create_branch: GitBranch,
  sandbox_switch_branch: GitBranch,
  sandbox_commit: GitCommit,
  prepare_push: Upload,
  sandbox_push: Upload,
  promote_to_github: Upload,
  sandbox_run_tests: ListChecks,
  sandbox_check_types: ListChecks,
  sandbox_verify_workspace: ListChecks,
  sandbox_read_symbols: Search,
  sandbox_download: Download,
  sandbox_save_draft: FileText,
  set_scratchpad: NotebookPen,
  append_scratchpad: NotebookPen,
  read_scratchpad: NotebookPen,
  todo_write: ListTodo,
  todo_read: ListTodo,
  todo_clear: ListTodo,
  ask_user: MessageCircleQuestion,
  create_artifact: Package,
  memory_grep: Brain,
  memory_expand: Brain,
  default: Wrench,
};

export function getLabel(toolName: string): ToolLabel {
  // verb/noun (which also canonicalizes) come from the shared vocabulary;
  // the icon lookup canonicalizes here and falls back to the default wrench.
  const canonical = resolveToolName(toolName) ?? toolName;
  const { verb, noun } = getToolVerbNoun(toolName);
  const icon = TOOL_ICONS[canonical] ?? TOOL_ICONS[toolName] ?? TOOL_ICONS.default;
  return { verb, noun, icon };
}

/* ------------------------------------------------------------------ */
/*  Summary-line builder                                               */
/* ------------------------------------------------------------------ */

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
