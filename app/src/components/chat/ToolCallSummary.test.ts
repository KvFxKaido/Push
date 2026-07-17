import { describe, it, expect } from 'vitest';
import type { ChatCard, ChatMessage } from '@/types';
import {
  groupChatMessages,
  buildSummaryLine,
  getLabel,
  isPendingActionCard,
  collectPendingActionCards,
  type ToolCallPair,
} from './tool-call-utils';
import { getAllToolSpecs } from '@/lib/tool-registry';

function textMsg(id: string, content: string): ChatMessage {
  return {
    id,
    role: 'assistant',
    content,
    timestamp: Date.now(),
    status: 'done',
  };
}

function toolCallMsg(id: string): ChatMessage {
  return {
    id,
    role: 'assistant',
    content: '',
    timestamp: Date.now(),
    status: 'done',
    isToolCall: true,
    toolMeta: {
      // Public name (production reality — getToolName → getToolPublicName),
      // not the canonical 'sandbox_exec'. Using the public name here guards
      // the label-resolution path the way production actually exercises it.
      toolName: 'exec',
      source: 'assistant',
      durationMs: 120,
      triggeredBy: 'assistant',
    },
  };
}

function toolResultMsg(id: string, toolName = 'exec'): ChatMessage {
  return {
    id,
    role: 'user',
    content: '[TOOL_RESULT] ok',
    timestamp: Date.now(),
    status: 'done',
    isToolResult: true,
    toolMeta: {
      toolName,
      source: 'assistant',
      durationMs: 120,
      triggeredBy: 'assistant',
    },
  };
}

/* ------------------------------------------------------------------ */
/*  groupChatMessages                                                 */
/* ------------------------------------------------------------------ */

describe('groupChatMessages', () => {
  it('passes plain text messages through unchanged', () => {
    const msgs = [textMsg('a', 'Hello'), textMsg('b', 'World')];
    const out = groupChatMessages(msgs);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ type: 'text', message: msgs[0] });
    expect(out[1]).toMatchObject({ type: 'text', message: msgs[1] });
  });

  it('groups a single tool-call + result pair', () => {
    const msgs = [toolCallMsg('tc1'), toolResultMsg('tr1')];
    const out = groupChatMessages(msgs);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ type: 'toolGroup' });
    const group = out[0] as { type: 'toolGroup'; items: ToolCallPair[] };
    expect(group.items).toHaveLength(1);
    expect(group.items[0].callMsg.id).toBe('tc1');
    expect(group.items[0].resultMsg.id).toBe('tr1');
  });

  it('groups multiple consecutive tool-call pairs', () => {
    const msgs = [
      toolCallMsg('tc1'),
      toolResultMsg('tr1', 'read'),
      toolCallMsg('tc2'),
      toolResultMsg('tr2', 'exec'),
    ];
    const out = groupChatMessages(msgs);
    expect(out).toHaveLength(1);
    const group = out[0] as { type: 'toolGroup'; items: ToolCallPair[] };
    expect(group.items).toHaveLength(2);
  });

  it('separates text before and after tool group', () => {
    const msgs = [
      textMsg('a', 'Before'),
      toolCallMsg('tc1'),
      toolResultMsg('tr1'),
      textMsg('b', 'After'),
    ];
    const out = groupChatMessages(msgs);
    expect(out).toHaveLength(3);
    expect(out[0]).toMatchObject({ type: 'text' });
    expect(out[1]).toMatchObject({ type: 'toolGroup' });
    expect(out[2]).toMatchObject({ type: 'text' });
  });

  it('drops orphan tool results', () => {
    const msgs = [textMsg('a', 'Hi'), toolResultMsg('orphan')];
    const out = groupChatMessages(msgs);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ type: 'text' });
  });
});

/* ------------------------------------------------------------------ */
/*  buildSummaryLine                                                  */
/* ------------------------------------------------------------------ */

describe('buildSummaryLine', () => {
  it('summarises a single command as "Ran a command"', () => {
    const items: ToolCallPair[] = [
      { callMsg: toolCallMsg('1'), resultMsg: toolResultMsg('1', 'exec') },
    ];
    expect(buildSummaryLine(items)).toBe('Ran a command');
  });

  it('uses the captured target for a single call: "Ran npm test"', () => {
    const call = toolCallMsg('1');
    call.toolMeta = { ...call.toolMeta!, target: 'npm test' };
    const items: ToolCallPair[] = [{ callMsg: call, resultMsg: toolResultMsg('1', 'exec') }];
    expect(buildSummaryLine(items)).toBe('Ran npm test');
  });

  it('reads the target off the result message too', () => {
    const result = toolResultMsg('1', 'read');
    result.toolMeta = { ...result.toolMeta!, target: 'config.json' };
    const items: ToolCallPair[] = [{ callMsg: toolCallMsg('1'), resultMsg: result }];
    expect(buildSummaryLine(items)).toBe('Read config.json');
  });

  it('falls back to the noun form when a single call has no target', () => {
    const items: ToolCallPair[] = [
      { callMsg: toolCallMsg('1'), resultMsg: toolResultMsg('1', 'exec') },
    ];
    expect(buildSummaryLine(items)).toBe('Ran a command');
  });

  it('ignores the target for batches (keeps the aggregated count form)', () => {
    const items: ToolCallPair[] = Array.from({ length: 2 }, (_, i) => {
      const call = toolCallMsg(`c${i}`);
      call.toolMeta = { ...call.toolMeta!, toolName: 'read', target: `file${i}.ts` };
      return { callMsg: call, resultMsg: toolResultMsg(`r${i}`, 'read') };
    });
    expect(buildSummaryLine(items)).toBe('Read 2 files');
  });

  it('summarises 3 files as "Read 3 files"', () => {
    const items: ToolCallPair[] = Array.from({ length: 3 }, (_, i) => ({
      callMsg: toolCallMsg(`c${i}`),
      resultMsg: toolResultMsg(`r${i}`, 'read'),
    }));
    expect(buildSummaryLine(items)).toBe('Read 3 files');
  });

  it('summarises mixed tools', () => {
    const items: ToolCallPair[] = [
      { callMsg: toolCallMsg('1'), resultMsg: toolResultMsg('1', 'exec') },
      { callMsg: toolCallMsg('2'), resultMsg: toolResultMsg('2', 'read') },
      { callMsg: toolCallMsg('3'), resultMsg: toolResultMsg('3', 'read') },
    ];
    const line = buildSummaryLine(items);
    // Was 'Ran 1 command'. A bucket holding one call renders through
    // `formatToolTitle` rather than being counted: collapsing exists to compress
    // REPETITION, and a count of one compresses nothing. This fixture sets no
    // target, so the exec falls back to the article form; with a target it reads
    // concretely — see the next case, which is the shape production actually
    // hits (`buildSummaryLine` passes `toolMeta.target`).
    expect(line).toContain('Ran a command');
    expect(line).toContain('Read 2 files');
    expect(line).toContain(',');
  });

  it('names a lone tool in a mixed group instead of counting it', () => {
    // The web reaches the same shared formatter as the TUI (lib/tool-display),
    // and passes real targets — so the summary should say what ran, not that
    // one thing ran.
    const exec = toolCallMsg('1');
    exec.toolMeta = { ...exec.toolMeta!, target: 'pnpm test' };
    const items: ToolCallPair[] = [
      { callMsg: exec, resultMsg: toolResultMsg('1', 'exec') },
      { callMsg: toolCallMsg('2'), resultMsg: toolResultMsg('2', 'read') },
      { callMsg: toolCallMsg('3'), resultMsg: toolResultMsg('3', 'read') },
    ];
    expect(buildSummaryLine(items)).toBe('Ran pnpm test, Read 2 files');
  });
});

describe('getLabel', () => {
  // toolMeta.toolName is the PUBLIC name in production; the table is keyed by
  // canonical. These pin the public → canonical → verb resolution so a real
  // single call reads "Ran npm test", not "Used npm test".
  it('resolves public tool names to the right verb', () => {
    expect(getLabel('exec').verb).toBe('Ran'); // sandbox_exec
    expect(getLabel('read').verb).toBe('Read'); // sandbox_read_file
    expect(getLabel('repo_read').verb).toBe('Read'); // read_file
    expect(getLabel('write').verb).toBe('Wrote'); // sandbox_write_file
    expect(getLabel('edit').verb).toBe('Edited'); // sandbox_edit_file
    expect(getLabel('coder').verb).toBe('Delegated'); // delegate_coder
    expect(getLabel('web').verb).toBe('Searched'); // web_search
  });

  it('still resolves canonical names directly', () => {
    expect(getLabel('sandbox_exec').verb).toBe('Ran');
    expect(getLabel('delegate_explorer').verb).toBe('Delegated');
  });

  it('falls back to "Used" for unknown tools', () => {
    expect(getLabel('totally_unknown_tool').verb).toBe('Used');
  });

  it('labels the GitHub catalog (the screenshot regression: "Used a tool" for issues)', () => {
    expect(getLabel('issues').verb).toBe('Fetched'); // list_issues (public name)
    expect(getLabel('list_issues').noun).toBe('issue list');
    expect(getLabel('pr').verb).toBe('Fetched'); // fetch_pr
    expect(getLabel('commits').verb).toBe('Fetched'); // list_commits
    expect(getLabel('checks').verb).toBe('Fetched'); // fetch_checks
    expect(getLabel('workflow_run').verb).toBe('Triggered'); // trigger_workflow
  });

  // Drift guard: every tool in the shared registry must have a display label.
  // The default "Used a tool" fallback exists for genuinely unknown names
  // (malformed calls, future skew), not for shipped tools — a registry
  // addition without a LABELS entry regresses the collapsed summary to the
  // generic row this test pins against.
  it('covers every registered tool — no shipped tool renders "Used a tool"', () => {
    for (const spec of getAllToolSpecs()) {
      const label = getLabel(spec.canonicalName);
      expect(label.verb, `missing LABELS entry for ${spec.canonicalName}`).not.toBe('Used');
    }
  });
});

describe('withArticle (via buildSummaryLine)', () => {
  it('uses "an" for vowel-initial nouns in the single-call noun form', () => {
    const items: ToolCallPair[] = [
      { callMsg: toolCallMsg('1'), resultMsg: toolResultMsg('1', 'issues') },
    ];
    expect(buildSummaryLine(items)).toBe('Fetched an issue list');
  });
});

describe('pluralNoun (via buildSummaryLine)', () => {
  const batchOf = (toolName: string, n: number): ToolCallPair[] =>
    Array.from({ length: n }, (_, i) => ({
      callMsg: toolCallMsg(`c${i}`),
      resultMsg: toolResultMsg(`r${i}`, toolName),
    }));

  it('pluralizes sibilant endings with "es" (the "searchs"/"pushs" bug)', () => {
    expect(buildSummaryLine(batchOf('search', 2))).toBe('Searched 2 searches');
    expect(buildSummaryLine(batchOf('prepare_push', 2))).toBe('Prepared 2 pushes');
    expect(buildSummaryLine(batchOf('create_branch', 2))).toBe('Created 2 branches');
  });

  it('pluralizes consonant+y endings with "ies" (the "memorys" bug)', () => {
    expect(buildSummaryLine(batchOf('memory_grep', 2))).toBe('Recalled 2 memories');
  });

  it('keeps the plain "s" append for regular nouns', () => {
    expect(buildSummaryLine(batchOf('read', 2))).toBe('Read 2 files');
  });
});

/* ------------------------------------------------------------------ */
/*  Pending-action cards (hoisted out of collapsed groups)             */
/* ------------------------------------------------------------------ */

const askCard = (responseText?: string): ChatCard =>
  ({
    type: 'ask-user',
    data: { question: 'Pick one', options: [{ id: 'a', label: 'A' }], responseText },
  }) as ChatCard;

const commitCard = (status: string): ChatCard =>
  ({
    type: 'commit-review',
    data: {
      diff: { diff: '', filesChanged: 0, additions: 0, deletions: 0, truncated: false },
      auditVerdict: { verdict: 'safe', summary: '', risks: [], filesReviewed: 0 },
      commitMessage: 'feat: thing',
      status,
    },
  }) as ChatCard;

describe('isPendingActionCard', () => {
  it('treats an unanswered ask-user card as pending', () => {
    expect(isPendingActionCard(askCard())).toBe(true);
    expect(isPendingActionCard(askCard('   '))).toBe(true);
  });

  it('treats an answered ask-user card as resolved', () => {
    expect(isPendingActionCard(askCard('Option A'))).toBe(false);
  });

  it('treats commit-review as pending until it reaches a terminal state', () => {
    for (const status of ['pending', 'refreshing', 'approved', 'pushing', 'error']) {
      expect(isPendingActionCard(commitCard(status))).toBe(true);
    }
    expect(isPendingActionCard(commitCard('committed'))).toBe(false);
    expect(isPendingActionCard(commitCard('rejected'))).toBe(false);
  });

  it('ignores non-action cards', () => {
    expect(isPendingActionCard({ type: 'file', data: {} } as ChatCard)).toBe(false);
  });
});

describe('collectPendingActionCards', () => {
  it('hoists pending cards with their original message id + card index', () => {
    const callMsg: ChatMessage = {
      ...toolCallMsg('tc1'),
      // [resolved ask, pending commit] — index 1 must survive the filter.
      cards: [askCard('done'), commitCard('pending')],
    };
    const items: ToolCallPair[] = [{ callMsg, resultMsg: toolResultMsg('tr1') }];

    const hoisted = collectPendingActionCards(items);
    expect(hoisted).toHaveLength(1);
    expect(hoisted[0]).toMatchObject({ messageId: 'tc1', cardIndex: 1 });
    expect(hoisted[0].card.type).toBe('commit-review');
  });

  it('returns nothing when every card is resolved', () => {
    const callMsg: ChatMessage = {
      ...toolCallMsg('tc1'),
      cards: [askCard('answered'), commitCard('committed')],
    };
    expect(collectPendingActionCards([{ callMsg, resultMsg: toolResultMsg('tr1') }])).toHaveLength(
      0,
    );
  });
});
