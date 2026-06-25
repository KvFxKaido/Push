import type { LlmToolResultBlock, LlmToolUseBlock } from './provider-contract.js';

export function createToolUseBlockId(seed: string): string {
  return seed.startsWith('toolu_') ? seed : `toolu_${seed}`;
}

function normalizeToolInput(input: unknown): Record<string, unknown> {
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    return input as Record<string, unknown>;
  }
  return {};
}

export function buildToolUseBlock(options: {
  id: string;
  name: string;
  input?: unknown;
  /** Gemini `thoughtSignature` to round-trip on replay (see `LlmToolUseBlock`). */
  thoughtSignature?: string;
}): LlmToolUseBlock {
  return {
    type: 'tool_use',
    id: options.id,
    name: options.name,
    input: normalizeToolInput(options.input),
    ...(options.thoughtSignature ? { thoughtSignature: options.thoughtSignature } : {}),
  };
}

export function buildToolResultBlock(options: {
  toolUseId: string;
  content: string;
  isError?: boolean;
}): LlmToolResultBlock {
  return {
    type: 'tool_result',
    tool_use_id: options.toolUseId,
    content: options.content,
    ...(options.isError ? { is_error: true } : {}),
  };
}
