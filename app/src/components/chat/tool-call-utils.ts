import type { ChatCard, ChatMessage } from '@/types';
import { Terminal, FileText, Search, Globe, Hammer, Wrench } from 'lucide-react';

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
