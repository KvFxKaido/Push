import { describe, expect, it } from 'vitest';

import type { OpenAIChatRequest } from './openai-chat-types.ts';
import type {
  LlmMessage,
  PushStreamEvent,
  PushStreamRequest,
  ToolFunctionSchema,
} from './provider-contract.ts';
import {
  buildGeminiGenerateContentRequest,
  geminiEventStream,
  toGeminiGenerateContent,
} from './gemini-bridge.ts';
import { flatToolToOpenAITool } from './openai-chat-serializer.ts';
import { GEMINI_MISSING_THOUGHT_SIGNATURE_PLACEHOLDER } from './gemini-thought-signature.ts';
import { getToolFunctionSchemas } from './tool-function-schemas.ts';

function createEventStreamResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(chunk));
        }
        controller.close();
      },
    }),
  );
}

const readFileTool: ToolFunctionSchema = {
  name: 'sandbox_read_file',
  description: 'Read a file from the active workspace',
  input_schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Repo-relative path' },
    },
    required: ['path'],
    additionalProperties: false,
  },
};

describe('buildGeminiGenerateContentRequest', () => {
  it('renames assistant -> model, hoists system into systemInstruction', () => {
    const request: OpenAIChatRequest = {
      model: 'gemini-3.1-pro-preview',
      messages: [
        { role: 'system', content: 'Be concise.' },
        { role: 'developer', content: [{ type: 'text', text: 'Use markdown.' }] },
        { role: 'user', content: 'Hi' },
        { role: 'assistant', content: 'Hello back' },
        { role: 'user', content: 'Continue' },
      ],
      max_completion_tokens: 1024,
      temperature: 0.3,
      top_p: 0.95,
      stream: true,
    };

    expect(buildGeminiGenerateContentRequest(request)).toEqual({
      contents: [
        { role: 'user', parts: [{ text: 'Hi' }] },
        { role: 'model', parts: [{ text: 'Hello back' }] },
        { role: 'user', parts: [{ text: 'Continue' }] },
      ],
      systemInstruction: { parts: [{ text: 'Be concise.\n\nUse markdown.' }] },
      generationConfig: { maxOutputTokens: 1024, temperature: 0.3, topP: 0.95 },
    });
  });

  it('falls back to max_tokens when max_completion_tokens is absent', () => {
    expect(
      buildGeminiGenerateContentRequest({
        model: 'gemini-2.5-flash',
        messages: [{ role: 'user', content: 'x' }],
        max_tokens: 256,
      } as OpenAIChatRequest),
    ).toMatchObject({ generationConfig: { maxOutputTokens: 256 } });
  });

  it('pads contents with an empty user turn when only system messages are present', () => {
    expect(
      buildGeminiGenerateContentRequest({
        model: 'gemini-3.1-pro-preview',
        messages: [{ role: 'system', content: 'preamble only' }],
      } as OpenAIChatRequest),
    ).toEqual({
      contents: [{ role: 'user', parts: [{ text: '' }] }],
      systemInstruction: { parts: [{ text: 'preamble only' }] },
    });
  });

  it('unshifts an empty user turn when the first non-system message is an assistant', () => {
    // After context compaction the user prefix can get lopped off and the
    // first non-system message is an assistant turn. Gemini 400s on
    // `contents must not start with a model turn`, so we pad with an empty
    // user turn to satisfy the upstream invariant.
    expect(
      buildGeminiGenerateContentRequest({
        model: 'gemini-3.1-pro-preview',
        messages: [
          { role: 'system', content: 'be terse' },
          { role: 'assistant', content: 'Earlier answer.' },
          { role: 'user', content: 'follow-up' },
        ],
      } as OpenAIChatRequest),
    ).toEqual({
      contents: [
        { role: 'user', parts: [{ text: '' }] },
        { role: 'model', parts: [{ text: 'Earlier answer.' }] },
        { role: 'user', parts: [{ text: 'follow-up' }] },
      ],
      systemInstruction: { parts: [{ text: 'be terse' }] },
    });
  });

  it('translates inline image_url data URLs into Gemini inline_data parts', () => {
    const body = buildGeminiGenerateContentRequest({
      model: 'gemini-2.5-pro',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Describe' },
            {
              type: 'image_url',
              image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' },
            },
          ],
        },
      ],
    } as OpenAIChatRequest);

    expect(body).toEqual({
      contents: [
        {
          role: 'user',
          parts: [
            { text: 'Describe' },
            { inline_data: { mime_type: 'image/png', data: 'iVBORw0KGgo=' } },
          ],
        },
      ],
    });
  });

  it('adds googleSearch tool when google_search_grounding is true', () => {
    const body = buildGeminiGenerateContentRequest({
      model: 'gemini-3.1-pro-preview',
      messages: [{ role: 'user', content: 'What is the weather today?' }],
      google_search_grounding: true,
    } as OpenAIChatRequest);

    expect(body).toMatchObject({
      tools: [{ googleSearch: {} }],
    });
  });

  it('translates OpenAI function tools into Gemini functionDeclarations and drops grounding', () => {
    // `google_search_grounding` is set AND function tools are attached. Gemini only
    // supports that combination on Gemini 3 (Preview) and rejects it on gemini-2.5-*,
    // so the bridge drops grounding whenever native function tools are present —
    // function calling wins. See the dedicated drop test below.
    const body = buildGeminiGenerateContentRequest({
      model: 'gemini-3.1-pro-preview',
      messages: [{ role: 'user', content: 'Read README.md' }],
      tools: [flatToolToOpenAITool(readFileTool)],
      google_search_grounding: true,
    } as OpenAIChatRequest);

    expect(body.tools).toEqual([
      {
        functionDeclarations: [
          {
            name: 'sandbox_read_file',
            description: 'Read a file from the active workspace',
            parameters: {
              type: 'OBJECT',
              properties: {
                path: { type: 'STRING', description: 'Repo-relative path' },
              },
              required: ['path'],
            },
          },
        ],
      },
    ]);
  });

  it('drops googleSearch grounding when native function tools are present (combo unsupported on gemini-2.5)', () => {
    const withTools = buildGeminiGenerateContentRequest({
      model: 'gemini-2.5-flash',
      messages: [{ role: 'user', content: 'Read README.md' }],
      tools: [flatToolToOpenAITool(readFileTool)],
      google_search_grounding: true,
    } as OpenAIChatRequest);
    // Only functionDeclarations — no googleSearch entry.
    expect(withTools.tools).toHaveLength(1);
    expect(withTools.tools).not.toContainEqual({ googleSearch: {} });

    // Grounding-only turns (no function schemas) keep grounding.
    const groundingOnly = buildGeminiGenerateContentRequest({
      model: 'gemini-2.5-flash',
      messages: [{ role: 'user', content: 'weather?' }],
      google_search_grounding: true,
    } as OpenAIChatRequest);
    expect(groundingOnly.tools).toEqual([{ googleSearch: {} }]);
  });

  it('omits generationConfig when no sampling params are set', () => {
    const body = buildGeminiGenerateContentRequest({
      model: 'gemini-3.1-pro-preview',
      messages: [{ role: 'user', content: 'x' }],
    } as OpenAIChatRequest);
    expect(body).not.toHaveProperty('generationConfig');
  });
});

describe('Gemini functionDeclaration schema translation (empty-OBJECT guards)', () => {
  // Gemini rejects an OBJECT schema with no properties ("should be non-empty for
  // OBJECT type"), so the converter must never emit one — at the top level
  // (parameterless tools), as a nested property (open-ended objects), or as
  // array items (object-typed arrays). The full tool registry ships every round,
  // so a single offender 400s the whole request before the model can respond.
  const decl = (tool: ToolFunctionSchema): Record<string, unknown> => {
    const body = buildGeminiGenerateContentRequest({
      model: 'gemini-2.5-flash',
      messages: [{ role: 'user', content: 'go' }],
      // Legacy entry takes OpenAI-nested tools; nest the flat canonical fixture.
      tools: [flatToolToOpenAITool(tool)],
    } as OpenAIChatRequest);
    const tools = body.tools as Array<{ functionDeclarations: Array<Record<string, unknown>> }>;
    return tools[0].functionDeclarations[0];
  };

  it('omits `parameters` for a parameterless tool (no empty OBJECT)', () => {
    const noArg: ToolFunctionSchema = {
      name: 'sandbox_typecheck',
      description: 'Run typecheck',
      input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
    };
    const d = decl(noArg);
    expect(d).toEqual({ name: 'sandbox_typecheck', description: 'Run typecheck' });
    expect(d).not.toHaveProperty('parameters');
  });

  it('represents an open-ended object property as STRING', () => {
    const objParam: ToolFunctionSchema = {
      name: 'workflow_run',
      description: 'Dispatch a workflow',
      input_schema: {
        type: 'object',
        properties: { inputs: { type: 'object' } },
        required: ['inputs'],
        additionalProperties: false,
      },
    };
    const params = decl(objParam).parameters as {
      type: string;
      properties: Record<string, { type: string }>;
      required?: string[];
    };
    expect(params.type).toBe('OBJECT');
    expect(params.properties.inputs).toEqual({ type: 'STRING' });
    // `required` survives because `inputs` is still an emitted property.
    expect(params.required).toEqual(['inputs']);
  });

  it('represents object-typed array items as STRING items', () => {
    const arrParam: ToolFunctionSchema = {
      name: 'edit_file',
      description: 'Apply edits',
      input_schema: {
        type: 'object',
        properties: { edits: { type: 'array', items: { type: 'object' } } },
        required: ['edits'],
        additionalProperties: false,
      },
    };
    const params = decl(arrParam).parameters as {
      properties: { edits: { type: string; items: { type: string } } };
    };
    expect(params.properties.edits).toEqual({ type: 'ARRAY', items: { type: 'STRING' } });
  });

  it('drops a `required` entry whose property was not emitted', () => {
    // A property whose value is not a valid schema object gets skipped; the
    // converter must not leave it dangling in `required` (Gemini rejects that too).
    const dangling: ToolFunctionSchema = {
      name: 'odd_tool',
      description: 'x',
      input_schema: {
        type: 'object',
        properties: { path: { type: 'string' }, ghost: null as unknown as object },
        required: ['path', 'ghost'],
        additionalProperties: false,
      },
    };
    const params = decl(dangling).parameters as {
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(Object.keys(params.properties)).toEqual(['path']);
    expect(params.required).toEqual(['path']);
  });

  it('emits no empty-OBJECT schema for any real registry tool (full set, end to end)', () => {
    // The strongest guard against the P1: translate the *actual* tool registry
    // and walk every node of the resulting body, asserting Gemini's "OBJECT needs
    // non-empty properties" rule holds everywhere — and that no `required` entry
    // dangles past a dropped property.
    const tools = getToolFunctionSchemas();
    expect(tools.length).toBeGreaterThan(0);
    const body = buildGeminiGenerateContentRequest({
      model: 'gemini-2.5-flash',
      messages: [{ role: 'user', content: 'go' }],
      tools: tools.map(flatToolToOpenAITool),
    } as OpenAIChatRequest);

    const offenders: string[] = [];
    const walk = (node: unknown, path: string): void => {
      if (Array.isArray(node)) {
        node.forEach((n, i) => walk(n, `${path}[${i}]`));
        return;
      }
      if (!node || typeof node !== 'object') return;
      const obj = node as Record<string, unknown>;
      if (obj.type === 'OBJECT') {
        const props = obj.properties as Record<string, unknown> | undefined;
        if (!props || Object.keys(props).length === 0)
          offenders.push(`${path}: OBJECT w/o properties`);
        const req = Array.isArray(obj.required) ? (obj.required as string[]) : [];
        for (const r of req) {
          if (!props || !(r in props))
            offenders.push(`${path}: required "${r}" missing from properties`);
        }
      }
      for (const [k, v] of Object.entries(obj)) walk(v, `${path}.${k}`);
    };
    walk(body.tools, 'tools');
    expect(offenders).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Phase 2 (Gemini parity): toGeminiGenerateContent — direct neutral -> Gemini
// serializer. Pinned byte-for-byte against the legacy build-OpenAI-shape-then-
// bridge path the CLI used before, for the string-content cases that path
// supported; multimodal is new and tested directly.
// ---------------------------------------------------------------------------

function llm(
  id: string,
  role: LlmMessage['role'],
  content: string,
  contentParts?: unknown,
): LlmMessage {
  return {
    id,
    role,
    content,
    timestamp: 0,
    ...(contentParts ? { contentParts: contentParts as LlmMessage['contentParts'] } : {}),
  };
}

/** Reproduces the pre-Phase-2 CLI path: PushStreamRequest -> OpenAI shape ->
 *  buildGeminiGenerateContentRequest. (Gemini emits no `model` in the body.) */
function legacyGeminiDetour(
  req: PushStreamRequest<LlmMessage>,
  opts: { model: string; enableGoogleSearch: boolean },
): Record<string, unknown> {
  const openAIMessages: OpenAIChatRequest['messages'] = [];
  if (req.systemPromptOverride) {
    openAIMessages.push({ role: 'system', content: req.systemPromptOverride });
  }
  for (const m of req.messages) {
    openAIMessages.push({ role: m.role, content: m.content });
  }
  const openAIRequest: OpenAIChatRequest = {
    model: opts.model,
    messages: openAIMessages,
    stream: true,
    temperature: req.temperature ?? 0.1,
    ...(req.topP !== undefined ? { top_p: req.topP } : {}),
    ...(req.maxTokens !== undefined ? { max_tokens: req.maxTokens } : {}),
    ...(opts.enableGoogleSearch ? { google_search_grounding: true } : {}),
  };
  return buildGeminiGenerateContentRequest(openAIRequest);
}

describe('toGeminiGenerateContent — drift vs legacy OpenAI-detour path', () => {
  const corpus: Array<{
    name: string;
    req: PushStreamRequest<LlmMessage>;
    enableGoogleSearch: boolean;
  }> = [
    {
      name: 'single user turn (0.1 temperature default)',
      req: { provider: 'google', model: 'gemini-3.5-flash', messages: [llm('1', 'user', 'hi')] },
      enableGoogleSearch: false,
    },
    {
      name: 'system override + multi-turn + grounding',
      req: {
        provider: 'google',
        model: 'gemini-3.5-flash',
        systemPromptOverride: 'Be concise.',
        messages: [
          llm('1', 'user', 'Hi'),
          llm('2', 'assistant', 'Hello'),
          llm('3', 'user', 'More'),
        ],
      },
      enableGoogleSearch: true,
    },
    {
      name: 'system message inside messages',
      req: {
        provider: 'google',
        model: 'gemini-3.5-flash',
        messages: [llm('0', 'system', 'sys text'), llm('1', 'user', 'u1')],
      },
      enableGoogleSearch: false,
    },
    {
      name: 'explicit temperature + topP + maxTokens (no Phase-1 strip on Gemini)',
      req: {
        provider: 'google',
        model: 'gemini-3.5-flash',
        temperature: 0.4,
        topP: 0.9,
        maxTokens: 2048,
        messages: [llm('1', 'user', 'hi')],
      },
      enableGoogleSearch: false,
    },
    {
      name: 'assistant-first transcript pads a leading user turn',
      req: {
        provider: 'google',
        model: 'gemini-3.5-flash',
        messages: [llm('1', 'assistant', 'resuming'), llm('2', 'user', 'ok')],
      },
      enableGoogleSearch: false,
    },
  ];

  for (const { name, req, enableGoogleSearch } of corpus) {
    it(`byte-equal to legacy detour: ${name}`, () => {
      const direct = toGeminiGenerateContent(req, { enableGoogleSearch, temperatureDefault: 0.1 });
      const legacy = legacyGeminiDetour(req, { model: req.model, enableGoogleSearch });
      expect(direct).toEqual(legacy);
    });
  }

  it('forwards both temperature and topP — Gemini has no sampling-param removal', () => {
    const body = toGeminiGenerateContent({
      provider: 'google',
      model: 'gemini-3.5-flash',
      temperature: 0.2,
      topP: 0.8,
      messages: [llm('1', 'user', 'hi')],
    });
    expect(body.generationConfig).toEqual({ temperature: 0.2, topP: 0.8 });
  });

  it('reads a system message from contentParts (defensive — mirrors toAnthropicMessages)', () => {
    // google isn't cacheable so its system message is normally a plain string,
    // but if a system message ever arrives in content-part form (validator lands
    // array content there with content:''), reading `content` alone would drop
    // the whole system prompt. Honor contentParts defensively.
    const body = toGeminiGenerateContent({
      provider: 'google',
      model: 'gemini-3.5-flash',
      messages: [
        llm('s', 'system', '', [{ type: 'text', text: 'be terse' }]),
        llm('1', 'user', 'hi'),
      ],
    });
    expect(body.systemInstruction).toEqual({ parts: [{ text: 'be terse' }] });
  });

  it('serializes neutral native tools as Gemini functionDeclarations', () => {
    const body = toGeminiGenerateContent({
      provider: 'google',
      model: 'gemini-3.5-flash',
      messages: [llm('1', 'user', 'read it')],
      tools: [readFileTool],
    });

    expect(body.tools).toEqual([
      {
        functionDeclarations: [
          {
            name: 'sandbox_read_file',
            description: 'Read a file from the active workspace',
            parameters: {
              type: 'OBJECT',
              properties: {
                path: { type: 'STRING', description: 'Repo-relative path' },
              },
              required: ['path'],
            },
          },
        ],
      },
    ]);
  });
});

describe('toGeminiGenerateContent — multimodal contentParts', () => {
  const PNG = 'data:image/png;base64,iVBORw0KGgo=';
  const userParts = (parts: unknown): LlmMessage => llm('1', 'user', 'text fallback', parts);
  const firstParts = (body: Record<string, unknown>): Array<Record<string, unknown>> =>
    (body.contents as Array<{ parts: Array<Record<string, unknown>> }>)[0].parts;

  it('serializes text + base64 image parts as Gemini text + inline_data', () => {
    const body = toGeminiGenerateContent({
      provider: 'google',
      model: 'gemini-3.5-flash',
      messages: [
        userParts([
          { type: 'text', text: 'what is this?' },
          { type: 'image_url', image_url: { url: PNG } },
        ]),
      ],
    });
    expect(firstParts(body)).toEqual([
      { text: 'what is this?' },
      { inline_data: { mime_type: 'image/png', data: 'iVBORw0KGgo=' } },
    ]);
  });

  it('falls back to content text when contentParts is empty', () => {
    const body = toGeminiGenerateContent({
      provider: 'google',
      model: 'gemini-3.5-flash',
      messages: [userParts([])],
    });
    expect(firstParts(body)).toEqual([{ text: 'text fallback' }]);
  });

  it('throws loudly on an unsupported content part type', () => {
    expect(() =>
      toGeminiGenerateContent({
        provider: 'google',
        model: 'gemini-3.5-flash',
        messages: [userParts([{ type: 'audio', audio: {} }])],
      }),
    ).toThrow(/unsupported or malformed content part/);
  });

  it('throws loudly on a non-data image URL (Gemini inline needs base64)', () => {
    expect(() =>
      toGeminiGenerateContent({
        provider: 'google',
        model: 'gemini-3.5-flash',
        messages: [
          userParts([{ type: 'image_url', image_url: { url: 'https://example.com/c.png' } }]),
        ],
      }),
    ).toThrow(/cannot represent image/);
  });
});

describe('toGeminiGenerateContent — contentBlocks', () => {
  const req = (message: Partial<LlmMessage>): PushStreamRequest<LlmMessage> =>
    ({
      provider: 'google',
      model: 'gemini-3.5-flash',
      messages: [
        { id: '1', role: 'user', content: 'fallback', timestamp: 0, ...message } as LlmMessage,
      ],
    }) as PushStreamRequest<LlmMessage>;
  const firstParts = (body: Record<string, unknown>): Array<Record<string, unknown>> =>
    (body.contents as Array<{ parts: Array<Record<string, unknown>> }>)[0].parts;

  it('serializes text + base64 image blocks as Gemini text + inline_data', () => {
    const body = toGeminiGenerateContent(
      req({
        contentBlocks: [
          { type: 'text', text: 'what is this?' },
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' },
          },
        ],
      }),
    );
    expect(firstParts(body)).toEqual([
      { text: 'what is this?' },
      { inline_data: { mime_type: 'image/png', data: 'iVBORw0KGgo=' } },
    ]);
  });

  it('drops thinking blocks (Gemini surfaces text only)', () => {
    const body = toGeminiGenerateContent(
      req({
        role: 'assistant',
        contentBlocks: [
          { type: 'thinking', text: 'hmm', signature: 's' },
          { type: 'text', text: 'answer' },
        ],
      }),
    );
    // Assistant turns are renamed to `model`; assert on that turn directly
    // (Gemini front-pads an empty user turn before a leading model turn).
    const contents = body.contents as Array<{
      role: string;
      parts: Array<Record<string, unknown>>;
    }>;
    expect(contents.find((c) => c.role === 'model')?.parts).toEqual([{ text: 'answer' }]);
  });

  it('prefers contentBlocks over contentParts and content', () => {
    const body = toGeminiGenerateContent(
      req({
        content: 'text fallback',
        contentParts: [{ type: 'text', text: 'parts fallback' }],
        contentBlocks: [{ type: 'text', text: 'blocks win' }],
      }),
    );
    expect(firstParts(body)).toEqual([{ text: 'blocks win' }]);
  });

  it('honors contentBlocks on a system turn (hoisted into systemInstruction)', () => {
    const body = toGeminiGenerateContent(
      req({ role: 'system', content: '', contentBlocks: [{ type: 'text', text: 'be terse' }] }),
    );
    expect(body.systemInstruction).toEqual({ parts: [{ text: 'be terse' }] });
  });

  it('throws on a remote image url source (Gemini inline needs base64)', () => {
    expect(() =>
      toGeminiGenerateContent(
        req({
          contentBlocks: [
            { type: 'image', source: { type: 'url', url: 'https://example.com/c.png' } },
          ],
        }),
      ),
    ).toThrow(/cannot represent image/);
  });

  it('maps a tool_use block to a Gemini functionCall part (input is args verbatim)', () => {
    const body = toGeminiGenerateContent(
      req({
        role: 'assistant',
        contentBlocks: [
          { type: 'text', text: 'calling' },
          { type: 'tool_use', id: 'c1', name: 'read', input: { path: 'a.ts' } },
        ],
      }),
    );
    const contents = body.contents as Array<{
      role: string;
      parts: Array<Record<string, unknown>>;
    }>;
    expect(contents.find((c) => c.role === 'model')?.parts).toEqual([
      { text: 'calling' },
      // The call `id` is emitted for Gemini 3 correlation. The turn's first
      // functionCall carried no captured signature, so the documented placeholder
      // is backfilled (Gemini 3.x 400s on a bare first call).
      {
        functionCall: { id: 'c1', name: 'read', args: { path: 'a.ts' } },
        thoughtSignature: GEMINI_MISSING_THOUGHT_SIGNATURE_PLACEHOLDER,
      },
    ]);
  });

  it('replays a tool_use block thoughtSignature as a sibling of the functionCall part', () => {
    const body = toGeminiGenerateContent(
      req({
        role: 'assistant',
        contentBlocks: [
          {
            type: 'tool_use',
            id: 'c1',
            name: 'read',
            input: { path: 'a.ts' },
            thoughtSignature: 'AgQKAabc123==',
          },
        ],
      }),
    );
    const contents = body.contents as Array<{
      role: string;
      parts: Array<Record<string, unknown>>;
    }>;
    // The signature is a sibling of `functionCall` on the part (not nested in
    // it), replayed verbatim so Gemini 3.x accepts the continued turn.
    expect(contents.find((c) => c.role === 'model')?.parts).toEqual([
      {
        functionCall: { id: 'c1', name: 'read', args: { path: 'a.ts' } },
        thoughtSignature: 'AgQKAabc123==',
      },
    ]);
  });

  it('backfills the placeholder on the turn-first functionCall that carries no signature', () => {
    // A call that never carried a signature (text-dispatched, an upstream that
    // dropped it, or cross-model-transfer history replayed to Gemini) would make
    // Gemini 3.x 400 ("missing a thought_signature"). The documented placeholder
    // is substituted so the turn replays instead.
    const body = toGeminiGenerateContent(
      req({
        role: 'assistant',
        contentBlocks: [{ type: 'tool_use', id: 'c1', name: 'read', input: { path: 'a.ts' } }],
      }),
    );
    const contents = body.contents as Array<{
      role: string;
      parts: Array<Record<string, unknown>>;
    }>;
    const part = contents.find((c) => c.role === 'model')?.parts[0];
    expect(part).toMatchObject({
      functionCall: { id: 'c1', name: 'read', args: { path: 'a.ts' } },
      thoughtSignature: GEMINI_MISSING_THOUGHT_SIGNATURE_PLACEHOLDER,
    });
  });

  it('backfills only the turn-first call; trailing parallel calls stay bare', () => {
    // Gemini attaches the turn signature to the FIRST parallel call only and
    // validates that one; the rest legitimately carry none, so the fallback must
    // not pad them.
    const body = toGeminiGenerateContent(
      req({
        role: 'assistant',
        contentBlocks: [
          { type: 'tool_use', id: 'c1', name: 'read', input: { path: 'a.ts' } },
          { type: 'tool_use', id: 'c2', name: 'read', input: { path: 'b.ts' } },
        ],
      }),
    );
    const parts =
      (body.contents as Array<{ role: string; parts: Array<Record<string, unknown>> }>).find(
        (c) => c.role === 'model',
      )?.parts ?? [];
    expect(parts[0]).toMatchObject({
      functionCall: { id: 'c1', name: 'read', args: { path: 'a.ts' } },
      thoughtSignature: GEMINI_MISSING_THOUGHT_SIGNATURE_PLACEHOLDER,
    });
    expect(parts[1]).toEqual({
      functionCall: { id: 'c2', name: 'read', args: { path: 'b.ts' } },
    });
  });

  it('does not override a real captured signature on the first call', () => {
    const body = toGeminiGenerateContent(
      req({
        role: 'assistant',
        contentBlocks: [
          {
            type: 'tool_use',
            id: 'c1',
            name: 'read',
            input: { path: 'a.ts' },
            thoughtSignature: 'AgQKAreal==',
          },
          { type: 'tool_use', id: 'c2', name: 'read', input: { path: 'b.ts' } },
        ],
      }),
    );
    const parts =
      (body.contents as Array<{ role: string; parts: Array<Record<string, unknown>> }>).find(
        (c) => c.role === 'model',
      )?.parts ?? [];
    expect(parts[0]).toMatchObject({ thoughtSignature: 'AgQKAreal==' });
    // The first call had a real signature, so the second (bare) call is left bare
    // rather than receiving the placeholder.
    expect(parts[1]).not.toHaveProperty('thoughtSignature');
  });

  it('maps a tool_result block to a functionResponse with the id + resolved name', () => {
    const body = toGeminiGenerateContent({
      provider: 'google',
      model: 'gemini-3.5-flash',
      messages: [
        {
          id: '1',
          role: 'assistant',
          content: '',
          timestamp: 0,
          contentBlocks: [{ type: 'tool_use', id: 'c1', name: 'read', input: { path: 'a.ts' } }],
        },
        {
          id: '2',
          role: 'user',
          content: '',
          timestamp: 0,
          contentBlocks: [{ type: 'tool_result', tool_use_id: 'c1', content: 'file body' }],
        },
      ],
    } as PushStreamRequest<LlmMessage>);
    const contents = body.contents as Array<{
      role: string;
      parts: Array<Record<string, unknown>>;
    }>;
    // The result turn (user role) carries an id- and name-keyed functionResponse.
    expect(contents.at(-1)).toEqual({
      role: 'user',
      parts: [{ functionResponse: { id: 'c1', name: 'read', response: { output: 'file body' } } }],
    });
  });

  it('preserves is_error structurally in the functionResponse', () => {
    const body = toGeminiGenerateContent({
      provider: 'google',
      model: 'gemini-3.5-flash',
      messages: [
        {
          id: '1',
          role: 'assistant',
          content: '',
          timestamp: 0,
          contentBlocks: [{ type: 'tool_use', id: 'c1', name: 'read', input: {} }],
        },
        {
          id: '2',
          role: 'user',
          content: '',
          timestamp: 0,
          contentBlocks: [
            { type: 'tool_result', tool_use_id: 'c1', content: 'boom', is_error: true },
          ],
        },
      ],
    } as PushStreamRequest<LlmMessage>);
    const contents = body.contents as Array<{
      role: string;
      parts: Array<Record<string, unknown>>;
    }>;
    expect(contents.at(-1)?.parts).toEqual([
      {
        functionResponse: { id: 'c1', name: 'read', response: { output: 'boom', is_error: true } },
      },
    ]);
  });

  it('throws when a tool_result references a tool_use_id with no matching tool_use in the request', () => {
    expect(() =>
      toGeminiGenerateContent(
        req({
          role: 'user',
          contentBlocks: [{ type: 'tool_result', tool_use_id: 'missing', content: 'x' }],
        }),
      ),
    ).toThrow(/cannot resolve a function name for tool_result/);
  });
});

// ---------------------------------------------------------------------------
// Phase 3a (Gemini): geminiEventStream — Gemini SSE parsed directly into neutral
// PushStreamEvents. This is the production response path for both the CLI and
// the direct web Gemini route (the worker proxies Gemini's raw upstream SSE
// straight through). Expected sequences below were pinned from the now-removed
// createGeminiTranslatedStream -> openAISSEPump detour the CLI used before, so
// the native pump's behavior stays event-for-event identical to that baseline.
// ---------------------------------------------------------------------------

async function collectEvents(stream: AsyncIterable<PushStreamEvent>): Promise<PushStreamEvent[]> {
  const out: PushStreamEvent[] = [];
  for await (const e of stream) out.push(e);
  return out;
}

const frame = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`;

describe('toGeminiGenerateContent — structured output', () => {
  const schema = {
    type: 'object',
    properties: { verdict: { type: 'string' } },
    required: ['verdict'],
    additionalProperties: false,
  };
  const req = (extra: Partial<PushStreamRequest<LlmMessage>>): PushStreamRequest<LlmMessage> =>
    ({
      provider: 'google',
      model: 'gemini-3.1-pro-preview',
      messages: [{ id: '1', role: 'user', content: 'audit', timestamp: 0 } as LlmMessage],
      ...extra,
    }) as PushStreamRequest<LlmMessage>;

  it('emits responseMimeType + responseSchema (Gemini OpenAPI subset) for a responseFormat', () => {
    const body = toGeminiGenerateContent(req({ responseFormat: { name: 'verdict', schema } })) as {
      generationConfig?: {
        responseMimeType?: string;
        responseSchema?: { type?: string; properties?: Record<string, { type?: string }> };
      };
    };
    expect(body.generationConfig?.responseMimeType).toBe('application/json');
    // Converted to Gemini's uppercase OpenAPI-subset shape via the same path tool
    // params use; `additionalProperties` (unsupported by Gemini) is dropped.
    expect(body.generationConfig?.responseSchema?.type).toBe('OBJECT');
    expect(body.generationConfig?.responseSchema?.properties?.verdict?.type).toBe('STRING');
  });

  it('skips responseSchema when function tools are present (Gemini rejects the combo)', () => {
    const readFileTool: ToolFunctionSchema = {
      name: 'sandbox_read_file',
      description: 'Read a file',
      input_schema: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
        additionalProperties: false,
      },
    };
    const body = toGeminiGenerateContent(
      req({ responseFormat: { name: 'verdict', schema }, tools: [readFileTool] }),
    ) as {
      generationConfig?: { responseSchema?: unknown };
      tools?: Array<{ functionDeclarations?: unknown }>;
    };
    expect(body.generationConfig?.responseSchema).toBeUndefined();
    expect(body.tools?.[0]?.functionDeclarations).toBeDefined();
  });

  it('suppresses googleSearch grounding when structured output is requested', () => {
    // Grounding is default-on on web/CLI; Gemini rejects responseSchema + any
    // tool (incl. googleSearch), so a verdict turn must not ship both. (#1192 P2.)
    const body = toGeminiGenerateContent(
      req({ responseFormat: { name: 'verdict', schema }, googleSearchGrounding: true }),
    ) as {
      generationConfig?: { responseSchema?: { type?: string } };
      tools?: unknown;
    };
    expect(body.generationConfig?.responseSchema?.type).toBe('OBJECT');
    expect(body.tools).toBeUndefined();
  });

  it('omits structured-output fields when no responseFormat is set', () => {
    const body = toGeminiGenerateContent(req({})) as {
      generationConfig?: { responseMimeType?: string; responseSchema?: unknown };
    };
    expect(body.generationConfig?.responseMimeType).toBeUndefined();
    expect(body.generationConfig?.responseSchema).toBeUndefined();
  });
});

describe('geminiEventStream — Gemini SSE -> neutral events', () => {
  const corpus: Array<{ name: string; frames: string[]; expected: PushStreamEvent[] }> = [
    {
      name: 'multi-frame text + STOP + usage',
      frames: [
        frame({ candidates: [{ content: { parts: [{ text: 'Hello' }] } }] }),
        frame({ candidates: [{ content: { parts: [{ text: ', world' }] } }] }),
        frame({
          candidates: [{ content: { parts: [{ text: '!' }] }, finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 3, totalTokenCount: 7 },
        }),
      ],
      expected: [
        { type: 'text_delta', text: 'Hello' },
        { type: 'text_delta', text: ', world' },
        { type: 'text_delta', text: '!' },
        {
          type: 'done',
          finishReason: 'stop',
          usage: { inputTokens: 4, outputTokens: 3, totalTokens: 7 },
        },
      ],
    },
    {
      name: 'MAX_TOKENS -> length',
      frames: [
        frame({
          candidates: [{ content: { parts: [{ text: 'cut' }] }, finishReason: 'MAX_TOKENS' }],
        }),
      ],
      expected: [
        { type: 'text_delta', text: 'cut' },
        { type: 'done', finishReason: 'length' },
      ],
    },
    {
      name: 'text with a chat-template control token is stripped',
      frames: [
        frame({
          candidates: [{ content: { parts: [{ text: 'hi<|im_end|>' }] }, finishReason: 'STOP' }],
        }),
      ],
      expected: [
        { type: 'text_delta', text: 'hi' },
        { type: 'done', finishReason: 'stop' },
      ],
    },
    {
      name: 'malformed JSON frame is ignored',
      frames: [
        'data: { not valid json\n\n',
        frame({ candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }] }),
      ],
      expected: [
        { type: 'text_delta', text: 'ok' },
        { type: 'done', finishReason: 'stop' },
      ],
    },
    {
      name: 'no usageMetadata -> done without usage',
      frames: [
        frame({ candidates: [{ content: { parts: [{ text: 'plain' }] }, finishReason: 'STOP' }] }),
      ],
      expected: [
        { type: 'text_delta', text: 'plain' },
        { type: 'done', finishReason: 'stop' },
      ],
    },
    {
      name: 'bare JSON frame (no data: prefix)',
      frames: [
        `${JSON.stringify({ candidates: [{ content: { parts: [{ text: 'bare' }] }, finishReason: 'STOP' }] })}\n\n`,
      ],
      expected: [
        { type: 'text_delta', text: 'bare' },
        { type: 'done', finishReason: 'stop' },
      ],
    },
    {
      name: 'stream ends without a finishReason frame (clean close -> stop)',
      frames: [frame({ candidates: [{ content: { parts: [{ text: 'tail' }] } }] })],
      expected: [
        { type: 'text_delta', text: 'tail' },
        { type: 'done', finishReason: 'stop' },
      ],
    },
    {
      name: 'functionCall part flushes as dispatcher JSON',
      frames: [
        frame({
          candidates: [
            {
              content: {
                parts: [
                  { functionCall: { name: 'sandbox_read_file', args: { path: 'README.md' } } },
                ],
              },
              finishReason: 'STOP',
            },
          ],
        }),
      ],
      expected: [
        { type: 'tool_call_delta' },
        {
          type: 'native_tool_call',
          call: { name: 'sandbox_read_file', args: { path: 'README.md' } },
        },
        { type: 'done', finishReason: 'tool_calls' },
      ],
    },
    {
      name: 'functionCall part with clean close still finishes as tool_calls',
      frames: [
        frame({
          candidates: [
            {
              content: {
                parts: [
                  { functionCall: { name: 'sandbox_read_file', args: { path: 'README.md' } } },
                ],
              },
            },
          ],
        }),
      ],
      expected: [
        { type: 'tool_call_delta' },
        {
          type: 'native_tool_call',
          call: { name: 'sandbox_read_file', args: { path: 'README.md' } },
        },
        { type: 'done', finishReason: 'tool_calls' },
      ],
    },
    {
      name: 'thoughtSignature on the functionCall part rides onto the native call',
      frames: [
        frame({
          candidates: [
            {
              content: {
                parts: [
                  {
                    functionCall: { name: 'sandbox_read_file', args: { path: 'README.md' } },
                    thoughtSignature: 'SIG_ON_CALL==',
                  },
                ],
              },
              finishReason: 'STOP',
            },
          ],
        }),
      ],
      expected: [
        { type: 'tool_call_delta' },
        {
          type: 'native_tool_call',
          call: {
            name: 'sandbox_read_file',
            args: { path: 'README.md' },
            thoughtSignature: 'SIG_ON_CALL==',
          },
        },
        { type: 'done', finishReason: 'tool_calls' },
      ],
    },
    {
      // Gemini 3.x thinking: the turn signature can ride a `thought` part, not the
      // functionCall part. Without the fallback the call replayed bare → Gemini 400
      // ("Function call is missing a thought_signature in functionCall parts").
      name: 'thoughtSignature on a preceding thought part falls back onto the call',
      frames: [
        frame({
          candidates: [
            {
              content: {
                parts: [
                  { thought: true, thoughtSignature: 'SIG_ON_THOUGHT==' },
                  { functionCall: { name: 'sandbox_read_file', args: { path: 'README.md' } } },
                ],
              },
              finishReason: 'STOP',
            },
          ],
        }),
      ],
      expected: [
        { type: 'tool_call_delta' },
        {
          type: 'native_tool_call',
          call: {
            name: 'sandbox_read_file',
            args: { path: 'README.md' },
            thoughtSignature: 'SIG_ON_THOUGHT==',
          },
        },
        { type: 'done', finishReason: 'tool_calls' },
      ],
    },
    {
      // Parallel calls: Gemini puts the turn signature on the FIRST call only, so
      // the thought-part fallback fills just the first — the second stays bare.
      name: 'thought-part signature fills only the first of parallel calls',
      frames: [
        frame({
          candidates: [
            {
              content: {
                parts: [
                  { thought: true, thoughtSignature: 'SIG==' },
                  { functionCall: { name: 'read_a', args: {} } },
                  { functionCall: { name: 'read_b', args: {} } },
                ],
              },
              finishReason: 'STOP',
            },
          ],
        }),
      ],
      expected: [
        { type: 'tool_call_delta' },
        {
          type: 'native_tool_call',
          call: { name: 'read_a', args: {}, thoughtSignature: 'SIG==' },
        },
        { type: 'native_tool_call', call: { name: 'read_b', args: {} } },
        { type: 'done', finishReason: 'tool_calls' },
      ],
    },
  ];

  for (const { name, frames, expected } of corpus) {
    it(`parses: ${name}`, async () => {
      const direct = await collectEvents(geminiEventStream(createEventStreamResponse(frames)));
      expect(direct).toEqual(expected);
    });
  }

  it('emits a terminal done on a bodyless upstream', async () => {
    const events = await collectEvents(geminiEventStream(new Response(null)));
    expect(events).toEqual([{ type: 'done', finishReason: 'stop' }]);
  });

  it('stops cleanly when the signal is already aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    const events = await collectEvents(
      geminiEventStream(
        createEventStreamResponse([
          frame({
            candidates: [{ content: { parts: [{ text: 'never' }] }, finishReason: 'STOP' }],
          }),
        ]),
        ac.signal,
      ),
    );
    expect(events).toEqual([]);
  });
});
