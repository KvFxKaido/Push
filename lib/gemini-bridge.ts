import type { OpenAIChatRequest, OpenAIContentPart } from './openai-chat-types.ts';
import type {
  LlmContentBlock,
  LlmMessage,
  PushStreamEvent,
  PushStreamRequest,
  ResponseFormatSpec,
  StreamUsage,
  ToolFunctionSchema,
} from './provider-contract.ts';
import { parseNativeToolCallArgs, stripTemplateTokens } from './openai-sse-pump.ts';
import { withRequestContentBlocks } from './content-blocks.ts';
import { openAIToolToFlatTool } from './openai-chat-serializer.ts';
import { resolveGeminiReplaySignature } from './gemini-thought-signature.ts';

/**
 * OpenAI ↔ Gemini bridge.
 *
 * Translates an OpenAI-shaped chat request into Google's Generative Language
 * `:streamGenerateContent` body, and parses the upstream SSE response directly
 * into neutral `PushStreamEvent`s via `geminiEventStream` — the production
 * response path for both the CLI and the direct web Gemini route.
 *
 * Differences from Anthropic that drive shape choices:
 *   - Gemini's role vocabulary is `user` / `model` (not `user` / `assistant`).
 *   - System messages live in a separate top-level `systemInstruction` field,
 *     not in `contents[]`.
 *   - Sampling params and `max_tokens` go under `generationConfig`.
 *   - SSE frames are JSON objects with `candidates[0].content.parts[].text` +
 *     `candidates[0].finishReason` + a trailing `usageMetadata`.
 *   - Gemini sends a single terminal frame with `finishReason` and usage —
 *     no `[DONE]` sentinel.
 *
 * Gemini does not currently emit signed reasoning blocks the way Anthropic
 * does, so the response path surfaces text (and native function calls) only.
 * Prompt caching markers aren't preserved here either — Gemini's explicit-cache
 * API is opt-in and lives on a different endpoint, so passing
 * `cache_control: ephemeral` through would be a no-op.
 */

function dataUrlToGeminiInlinePart(dataUrl: string): Record<string, unknown> | null {
  const match = dataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
  if (!match) return null;
  return {
    inline_data: {
      mime_type: match[1],
      data: match[2],
    },
  };
}

function convertOpenAIContentToGeminiParts(
  content: string | OpenAIContentPart[] | null | undefined,
): Array<Record<string, unknown>> {
  if (typeof content === 'string') {
    return [{ text: content }];
  }

  if (!Array.isArray(content)) {
    return [{ text: '' }];
  }

  const parts: Array<Record<string, unknown>> = [];
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    if (part.type === 'text' && typeof part.text === 'string') {
      parts.push({ text: part.text });
      continue;
    }
    if (part.type === 'image_url' && typeof part.image_url?.url === 'string') {
      const inlinePart = dataUrlToGeminiInlinePart(part.image_url.url);
      if (inlinePart) parts.push(inlinePart);
    }
  }

  return parts.length > 0 ? parts : [{ text: '' }];
}

function flattenSystemParts(parts: Array<Record<string, unknown>>): string {
  return parts
    .map((p) => (typeof p.text === 'string' ? p.text : ''))
    .filter((text) => text.length > 0)
    .join('\n\n');
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function jsonSchemaTypeToGeminiType(type: unknown): string | undefined {
  switch (type) {
    case 'object':
      return 'OBJECT';
    case 'array':
      return 'ARRAY';
    case 'string':
      return 'STRING';
    case 'integer':
      return 'INTEGER';
    case 'number':
      return 'NUMBER';
    case 'boolean':
      return 'BOOLEAN';
    default:
      return undefined;
  }
}

function openAIJsonSchemaToGeminiSchema(schema: unknown): Record<string, unknown> {
  const src = asRecord(schema);
  if (!src) return {};

  const out: Record<string, unknown> = {};
  const type = jsonSchemaTypeToGeminiType(src.type);
  if (typeof src.description === 'string' && src.description.length > 0) {
    out.description = src.description;
  }
  if (Array.isArray(src.enum)) {
    const values = src.enum.filter(
      (item) => typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean',
    );
    if (values.length > 0) out.enum = values;
  }

  // Build child properties first so we can detect an OBJECT that ends up with no
  // usable properties.
  const mapped: Record<string, unknown> = {};
  const properties = asRecord(src.properties);
  if (properties) {
    for (const [key, value] of Object.entries(properties)) {
      const child = openAIJsonSchemaToGeminiSchema(value);
      if (Object.keys(child).length > 0) mapped[key] = child;
    }
  }

  // Gemini's API rejects an OBJECT schema whose `properties` is empty/missing
  // ("properties: should be non-empty for OBJECT type"). Our tool schemas carry
  // open-ended objects (e.g. `workflow_run.inputs`) and object-typed array items
  // (`edits[]`) with no declared sub-fields, plus parameterless tools whose whole
  // parameter object is empty. Represent any such empty OBJECT as STRING — the
  // documented Gemini workaround for open-ended objects — so the request isn't
  // rejected; the loose executor + text-dispatch fallback still handle the real
  // shape. Parameterless tools then drop `parameters` entirely in the declaration
  // builder (a STRING is not a valid top-level parameters schema).
  if (type === 'OBJECT' && Object.keys(mapped).length === 0) {
    out.type = 'STRING';
    return out;
  }

  if (type) out.type = type;
  if (Object.keys(mapped).length > 0) {
    out.properties = mapped;
    // Only keep `required` entries that name a property we actually emitted —
    // Gemini also rejects a `required` value that points at a missing property.
    if (Array.isArray(src.required)) {
      const required = src.required.filter(
        (item): item is string => typeof item === 'string' && item in mapped,
      );
      if (required.length > 0) out.required = required;
    }
  }

  if (src.items !== undefined) {
    const items = openAIJsonSchemaToGeminiSchema(src.items);
    if (Object.keys(items).length > 0) out.items = items;
  }

  return out;
}

function openAIToolToGeminiFunctionDeclaration(tool: ToolFunctionSchema): Record<string, unknown> {
  const declaration: Record<string, unknown> = { name: tool.name };
  if (tool.description) declaration.description = tool.description;
  const parameters = openAIJsonSchemaToGeminiSchema(tool.input_schema);
  // Attach `parameters` only for an OBJECT with at least one property. A
  // parameterless tool (empty object, collapsed to STRING above) must be declared
  // with name + description only — Gemini rejects an empty OBJECT parameter block.
  const props = asRecord(parameters.properties);
  if (parameters.type === 'OBJECT' && props && Object.keys(props).length > 0) {
    declaration.parameters = parameters;
  }
  return declaration;
}

export function buildGeminiGenerateContentRequest(
  request: OpenAIChatRequest,
): Record<string, unknown> {
  const messages = Array.isArray(request.messages) ? request.messages : [];

  const systemParts: Array<Record<string, unknown>> = [];
  const contents: Array<Record<string, unknown>> = [];

  for (const message of messages) {
    const role = typeof message.role === 'string' ? message.role : 'user';
    if (role === 'system' || role === 'developer') {
      for (const part of convertOpenAIContentToGeminiParts(message.content)) {
        if (typeof part.text === 'string' && part.text.length > 0) {
          systemParts.push(part);
        }
      }
      continue;
    }

    const parts = convertOpenAIContentToGeminiParts(message.content);
    contents.push({
      role: role === 'assistant' ? 'model' : 'user',
      parts,
    });
  }

  return assembleGeminiBody({
    contents,
    systemText: systemParts.length > 0 ? flattenSystemParts(systemParts) : '',
    maxOutputTokens:
      typeof request.max_completion_tokens === 'number'
        ? request.max_completion_tokens
        : typeof request.max_tokens === 'number'
          ? request.max_tokens
          : undefined,
    temperature: typeof request.temperature === 'number' ? request.temperature : undefined,
    topP: typeof request.top_p === 'number' ? request.top_p : undefined,
    // Strict `=== true` so a malformed input (e.g. the string `"false"`) can't
    // accidentally enable grounding.
    enableGoogleSearch: request.google_search_grounding === true,
    tools: request.tools?.map(openAIToolToFlatTool),
    responseFormat: request.response_format?.json_schema
      ? {
          name: request.response_format.json_schema.name,
          schema: request.response_format.json_schema.schema,
          strict: request.response_format.json_schema.strict,
        }
      : undefined,
  });
}

/**
 * Shared final assembly — both `buildGeminiGenerateContentRequest` (OpenAI
 * shape) and `toGeminiGenerateContent` (neutral) converge here, so the two paths
 * can only diverge on message conversion. Applies Gemini's user-first-turn
 * requirement, `generationConfig` placement, the `systemInstruction` hoist, and
 * native tools (`functionDeclarations` and `googleSearch`). (Model is NOT in the
 * body — Gemini carries it in the URL path.)
 */
interface GeminiBodyAssembly {
  contents: Array<Record<string, unknown>>;
  /** Flattened system text, or `''` when there is no system content. */
  systemText: string;
  maxOutputTokens?: number;
  temperature?: number;
  topP?: number;
  enableGoogleSearch: boolean;
  tools?: ToolFunctionSchema[];
  /** Native structured-output constraint. Emitted as `generationConfig`'s
   *  `responseMimeType: 'application/json'` + `responseSchema` (Gemini's OpenAPI
   *  subset). Skipped when function tools are present (Gemini rejects the combo). */
  responseFormat?: ResponseFormatSpec;
}

function assembleGeminiBody(parts: GeminiBodyAssembly): Record<string, unknown> {
  const contents = parts.contents;
  // Gemini requires `contents` non-empty AND starting with a `user` turn —
  // `[{ role: 'model', ... }]` 400s. Pad with an empty user turn when there are
  // no non-system messages, or when the first is an assistant (e.g. after
  // context compaction lops off the user prefix).
  if (contents.length === 0) {
    contents.push({ role: 'user', parts: [{ text: '' }] });
  } else if (contents[0].role === 'model') {
    contents.unshift({ role: 'user', parts: [{ text: '' }] });
  }

  const generationConfig: Record<string, unknown> = {};
  if (typeof parts.maxOutputTokens === 'number') {
    generationConfig.maxOutputTokens = parts.maxOutputTokens;
  }
  if (typeof parts.temperature === 'number') {
    generationConfig.temperature = parts.temperature;
  }
  if (typeof parts.topP === 'number') {
    generationConfig.topP = parts.topP;
  }
  // Structured output: Gemini constrains generation natively via
  // `responseMimeType: 'application/json'` + `responseSchema` (its OpenAPI-3.0
  // subset — the same shape `openAIJsonSchemaToGeminiSchema` builds for tool
  // params). The JSON then streams back as ordinary text content, so callers
  // `JSON.parse` it exactly as they do Anthropic `output_config` / OpenAI
  // `response_format`. Skipped when function tools are present: Gemini rejects
  // `responseSchema` combined with `functionDeclarations`, and the structured
  // paths (Auditor/Reviewer verdicts) never set both — tools win, mirroring the
  // grounding drop below.
  if (parts.responseFormat && (parts.tools ?? []).length === 0) {
    generationConfig.responseMimeType = 'application/json';
    generationConfig.responseSchema = openAIJsonSchemaToGeminiSchema(parts.responseFormat.schema);
  }

  const body: Record<string, unknown> = { contents };
  if (parts.systemText) {
    // Flattened-string form matches Gemini's REST examples; the upstream
    // concatenates parts into a single system turn anyway.
    body.systemInstruction = { parts: [{ text: parts.systemText }] };
  }
  if (Object.keys(generationConfig).length > 0) {
    body.generationConfig = generationConfig;
  }
  const tools: Array<Record<string, unknown>> = [];
  const nativeFunctionTools = parts.tools ?? [];
  if (nativeFunctionTools.length > 0) {
    tools.push({
      functionDeclarations: nativeFunctionTools.map(openAIToolToGeminiFunctionDeclaration),
    });
  }
  // Gemini only supports combining the built-in `googleSearch` grounding tool
  // with custom `functionDeclarations` on Gemini 3 models (it's a Preview
  // feature, "supported for Gemini 3 models only"), and even there it's been
  // field-flaky — `gemini-2.5-*` reject the combination outright. Push offers
  // both 2.5 and 3 Gemini models and grounding is default-on, so when native
  // function tools are attached we drop grounding to keep function calling
  // working uniformly across the catalog rather than 400 on the 2.5 models.
  // Grounding-only turns (no function schemas attached) are unaffected.
  //
  // Structured output also suppresses grounding: Gemini rejects `responseSchema`
  // combined with ANY tool (functionDeclarations OR googleSearch), and grounding
  // is default-on on web/CLI — so an Auditor/Reviewer verdict turn would ship
  // schema + googleSearch and 400. A verdict shouldn't web-search anyway, so
  // structured output wins over grounding here.
  // Ref: https://ai.google.dev/gemini-api/docs/tool-combination
  if (parts.enableGoogleSearch && nativeFunctionTools.length === 0 && !parts.responseFormat) {
    tools.push({ googleSearch: {} });
  }
  if (tools.length > 0) {
    body.tools = tools;
  }
  return body;
}

/**
 * Build a `tool_use_id` → function-name map across all of a request's
 * `contentBlocks`. Gemini's `functionResponse` is keyed by the function NAME,
 * but a neutral `tool_result` block carries only the `tool_use_id` — so we
 * resolve the name from the `tool_use` block that declared the call (which lives
 * on a prior assistant turn in the same request).
 */
function buildToolNameById(messages: readonly LlmMessage[]): Map<string, string> {
  const byId = new Map<string, string>();
  for (const m of messages) {
    if (!m.contentBlocks) continue;
    for (const rawBlock of m.contentBlocks) {
      const block = rawBlock as { type?: unknown; id?: unknown; name?: unknown };
      if (
        block.type === 'tool_use' &&
        typeof block.id === 'string' &&
        typeof block.name === 'string'
      ) {
        byId.set(block.id, block.name);
      }
    }
  }
  return byId;
}

/**
 * Strict converter for the neutral `LlmMessage.contentBlocks` → Gemini parts —
 * the Gemini downcast of the contract migration (see
 * `docs/decisions/Provider Contract — Anthropic-Conceptual Neutral Hub.md`).
 * Handles `text` and `image`, DROPS `thinking` / `redacted_thinking` (Gemini
 * surfaces text only and has no signed-reasoning slot, same as the OpenAI
 * path), and maps the tool blocks: `tool_use` → a `functionCall` part (the
 * parsed `input` object is Gemini's `args` verbatim) and `tool_result` → a
 * `functionResponse` part. Unlike OpenAI, Gemini keeps these inline in the
 * turn's `parts` array (no message splitting) — closer to Anthropic. A base64
 * image `source` maps to `inline_data`; a remote `url` source throws — Gemini
 * inline parts can't carry a URL.
 *
 * Both tool parts also carry an `id` (`tool_use.id` / `tool_result.tool_use_id`)
 * — Gemini 3 correlates a `functionResponse` to its `functionCall` by id, which
 * is what disambiguates parallel or repeated same-name calls. `functionResponse`
 * is additionally keyed by function NAME (resolved via `toolNameById`, built by
 * {@link buildToolNameById}); an unresolvable `tool_use_id` throws rather than
 * emit an invalid response. The result is wrapped as `{ output: <content> }`;
 * Gemini has no typed `is_error` slot but its `response` is free-form, so the
 * flag is preserved there structurally when set. THROWS on unsupported/malformed
 * blocks.
 */
function llmContentBlocksToGemini(
  blocks: readonly LlmContentBlock[],
  toolNameById: ReadonlyMap<string, string>,
): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  // Gemini validates that the turn's FIRST functionCall part carries a
  // thoughtSignature; track whether we've emitted one yet so the placeholder
  // fallback below only fills the first signatureless call (blocks here are a
  // single neutral message = one Gemini `model` turn).
  let seenFunctionCall = false;
  for (const rawBlock of blocks) {
    const block = rawBlock as {
      type?: unknown;
      text?: unknown;
      source?: { type?: unknown; media_type?: unknown; data?: unknown; url?: unknown };
      id?: unknown;
      name?: unknown;
      input?: unknown;
      tool_use_id?: unknown;
      content?: unknown;
      is_error?: unknown;
      thoughtSignature?: unknown;
    };
    if (block.type === 'text' && typeof block.text === 'string') {
      out.push({ text: block.text });
      continue;
    }
    if (block.type === 'image' && block.source && typeof block.source === 'object') {
      const s = block.source;
      if (s.type === 'base64' && typeof s.media_type === 'string' && typeof s.data === 'string') {
        out.push({ inline_data: { mime_type: s.media_type, data: s.data } });
        continue;
      }
      if (s.type === 'url' && typeof s.url === 'string') {
        // Gemini inline parts can't carry a remote URL — fail loudly rather
        // than drop the image.
        throw new Error(
          `toGeminiGenerateContent: cannot represent image (Gemini inline parts require a data:image base64 URL): ${s.url.slice(0, 48)}`,
        );
      }
      // Malformed image source — fall through to the loud throw below.
    }
    if (block.type === 'thinking' || block.type === 'redacted_thinking') {
      // Dropped — Gemini surfaces text only and has no signed-reasoning slot.
      continue;
    }
    if (
      block.type === 'tool_use' &&
      typeof block.id === 'string' &&
      typeof block.name === 'string' &&
      // `input` is a non-null object — an empty `{}` (parameterless call) is
      // valid; an absent input would be null/undefined and falls through to throw.
      block.input !== null &&
      typeof block.input === 'object'
    ) {
      // Emit the call `id` for correlation — Gemini 3 matches each
      // `functionResponse` to its `functionCall` by id, which is what keeps
      // parallel or repeated same-name calls from being mis-associated.
      //
      // `thoughtSignature` is a sibling field on the *part* (not inside
      // `functionCall`), replayed verbatim. Gemini 3.x rejects the follow-up
      // request 400 if the turn's first call has no signature; an altered value
      // breaks the model's chain of reasoning, so a real captured signature is
      // always preferred. When the first call carries none (text-dispatched call,
      // an upstream that dropped it, or Google omitting it on the first parallel
      // call), substitute the documented placeholder so the turn replays instead
      // of 400ing. Trailing parallel calls legitimately carry none → left bare.
      const replaySignature = resolveGeminiReplaySignature({
        ownSignature:
          typeof block.thoughtSignature === 'string' && block.thoughtSignature
            ? block.thoughtSignature
            : undefined,
        isFirstCallInTurn: !seenFunctionCall,
      });
      seenFunctionCall = true;
      out.push({
        functionCall: { id: block.id, name: block.name, args: block.input },
        ...(replaySignature ? { thoughtSignature: replaySignature } : {}),
      });
      continue;
    }
    if (
      block.type === 'tool_result' &&
      typeof block.tool_use_id === 'string' &&
      typeof block.content === 'string'
    ) {
      const name = toolNameById.get(block.tool_use_id);
      if (!name) {
        throw new Error(
          `toGeminiGenerateContent: cannot resolve a function name for tool_result (tool_use_id: ${JSON.stringify(
            block.tool_use_id,
          )} has no matching tool_use in the request)`,
        );
      }
      // Gemini has no typed `is_error` slot (like OpenAI), but its
      // `functionResponse.response` is a free-form object — so preserve the
      // flag there structurally rather than dropping it or hacking it into the
      // content string. Anthropic keeps its native slot; this is the closest
      // Gemini-faithful equivalent.
      const response: Record<string, unknown> = { output: block.content };
      if (block.is_error === true) response.is_error = true;
      // `id` ties this response back to its `functionCall` (Gemini 3 correlation
      // for parallel / repeated same-name calls); `name` is still required.
      out.push({ functionResponse: { id: block.tool_use_id, name, response } });
      continue;
    }
    throw new Error(
      `toGeminiGenerateContent: unsupported or malformed content block (type: ${JSON.stringify(block.type)})`,
    );
  }
  return out.length > 0 ? out : [{ text: '' }];
}

/** Options for the neutral `PushStreamRequest` → Gemini serializer. */
export interface ToGeminiGenerateContentOptions {
  /** Attach the native `googleSearch` grounding tool. The caller owns the policy
   *  decision (the CLI's env-driven default-on). Defaults to
   *  `req.googleSearchGrounding === true`. */
  enableGoogleSearch?: boolean;
  /** Temperature applied when `req.temperature` is unset (the CLI passes 0.1). */
  temperatureDefault?: number;
}

/**
 * Build a Gemini `:generateContent` body **directly** from the neutral
 * `PushStreamRequest` — no OpenAI Chat Completions intermediate. The Gemini
 * analog of `toAnthropicMessages`: system hoist into `systemInstruction`,
 * `user`/`model` role rename, multimodal `contentParts` (text + base64 image,
 * failing loudly on an unrepresentable part), and `generationConfig` assembly.
 *
 * Gemini has **no** model-capability sampling gate (temperature/topP/topK are
 * accepted across gemini-2.5 / gemini-3.x), so there is no Phase-1-style strip
 * here. `cacheBreakpointIndices` are ignored — Gemini's explicit-cache API lives
 * on a different endpoint, so inline cache markers are a no-op (same as the
 * legacy bridge). Model is NOT emitted: Gemini carries it in the URL path.
 */
export function toGeminiGenerateContent(
  req: PushStreamRequest<LlmMessage>,
  options?: ToGeminiGenerateContentOptions,
): Record<string, unknown> {
  // Producer flip: materialize contentBlocks for multimodal/tool turns so they
  // run the block path in production. See lib/content-blocks.ts.
  const messages = withRequestContentBlocks(Array.isArray(req.messages) ? req.messages : []);
  const hasOverride =
    typeof req.systemPromptOverride === 'string' && req.systemPromptOverride.length > 0;

  const systemParts: Array<Record<string, unknown>> = [];
  const contents: Array<Record<string, unknown>> = [];

  const pushSystemText = (text: string): void => {
    if (text.length > 0) systemParts.push({ text });
  };
  if (hasOverride) pushSystemText(req.systemPromptOverride as string);

  // Resolve tool_use ids → function names up front so `tool_result` blocks
  // (which carry only `tool_use_id`) can emit Gemini's name-keyed
  // `functionResponse`. Built across the whole request since a result's call
  // lives on a prior turn.
  const toolNameById = buildToolNameById(messages);

  for (const m of messages) {
    if (m.role === 'system') {
      // Gemini's systemInstruction is text-only. The request materializer
      // normalizes rich system prompts onto `contentBlocks`; plain-string system
      // messages still flow through `content`. Non-text parts are skipped
      // (systemInstruction is text-only).
      if (m.contentBlocks && m.contentBlocks.length > 0) {
        for (const part of llmContentBlocksToGemini(m.contentBlocks, toolNameById)) {
          if (typeof part.text === 'string' && part.text.length > 0) pushSystemText(part.text);
        }
      } else {
        pushSystemText(m.content);
      }
      continue;
    }
    // Prefer the Anthropic-conceptual `contentBlocks` when present, else the
    // permanent `content` text fallback. `contentParts` are normalized into
    // blocks by `withRequestContentBlocks` before this loop.
    const parts =
      m.contentBlocks && m.contentBlocks.length > 0
        ? llmContentBlocksToGemini(m.contentBlocks, toolNameById)
        : [{ text: m.content }];
    contents.push({ role: m.role === 'assistant' ? 'model' : 'user', parts });
  }

  return assembleGeminiBody({
    contents,
    systemText: systemParts.length > 0 ? flattenSystemParts(systemParts) : '',
    maxOutputTokens: typeof req.maxTokens === 'number' ? req.maxTokens : undefined,
    temperature:
      typeof req.temperature === 'number' ? req.temperature : options?.temperatureDefault,
    topP: typeof req.topP === 'number' ? req.topP : undefined,
    enableGoogleSearch: options?.enableGoogleSearch ?? req.googleSearchGrounding === true,
    tools: req.tools,
    responseFormat: req.responseFormat,
  });
}

function mapGeminiFinishReason(reason: string | null | undefined): string {
  switch (reason) {
    case 'MAX_TOKENS':
      return 'length';
    case 'SAFETY':
    case 'RECITATION':
    case 'BLOCKLIST':
    case 'PROHIBITED_CONTENT':
    case 'SPII':
      // Gemini's safety stops are still terminal; surface as `stop` so the
      // OpenAI-shaped consumer treats the run as a clean finish rather than
      // a tool-call expectation.
      return 'stop';
    case 'STOP':
    default:
      return 'stop';
  }
}

type GeminiFunctionCall = {
  name?: unknown;
  args?: unknown;
};

type GeminiCandidatePart = {
  text?: unknown;
  functionCall?: GeminiFunctionCall;
  // Gemini 3.x signed-reasoning token; on the REST wire it is a camelCase
  // sibling of `functionCall` on the part, not a field inside it.
  thoughtSignature?: unknown;
};

type GeminiCandidate = {
  content?: { parts?: GeminiCandidatePart[] };
  finishReason?: string;
};

type GeminiStreamChunk = {
  candidates?: GeminiCandidate[];
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  };
};

function extractTextFromCandidate(candidate: GeminiCandidate | undefined): string {
  const parts = candidate?.content?.parts;
  if (!Array.isArray(parts)) return '';
  let out = '';
  for (const part of parts) {
    if (part && typeof part.text === 'string') out += part.text;
  }
  return out;
}

function stringifyGeminiFunctionCallArgs(args: unknown): string {
  if (args === undefined || args === null) return '{}';
  if (typeof args === 'string') return args.trim() ? args : '{}';
  if (typeof args === 'object') {
    try {
      return JSON.stringify(args);
    } catch {
      return '{}';
    }
  }
  return '{}';
}

function extractFunctionCallsFromCandidate(
  candidate: GeminiCandidate | undefined,
): Array<{ name: string; argsJson: string; thoughtSignature?: string }> {
  const parts = candidate?.content?.parts;
  if (!Array.isArray(parts)) return [];
  // Gemini 3.x thinking models don't always put the turn's `thoughtSignature` on
  // the `functionCall` part — it can ride on a preceding `thought`/text part (the
  // signature is tied to the thinking step). We only kept signatures that were
  // siblings of a `functionCall`, so a turn whose signature sat on a thought part
  // replayed its call bare → Gemini 400 ("Function call is missing a
  // thought_signature in functionCall parts"). Capture the first non-call part
  // signature as a fallback. Per Gemini's parallel-call rule the turn signature
  // rides the FIRST call, so the fallback only fills the first call that lacks
  // its own — it never overwrites a call's own signature or back-fills the rest.
  let fallbackSignature: string | undefined;
  for (const part of parts) {
    const sig = part?.thoughtSignature;
    if (typeof sig === 'string' && sig && !asRecord(part?.functionCall)) {
      fallbackSignature = sig;
      break;
    }
  }
  const out: Array<{ name: string; argsJson: string; thoughtSignature?: string }> = [];
  for (const part of parts) {
    const call = asRecord(part?.functionCall);
    if (!call) continue;
    const rawName = call?.name;
    if (typeof rawName !== 'string' || rawName.trim().length === 0) continue;
    const ownSig = part?.thoughtSignature;
    const sig =
      typeof ownSig === 'string' && ownSig
        ? ownSig
        : out.length === 0 // first call only
          ? fallbackSignature
          : undefined;
    out.push({
      name: rawName.trim(),
      argsJson: stringifyGeminiFunctionCallArgs(call.args),
      ...(sig ? { thoughtSignature: sig } : {}),
    });
  }
  return out;
}

/**
 * Phase 3a (Gemini): parse the Gemini `:streamGenerateContent` SSE stream
 * **directly into neutral `PushStreamEvent`s**, with no OpenAI Chat-Completions
 * SSE intermediate. This is the production response path for both the CLI and
 * the direct web Gemini route (the worker proxies Gemini's raw upstream SSE
 * straight through), so there's no translator left — the old
 * OpenAI-SSE-serialize-then-reparse detour has been removed. The test corpus
 * pins this pump to the event sequence that detour produced.
 *
 * Gemini is text-only here (no reasoning blocks, no pause_turn): each frame's
 * candidate text becomes a `text_delta` (through the same `stripTemplateTokens`
 * the pump applies, for byte-parity), usage is tracked from `usageMetadata`, and
 * a single terminal `done` is emitted at stream end with the last-seen finish
 * reason — Gemini sends no `[DONE]` sentinel and carries `finishReason` on its
 * final candidate frame.
 */
export async function* geminiEventStream(
  upstream: Response,
  signal?: AbortSignal,
  // Optional early drop of hallucinated/unknown tool names, matching the
  // `openAISSEPump` filter the web path used before this native pump replaced
  // it. The CLI omits it and relies on downstream `detectNativeToolCalls`.
  isKnownToolName?: (name: string) => boolean,
): AsyncIterable<PushStreamEvent> {
  const reader = upstream.body?.getReader();
  if (!reader) {
    yield { type: 'done', finishReason: 'stop' };
    return;
  }

  const decoder = new TextDecoder();
  let buffer = '';
  let usage: StreamUsage | undefined;
  let terminalFinishReason: 'stop' | 'length' | 'tool_calls' = 'stop';
  const pendingFunctionCalls: Array<{ name: string; argsJson: string; thoughtSignature?: string }> =
    [];

  function* flushFunctionCalls(): Generator<PushStreamEvent> {
    for (const call of pendingFunctionCalls) {
      if (isKnownToolName && !isKnownToolName(call.name)) {
        console.warn(`[Push] Native tool call "${call.name}" is not a known tool — dropped`);
        continue;
      }
      yield {
        type: 'native_tool_call',
        call: {
          name: call.name,
          args: parseNativeToolCallArgs(call.argsJson),
          // Round-trip Gemini's signed-reasoning token so it survives into the
          // stored tool_use sidecar and replays next turn. The web pump already
          // carries this; the CLI's direct event stream must too, or CLI Gemini
          // native calls lose the signature.
          ...(call.thoughtSignature ? { thoughtSignature: call.thoughtSignature } : {}),
        },
      };
    }
    pendingFunctionCalls.length = 0;
  }

  function* processFrame(raw: string): Generator<PushStreamEvent> {
    const trimmed = raw.trim();
    if (!trimmed) return;
    // Gemini emits `data: { ... }` frames under `?alt=sse`; some intermediaries
    // strip the prefix. Handle both, and ignore a stray `[DONE]`.
    const jsonStr = trimmed.startsWith('data:') ? trimmed.slice(5).trimStart() : trimmed;
    if (!jsonStr || jsonStr === '[DONE]') return;

    let parsed: GeminiStreamChunk;
    try {
      parsed = JSON.parse(jsonStr) as GeminiStreamChunk;
    } catch {
      return;
    }

    const candidate = parsed.candidates?.[0];
    const text = extractTextFromCandidate(candidate);
    if (text) {
      // Same chat-template-token strip the openAISSEPump text branch applies,
      // so the direct path stays event-for-event identical to the legacy path.
      const token = stripTemplateTokens(text);
      if (token) yield { type: 'text_delta', text: token };
    }

    const functionCalls = extractFunctionCallsFromCandidate(candidate);
    if (functionCalls.length > 0) {
      pendingFunctionCalls.push(...functionCalls);
      if (terminalFinishReason === 'stop') terminalFinishReason = 'tool_calls';
      yield { type: 'tool_call_delta' };
    }

    if (parsed.usageMetadata) {
      const inputTokens = parsed.usageMetadata.promptTokenCount ?? usage?.inputTokens ?? 0;
      const outputTokens = parsed.usageMetadata.candidatesTokenCount ?? usage?.outputTokens ?? 0;
      const totalTokens = parsed.usageMetadata.totalTokenCount ?? inputTokens + outputTokens;
      usage = { inputTokens, outputTokens, totalTokens };
    }

    if (candidate?.finishReason) {
      const mapped = mapGeminiFinishReason(candidate.finishReason);
      terminalFinishReason =
        pendingFunctionCalls.length > 0 && mapped === 'stop'
          ? 'tool_calls'
          : mapped === 'length'
            ? 'length'
            : 'stop';
    }
  }

  const onAbort = () => {
    reader.cancel().catch(() => {
      /* reader may already be closed */
    });
  };
  signal?.addEventListener('abort', onAbort, { once: true });

  try {
    while (true) {
      if (signal?.aborted) return;
      const { done, value } = await reader.read();
      if (signal?.aborted) return;
      if (done) break;

      // Normalize CRLF → LF so the `\n\n` boundary scan matches Google's edge
      // framing (same defense the translator applies).
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
        const rawEvent = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        yield* processFrame(rawEvent);
        boundary = buffer.indexOf('\n\n');
      }
    }

    if (buffer.trim()) {
      yield* processFrame(buffer);
    }
    // Gemini has no [DONE] sentinel — emit the single terminal `done` at stream
    // end with the finish reason + usage accumulated from the final frame.
    yield* flushFunctionCalls();
    yield { type: 'done', finishReason: terminalFinishReason, usage };
  } finally {
    signal?.removeEventListener('abort', onAbort);
    try {
      reader.releaseLock();
    } catch {
      /* reader may have been cancelled */
    }
  }
}
