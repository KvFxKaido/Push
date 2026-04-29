import type { ChatMessage } from '@/types';
import { ChevronRight, Terminal, FileText, Search, Globe, Hammer, Wrench } from 'lucide-react';

/* ------------------------------------------------------------------ */
/*  ToolCallPair                                                      */
/* ------------------------------------------------------------------ */

export interface ToolCallPair {
  callMsg: ChatMessage;
  resultMsg: ChatMessage;
}

/* ------------------------------------------------------------------ */
/*  Labels (pure — no React runtime except icon type)                  */
/* ------------------------------------------------------------------ */

type ToolLabel = {
  noun: string;
  verb: string;
  icon: React.ElementType;
};

const LABELS: Record<string, ToolLabel> = {
  sandbox_exec: { noun: 'command', verb: 'Ran', icon: Terminal },
  read_file: { noun: 'file', verb: 'Read', icon: FileText },
  write_file: { noun: 'file', verb: 'Wrote', icon: FileText },
  edit_range: { noun: 'file', verb: 'Edited', icon: FileText },
  replace: { noun: 'file', verb: 'Edited', icon: FileText },
  search: { noun: 'search', verb: 'Searched', icon: Search },
  repo_search: { noun: 'search', verb: 'Searched', icon: Search },
  repo_grep: { noun: 'search', verb: 'Searched', icon: Search },
  repo_read: { noun: 'file', verb: 'Read', icon: FileText },
  repo_ls: { noun: 'list', verb: 'Listed', icon: FileText },
  web_search: { noun: 'search', verb: 'Searched', icon: Globe },
  delegate_coder: { noun: 'task', verb: 'Delegated', icon: Hammer },
  delegate_explorer: { noun: 'task', verb: 'Delegated', icon: Hammer },
  default: { noun: 'tool', verb: 'Used', icon: Wrench },
};

export function getLabel(toolName: string): ToolLabel {
  return LABELS[toolName] ?? LABELS.default;
}

/* ------------------------------------------------------------------ */
/*  Summary-line builder                                               */
/* ------------------------------------------------------------------ */

export function buildSummaryLine(items: ToolCallPair[]): string {
  const counts = new Map<string, number>();
  for (const item of items) {
    const name = item.resultMsg.toolMeta?.toolName ?? item.callMsg.toolMeta?.toolName ?? 'unknown';
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }

  const phrases: string[] = [];
  for (const [name, count] of counts) {
    const { noun, verb } = getLabel(name);
    phrases.push(`${verb} ${count} ${noun}${count > 1 ? 's' : ''}`);
  }

  // Single tool → drop count, e.g. "Ran a command"
  if (phrases.length === 1) {
    const raw = phrases[0];
    const match = raw.match(/^(\w+) (\d+) (.+)$/);
    if (!match) return raw;
    const [, verb, cntStr, noun] = match;
    const cnt = Number(cntStr);
    if (Number.isNaN(cnt)) return raw;
    return cnt === 1 ? `${verb} a ${noun}` : phrases[0];
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
