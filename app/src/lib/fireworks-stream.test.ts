import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '@/types';
import type { PushStreamEvent, PushStreamRequest } from '@push/lib/provider-contract';

// Module-level mocks so the stream's runtime dependencies don't hit real
// storage or network.
vi.mock('@/hooks/useFireworksConfig', () => ({
  getFireworksKey: () => 'test-key',
}));

vi.mock('./providers', () => ({
  PROVIDER_URLS: {
    fireworks: { chat: 'https://fireworks.example/v1/responses' },
  },
}));

// toLLMMessages pulls in a huge dependency graph — stub to a trivial passthrough.
vi.mock('./orchestrator', () => ({
  toLLMMessages: (messages: ChatMessage[]) =>
    messages.map((m) => ({ role: m.role, content: m.content })),
}));

vi.mock('./tool-dispatch', () => ({
  KNOWN_TOOL_NAMES: new Set(['sandbox_write_file']),
}));

const baseRequest: PushStreamRequest<ChatMessage> = {
  provider: 'fireworks',
  model: 'accounts/fireworks/models/deepseek-v4-pro',
  messages: [{ id: '1', role: 'user', content: 'hi', timestamp: 0 } as unknown as ChatMessage],
};

const sampleTool = {
  name: 'sandbox_write_file',
  description: 'Write a file to the sandbox',
  input_schema: {
    type: 'object' as const,
    properties: { path: { type: 'string' as const } },
    required: ['path'],
    additionalProperties: false as const,
  },
};
// Responses-API flat function-tool shape (no nested `function` wrapper).
const responsesTool = {
  type: 'function',
  name: sampleTool.name,
  description: sampleTool.description,
  parameters: sampleTool.input_schema,
};

describe('fireworksStream', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    // A response that completes immediately so the pump drains and the stream ends.
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

  async function drain(req: PushStreamRequest<ChatMessage>): Promise<void> {
    const { fireworksStream } = await import('./fireworks-stream');
    const out: PushStreamEvent[] = [];
    for await (const e of fireworksStream(req)) out.push(e);
  }

  it('serializes a Responses `input`-item body (not Chat `messages`)', async () => {
    await drain(baseRequest);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.messages).toBeUndefined();
    expect(body.input).toEqual([
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
    ]);
    expect(body.stream).toBe(true);
  });

  it('forwards native function tools + tool_choice into the request body', async () => {
    await drain({ ...baseRequest, tools: [sampleTool] });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.tools).toEqual([responsesTool]);
    expect(body.tool_choice).toBe('auto');
  });

  it('omits tools / tool_choice when no native tools are attached', async () => {
    await drain(baseRequest);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.tools).toBeUndefined();
    expect(body.tool_choice).toBeUndefined();
  });
});
