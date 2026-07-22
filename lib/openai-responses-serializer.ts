/**
 * Neutral `PushStreamRequest` -> OpenAI Responses serializer.
 *
 * This is the direct OpenAI peer of `toOpenAIChat`: it speaks `/v1/responses`
 * with typed `input` items, flat function tools, and `text.format` structured
 * output. OpenAI-compatible providers must not use this serializer unless they
 * explicitly support Responses semantics.
 */

import type {
  LlmContentBlock,
  LlmMessage,
  PushStreamRequest,
  ResponseFormatSpec,
  ToolFunctionSchema,
} from './provider-contract.ts';
import { withRequestContentBlocks } from './content-blocks.ts';
import type {
  OpenAIResponsesFunctionTool,
  OpenAIResponsesInputContent,
  OpenAIResponsesInputItem,
  OpenAIResponsesRequest,
  OpenAIResponsesTextFormat,
  OpenAIResponsesTool,
} from './openai-responses-types.ts';
import {
  resolveGeminiReplaySignature,
  toolCallFunctionThoughtSignatureField,
  toolCallThoughtSignatureFields,
} from './gemini-thought-signature.ts';

export function toOpenAIResponsesTextFormat(spec: ResponseFormatSpec): OpenAIResponsesTextFormat {
  return {
    type: 'json_schema',
    name: spec.name,
    strict: spec.strict ?? true,
    schema: spec.schema,
  };
}

export function flatToolToOpenAIResponsesTool(
  tool: ToolFunctionSchema,
): OpenAIResponsesFunctionTool {
  return {
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: tool.input_schema,
  };
}

/** Responses text content type by message role: assistant history replays as
 *  `output_text` (the API rejects `input_text` on assistant messages —
 *  "Supported values are: 'output_text' and 'refusal'"); every other role
 *  sends `input_text`. First user turn worked, turn two 400'd — the 2026-07-21
 *  push-gate `gpt-5.6-luna` failure. */
function textContent(
  role: LlmMessage['role'],
  text: string,
): { type: 'input_text' | 'output_text'; text: string } {
  return { type: role === 'assistant' ? 'output_text' : 'input_text', text };
}

function blockToResponsesContent(
  block: LlmContentBlock,
  role: LlmMessage['role'],
): OpenAIResponsesInputContent | null {
  if (block.type === 'text') {
    return textContent(role, block.text);
  }
  if (block.type === 'image') {
    if (block.source.type === 'base64') {
      return {
        type: 'input_image',
        image_url: `data:${block.source.media_type};base64,${block.source.data}`,
        detail: 'auto',
      };
    }
    if (block.source.type === 'url') {
      return { type: 'input_image', image_url: block.source.url, detail: 'auto' };
    }
  }
  // Responses has richer reasoning item support, but Push does not yet persist
  // OpenAI encrypted reasoning items. Drop existing Anthropic/Gemini-private
  // reasoning blocks here, matching the Chat serializer's direct-OpenAI rule.
  if (block.type === 'thinking' || block.type === 'redacted_thinking') {
    return null;
  }
  throw new Error(
    `toOpenAIResponses: unsupported or malformed content block (type: ${JSON.stringify(
      (block as { type?: unknown }).type,
    )})`,
  );
}

function visibleBlocksToMessageContent(
  blocks: readonly LlmContentBlock[],
  role: LlmMessage['role'],
): OpenAIResponsesInputContent[] {
  const content: OpenAIResponsesInputContent[] = [];
  for (const block of blocks) {
    if (block.type === 'tool_use' || block.type === 'tool_result') continue;
    const converted = blockToResponsesContent(block, role);
    if (converted) content.push(converted);
  }
  return content.length > 0 ? content : [textContent(role, '')];
}

function pushMessageItem(
  out: OpenAIResponsesInputItem[],
  role: LlmMessage['role'],
  content: OpenAIResponsesInputContent[],
): void {
  out.push({
    type: 'message',
    role,
    content,
  });
}

function appendBlocksAsResponsesItems(
  out: OpenAIResponsesInputItem[],
  message: LlmMessage,
  options?: { geminiThoughtSignatureFallback?: boolean },
): void {
  const blocks = message.contentBlocks ?? [];
  let visible: LlmContentBlock[] = [];
  let seenToolCall = false;

  const flushVisible = () => {
    if (visible.length === 0) return;
    pushMessageItem(out, message.role, visibleBlocksToMessageContent(visible, message.role));
    visible = [];
  };

  for (const block of blocks) {
    if (block.type === 'tool_use') {
      if (
        typeof block.id !== 'string' ||
        typeof block.name !== 'string' ||
        block.input === null ||
        typeof block.input !== 'object'
      ) {
        throw new Error(
          `toOpenAIResponses: malformed tool_use block (id: ${JSON.stringify(
            (block as { id?: unknown }).id,
          )})`,
        );
      }
      flushVisible();
      const ownSignature =
        typeof block.thoughtSignature === 'string' && block.thoughtSignature
          ? block.thoughtSignature
          : undefined;
      const replaySignature = options?.geminiThoughtSignatureFallback
        ? resolveGeminiReplaySignature({ ownSignature, isFirstCallInTurn: !seenToolCall })
        : undefined;
      seenToolCall = true;
      const thoughtSignatureFields = replaySignature
        ? {
            ...toolCallThoughtSignatureFields(replaySignature),
            function: {
              ...toolCallFunctionThoughtSignatureField(replaySignature),
            },
          }
        : {};
      out.push({
        type: 'function_call',
        call_id: block.id,
        name: block.name,
        arguments: JSON.stringify(block.input),
        status: 'completed',
        ...thoughtSignatureFields,
      });
      continue;
    }

    if (block.type === 'tool_result') {
      if (typeof block.tool_use_id !== 'string' || typeof block.content !== 'string') {
        throw new Error(
          `toOpenAIResponses: malformed tool_result block (tool_use_id: ${JSON.stringify(
            (block as { tool_use_id?: unknown }).tool_use_id,
          )})`,
        );
      }
      flushVisible();
      out.push({
        type: 'function_call_output',
        call_id: block.tool_use_id,
        output: block.content,
      });
      seenToolCall = false;
      continue;
    }

    visible.push(block);
  }

  flushVisible();
  if (blocks.length === 0) {
    pushMessageItem(out, message.role, [textContent(message.role, message.content)]);
  }
}

export interface ToOpenAIResponsesOptions {
  modelOverride?: string;
  temperatureDefault?: number;
  stream?: boolean;
  geminiThoughtSignatureFallback?: boolean;
  /** Include encrypted reasoning in the response and replay persisted items.
   *  Opt-in because compatible gateways that do not implement this include
   *  value may reject it. */
  encryptedReasoningReplay?: boolean;
}

export function toOpenAIResponses(
  req: PushStreamRequest<LlmMessage>,
  options?: ToOpenAIResponsesOptions,
): OpenAIResponsesRequest {
  const model = options?.modelOverride ?? req.model;
  const reqMessages = withRequestContentBlocks(Array.isArray(req.messages) ? req.messages : []);
  const input: OpenAIResponsesInputItem[] = [];

  if (req.systemPromptOverride) {
    pushMessageItem(input, 'system', [{ type: 'input_text', text: req.systemPromptOverride }]);
  }

  for (const message of reqMessages) {
    if (
      options?.encryptedReasoningReplay &&
      message.role === 'assistant' &&
      message.responsesReasoningItems
    ) {
      input.push(...message.responsesReasoningItems);
    }
    if (message.contentBlocks && message.contentBlocks.length > 0) {
      appendBlocksAsResponsesItems(input, message, {
        geminiThoughtSignatureFallback: options?.geminiThoughtSignatureFallback,
      });
      continue;
    }
    pushMessageItem(input, message.role, [textContent(message.role, message.content)]);
  }

  const temperature =
    typeof req.temperature === 'number' ? req.temperature : options?.temperatureDefault;
  const nativeTools = Array.isArray(req.tools) && req.tools.length > 0 ? req.tools : [];

  // Native function tools and OpenAI's server-side `web_search` tool merge into
  // one `tools` array (web search appended last). Web search alone is enough to
  // emit `tools` even when no function schemas are attached — the model then
  // decides per-turn whether to search. `tool_choice: 'auto'` keeps prose
  // answers available when neither is needed.
  //
  // Suppress `web_search` when a strict JSON-schema output is requested:
  // structured/verification turns force `text.format`, and the Responses API
  // constrains combining a built-in tool with strict structured output — adding
  // it there risks perturbing or rejecting the turn. Function tools still merge;
  // only the server-side search is held back.
  const webSearch = req.responsesWebSearch === true && !req.responseFormat;
  const tools: OpenAIResponsesTool[] = [
    ...nativeTools.map(flatToolToOpenAIResponsesTool),
    ...(webSearch ? [{ type: 'web_search' as const }] : []),
  ];

  return {
    model,
    input,
    stream: options?.stream ?? true,
    store: false,
    ...(options?.encryptedReasoningReplay
      ? { include: ['reasoning.encrypted_content' as const] }
      : {}),
    ...(typeof temperature === 'number' ? { temperature } : {}),
    ...(typeof req.topP === 'number' ? { top_p: req.topP } : {}),
    ...(typeof req.maxTokens === 'number' ? { max_output_tokens: req.maxTokens } : {}),
    ...(req.responseFormat
      ? { text: { format: toOpenAIResponsesTextFormat(req.responseFormat) } }
      : {}),
    ...(tools.length > 0 ? { tools, tool_choice: req.toolChoice ?? 'auto' } : {}),
  };
}
