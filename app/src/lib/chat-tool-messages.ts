import type {
  AIProviderType,
  ChatCard,
  ChatMessage,
  ToolMeta,
} from '@/types';
import {
  estimateContextTokens,
  getContextBudget,
  type ActiveProvider,
} from './orchestrator';
import { fileLedger } from './file-awareness-ledger';
import type { AnyToolCall } from './tool-dispatch';
import { formatToolResultEnvelope } from './tool-call-recovery';
import { getToolStatusLabelFromName, getToolPublicName } from './tool-registry';

export interface ToolResultMetaSnapshot {
  dirty: boolean;
  files: number;
}

export interface BuildToolMetaOptions {
  toolName: string;
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
}

export interface MarkAssistantToolCallOptions {
  content: string;
  thinking?: string;
  malformed?: boolean;
  toolMeta?: ToolMeta;
}

export function getToolStatusLabel(toolCall: AnyToolCall): string {
  return getToolStatusLabelFromName(toolCall.call.tool) ?? 'Processing...';
}

export function getToolName(toolCall: AnyToolCall): string {
  return getToolPublicName(toolCall.call.tool) || 'unknown';
}

export function buildToolResultMetaLine(
  round: number,
  apiMessages: readonly Pick<ChatMessage, 'content'>[],
  provider: ActiveProvider,
  model: string | null | undefined,
  sandboxStatusCache?: ToolResultMetaSnapshot | null,
): string {
  const contextChars = apiMessages.reduce((sum, message) => sum + message.content.length, 0);
  const contextKb = Math.round(contextChars / 1024);
  const contextTokens = estimateContextTokens(apiMessages as ChatMessage[]);
  const budget = getContextBudget(provider, model || undefined);
  const parts = [
    `[meta] round=${round} ctx=${contextKb}kb tok=${Math.round(contextTokens / 1000)}k/${Math.round(
      budget.maxTokens / 1000,
    )}k`,
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

  return parts.join(' ');
}

export function buildToolMeta(options: BuildToolMetaOptions): ToolMeta {
  return {
    toolName: options.toolName,
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
  };
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
