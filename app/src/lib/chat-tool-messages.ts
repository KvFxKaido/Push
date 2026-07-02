import type { AIProviderType, ChatCard, ChatMessage, ToolMeta } from '@/types';
import type { LlmToolResultBlock, LlmToolUseBlock } from '@push/lib/provider-contract';
import { estimateContextTokens, getContextBudget, type ActiveProvider } from './orchestrator';
import { stripToolCallPayload } from './message-content';
import { fileLedger } from './file-awareness-ledger';
import { getSandboxEnvironment } from './sandbox-client';
import type { AnyToolCall } from './tool-dispatch';
import { formatToolResultEnvelope } from './tool-call-recovery';
import { getToolStatusLabelFromName, getToolPublicName } from './tool-registry';
import { getToolTargetDetail } from '@push/lib/tool-target-detail';

export interface ToolResultMetaSnapshot {
  dirty: boolean;
  files: number;
  branch?: string;
  head?: string;
  changedFiles?: string[];
  /** Local commits not yet on the upstream tracking ref. */
  ahead?: number;
  /** Whether the branch has an upstream — `ahead` is only emitted when true. */
  hasUpstream?: boolean;
}

export interface BuildToolResultMetaLineOptions {
  includePulse?: boolean;
  pulseReason?: 'mutation' | 'periodic';
}

export interface BuildToolMetaOptions {
  toolName: string;
  target?: string;
  source: string;
  provider?: AIProviderType;
  durationMs: number;
  isError?: boolean;
  triggeredBy?: 'assistant' | 'system';
}

export interface BuildToolResultMessageOptions {
  id: string;
  timestamp: number;
  text: string;
  toolMeta: ToolMeta;
  metaLine?: string;
  /** Branch to stamp on the resulting message. For delegate results this is
   *  the dispatch-time `originBranch` from the delegation envelope, NOT the
   *  current foreground branch — the delegate did its work against the
   *  launch branch. For non-delegate tools the caller passes the foreground
   *  branch at completion time. */
  branch?: string;
  toolResults?: LlmToolResultBlock[];
}

export interface MarkAssistantToolCallOptions {
  content: string;
  thinking?: string;
  malformed?: boolean;
  toolMeta?: ToolMeta;
  toolUses?: LlmToolUseBlock[];
}

export function getToolStatusLabel(toolCall: AnyToolCall): string {
  return getToolStatusLabelFromName(toolCall.call.tool) ?? 'Processing...';
}

export function getToolName(toolCall: AnyToolCall): string {
  return getToolPublicName(toolCall.call.tool) || 'unknown';
}

/** Tool-specific detail string for the AgentStatusBar — turns a generic
 *  "Executing in sandbox..." into "Executing in sandbox... `npm install`".
 *  Returns undefined when there's nothing useful to show; the banner
 *  hides the detail span in that case.
 *
 *  Detail is bounded to keep the status line scannable on mobile —
 *  60 chars for paths/commands, 50 for prose. Truncation appends an
 *  ellipsis so the user sees that the value was cut. */
export function getToolStatusDetail(toolCall: AnyToolCall): string | undefined {
  const tool = toolCall.call.tool;
  // Type-guard via `'args' in` instead of a cast — `AnyToolCall` is a
  // discriminated union and some future variants may legitimately lack
  // `args`. The guard narrows to members that have it, and the
  // `typeof === 'object'` check defends against malformed runtime input.
  const args =
    'args' in toolCall.call && toolCall.call.args && typeof toolCall.call.args === 'object'
      ? (toolCall.call.args as Record<string, unknown>)
      : {};

  return getToolTargetDetail(tool, args);
}

export function buildToolResultMetaLine(
  round: number,
  apiMessages: readonly Pick<ChatMessage, 'content'>[],
  provider: ActiveProvider,
  model: string | null | undefined,
  sandboxStatusCache?: ToolResultMetaSnapshot | null,
  options?: BuildToolResultMetaLineOptions,
): string {
  const contextChars = apiMessages.reduce((sum, message) => sum + message.content.length, 0);
  const contextKb = Math.round(contextChars / 1024);
  const contextTokens = estimateContextTokens(apiMessages as ChatMessage[]);
  const budget = getContextBudget(provider, model || undefined);
  const contextPressurePct =
    budget.maxTokens > 0 ? Math.max(0, Math.round((contextTokens / budget.maxTokens) * 100)) : 0;
  const contextPressure =
    contextPressurePct >= 95
      ? 'critical'
      : contextPressurePct >= 80
        ? 'high'
        : contextPressurePct >= 60
          ? 'elevated'
          : 'low';

  const parts = [
    `[meta] round=${round} ctx=${contextKb}kb tok=${Math.round(contextTokens / 1000)}k/${Math.round(
      budget.maxTokens / 1000,
    )}k pressure=${contextPressure} pct=${contextPressurePct}`,
  ];

  if (sandboxStatusCache) {
    parts.push(`dirty=${sandboxStatusCache.dirty} files=${sandboxStatusCache.files}`);
    const provenance = fileLedger.getDirtyFilesWithProvenance();
    if (provenance.length > 0) {
      const counts = {
        agent: provenance.filter((entry) => entry.modifiedBy === 'agent').length,
        user: provenance.filter((entry) => entry.modifiedBy === 'user').length,
        unknown: provenance.filter((entry) => entry.modifiedBy === 'unknown').length,
      };
      const provParts = [
        counts.agent ? `agent=${counts.agent}` : null,
        counts.user ? `user=${counts.user}` : null,
        counts.unknown ? `unknown=${counts.unknown}` : null,
      ].filter(Boolean);
      if (provParts.length > 0) {
        parts.push(`by:[${provParts.join(',')}]`);
      }
    }
  }

  const lines = [parts.join(' ')];
  if (sandboxStatusCache && options?.includePulse) {
    const sandboxEnv = getSandboxEnvironment();
    const pulsePayload = {
      reason: options.pulseReason ?? 'periodic',
      branch: sandboxStatusCache.branch ?? null,
      head: sandboxStatusCache.head ?? null,
      dirty: sandboxStatusCache.dirty,
      files: sandboxStatusCache.files,
      changedFiles: sandboxStatusCache.changedFiles?.slice(0, 6) ?? [],
      // `ahead: 0` on a branch with NO upstream would read as "in sync with
      // origin" when in fact nothing is on origin — the one case where the
      // divergence signal matters most (a fresh auto-branch after
      // sandbox_commit, before its first push). Emit the count only when an
      // upstream exists; say `noUpstream` explicitly when it doesn't; emit
      // neither when upstream state is unknown (no fabricated zeros).
      ...(sandboxStatusCache.hasUpstream === true
        ? { ahead: sandboxStatusCache.ahead ?? 0 }
        : sandboxStatusCache.hasUpstream === false
          ? { noUpstream: true }
          : {}),
      warnings: sandboxEnv?.warnings?.slice(0, 2) ?? [],
    };
    lines.push(`[pulse] ${JSON.stringify(pulsePayload)}`);
  }

  return lines.join('\n');
}

export function buildToolMeta(options: BuildToolMetaOptions): ToolMeta {
  return {
    toolName: options.toolName,
    target: options.target,
    source: options.source,
    provider: options.provider,
    durationMs: options.durationMs,
    isError: options.isError,
    triggeredBy: options.triggeredBy ?? 'assistant',
  };
}

export function buildToolResultMessage(options: BuildToolResultMessageOptions): ChatMessage {
  return {
    id: options.id,
    role: 'user',
    content: formatToolResultEnvelope(options.text, options.metaLine),
    timestamp: options.timestamp,
    status: 'done',
    isToolResult: true,
    toolMeta: options.toolMeta,
    ...(options.branch !== undefined ? { branch: options.branch } : {}),
    ...(options.toolResults && options.toolResults.length > 0
      ? { toolResults: [...options.toolResults] }
      : {}),
  };
}

export function markLastAssistantToolCall(
  messages: readonly ChatMessage[],
  options: MarkAssistantToolCallOptions,
): ChatMessage[] {
  const lastIndex = messages.length - 1;
  if (lastIndex < 0) return [...messages];
  const lastMessage = messages[lastIndex];
  if (lastMessage.role !== 'assistant') return [...messages];

  const nextMessages = [...messages];
  nextMessages[lastIndex] = {
    ...lastMessage,
    content: options.content,
    thinking: options.thinking || undefined,
    status: 'done',
    isToolCall: true,
    isMalformed: options.malformed || undefined,
    ...(options.toolMeta ? { toolMeta: options.toolMeta } : {}),
    ...(options.toolUses && options.toolUses.length > 0 ? { toolUses: [...options.toolUses] } : {}),
  };

  // Interleaved-prose split: the narration the model streamed before its tool
  // call ("Let me check the config…") used to vanish when this message folded
  // into the collapsed ToolCallSummary group — MessageBubble force-clears
  // isToolCall text and the group renderer never reads callMsg.content. Split
  // it into its own settled, display-only message so it stays visible between
  // tool groups (and naturally breaks consecutive rounds into separate
  // groups). Display-only (`visibleToModel: false`): the tool-call message
  // keeps the full content for the wire transcript, so the model-facing
  // history is unchanged. Malformed rounds keep the old behavior — their
  // leftover text is protocol garbage, not narration.
  if (!options.malformed) {
    const previous = lastIndex > 0 ? nextMessages[lastIndex - 1] : undefined;
    // Re-marks of the same round (the batched path marks once per state
    // update) must not stack duplicates — the id link makes the split
    // idempotent per tool-call message.
    const alreadySplit =
      previous?.kind === 'tool_prose' && previous.toolProseFor === lastMessage.id;
    if (!alreadySplit) {
      const prose = stripToolCallPayload(options.content);
      if (prose) {
        nextMessages.splice(lastIndex, 0, {
          id: crypto.randomUUID(),
          role: 'assistant',
          content: prose,
          timestamp: lastMessage.timestamp,
          status: 'done',
          kind: 'tool_prose',
          toolProseFor: lastMessage.id,
          visibleToModel: false,
          ...(lastMessage.branch !== undefined ? { branch: lastMessage.branch } : {}),
        });
      }
    }
  }
  return nextMessages;
}

export function appendCardsToLatestToolCall(
  messages: readonly ChatMessage[],
  cards: readonly ChatCard[],
): ChatMessage[] {
  const safeCards = cards.filter((card) => card.type !== 'sandbox-state');
  if (safeCards.length === 0) return [...messages];

  const lastToolCallIndex = [...messages]
    .map((message, index) => ({ message, index }))
    .reverse()
    .find(({ message }) => message.role === 'assistant' && message.isToolCall)?.index;

  if (lastToolCallIndex === undefined) return [...messages];

  const nextMessages = [...messages];
  const target = nextMessages[lastToolCallIndex];
  nextMessages[lastToolCallIndex] = {
    ...target,
    cards: [...(target.cards || []), ...safeCards],
  };
  return nextMessages;
}
