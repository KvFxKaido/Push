/**
 * Shared OpenAI Responses wire-shape types.
 *
 * Direct OpenAI and verified Responses-compatible gateways use these for
 * `/v1/responses`. Generic Chat Completions-compatible providers stay on
 * `openai-chat-types.ts`.
 */

import type { ResponsesReasoningItem, ToolFunctionSchema } from './provider-contract.js';

export type OpenAIResponsesInputContent =
  | { type: 'input_text'; text: string }
  | { type: 'input_image'; image_url: string; detail?: 'low' | 'high' | 'auto' | 'original' };

export interface OpenAIResponsesMessageItem {
  type: 'message';
  role: 'system' | 'developer' | 'user' | 'assistant';
  content: OpenAIResponsesInputContent[];
}

export interface OpenAIResponsesFunctionCallItem {
  type: 'function_call';
  /** Provider item id when a prior Responses output item exposed one. */
  id?: string;
  /** Stable function-call id used to attach `function_call_output` results. */
  call_id: string;
  name: string;
  arguments: string;
  status?: 'in_progress' | 'completed' | 'incomplete';
  /**
   * Gemini-fronting Responses gateways can require the signed-reasoning
   * `thoughtSignature` to replay tool history. These provider-private fields
   * mirror the compat chat serializer's three tolerated wire shapes and are
   * emitted only by callers that opt into Gemini replay support.
   */
  thoughtSignature?: string;
  extra_content?: { google?: { thought_signature?: string } };
  function?: { thought_signature?: string };
}

export interface OpenAIResponsesFunctionCallOutputItem {
  type: 'function_call_output';
  call_id: string;
  output: string;
}

export type OpenAIResponsesInputItem =
  | OpenAIResponsesMessageItem
  | OpenAIResponsesFunctionCallItem
  | OpenAIResponsesFunctionCallOutputItem
  | ResponsesReasoningItem;

export interface OpenAIResponsesFunctionTool {
  type: 'function';
  name: string;
  description: string;
  parameters: ToolFunctionSchema['input_schema'];
}

/**
 * OpenAI's native server-side web search, expressed as a built-in tool. The
 * provider runs the search upstream and feeds grounded, `url_citation`-annotated
 * results back to the model. Supported by direct OpenAI and the Responses-native
 * gateways (Sakana Fugu, Fireworks). Advanced options aren't sent — the bare
 * `{ type: 'web_search' }` shape lets the model decide when to search.
 */
export interface OpenAIResponsesWebSearchTool {
  type: 'web_search';
}

export type OpenAIResponsesTool = OpenAIResponsesFunctionTool | OpenAIResponsesWebSearchTool;

export interface OpenAIResponsesTextFormat {
  type: 'json_schema';
  name: string;
  strict?: boolean;
  schema: Record<string, unknown>;
}

export interface OpenAIResponsesRequest {
  model: string;
  input: OpenAIResponsesInputItem[];
  stream: boolean;
  /**
   * Push sends the full neutral history every turn. Disabling server-side
   * storage keeps this path stateless and avoids depending on
   * `previous_response_id` conversation state.
   */
  store: false;
  /** Ask stateless Responses endpoints to return the encrypted reasoning item
   *  needed for manual multi-turn replay. */
  include?: ['reasoning.encrypted_content'];
  temperature?: number;
  top_p?: number;
  max_output_tokens?: number;
  text?: { format: OpenAIResponsesTextFormat };
  tools?: OpenAIResponsesTool[];
  tool_choice?: 'auto' | 'none' | 'required';
}
