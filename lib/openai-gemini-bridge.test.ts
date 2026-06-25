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
  createGeminiTranslatedStream,
  geminiEventStream,
  toGeminiGenerateContent,
} from './openai-gemini-bridge.ts';
import { openAISSEPump } from './openai-sse-pump.ts';
import { flatToolToOpenAITool } from './openai-chat-serializer.ts';
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

async function collectChunks(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  out += decoder.decode();
  return out;
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

describe('createGeminiTranslatedStream', () => {
  it('forwards candidate text as OpenAI-shaped content deltas', async () => {
    const frames = [
      `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Hello' }] } }] })}\n\n`,
      `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: ', world' }] } }] })}\n\n`,
      `data: ${JSON.stringify({
        candidates: [{ content: { parts: [{ text: '!' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 3, totalTokenCount: 7 },
      })}\n\n`,
    ];

    const translated = createGeminiTranslatedStream(
      createEventStreamResponse(frames),
      'gemini-3.1-pro-preview',
    );
    const out = await collectChunks(translated);

    // Three content deltas + one terminal frame with finish_reason + usage,
    // then the OpenAI [DONE] sentinel.
    expect(out).toContain('"content":"Hello"');
    expect(out).toContain('"content":", world"');
    expect(out).toContain('"content":"!"');
    expect(out).toContain('"finish_reason":"stop"');
    expect(out).toContain('"prompt_tokens":4');
    expect(out).toContain('"completion_tokens":3');
    expect(out).toContain('"total_tokens":7');
    expect(out.endsWith('data: [DONE]\n\n')).toBe(true);
  });

  it('maps Gemini MAX_TOKENS to OpenAI length finish reason', async () => {
    const frame = `data: ${JSON.stringify({
      candidates: [{ content: { parts: [{ text: 'cut' }] }, finishReason: 'MAX_TOKENS' }],
    })}\n\n`;

    const out = await collectChunks(
      createGeminiTranslatedStream(createEventStreamResponse([frame]), 'gemini-3.1-pro-preview'),
    );

    expect(out).toContain('"finish_reason":"length"');
  });

  it('ignores malformed JSON frames without breaking the stream', async () => {
    const frames = [
      `data: { not valid json\n\n`,
      `data: ${JSON.stringify({
        candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
      })}\n\n`,
    ];

    const out = await collectChunks(
      createGeminiTranslatedStream(createEventStreamResponse(frames), 'gemini-3.1-pro-preview'),
    );

    expect(out).toContain('"content":"ok"');
    expect(out.endsWith('data: [DONE]\n\n')).toBe(true);
  });

  it('closes cleanly when upstream has no body', async () => {
    const empty = new Response(null);
    const out = await collectChunks(createGeminiTranslatedStream(empty, 'gemini-2.5-flash'));
    expect(out).toContain('"finish_reason":"stop"');
    expect(out.endsWith('data: [DONE]\n\n')).toBe(true);
  });

  it('parses CRLF-framed SSE upstreams without buffering', async () => {
    // SSE permits `\r\n\r\n` event boundaries. Google's edge or an
    // intermediary can emit that form; without CRLF normalization the
    // boundary scan never matches, the whole stream buffers, and only the
    // synthesized terminal frame is emitted.
    const frames = [
      `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: 'crlf' }] } }] })}\r\n\r\n`,
      `data: ${JSON.stringify({
        candidates: [{ content: { parts: [{ text: ' frames' }] }, finishReason: 'STOP' }],
      })}\r\n\r\n`,
    ];

    const out = await collectChunks(
      createGeminiTranslatedStream(createEventStreamResponse(frames), 'gemini-3.1-pro-preview'),
    );

    expect(out).toContain('"content":"crlf"');
    expect(out).toContain('"content":" frames"');
    expect(out).toContain('"finish_reason":"stop"');
    expect(out.endsWith('data: [DONE]\n\n')).toBe(true);
  });

  it('translates Gemini functionCall parts into OpenAI tool_call deltas', async () => {
    const frames = [
      `data: ${JSON.stringify({
        candidates: [
          {
            content: {
              parts: [{ functionCall: { name: 'sandbox_read_file', args: { path: 'README.md' } } }],
            },
            finishReason: 'STOP',
          },
        ],
      })}\n\n`,
    ];

    const translated = createGeminiTranslatedStream(
      createEventStreamResponse(frames),
      'gemini-3.1-pro-preview',
    );
    const events = await collectEvents(
      openAISSEPump({
        body: translated,
        isKnownToolName: (name) => name === 'sandbox_read_file',
      }),
    );

    expect(events[0]).toEqual({ type: 'tool_call_delta' });
    expect(events[1]).toEqual({
      type: 'native_tool_call',
      call: { name: 'sandbox_read_file', args: { path: 'README.md' } },
    });
    expect(events[2]).toMatchObject({ type: 'done', finishReason: 'tool_calls' });
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
      // The call `id` is emitted for Gemini 3 correlation.
      { functionCall: { id: 'c1', name: 'read', args: { path: 'a.ts' } } },
    ]);
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
// PushStreamEvents. Pinned event-for-event against the legacy
// createGeminiTranslatedStream -> openAISSEPump round-trip the CLI used before
// (and the web Worker still uses for its response wire).
// ---------------------------------------------------------------------------

async function collectEvents(stream: AsyncIterable<PushStreamEvent>): Promise<PushStreamEvent[]> {
  const out: PushStreamEvent[] = [];
  for await (const e of stream) out.push(e);
  return out;
}

function legacyGeminiEvents(frames: string[]): Promise<PushStreamEvent[]> {
  const translated = createGeminiTranslatedStream(createEventStreamResponse(frames), 'gemini-x');
  return collectEvents(openAISSEPump({ body: translated }));
}

const frame = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`;

describe('geminiEventStream — drift vs translate->pump', () => {
  const corpus: Array<{ name: string; frames: string[] }> = [
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
    },
    {
      name: 'MAX_TOKENS -> length',
      frames: [
        frame({
          candidates: [{ content: { parts: [{ text: 'cut' }] }, finishReason: 'MAX_TOKENS' }],
        }),
      ],
    },
    {
      name: 'text with a chat-template control token is stripped',
      frames: [
        frame({
          candidates: [{ content: { parts: [{ text: 'hi<|im_end|>' }] }, finishReason: 'STOP' }],
        }),
      ],
    },
    {
      name: 'malformed JSON frame is ignored',
      frames: [
        'data: { not valid json\n\n',
        frame({ candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }] }),
      ],
    },
    {
      name: 'no usageMetadata -> done without usage',
      frames: [
        frame({ candidates: [{ content: { parts: [{ text: 'plain' }] }, finishReason: 'STOP' }] }),
      ],
    },
    {
      name: 'bare JSON frame (no data: prefix)',
      frames: [
        `${JSON.stringify({ candidates: [{ content: { parts: [{ text: 'bare' }] }, finishReason: 'STOP' }] })}\n\n`,
      ],
    },
    {
      name: 'stream ends without a finishReason frame (clean close -> stop)',
      frames: [frame({ candidates: [{ content: { parts: [{ text: 'tail' }] } }] })],
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
    },
  ];

  for (const { name, frames } of corpus) {
    it(`matches the legacy round-trip: ${name}`, async () => {
      const direct = await collectEvents(geminiEventStream(createEventStreamResponse(frames)));
      const legacy = await legacyGeminiEvents(frames);
      expect(direct).toEqual(legacy);
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
