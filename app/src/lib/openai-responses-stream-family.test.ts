import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '@/types';
import type { PushStreamEvent, PushStreamRequest } from '@push/lib/provider-contract';

const { nativeWebSearchMock, toLLMMessagesMock } = vi.hoisted(() => ({
  nativeWebSearchMock: vi.fn(() => false),
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

vi.mock('./web-search-mode', () => ({
  isNativeWebSearchEnabled: nativeWebSearchMock,
}));

import {
  createOpenAIResponsesStream,
  type OpenAIResponsesStreamFamilyConfig,
} from './openai-responses-stream-family';

const baseRequest: PushStreamRequest<ChatMessage> = {
  provider: 'openai',
  model: 'test-model',
  messages: [{ id: '1', role: 'user', content: 'hello', timestamp: 0 } as ChatMessage],
};

const familyFixtures: OpenAIResponsesStreamFamilyConfig[] = [
  {
    provider: 'openai',
    endpoint: 'https://push.test/openai',
    displayName: 'OpenAI',
    getApiKey: () => ' openai-key ',
  },
  {
    provider: 'xai',
    endpoint: 'https://push.test/xai',
    displayName: 'xAI',
    getApiKey: () => 'xai-key',
  },
  {
    provider: 'sakana',
    endpoint: 'https://push.test/sakana',
    displayName: 'Sakana AI',
    getApiKey: () => 'sakana-key',
  },
  {
    provider: 'fireworks',
    endpoint: 'https://push.test/fireworks',
    displayName: 'Fireworks AI',
    getApiKey: () => 'fireworks-key',
  },
];

async function drain(
  config: OpenAIResponsesStreamFamilyConfig,
  req: PushStreamRequest<ChatMessage> = baseRequest,
): Promise<PushStreamEvent[]> {
  const events: PushStreamEvent[] = [];
  for await (const event of createOpenAIResponsesStream(config)(req)) events.push(event);
  return events;
}

describe('createOpenAIResponsesStream', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    toLLMMessagesMock.mockClear();
    nativeWebSearchMock.mockClear();
    nativeWebSearchMock.mockReturnValue(false);
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
    'pins the $provider family fixture to its endpoint, identity, and traced bearer request',
    async (config) => {
      await drain(config);

      expect(toLLMMessagesMock).toHaveBeenCalledWith(
        baseRequest.messages,
        expect.objectContaining({
          providerType: config.provider,
          providerModel: baseRequest.model,
          emitContentBlocks: true,
        }),
      );
      expect(nativeWebSearchMock).toHaveBeenCalledWith(config.provider, baseRequest.model);

      const [endpoint, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(endpoint).toBe(config.endpoint);
      expect(init.method).toBe('POST');
      expect(init.headers).toEqual(
        expect.objectContaining({
          Authorization: `Bearer ${config.getApiKey()?.trim()}`,
          'Content-Type': 'application/json',
          traceparent: 'test-trace',
        }),
      );
      expect(JSON.parse(init.body as string)).toMatchObject({
        model: baseRequest.model,
        stream: true,
        input: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'hello' }],
          },
        ],
      });
    },
  );

  it('omits an empty client bearer so the Worker can use its configured credential', async () => {
    await drain({ ...familyFixtures[0], getApiKey: () => '   ' });

    const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>;
    expect(headers).not.toHaveProperty('Authorization');
  });

  it('preserves an already-prefixed Worker error and its structured status', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'OpenAI 429: upstream rate limit' }), {
        status: 429,
        headers: { 'content-type': 'application/json' },
      }),
    );

    await expect(drain(familyFixtures[0])).rejects.toMatchObject({
      name: 'ProviderStreamError',
      message: 'OpenAI 429: upstream rate limit',
      status: 429,
      retryable: true,
    });
  });

  it('names a successful response that has no stream body', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));

    await expect(drain(familyFixtures[2])).rejects.toThrow('Sakana AI response had no body');
  });
});
