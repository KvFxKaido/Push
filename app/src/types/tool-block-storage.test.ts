import { describe, expect, it } from 'vitest';
import type { LlmToolResultBlock, LlmToolUseBlock } from '@push/lib/provider-contract';
import type { ChatMessage } from './index';

/**
 * Slice 0 drift pin — Structured Tool-Call Sourcing
 * (`docs/decisions/Structured Tool-Call Sourcing.md`).
 *
 * The transcript gains an additive, Anthropic-canonical tool-block sidecar
 * (`toolUses` on the assistant turn, `toolResults` on the result message(s))
 * carried alongside the fenced-JSON text in `content`. This slice is shape-only:
 * no producer writes the fields and no consumer reads them yet — same staging as
 * `reasoningBlocks` landed before its producer existed.
 *
 * These assertions pin (1) the fields exist, (2) they carry the *canonical* block
 * types from `provider-contract` (not a local re-declaration — the single source of
 * truth the new-feature checklist requires), and (3) they stay optional so legacy
 * transcripts that omit them keep serving via the text arm (the per-exchange
 * fallback). A field rename, a block-shape change, or a slip to required would fail
 * to typecheck here. The CLI peer (`cli/context-manager.ts` `Message.toolUses` /
 * `toolResults`) MUST move in lockstep — this test guards the web half; the CLI half
 * is guarded by `npm run typecheck:all`.
 */
describe('ChatMessage structured tool-call sidecar (Slice 0)', () => {
  it('carries toolUses as canonical LlmToolUseBlock[] on an assistant turn', () => {
    const use: LlmToolUseBlock = {
      type: 'tool_use',
      id: 'toolu_read_1',
      name: 'read_file',
      input: { path: 'README.md' },
    };
    const assistant: ChatMessage = {
      id: 'a1',
      role: 'assistant',
      content: '```json\n{"tool":"read_file","input":{"path":"README.md"}}\n```',
      timestamp: 1,
      isToolCall: true,
      toolUses: [use],
    };
    expect(assistant.toolUses).toEqual([use]);
    // The text arm stays the model-facing boundary — the sidecar is additive.
    expect(assistant.content).toContain('read_file');
  });

  it('carries toolResults as canonical LlmToolResultBlock[], linked by tool_use_id', () => {
    const result: LlmToolResultBlock = {
      type: 'tool_result',
      tool_use_id: 'toolu_read_1',
      content: '# Push\n…',
      is_error: false,
    };
    const resultMessage: ChatMessage = {
      id: 'r1',
      role: 'user',
      content: '[TOOL_RESULT] read_file → …',
      timestamp: 2,
      isToolResult: true,
      toolResults: [result],
    };
    expect(resultMessage.toolResults?.[0]?.tool_use_id).toBe('toolu_read_1');
  });

  it('holds plural results — a parallel/file-mutation batch lands several blocks', () => {
    const batch: ChatMessage = {
      id: 'r2',
      role: 'user',
      content: '[TOOL_RESULT] …',
      timestamp: 3,
      isToolResult: true,
      toolResults: [
        { type: 'tool_result', tool_use_id: 'toolu_a', content: 'ok' },
        { type: 'tool_result', tool_use_id: 'toolu_b', content: 'ok' },
      ],
    };
    expect(batch.toolResults).toHaveLength(2);
  });

  it('keeps both fields optional so legacy transcripts fall back to the text arm', () => {
    const legacy: ChatMessage = {
      id: 'l1',
      role: 'assistant',
      content: 'plain reply, no tool call',
      timestamp: 1,
    };
    expect(legacy.toolUses).toBeUndefined();
    expect(legacy.toolResults).toBeUndefined();
  });
});
