import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '@/types';
import type { PushStreamEvent, PushStreamRequest } from '@push/lib/provider-contract';

const { nativeWebSearchMock, toLLMMessagesMock } = vi.hoisted(() => ({
  nativeWebSearchMock: vi.fn(() => true),
  toLLMMessagesMock: vi.fn((messages: ChatMessage[]) =>
    messages.map((message) => ({ role: message.role, content: message.content })),
  ),
}));

vi.mock('./model-catalog', () => ({
  resolvePushCapabilityProfile: () => ({ contentBlocks: true }),
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
  createAnthropicFamilyStream,
  type AnthropicStreamFamilyConfig,
} from './anthropic-stream-family';

const baseRequest: PushStreamRequest<ChatMessage> = {
  provider: 'anthropic',
  model: 'test-model',
  messages: [{ id: '1', role: 'user', content: 'hello', timestamp: 0 } as ChatMessage],
};

const familyFixtures: AnthropicStreamFamilyConfig[] = [
  {
    provider: 'anthropic',
    endpoint: 'https://push.test/anthropic',
    displayName: 'Anthropic',
    getApiKey: () => ' anthropic-key ',
    nativeWebSearch: 'anthropic',
    pauseTurns: 'continue',
  },
  {
    provider: 'deepseek',
    endpoint: 'https://push.test/deepseek',
    displayName: 'DeepSeek',
    getApiKey: () => 'deepseek-key',
    nativeWebSearch: 'none',
    pauseTurns: 'complete-without-pause',
  },
];

async function drain(
  config: AnthropicStreamFamilyConfig,
  req: PushStreamRequest<ChatMessage> = baseRequest,
): Promise<PushStreamEvent[]> {
  const events: PushStreamEvent[] = [];
  for await (const event of createAnthropicFamilyStream(config)(req)) events.push(event);
  return events;
}

describe('createAnthropicFamilyStream', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    toLLMMessagesMock.mockClear();
    nativeWebSearchMock.mockClear();
    nativeWebSearchMock.mockReturnValue(true);
    fetchMock = vi.fn(
      async () =>
        new Response('data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n', {
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

  it.each(
    familyFixtures,
  )('pins the $provider family fixture to its endpoint, identity, and pause policy', async (config) => {
    const output = await drain(config);

    expect(output.at(-1)).toEqual({
      type: 'done',
      finishReason: 'stop',
      usage: undefined,
    });
    expect(toLLMMessagesMock).toHaveBeenCalledWith(
      baseRequest.messages,
      expect.objectContaining({
        providerType: config.provider,
        providerModel: baseRequest.model,
        emitContentBlocks: true,
      }),
    );

    const [endpoint, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(endpoint).toBe(config.endpoint);
    expect(init.headers).toEqual(
      expect.objectContaining({
        Authorization: `Bearer ${config.getApiKey()?.trim()}`,
        'Content-Type': 'application/json',
        traceparent: 'test-trace',
      }),
    );
    expect(JSON.parse(init.body as string)).toMatchObject({
      contract: 'push.stream.v1',
      provider: config.provider,
      model: baseRequest.model,
      messages: [{ role: 'user', content: 'hello' }],
    });
  });

  it('enables native web search only for the direct Anthropic leaf', async () => {
    await drain(familyFixtures[0]);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string).anthropicWebSearch).toBe(true);
    expect(nativeWebSearchMock).toHaveBeenCalledWith('anthropic', baseRequest.model);

    fetchMock.mockClear();
    nativeWebSearchMock.mockClear();
    await drain(familyFixtures[1]);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string)).not.toHaveProperty(
      'anthropicWebSearch',
    );
    expect(nativeWebSearchMock).not.toHaveBeenCalled();
  });

  it('omits an empty client bearer so the Worker can use its configured credential', async () => {
    await drain({ ...familyFixtures[0], getApiKey: () => '   ' });

    const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>;
    expect(headers).not.toHaveProperty('Authorization');
  });

  it('preserves an already-prefixed Worker error and structured status', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'Anthropic 429: upstream rate limit' }), {
        status: 429,
        headers: { 'content-type': 'application/json' },
      }),
    );

    await expect(drain(familyFixtures[0])).rejects.toMatchObject({
      name: 'ProviderStreamError',
      message: 'Anthropic 429: upstream rate limit',
      status: 429,
      retryable: true,
    });
  });

  it('names a successful response that has no stream body', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));

    await expect(drain(familyFixtures[1])).rejects.toThrow('DeepSeek response had no body');
  });
});
