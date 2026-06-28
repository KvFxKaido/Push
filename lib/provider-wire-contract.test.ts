import { describe, expect, it } from 'vitest';

import type { LlmContentBlock, LlmMessage, PushStreamRequest } from './provider-contract.ts';
import { toOpenAIChat, expandToolMessagesForOpenAICompat } from './openai-chat-serializer.ts';
import { toAnthropicMessages } from './anthropic-bridge.ts';
import { toGeminiGenerateContent } from './gemini-bridge.ts';

/**
 * Cross-provider wire-contract pins for tool-bearing turns — at the SERIALIZER
 * stage (neutral message -> provider wire body).
 *
 * A tool call/result must survive serialization on EVERY provider that supports
 * native tool calling, and provider-specific sidecars (Gemini's
 * `thoughtSignature`) must round-trip wherever they apply. This directly guards
 * the #1220 class — `thoughtSignature` dropped on the OpenAI-compat flatten —
 * and the serializer-stage emission of `tool_calls` / `tool_call_id`.
 *
 * Scope note: the sibling #1219 regression was a strip at a DIFFERENT stage —
 * the Worker proxy normalizer (`validateAndNormalizeChatRequest`) dropping
 * `tool_calls` / `tool_call_id` after the client serialized them. That stage is
 * app-layer (a `lib/` test importing it would invert layering) and is guarded in
 * `app/src/lib/chat-request-guardrails.test.ts`. This file is the serializer-stage
 * half of the same "a wire field carried on one path is silently dropped on
 * another" class; the two together cover producer + proxy.
 *
 * Two layers:
 *   1. Round-trip invariants — the call id and (where supported) the signature
 *      reach the wire, and the result correlates back by id. Regression guard.
 *   2. Key-set pins on the tool-call object — a NEW field added to one serializer
 *      fails the pin, forcing the author to decide whether the other providers
 *      need it too (the drift-awareness mechanism, mirroring the Object.keys pins
 *      in cli/tests/protocol-drift.test.mjs).
 */

const SIGNATURE = 'sig-abc';

const toolUse: LlmContentBlock = {
  type: 'tool_use',
  id: 'toolu_1',
  name: 'sandbox_read_file',
  input: { path: 'a.ts' },
  thoughtSignature: SIGNATURE,
} as LlmContentBlock;

const toolResult: LlmContentBlock = {
  type: 'tool_result',
  tool_use_id: 'toolu_1',
  content: 'file body',
} as LlmContentBlock;

function req(messages: LlmMessage[]): PushStreamRequest<LlmMessage> {
  return { provider: 'openrouter', model: 'wire-contract-probe', messages };
}

const toolTurn: LlmMessage[] = [
  { id: 'a', role: 'assistant', content: 'calling', contentBlocks: [toolUse], timestamp: 0 },
  { id: 'r', role: 'user', content: 'result', contentBlocks: [toolResult], timestamp: 0 },
];

describe('provider wire contract — tool turns', () => {
  describe('OpenAI Chat (toOpenAIChat)', () => {
    const wire = toOpenAIChat(req(toolTurn));
    const assistant = (wire.messages ?? []).find((m) => m.role === 'assistant');
    const toolMsg = (wire.messages ?? []).find((m) => m.role === 'tool');

    it('carries the tool call with its id and stringified args', () => {
      expect(assistant?.tool_calls?.[0]).toMatchObject({
        id: 'toolu_1',
        type: 'function',
        function: { name: 'sandbox_read_file', arguments: '{"path":"a.ts"}' },
      });
    });

    it('correlates the result back to the call by id', () => {
      expect(toolMsg).toMatchObject({
        role: 'tool',
        tool_call_id: 'toolu_1',
        content: 'file body',
      });
    });

    it('round-trips Gemini thoughtSignature in BOTH wire shapes', () => {
      expect(assistant?.tool_calls?.[0]).toMatchObject({
        thoughtSignature: SIGNATURE,
        extra_content: { google: { thought_signature: SIGNATURE } },
      });
    });

    it('pins the tool-call key set (a new field must be considered everywhere)', () => {
      expect(Object.keys(assistant?.tool_calls?.[0] ?? {}).sort()).toEqual([
        'extra_content',
        'function',
        'id',
        'thoughtSignature',
        'type',
      ]);
    });
  });

  describe('OpenAI-compat raw-forward (expandToolMessagesForOpenAICompat)', () => {
    // The Ollama/OpenRouter path: toLLMMessages would have materialized the
    // sidecars into contentBlocks; feed that shape directly.
    const wire = expandToolMessagesForOpenAICompat(toolTurn);
    const assistant = wire.find((m) => (m as { role?: string }).role === 'assistant') as {
      tool_calls?: Array<Record<string, unknown>>;
    };
    const toolMsg = wire.find((m) => (m as { role?: string }).role === 'tool');

    it('matches the toOpenAIChat tool-call shape (same flatten)', () => {
      expect(assistant?.tool_calls?.[0]).toMatchObject({
        id: 'toolu_1',
        type: 'function',
        function: { name: 'sandbox_read_file', arguments: '{"path":"a.ts"}' },
        thoughtSignature: SIGNATURE,
        extra_content: { google: { thought_signature: SIGNATURE } },
      });
      expect(toolMsg).toMatchObject({ role: 'tool', tool_call_id: 'toolu_1' });
    });
  });

  describe('Anthropic Messages (toAnthropicMessages)', () => {
    const wire = toAnthropicMessages(req(toolTurn)) as {
      messages: Array<{ role: string; content: unknown }>;
    };
    const assistant = wire.messages.find((m) => m.role === 'assistant');
    const user = wire.messages.find((m) => m.role === 'user');
    const useBlock = (assistant?.content as LlmContentBlock[]).find((b) => b.type === 'tool_use');
    const resultBlock = (user?.content as LlmContentBlock[]).find((b) => b.type === 'tool_result');

    it('emits native tool_use / tool_result blocks correlated by id', () => {
      expect(useBlock).toMatchObject({
        type: 'tool_use',
        id: 'toolu_1',
        name: 'sandbox_read_file',
      });
      expect(resultBlock).toMatchObject({ type: 'tool_result', tool_use_id: 'toolu_1' });
    });
  });

  describe('Gemini GenerateContent (toGeminiGenerateContent)', () => {
    const wire = toGeminiGenerateContent(req(toolTurn)) as {
      contents: Array<{ role: string; parts: Array<Record<string, unknown>> }>;
    };
    // Flatten parts across turns: the bridge prepends a synthetic empty `user`
    // turn (Gemini requires the conversation to open with one), so locate the
    // call/response by their part shape rather than by turn position.
    const allParts = wire.contents.flatMap((c) => c.parts);
    const callPart = allParts.find((p) => 'functionCall' in p);
    const responsePart = allParts.find((p) => 'functionResponse' in p);

    it('emits functionCall/functionResponse correlated by id', () => {
      expect(callPart?.functionCall).toMatchObject({ id: 'toolu_1', name: 'sandbox_read_file' });
      expect(responsePart?.functionResponse).toMatchObject({ id: 'toolu_1' });
    });

    it('round-trips thoughtSignature as a sibling on the call part', () => {
      expect(callPart?.thoughtSignature).toBe(SIGNATURE);
    });
  });

  it('every signature-bearing serializer surfaces a thoughtSignature it was given', () => {
    // One assertion that fails loudly if a NEW serializer (or a refactor) starts
    // dropping the signature. Anthropic has no signature concept and is omitted.
    const openai = toOpenAIChat(req(toolTurn));
    const openaiSig = (openai.messages ?? []).some(
      (m) => m.role === 'assistant' && m.tool_calls?.some((t) => t.thoughtSignature === SIGNATURE),
    );
    const gemini = toGeminiGenerateContent(req(toolTurn)) as {
      contents: Array<{ parts: Array<Record<string, unknown>> }>;
    };
    const geminiSig = gemini.contents.some((c) =>
      c.parts.some((p) => p.thoughtSignature === SIGNATURE),
    );
    expect({ openai: openaiSig, gemini: geminiSig }).toEqual({ openai: true, gemini: true });
  });
});
