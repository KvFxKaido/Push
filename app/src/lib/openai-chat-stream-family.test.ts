import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '@/types';
import type { PushStreamEvent, PushStreamRequest } from '@push/lib/provider-contract';

const { toLLMMessagesMock } = vi.hoisted(() => ({
  toLLMMessagesMock: vi.fn((messages: ChatMessage[]) =>
    messages.map((message) => ({ role: message.role, content: message.content })),
  ),
}));

vi.mock('./orchestrator', () => ({
  toLLMMessages: toLLMMessagesMock,
}));

vi.mock('./tool-dispatch', () => ({
  KNOWN_TOOL_NAMES: new Set(['sandbox_write_file']),
}));

vi.mock('./tracing', () => ({
  injectTraceHeaders: (headers: Record<string, string>) => {
    headers.traceparent = 'test-trace';
  },
}));

import {
  createOpenAIChatStream,
  type OpenAIChatStreamFamilyConfig,
} from './openai-chat-stream-family';

const baseRequest: PushStreamRequest<ChatMessage> = {
  provider: 'zai',
  model: 'test-model',
  messages: [{ id: '1', role: 'user', content: 'hello', timestamp: 0 } as ChatMessage],
};

const familyFixtures: OpenAIChatStreamFamilyConfig[] = [
  {
    provider: 'zai',
    endpoint: 'https://push.test/zai',
    displayName: 'Z.ai',
    credential: { kind: 'bearer', getApiKey: () => ' zai-key ' },
    errorPrefix: 'preserve-worker-prefix',
  },
  {
    provider: 'huggingface',
    endpoint: 'https://push.test/huggingface',
    displayName: 'Hugging Face',
    credential: { kind: 'bearer', getApiKey: () => 'huggingface-key' },
    errorPrefix: 'preserve-worker-prefix',
  },
  {
    provider: 'cloudflare',
    endpoint: 'https://push.test/cloudflare',
    displayName: 'Cloudflare Workers AI',
    credential: { kind: 'worker-binding' },
    errorPrefix: 'always',
  },
];

async function drain(
  config: OpenAIChatStreamFamilyConfig,
  req: PushStreamRequest<ChatMessage> = baseRequest,
): Promise<PushStreamEvent[]> {
  const events: PushStreamEvent[] = [];
  for await (const event of createOpenAIChatStream(config)(req)) events.push(event);
  return events;
}

describe('createOpenAIChatStream', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    toLLMMessagesMock.mockClear();
    fetchMock = vi.fn(
      async () =>
        new Response('data: [DONE]\n\n', {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it.each(familyFixtures)(
    'pins the $provider family fixture to its endpoint, identity, and credential mode',
    async (config) => {
      await drain(config);

      expect(toLLMMessagesMock).toHaveBeenCalledWith(
        baseRequest.messages,
        expect.objectContaining({
          providerType: config.provider,
          providerModel: baseRequest.model,
        }),
      );

      const [endpoint, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(endpoint).toBe(config.endpoint);
      expect(init.method).toBe('POST');
      expect(init.headers).toEqual(
        expect.objectContaining({
          'Content-Type': 'application/json',
          traceparent: 'test-trace',
        }),
      );
      const headers = init.headers as Record<string, string>;
      if (config.credential.kind === 'bearer') {
        expect(headers.Authorization).toBe(`Bearer ${config.credential.getApiKey()?.trim()}`);
      } else {
        expect(headers).not.toHaveProperty('Authorization');
      }
      expect(JSON.parse(init.body as string)).toMatchObject({
        model: baseRequest.model,
        messages: [{ role: 'user', content: 'hello' }],
        stream: true,
      });
    },
  );

  it('serializes shared sampling, tools, tool choice, and structured output fields', async () => {
    const tool = {
      name: 'sandbox_write_file',
      description: 'Write a file',
      input_schema: {
        type: 'object' as const,
        properties: { path: { type: 'string' as const } },
        required: ['path'],
        additionalProperties: false as const,
      },
    };

    await drain(familyFixtures[0], {
      ...baseRequest,
      maxTokens: 2048,
      temperature: 0.4,
      topP: 0.9,
      tools: [tool],
      toolChoice: 'required',
      responseFormat: { name: 'result', schema: { type: 'object' } },
    });

    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string)).toMatchObject({
      max_tokens: 2048,
      temperature: 0.4,
      top_p: 0.9,
      tool_choice: 'required',
      tools: [
        {
          type: 'function',
          function: {
            name: 'sandbox_write_file',
            description: 'Write a file',
            parameters: tool.input_schema,
          },
        },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'result', strict: true, schema: { type: 'object' } },
      },
    });
  });

  it('omits an empty bearer so the Worker can use its configured credential', async () => {
    const config: OpenAIChatStreamFamilyConfig = {
      ...familyFixtures[0],
      credential: { kind: 'bearer', getApiKey: () => '   ' },
    };
    await drain(config);

    const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>;
    expect(headers).not.toHaveProperty('Authorization');
  });

  it('preserves an already-prefixed Worker error when the leaf opts in', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'Z.ai 429: upstream rate limit' }), {
        status: 429,
        headers: { 'content-type': 'application/json' },
      }),
    );

    await expect(drain(familyFixtures[0])).rejects.toMatchObject({
      name: 'ProviderStreamError',
      message: 'Z.ai 429: upstream rate limit',
      status: 429,
      retryable: true,
    });
  });

  it('keeps unconditional prefixing explicit for providers whose leaf always did it', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'upstream rate limit' }), {
        status: 429,
        headers: { 'content-type': 'application/json' },
      }),
    );

    await expect(drain(familyFixtures[2])).rejects.toMatchObject({
      message: 'Cloudflare Workers AI 429: upstream rate limit',
      status: 429,
    });
  });

  it('names a successful response that has no stream body', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));

    await expect(drain(familyFixtures[2])).rejects.toThrow(
      'Cloudflare Workers AI response had no body',
    );
  });
});
