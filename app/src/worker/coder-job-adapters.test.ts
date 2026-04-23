/**
 * Tests for the real PR #3a adapter implementations:
 *   - `createWebExecutorAdapter` dispatches sandbox tool calls through
 *     `handleCloudflareSandbox` and formats the response.
 *   - `createWebStreamAdapter` pumps an OpenAI-compatible SSE stream
 *     from a provider handler into `onToken` / `onDone` callbacks.
 *
 * Both adapters are normally wired by the CoderJob DO's runLoop;
 * these tests exercise them directly so the adapter logic is covered
 * without needing a full DurableObjectState mock.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@cloudflare/sandbox', () => ({
  getSandbox: vi.fn(),
}));

const handleCloudflareSandboxMock = vi.hoisted(() => vi.fn());
vi.mock('./worker-cf-sandbox', () => ({
  handleCloudflareSandbox: handleCloudflareSandboxMock,
}));

const providerHandlerMocks = vi.hoisted(() => ({
  handleOpenRouterChat: vi.fn(),
  handleOllamaChat: vi.fn(),
  handleZenChat: vi.fn(),
  handleNvidiaChat: vi.fn(),
  handleBlackboxChat: vi.fn(),
  handleKiloCodeChat: vi.fn(),
  handleOpenAdapterChat: vi.fn(),
}));
vi.mock('./worker-providers', () => providerHandlerMocks);

import { createWebExecutorAdapter } from './coder-job-executor-adapter';
import { createWebStreamAdapter } from './coder-job-stream-adapter';
import type { SandboxToolCall } from './coder-job-detector-adapter';
import type { Env } from './worker-middleware';
import type { ChatMessage } from '@/types';

function env(): Env {
  return {
    RATE_LIMITER: {} as unknown as Env['RATE_LIMITER'],
    ASSETS: {} as Env['ASSETS'],
  };
}

// ---------------------------------------------------------------------------
// Executor adapter
// ---------------------------------------------------------------------------

describe('createWebExecutorAdapter — sandbox tool dispatch', () => {
  beforeEach(() => {
    handleCloudflareSandboxMock.mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('routes sandbox_exec to /api/sandbox-cf/exec with command + ownerToken', async () => {
    handleCloudflareSandboxMock.mockResolvedValue(
      new Response(JSON.stringify({ stdout: 'ok\n', stderr: '', exit_code: 0 }), { status: 200 }),
    );
    const adapter = createWebExecutorAdapter({
      env: env(),
      origin: 'https://push.example.test',
      sandboxId: 'sb-1',
      ownerToken: 'tok-1',
      provider: 'openrouter',
      jobId: 'job-test-1',
    });
    const result = await adapter.executeSandboxToolCall(
      { tool: 'sandbox_exec', args: { command: 'ls -1' } } as SandboxToolCall,
      'sb-1',
      { auditorProviderOverride: 'openrouter', auditorModelOverride: 'x' },
    );
    expect(handleCloudflareSandboxMock).toHaveBeenCalledTimes(1);
    const forwardedReq = handleCloudflareSandboxMock.mock.calls[0]![0] as Request;
    const forwardedRoute = handleCloudflareSandboxMock.mock.calls[0]![3];
    expect(forwardedRoute).toBe('exec');
    expect(forwardedReq.url).toBe('https://push.example.test/api/sandbox-cf/exec');
    expect(forwardedReq.headers.get('Origin')).toBe('https://push.example.test');
    const body = JSON.parse(await forwardedReq.text()) as Record<string, unknown>;
    expect(body).toMatchObject({
      sandbox_id: 'sb-1',
      owner_token: 'tok-1',
      command: 'ls -1',
    });
    expect(result.text).toContain('exit=0');
    expect(result.text).toContain('ok');
    expect(result.structuredError).toBeUndefined();
  });

  it('surfaces handler error responses as structured errors', async () => {
    handleCloudflareSandboxMock.mockResolvedValue(
      new Response(JSON.stringify({ error: 'sandbox gone', code: 'SANDBOX_UNREACHABLE' }), {
        status: 503,
      }),
    );
    const adapter = createWebExecutorAdapter({
      env: env(),
      origin: 'https://push.example.test',
      sandboxId: 'sb-1',
      ownerToken: 'tok-1',
      provider: 'openrouter',
      jobId: 'job-test-1',
    });
    const result = await adapter.executeSandboxToolCall(
      { tool: 'sandbox_exec', args: { command: 'ls' } } as SandboxToolCall,
      'sb-1',
      { auditorProviderOverride: 'openrouter', auditorModelOverride: undefined },
    );
    expect(result.structuredError?.type).toBe('SANDBOX_UNREACHABLE');
    expect(result.structuredError?.retryable).toBe(true);
    expect(result.text).toContain('sandbox gone');
  });

  it('formats sandbox_diff output', async () => {
    handleCloudflareSandboxMock.mockResolvedValue(
      new Response(JSON.stringify({ diff: 'diff --git a/x b/x\n+foo', changed_files: ['x'] }), {
        status: 200,
      }),
    );
    const adapter = createWebExecutorAdapter({
      env: env(),
      origin: 'https://push.example.test',
      sandboxId: 'sb-1',
      ownerToken: 'tok-1',
      provider: 'openrouter',
      jobId: 'job-test-1',
    });
    const result = await adapter.executeSandboxToolCall(
      { tool: 'sandbox_diff', args: {} } as SandboxToolCall,
      'sb-1',
      { auditorProviderOverride: 'openrouter', auditorModelOverride: undefined },
    );
    expect(handleCloudflareSandboxMock.mock.calls[0]![3]).toBe('diff');
    expect(result.text).toContain('diff --git');
    expect(result.text).toContain('+foo');
  });

  it('returns NOT_IMPLEMENTED_YET for tools deferred to PR #3b', async () => {
    const adapter = createWebExecutorAdapter({
      env: env(),
      origin: 'https://push.example.test',
      sandboxId: 'sb-1',
      ownerToken: 'tok-1',
      provider: 'openrouter',
      jobId: 'job-test-1',
    });
    const result = await adapter.executeSandboxToolCall(
      { tool: 'sandbox_edit_file', args: { path: 'a', edits: [] } } as SandboxToolCall,
      'sb-1',
      { auditorProviderOverride: 'openrouter', auditorModelOverride: undefined },
    );
    expect(result.structuredError?.type).toBe('APPROVAL_GATE_BLOCKED');
    expect(result.text).toContain("isn't wired for background jobs yet");
    expect(handleCloudflareSandboxMock).not.toHaveBeenCalled();
  });

  it('rejects orchestrator-only tools as unsupported', async () => {
    const adapter = createWebExecutorAdapter({
      env: env(),
      origin: 'https://push.example.test',
      sandboxId: 'sb-1',
      ownerToken: 'tok-1',
      provider: 'openrouter',
      jobId: 'job-test-1',
    });
    const result = await adapter.executeSandboxToolCall(
      { tool: 'promote_to_github', args: { repo_name: 'x' } } as SandboxToolCall,
      'sb-1',
      { auditorProviderOverride: 'openrouter', auditorModelOverride: undefined },
    );
    expect(result.structuredError?.type).toBe('APPROVAL_GATE_BLOCKED');
    expect(result.text).toContain('Orchestrator-only');
  });

  it('blocks direct `git push` in sandbox_exec without allowDirectGit', async () => {
    const adapter = createWebExecutorAdapter({
      env: env(),
      origin: 'https://push.example.test',
      sandboxId: 'sb-1',
      ownerToken: 'tok-1',
      provider: 'openrouter',
      jobId: 'job-test-1',
    });
    const result = await adapter.executeSandboxToolCall(
      { tool: 'sandbox_exec', args: { command: 'git push origin main' } } as SandboxToolCall,
      'sb-1',
      { auditorProviderOverride: 'openrouter', auditorModelOverride: undefined },
    );
    expect(result.structuredError?.type).toBe('APPROVAL_GATE_BLOCKED');
    expect(result.structuredError?.message).toContain('is blocked without allowDirectGit');
    expect(result.text).toContain('sandbox_prepare_commit + sandbox_push');
    expect(handleCloudflareSandboxMock).not.toHaveBeenCalled();
  });

  it('allows direct git commands when the model opts in via allowDirectGit', async () => {
    handleCloudflareSandboxMock.mockResolvedValue(
      new Response(JSON.stringify({ stdout: 'pushed', stderr: '', exit_code: 0 }), { status: 200 }),
    );
    const adapter = createWebExecutorAdapter({
      env: env(),
      origin: 'https://push.example.test',
      sandboxId: 'sb-1',
      ownerToken: 'tok-1',
      provider: 'openrouter',
      jobId: 'job-test-1',
    });
    const result = await adapter.executeSandboxToolCall(
      {
        tool: 'sandbox_exec',
        args: { command: 'git push origin main', allowDirectGit: true },
      } as SandboxToolCall,
      'sb-1',
      { auditorProviderOverride: 'openrouter', auditorModelOverride: undefined },
    );
    expect(handleCloudflareSandboxMock).toHaveBeenCalledTimes(1);
    expect(result.structuredError).toBeUndefined();
    expect(result.text).toContain('exit=0');
  });

  it('surfaces sandbox_diff HTTP-200 error payload as a structured error', async () => {
    handleCloudflareSandboxMock.mockResolvedValue(
      new Response(JSON.stringify({ diff: '', error: 'fatal: not a git repository' }), {
        status: 200,
      }),
    );
    const adapter = createWebExecutorAdapter({
      env: env(),
      origin: 'https://push.example.test',
      sandboxId: 'sb-1',
      ownerToken: 'tok-1',
      provider: 'openrouter',
      jobId: 'job-test-1',
    });
    const result = await adapter.executeSandboxToolCall(
      { tool: 'sandbox_diff', args: {} } as SandboxToolCall,
      'sb-1',
      { auditorProviderOverride: 'openrouter', auditorModelOverride: undefined },
    );
    expect(result.structuredError?.type).toBe('SANDBOX_GIT_ERROR');
    expect(result.structuredError?.message).toContain('not a git repository');
    expect(result.text).toContain('not a git repository');
  });

  it('uses the method sandboxId parameter, not args.sandboxId, when forwarding', async () => {
    handleCloudflareSandboxMock.mockResolvedValue(
      new Response(JSON.stringify({ stdout: 'ok', exit_code: 0 }), { status: 200 }),
    );
    const adapter = createWebExecutorAdapter({
      env: env(),
      origin: 'https://push.example.test',
      sandboxId: 'sb-factory-default',
      ownerToken: 'tok-1',
      provider: 'openrouter',
      jobId: 'job-test-1',
    });
    await adapter.executeSandboxToolCall(
      { tool: 'sandbox_exec', args: { command: 'ls' } } as SandboxToolCall,
      'sb-from-method',
      { auditorProviderOverride: 'openrouter', auditorModelOverride: undefined },
    );
    const forwardedReq = handleCloudflareSandboxMock.mock.calls[0]![0] as Request;
    const body = JSON.parse(await forwardedReq.text()) as { sandbox_id: string };
    expect(body.sandbox_id).toBe('sb-from-method');
    expect(body.sandbox_id).not.toBe('sb-factory-default');
  });

  it('stamps X-Forwarded-For with job:<jobId> on outbound requests', async () => {
    handleCloudflareSandboxMock.mockResolvedValue(
      new Response(JSON.stringify({ stdout: 'ok', exit_code: 0 }), { status: 200 }),
    );
    const adapter = createWebExecutorAdapter({
      env: env(),
      origin: 'https://push.example.test',
      sandboxId: 'sb-1',
      ownerToken: 'tok-1',
      provider: 'openrouter',
      jobId: 'job-rate-bucket-abc',
    });
    await adapter.executeSandboxToolCall(
      { tool: 'sandbox_exec', args: { command: 'ls' } } as SandboxToolCall,
      'sb-1',
      { auditorProviderOverride: 'openrouter', auditorModelOverride: undefined },
    );
    const forwardedReq = handleCloudflareSandboxMock.mock.calls[0]![0] as Request;
    expect(forwardedReq.headers.get('X-Forwarded-For')).toBe('job:job-rate-bucket-abc');
  });

  it('normalizes a trailing-slash origin so URLs do not become double-slashed', async () => {
    handleCloudflareSandboxMock.mockResolvedValue(
      new Response(JSON.stringify({ stdout: 'ok', exit_code: 0 }), { status: 200 }),
    );
    const adapter = createWebExecutorAdapter({
      env: env(),
      origin: 'https://push.example.test/',
      sandboxId: 'sb-1',
      ownerToken: 'tok-1',
      provider: 'openrouter',
      jobId: 'job-test-1',
    });
    await adapter.executeSandboxToolCall(
      { tool: 'sandbox_exec', args: { command: 'ls' } } as SandboxToolCall,
      'sb-1',
      { auditorProviderOverride: 'openrouter', auditorModelOverride: undefined },
    );
    const forwardedReq = handleCloudflareSandboxMock.mock.calls[0]![0] as Request;
    expect(forwardedReq.url).toBe('https://push.example.test/api/sandbox-cf/exec');
  });

  it('returns a TIMEOUT structured error when the sandbox handler hangs', async () => {
    vi.useFakeTimers();
    try {
      // Never resolve — simulates a wedged sandbox subrequest (the repro:
      // `npm install` under heavy FS pressure, then the next exec stalls
      // waiting on the Cloudflare Sandbox SDK's gRPC to the container).
      handleCloudflareSandboxMock.mockImplementation(() => new Promise(() => {}));

      const adapter = createWebExecutorAdapter({
        env: env(),
        origin: 'https://push.example.test',
        sandboxId: 'sb-1',
        ownerToken: 'tok-1',
        provider: 'openrouter',
        jobId: 'job-timeout-1',
      });

      const pending = adapter.executeSandboxToolCall(
        { tool: 'sandbox_exec', args: { command: 'sleep 999' } } as SandboxToolCall,
        'sb-1',
        { auditorProviderOverride: 'openrouter', auditorModelOverride: undefined },
      );

      // Advance past the 180s round-trip deadline — without the timeout
      // guard this would hang forever and wedge runLoop.
      await vi.advanceTimersByTimeAsync(180_001);
      const result = await pending;

      expect(result.structuredError?.type).toBe('TIMEOUT');
      expect(result.structuredError?.retryable).toBe(true);
      expect(result.text).toContain('Tool Timeout');
      expect(result.text).toContain('180000ms');
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// Stream adapter
// ---------------------------------------------------------------------------

describe('createWebStreamAdapter — provider SSE pump', () => {
  beforeEach(() => {
    Object.values(providerHandlerMocks).forEach((fn) => fn.mockReset());
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function sseResponse(chunks: string[], status = 200): Response {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(chunk));
        }
        controller.close();
      },
    });
    return new Response(body, {
      status,
      headers: { 'content-type': 'text/event-stream' },
    });
  }

  it('pumps OpenRouter SSE tokens through onToken and closes on [DONE]', async () => {
    providerHandlerMocks.handleOpenRouterChat.mockResolvedValue(
      sseResponse([
        'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
        'data: [DONE]\n\n',
      ]),
    );
    const streamFn = createWebStreamAdapter({
      env: env(),
      origin: 'https://push.example.test',
      provider: 'openrouter',
      modelId: 'sonnet-4.6',
      jobId: 'job-test-1',
    });

    const tokens: string[] = [];
    let doneCalled = false;
    const errors: Error[] = [];
    await streamFn(
      [{ id: '1', role: 'user', content: 'hi', timestamp: 0 }] as ChatMessage[],
      (t) => tokens.push(t),
      () => {
        doneCalled = true;
      },
      (e) => errors.push(e),
    );

    expect(tokens.join('')).toBe('Hello');
    expect(doneCalled).toBe(true);
    expect(errors).toEqual([]);

    const req = providerHandlerMocks.handleOpenRouterChat.mock.calls[0]![0] as Request;
    expect(req.url).toBe('https://push.example.test/api/openrouter/chat');
    expect(req.headers.get('Origin')).toBe('https://push.example.test');
    const body = JSON.parse(await req.text()) as { messages: unknown; model: string };
    expect(body.model).toBe('sonnet-4.6');
    expect(body.messages).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('invokes onError when the provider handler returns a non-2xx status', async () => {
    providerHandlerMocks.handleOpenRouterChat.mockResolvedValue(
      new Response('upstream went boom', { status: 502 }),
    );
    const streamFn = createWebStreamAdapter({
      env: env(),
      origin: 'https://push.example.test',
      provider: 'openrouter',
      modelId: 'sonnet-4.6',
      jobId: 'job-test-1',
    });
    const errors: Error[] = [];
    await streamFn(
      [{ id: '1', role: 'user', content: 'hi', timestamp: 0 }] as ChatMessage[],
      () => {},
      () => {},
      (e) => errors.push(e),
    );
    expect(errors.length).toBe(1);
    expect(errors[0]!.message).toContain('502');
  });

  it('fails via onError for unsupported providers (azure in Phase 1)', async () => {
    const streamFn = createWebStreamAdapter({
      env: env(),
      origin: 'https://push.example.test',
      provider: 'azure',
      modelId: 'gpt-4o',
      jobId: 'job-test-1',
    });
    const errors: Error[] = [];
    await streamFn(
      [{ id: '1', role: 'user', content: 'hi', timestamp: 0 }] as ChatMessage[],
      () => {},
      () => {},
      (e) => errors.push(e),
    );
    expect(errors.length).toBe(1);
    expect(errors[0]!.message).toContain('azure');
    expect(providerHandlerMocks.handleOpenRouterChat).not.toHaveBeenCalled();
  });

  it('ignores malformed SSE chunks and keeps pumping', async () => {
    providerHandlerMocks.handleOpenRouterChat.mockResolvedValue(
      sseResponse([
        'data: not-json\n\n',
        'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
        'data: [DONE]\n\n',
      ]),
    );
    const streamFn = createWebStreamAdapter({
      env: env(),
      origin: 'https://push.example.test',
      provider: 'openrouter',
      modelId: 'sonnet-4.6',
      jobId: 'job-test-1',
    });
    const tokens: string[] = [];
    const errors: Error[] = [];
    let doneCalled = false;
    await streamFn(
      [{ id: '1', role: 'user', content: 'hi', timestamp: 0 }] as ChatMessage[],
      (t) => tokens.push(t),
      () => {
        doneCalled = true;
      },
      (e) => errors.push(e),
    );
    expect(tokens.join('')).toBe('ok');
    expect(doneCalled).toBe(true);
    expect(errors).toEqual([]);
  });

  it('splits CRLF-delimited SSE (providers that frame with \\r\\n\\r\\n)', async () => {
    providerHandlerMocks.handleOpenRouterChat.mockResolvedValue(
      sseResponse([
        'data: {"choices":[{"delta":{"content":"hel"}}]}\r\n\r\n',
        'data: {"choices":[{"delta":{"content":"lo"}}]}\r\n\r\n',
        'data: [DONE]\r\n\r\n',
      ]),
    );
    const streamFn = createWebStreamAdapter({
      env: env(),
      origin: 'https://push.example.test',
      provider: 'openrouter',
      modelId: 'sonnet-4.6',
      jobId: 'job-test-1',
    });
    const tokens: string[] = [];
    let doneCalled = false;
    await streamFn(
      [{ id: '1', role: 'user', content: 'hi', timestamp: 0 }] as ChatMessage[],
      (t) => tokens.push(t),
      () => {
        doneCalled = true;
      },
      () => {},
    );
    expect(tokens.join('')).toBe('hello');
    expect(doneCalled).toBe(true);
  });

  it('stamps X-Forwarded-For with job:<jobId> so jobs get distinct rate-limit buckets', async () => {
    providerHandlerMocks.handleOpenRouterChat.mockResolvedValue(sseResponse(['data: [DONE]\n\n']));
    const streamFn = createWebStreamAdapter({
      env: env(),
      origin: 'https://push.example.test',
      provider: 'openrouter',
      modelId: 'sonnet-4.6',
      jobId: 'job-rate-limit-1',
    });
    await streamFn(
      [{ id: '1', role: 'user', content: 'hi', timestamp: 0 }] as ChatMessage[],
      () => {},
      () => {},
      () => {},
    );
    const req = providerHandlerMocks.handleOpenRouterChat.mock.calls[0]![0] as Request;
    expect(req.headers.get('X-Forwarded-For')).toBe('job:job-rate-limit-1');
  });

  it('honors an aborted AbortSignal by invoking onError before dispatch', async () => {
    const controller = new AbortController();
    controller.abort();
    const streamFn = createWebStreamAdapter({
      env: env(),
      origin: 'https://push.example.test',
      provider: 'openrouter',
      modelId: 'sonnet-4.6',
      jobId: 'job-test-1',
    });
    const errors: Error[] = [];
    await streamFn(
      [{ id: '1', role: 'user', content: 'hi', timestamp: 0 }] as ChatMessage[],
      () => {},
      () => {},
      (e) => errors.push(e),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      controller.signal,
    );
    expect(errors.length).toBe(1);
    expect(errors[0]!.message).toMatch(/abort/i);
    expect(providerHandlerMocks.handleOpenRouterChat).not.toHaveBeenCalled();
  });

  it('normalizes a trailing-slash origin so URLs do not become double-slashed', async () => {
    providerHandlerMocks.handleOpenRouterChat.mockResolvedValue(sseResponse(['data: [DONE]\n\n']));
    const streamFn = createWebStreamAdapter({
      env: env(),
      origin: 'https://push.example.test/',
      provider: 'openrouter',
      modelId: 'sonnet-4.6',
      jobId: 'job-test-1',
    });
    await streamFn(
      [{ id: '1', role: 'user', content: 'hi', timestamp: 0 }] as ChatMessage[],
      () => {},
      () => {},
      () => {},
    );
    const req = providerHandlerMocks.handleOpenRouterChat.mock.calls[0]![0] as Request;
    expect(req.url).toBe('https://push.example.test/api/openrouter/chat');
  });
});
