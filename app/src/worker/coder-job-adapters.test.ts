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
  handleZenGoChat: vi.fn(),
  handleNvidiaChat: vi.fn(),
  handleFireworksChat: vi.fn(),
}));
vi.mock('./worker-providers', () => providerHandlerMocks);

import { createWebExecutorAdapter } from './coder-job-executor-adapter';
import { createWebStreamAdapter } from './coder-job-stream-adapter';
import { putUserProviderKey } from './user-secrets';
import type { SandboxToolCall } from './coder-job-detector-adapter';
import type { Env } from './worker-middleware';
import type { ChatMessage } from '@/types';
import type { AIProviderType } from '@push/lib/provider-contract';

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

  it('maps NOT_FOUND from the auth gate to SANDBOX_UNREACHABLE so the kernel can resume', async () => {
    // Reproduces the post-`/api/sandbox-cf/cleanup` failure mode the layer-3
    // smoke test surfaced (see scripts/snapshot-smoke/README.md §"Layer 3"):
    // the auth gate's `verifySandboxOwnerToken` reads the owner-token file
    // from the destroyed sandbox, hits "no such" via `classifyCfError`, and
    // returns 404 + `code: 'NOT_FOUND'`. Without translation, the kernel's
    // `SANDBOX_LOSS_THRESHOLD` counter never increments and the CoderJob
    // DO never enters the resume path — `/cleanup` silently bypasses it.
    handleCloudflareSandboxMock.mockResolvedValue(
      new Response(JSON.stringify({ error: 'Sandbox not found', code: 'NOT_FOUND' }), {
        status: 404,
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
    // A dead sandbox is recoverable via the DO's restore path, even though
    // the underlying response was a 404 (not a 5xx).
    expect(result.structuredError?.retryable).toBe(true);
    // `fatal: true` short-circuits the kernel's SANDBOX_LOSS_THRESHOLD so the
    // first occurrence throws SandboxUnreachableError instead of waiting for
    // a second consecutive tool call that some models never make.
    expect(result.structuredError?.fatal).toBe(true);
    expect(result.text).toContain('Sandbox not found');
  });

  it('passes AUTH_FAILURE through unchanged (a token mismatch is not a sandbox loss)', async () => {
    // Distinct from NOT_FOUND: AUTH_FAILURE means the caller's token doesn't
    // match what's on file — the sandbox itself is alive and reachable.
    // Mapping this to SANDBOX_UNREACHABLE would trick the kernel into
    // attempting resume on a healthy sandbox owned by someone else.
    handleCloudflareSandboxMock.mockResolvedValue(
      new Response(JSON.stringify({ error: 'Invalid owner token', code: 'AUTH_FAILURE' }), {
        status: 403,
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
    expect(result.structuredError?.type).toBe('AUTH_FAILURE');
    expect(result.structuredError?.retryable).toBe(false);
    // Not fatal — the sandbox is alive, the caller just doesn't own it.
    // Forcing a resume here would attempt to restore over a healthy sandbox.
    expect(result.structuredError?.fatal).toBeUndefined();
  });

  it('classifies HTTP 429 (rate-limited) as RATE_LIMITED, not SANDBOX_UNREACHABLE', async () => {
    // The per-job rate-limit bucket (`X-Forwarded-For: job:<jobId>`) returns
    // `{ error: 'Rate limit exceeded…' }` with HTTP 429 — no `code` field.
    // Defaulting `err.code ?? 'SANDBOX_UNREACHABLE'` here would falsely trip
    // the kernel's loss tracker on two consecutive 429s and burn a resume
    // budget on a healthy sandbox. Distinct type + retryable=true tells the
    // kernel "back off and try again" without poisoning the loss counter.
    handleCloudflareSandboxMock.mockResolvedValue(
      new Response(JSON.stringify({ error: 'Rate limit exceeded. Try again later.' }), {
        status: 429,
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
    expect(result.structuredError?.type).toBe('RATE_LIMITED');
    expect(result.structuredError?.retryable).toBe(true);
    expect(result.structuredError?.fatal).toBeUndefined();
  });

  it('classifies unknown 4xx without an err.code as UNKNOWN (not SANDBOX_UNREACHABLE)', async () => {
    // Previously any 4xx without an `err.code` defaulted to
    // SANDBOX_UNREACHABLE, which fed the kernel's loss counter on errors
    // that have nothing to do with the sandbox being gone (e.g. handler
    // validation rejecting a request body shape). Map unknown 4xx to
    // UNKNOWN so the loss counter stays put. 5xx without a code still
    // defaults to SANDBOX_UNREACHABLE — backend trouble in the sandbox
    // handler IS the sandbox being unreachable from the kernel's POV.
    handleCloudflareSandboxMock.mockResolvedValue(
      new Response(JSON.stringify({ error: 'Some unexpected 4xx' }), { status: 422 }),
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
    expect(result.structuredError?.type).toBe('UNKNOWN');
    expect(result.structuredError?.retryable).toBe(false);
    expect(result.structuredError?.fatal).toBeUndefined();
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
      protectMain: false,
    });
    const result = await adapter.executeSandboxToolCall(
      { tool: 'sandbox_exec', args: { command: 'git push origin main' } } as SandboxToolCall,
      'sb-1',
      { auditorProviderOverride: 'openrouter', auditorModelOverride: undefined },
    );
    expect(result.structuredError?.type).toBe('APPROVAL_GATE_BLOCKED');
    expect(result.structuredError?.message).toContain('is blocked without allowDirectGit');
    expect(result.text).toContain('sandbox_commit to commit and prepare_push to ship');
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
      protectMain: false,
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

  // #977: the background lane must match the web git-guard — Protect Main blocks
  // raw push even with allowDirectGit, and forbidden ops have no escape at all.
  it('fails closed for raw `git push` when Protect Main context is missing', async () => {
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
        args: { command: 'git push origin HEAD:main', allowDirectGit: true },
      } as SandboxToolCall,
      'sb-1',
      { auditorProviderOverride: 'openrouter', auditorModelOverride: undefined },
    );
    expect(result.structuredError?.type).toBe('APPROVAL_GATE_BLOCKED');
    expect(result.structuredError?.message).toContain('Protect Main on');
    expect(handleCloudflareSandboxMock).not.toHaveBeenCalled();
  });

  it('blocks direct `git push` under Protect Main even with allowDirectGit', async () => {
    const adapter = createWebExecutorAdapter({
      env: env(),
      origin: 'https://push.example.test',
      sandboxId: 'sb-1',
      ownerToken: 'tok-1',
      provider: 'openrouter',
      jobId: 'job-test-1',
      protectMain: true,
    });
    const result = await adapter.executeSandboxToolCall(
      {
        tool: 'sandbox_exec',
        args: { command: 'git push origin HEAD:main', allowDirectGit: true },
      } as SandboxToolCall,
      'sb-1',
      { auditorProviderOverride: 'openrouter', auditorModelOverride: undefined },
    );
    expect(result.structuredError?.type).toBe('APPROVAL_GATE_BLOCKED');
    expect(result.structuredError?.message).toContain('Protect Main on');
    expect(result.text).toContain('Protect Main is on');
    expect(handleCloudflareSandboxMock).not.toHaveBeenCalled();
  });

  it('blocks a forbidden `git merge` even with allowDirectGit', async () => {
    const adapter = createWebExecutorAdapter({
      env: env(),
      origin: 'https://push.example.test',
      sandboxId: 'sb-1',
      ownerToken: 'tok-1',
      provider: 'openrouter',
      jobId: 'job-test-1',
      protectMain: false,
    });
    const result = await adapter.executeSandboxToolCall(
      {
        tool: 'sandbox_exec',
        args: { command: 'git merge feature/x', allowDirectGit: true },
      } as SandboxToolCall,
      'sb-1',
      { auditorProviderOverride: 'openrouter', auditorModelOverride: undefined },
    );
    expect(result.structuredError?.type).toBe('APPROVAL_GATE_BLOCKED');
    expect(result.structuredError?.message).toContain('no allowDirectGit escape');
    expect(handleCloudflareSandboxMock).not.toHaveBeenCalled();
  });

  it('blocks a `git remote set-url` repoint even with allowDirectGit', async () => {
    const adapter = createWebExecutorAdapter({
      env: env(),
      origin: 'https://push.example.test',
      sandboxId: 'sb-1',
      ownerToken: 'tok-1',
      provider: 'openrouter',
      jobId: 'job-test-1',
      protectMain: false,
    });
    const result = await adapter.executeSandboxToolCall(
      {
        tool: 'sandbox_exec',
        args: {
          command: 'git remote set-url origin https://evil.example/r.git',
          allowDirectGit: true,
        },
      } as SandboxToolCall,
      'sb-1',
      { auditorProviderOverride: 'openrouter', auditorModelOverride: undefined },
    );
    expect(result.structuredError?.type).toBe('APPROVAL_GATE_BLOCKED');
    expect(result.structuredError?.message).toContain('no allowDirectGit escape');
    expect(handleCloudflareSandboxMock).not.toHaveBeenCalled();
  });

  it('allows raw `git push` with allowDirectGit when Protect Main is off', async () => {
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
      protectMain: false,
    });
    const result = await adapter.executeSandboxToolCall(
      {
        tool: 'sandbox_exec',
        args: { command: 'git push origin HEAD:feature/x', allowDirectGit: true },
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
// Slice 3: sandbox_create_branch in background jobs
//
// Background path routes through the existing `exec` worker handler with a
// constructed `git checkout -b` command. Result carries `meta.branchCreated`
// (observability only, no UI routing — that boundary is the slice 3 contract).
// ---------------------------------------------------------------------------

describe('createWebExecutorAdapter — sandbox_create_branch (slice 3)', () => {
  beforeEach(() => {
    handleCloudflareSandboxMock.mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('routes through exec with git checkout -b and returns meta.branchCreated on success', async () => {
    handleCloudflareSandboxMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          stdout: "Switched to a new branch 'feature/foo'",
          stderr: '',
          exit_code: 0,
        }),
        { status: 200 },
      ),
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
      { tool: 'sandbox_create_branch', args: { name: 'feature/foo' } } as SandboxToolCall,
      'sb-1',
      { auditorProviderOverride: 'openrouter', auditorModelOverride: undefined },
    );

    expect(handleCloudflareSandboxMock).toHaveBeenCalledTimes(1);
    const forwardedReq = handleCloudflareSandboxMock.mock.calls[0]![0] as Request;
    expect(handleCloudflareSandboxMock.mock.calls[0]![3]).toBe('exec');
    const body = JSON.parse(await forwardedReq.text()) as Record<string, unknown>;
    expect(body.command).toBe(`cd /workspace && git checkout -b 'feature/foo'`);
    // allow_direct_git: true is required so the reused exec path bypasses
    // the worker-side git guard for this branch-create form.
    expect(body.allow_direct_git).toBe(true);

    expect(result.text).toContain('[Tool Result — sandbox_create_branch]');
    expect(result.text).toContain('Created and switched to feature/foo');
    expect(result.meta).toEqual({ branchCreated: { name: 'feature/foo' } });
    expect(result.structuredError).toBeUndefined();
  });

  it('includes `from` in the constructed atomic git checkout -b command', async () => {
    handleCloudflareSandboxMock.mockResolvedValue(
      new Response(JSON.stringify({ stdout: '', stderr: '', exit_code: 0 }), { status: 200 }),
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
        tool: 'sandbox_create_branch',
        args: { name: 'feature/foo', from: 'main' },
      } as SandboxToolCall,
      'sb-1',
      { auditorProviderOverride: 'openrouter', auditorModelOverride: undefined },
    );

    const forwardedReq = handleCloudflareSandboxMock.mock.calls[0]![0] as Request;
    const body = JSON.parse(await forwardedReq.text()) as Record<string, unknown>;
    // Atomic single-command form, not chained — failure must not leave HEAD on `from`.
    expect(body.command).toBe(`cd /workspace && git checkout -b 'feature/foo' 'main'`);
    expect(result.text).toContain('from main');
    expect(result.meta).toEqual({ branchCreated: { name: 'feature/foo' } });
  });

  it('returns a structured error on non-zero exit (e.g. branch already exists)', async () => {
    handleCloudflareSandboxMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          stdout: '',
          stderr: "fatal: a branch named 'feature/foo' already exists",
          exit_code: 128,
        }),
        { status: 200 },
      ),
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
      { tool: 'sandbox_create_branch', args: { name: 'feature/foo' } } as SandboxToolCall,
      'sb-1',
      { auditorProviderOverride: 'openrouter', auditorModelOverride: undefined },
    );

    expect(result.structuredError?.type).toBe('WRITE_FAILED');
    expect(result.structuredError?.message).toContain('already exists');
    expect(result.text).toContain('[Tool Error — sandbox_create_branch]');
    expect(result.meta).toBeUndefined();
  });

  it('rejects invalid branch name without invoking the handler', async () => {
    const adapter = createWebExecutorAdapter({
      env: env(),
      origin: 'https://push.example.test',
      sandboxId: 'sb-1',
      ownerToken: 'tok-1',
      provider: 'openrouter',
      jobId: 'job-test-1',
    });

    const result = await adapter.executeSandboxToolCall(
      { tool: 'sandbox_create_branch', args: { name: '-evil' } } as SandboxToolCall,
      'sb-1',
      { auditorProviderOverride: 'openrouter', auditorModelOverride: undefined },
    );

    expect(result.structuredError?.type).toBe('INVALID_ARG');
    expect(result.text).toContain('Invalid name "-evil"');
    expect(result.meta).toBeUndefined();
    expect(handleCloudflareSandboxMock).not.toHaveBeenCalled();
  });

  it('rejects invalid `from` ref without invoking the handler', async () => {
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
        tool: 'sandbox_create_branch',
        args: { name: 'feature/foo', from: '-evil' },
      } as SandboxToolCall,
      'sb-1',
      { auditorProviderOverride: 'openrouter', auditorModelOverride: undefined },
    );

    expect(result.structuredError?.type).toBe('INVALID_ARG');
    expect(result.text).toContain('Invalid from "-evil"');
    expect(handleCloudflareSandboxMock).not.toHaveBeenCalled();
  });

  it('redirects `git checkout -b` in sandbox_exec to sandbox_create_branch (slice 3 guidance)', async () => {
    // Pre-slice-3, the git_blocked branch told the model to use
    // sandbox_commit + prepare_push for ALL blocked git ops,
    // which was wrong for branch creation. Now that sandbox_create_branch
    // is wired for background jobs, the guidance points there directly.
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
        args: { command: 'git checkout -b feature/foo' },
      } as SandboxToolCall,
      'sb-1',
      { auditorProviderOverride: 'openrouter', auditorModelOverride: undefined },
    );

    expect(result.structuredError?.type).toBe('APPROVAL_GATE_BLOCKED');
    expect(result.structuredError?.message).toContain('use sandbox_create_branch');
    expect(result.text).toContain('sandbox_create_branch');
    expect(result.text).not.toContain('sandbox_commit');
    expect(handleCloudflareSandboxMock).not.toHaveBeenCalled();
  });

  it('explains `git checkout <branch>` is unsupported in background jobs (no sandbox_switch_branch fallback)', async () => {
    // Slice 2.5 detects bare branch checkouts. Slice 3 keeps
    // sandbox_switch_branch as `unsupported` in the adapter, so the
    // background-side guidance must NOT pretend the foreground tool
    // exists here — it tells the model to stop trying instead.
    const adapter = createWebExecutorAdapter({
      env: env(),
      origin: 'https://push.example.test',
      sandboxId: 'sb-1',
      ownerToken: 'tok-1',
      provider: 'openrouter',
      jobId: 'job-test-1',
    });

    const result = await adapter.executeSandboxToolCall(
      { tool: 'sandbox_exec', args: { command: 'git checkout main' } } as SandboxToolCall,
      'sb-1',
      { auditorProviderOverride: 'openrouter', auditorModelOverride: undefined },
    );

    expect(result.structuredError?.type).toBe('APPROVAL_GATE_BLOCKED');
    expect(result.structuredError?.message).toContain('branch switching unsupported');
    expect(result.text).toContain("isn't available in background Coder jobs");
    expect(handleCloudflareSandboxMock).not.toHaveBeenCalled();
  });

  it('explains `git switch feat/foo` is unsupported in background jobs', async () => {
    const adapter = createWebExecutorAdapter({
      env: env(),
      origin: 'https://push.example.test',
      sandboxId: 'sb-1',
      ownerToken: 'tok-1',
      provider: 'openrouter',
      jobId: 'job-test-1',
    });

    const result = await adapter.executeSandboxToolCall(
      { tool: 'sandbox_exec', args: { command: 'git switch feat/foo' } } as SandboxToolCall,
      'sb-1',
      { auditorProviderOverride: 'openrouter', auditorModelOverride: undefined },
    );

    expect(result.structuredError?.type).toBe('APPROVAL_GATE_BLOCKED');
    expect(result.structuredError?.message).toContain('branch switching unsupported');
    expect(result.text).toContain("isn't available in background Coder jobs");
    expect(handleCloudflareSandboxMock).not.toHaveBeenCalled();
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

  /**
   * Drain the PushStream into the legacy callback-shaped buckets the existing
   * test cases assert on. Lets the assertions stay focused on text-token
   * accumulation, terminal `done`, and structured errors without restating
   * each case as a `for await` loop.
   */
  async function drain(
    stream: ReturnType<typeof createWebStreamAdapter>,
    options: { messages?: ChatMessage[]; signal?: AbortSignal } = {},
  ): Promise<{ tokens: string[]; doneCalled: boolean; errors: Error[] }> {
    const tokens: string[] = [];
    let doneCalled = false;
    const errors: Error[] = [];
    const messages: ChatMessage[] = options.messages ?? [
      { id: '1', role: 'user', content: 'hi', timestamp: 0 },
    ];
    try {
      for await (const event of stream({
        provider: 'openrouter',
        model: 'anthropic/claude-sonnet-4.6:nitro',
        messages,
        signal: options.signal,
      })) {
        if (event.type === 'text_delta') {
          tokens.push(event.text);
        } else if (event.type === 'done') {
          doneCalled = true;
        }
      }
    } catch (err) {
      errors.push(err instanceof Error ? err : new Error(String(err)));
    }
    return { tokens, doneCalled, errors };
  }

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

  function responsesTextChunk(text: string, separator = '\n\n'): string {
    return `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: text })}${separator}`;
  }

  function responsesCompletedChunk(
    usage?: { input_tokens: number; output_tokens: number; total_tokens: number },
    separator = '\n\n',
  ): string {
    return `data: ${JSON.stringify({
      type: 'response.completed',
      response: { status: 'completed', ...(usage ? { usage } : {}) },
    })}${separator}`;
  }

  it('pumps OpenRouter Responses SSE tokens through onToken and closes on response.completed', async () => {
    providerHandlerMocks.handleOpenRouterChat.mockResolvedValue(
      sseResponse([responsesTextChunk('Hel'), responsesTextChunk('lo'), responsesCompletedChunk()]),
    );
    const stream = createWebStreamAdapter({
      env: env(),
      origin: 'https://push.example.test',
      provider: 'openrouter',
      modelId: 'anthropic/claude-sonnet-4.6:nitro',
      jobId: 'job-test-1',
    });

    const { tokens, doneCalled, errors } = await drain(stream);

    expect(tokens.join('')).toBe('Hello');
    expect(doneCalled).toBe(true);
    expect(errors).toEqual([]);

    const req = providerHandlerMocks.handleOpenRouterChat.mock.calls[0]![0] as Request;
    expect(req.url).toBe('https://push.example.test/api/openrouter/chat');
    expect(req.headers.get('Origin')).toBe('https://push.example.test');
    const body = JSON.parse(await req.text()) as { input: unknown; model: string; stream: boolean };
    expect(body.model).toBe('anthropic/claude-sonnet-4.6:nitro');
    expect(body.stream).toBe(true);
    expect(body.input).toEqual([
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
    ]);
  });

  it('emits Responses usage on the terminal done event', async () => {
    providerHandlerMocks.handleOpenRouterChat.mockResolvedValue(
      sseResponse([
        responsesTextChunk('hi'),
        responsesCompletedChunk({ input_tokens: 120, output_tokens: 34, total_tokens: 154 }),
      ]),
    );
    const stream = createWebStreamAdapter({
      env: env(),
      origin: 'https://push.example.test',
      provider: 'openrouter',
      modelId: 'anthropic/claude-sonnet-4.6:nitro',
      jobId: 'job-usage-1',
    });

    let doneUsage: { inputTokens: number; outputTokens: number; totalTokens: number } | undefined;
    let text = '';
    for await (const event of stream({
      provider: 'openrouter',
      model: 'anthropic/claude-sonnet-4.6:nitro',
      messages: [{ id: '1', role: 'user', content: 'hi', timestamp: 0 }],
    })) {
      if (event.type === 'text_delta') text += event.text;
      else if (event.type === 'done') doneUsage = event.usage;
    }

    expect(text).toBe('hi');
    expect(doneUsage).toEqual({ inputTokens: 120, outputTokens: 34, totalTokens: 154 });

    const req = providerHandlerMocks.handleOpenRouterChat.mock.calls[0]![0] as Request;
    const body = JSON.parse(await req.text()) as { stream: boolean; stream_options?: unknown };
    expect(body.stream).toBe(true);
    expect(body.stream_options).toBeUndefined();
  });

  it('emits done with undefined usage when the provider reports none', async () => {
    providerHandlerMocks.handleOpenRouterChat.mockResolvedValue(
      sseResponse([responsesTextChunk('hi'), responsesCompletedChunk()]),
    );
    const stream = createWebStreamAdapter({
      env: env(),
      origin: 'https://push.example.test',
      provider: 'openrouter',
      modelId: 'anthropic/claude-sonnet-4.6:nitro',
      jobId: 'job-usage-2',
    });

    let sawDone = false;
    let doneUsage: unknown = 'unset';
    for await (const event of stream({
      provider: 'openrouter',
      model: 'anthropic/claude-sonnet-4.6:nitro',
      messages: [{ id: '1', role: 'user', content: 'hi', timestamp: 0 }],
    })) {
      if (event.type === 'done') {
        sawDone = true;
        doneUsage = event.usage;
      }
    }
    expect(sawDone).toBe(true);
    expect(doneUsage).toBeUndefined();
  });

  it('throws when the provider handler returns a non-2xx status', async () => {
    providerHandlerMocks.handleOpenRouterChat.mockResolvedValue(
      new Response('upstream went boom', { status: 502 }),
    );
    const stream = createWebStreamAdapter({
      env: env(),
      origin: 'https://push.example.test',
      provider: 'openrouter',
      modelId: 'anthropic/claude-sonnet-4.6:nitro',
      jobId: 'job-test-1',
    });
    const { errors } = await drain(stream);
    expect(errors.length).toBe(1);
    expect(errors[0]!.message).toContain('502');
  });

  it('throws for unsupported providers (demo)', async () => {
    const stream = createWebStreamAdapter({
      env: env(),
      origin: 'https://push.example.test',
      provider: 'demo',
      modelId: 'demo-model',
      jobId: 'job-test-1',
    });
    const { errors } = await drain(stream);
    expect(errors.length).toBe(1);
    expect(errors[0]!.message).toContain('demo');
    expect(providerHandlerMocks.handleOpenRouterChat).not.toHaveBeenCalled();
  });

  it('ignores malformed SSE chunks and keeps pumping', async () => {
    providerHandlerMocks.handleOpenRouterChat.mockResolvedValue(
      sseResponse(['data: not-json\n\n', responsesTextChunk('ok'), responsesCompletedChunk()]),
    );
    const stream = createWebStreamAdapter({
      env: env(),
      origin: 'https://push.example.test',
      provider: 'openrouter',
      modelId: 'anthropic/claude-sonnet-4.6:nitro',
      jobId: 'job-test-1',
    });
    const { tokens, doneCalled, errors } = await drain(stream);
    expect(tokens.join('')).toBe('ok');
    expect(doneCalled).toBe(true);
    expect(errors).toEqual([]);
  });

  it('splits CRLF-delimited SSE (providers that frame with \\r\\n\\r\\n)', async () => {
    providerHandlerMocks.handleOpenRouterChat.mockResolvedValue(
      sseResponse([
        responsesTextChunk('hel', '\r\n\r\n'),
        responsesTextChunk('lo', '\r\n\r\n'),
        responsesCompletedChunk(undefined, '\r\n\r\n'),
      ]),
    );
    const stream = createWebStreamAdapter({
      env: env(),
      origin: 'https://push.example.test',
      provider: 'openrouter',
      modelId: 'anthropic/claude-sonnet-4.6:nitro',
      jobId: 'job-test-1',
    });
    const { tokens, doneCalled } = await drain(stream);
    expect(tokens.join('')).toBe('hello');
    expect(doneCalled).toBe(true);
  });

  it('builds a Chat Completions body for an OpenRouter model outside the /responses allowlist', async () => {
    // Same per-model gate as the web client and CLI: a non-allowlisted model
    // (the minimax case that motivated the allowlist) gets a `messages` body
    // and the chat SSE pump — never a Responses body the legacy endpoint
    // would 400 on.
    providerHandlerMocks.handleOpenRouterChat.mockResolvedValue(
      sseResponse([
        `data: ${JSON.stringify({ choices: [{ delta: { content: 'chat-path' } }] })}\n\n`,
        'data: [DONE]\n\n',
      ]),
    );
    const stream = createWebStreamAdapter({
      env: env(),
      origin: 'https://push.example.test',
      provider: 'openrouter',
      modelId: 'minimax/minimax-m3',
      jobId: 'job-chat-path-1',
    });

    const tokens: string[] = [];
    for await (const event of stream({
      provider: 'openrouter',
      model: 'minimax/minimax-m3',
      messages: [{ id: '1', role: 'user', content: 'hi', timestamp: 0 }],
    })) {
      if (event.type === 'text_delta') tokens.push(event.text);
    }

    expect(tokens.join('')).toBe('chat-path');
    const req = providerHandlerMocks.handleOpenRouterChat.mock.calls[0]![0] as Request;
    const body = JSON.parse(await req.text()) as {
      model: string;
      messages?: unknown;
      input?: unknown;
    };
    expect(body.model).toBe('minimax/minimax-m3');
    expect(body.messages).toBeDefined();
    expect(body.input).toBeUndefined();
  });

  it('stamps X-Forwarded-For with job:<jobId> so jobs get distinct rate-limit buckets', async () => {
    providerHandlerMocks.handleOpenRouterChat.mockResolvedValue(sseResponse(['data: [DONE]\n\n']));
    const stream = createWebStreamAdapter({
      env: env(),
      origin: 'https://push.example.test',
      provider: 'openrouter',
      modelId: 'anthropic/claude-sonnet-4.6:nitro',
      jobId: 'job-rate-limit-1',
    });
    await drain(stream);
    const req = providerHandlerMocks.handleOpenRouterChat.mock.calls[0]![0] as Request;
    expect(req.headers.get('X-Forwarded-For')).toBe('job:job-rate-limit-1');
  });

  it('honors an aborted AbortSignal by throwing before dispatch', async () => {
    const controller = new AbortController();
    controller.abort();
    const stream = createWebStreamAdapter({
      env: env(),
      origin: 'https://push.example.test',
      provider: 'openrouter',
      modelId: 'anthropic/claude-sonnet-4.6:nitro',
      jobId: 'job-test-1',
    });
    const { errors } = await drain(stream, { signal: controller.signal });
    expect(errors.length).toBe(1);
    expect(errors[0]!.message).toMatch(/abort/i);
    expect(providerHandlerMocks.handleOpenRouterChat).not.toHaveBeenCalled();
  });

  it('normalizes a trailing-slash origin so URLs do not become double-slashed', async () => {
    providerHandlerMocks.handleOpenRouterChat.mockResolvedValue(sseResponse(['data: [DONE]\n\n']));
    const stream = createWebStreamAdapter({
      env: env(),
      origin: 'https://push.example.test/',
      provider: 'openrouter',
      modelId: 'anthropic/claude-sonnet-4.6:nitro',
      jobId: 'job-test-1',
    });
    await drain(stream);
    const req = providerHandlerMocks.handleOpenRouterChat.mock.calls[0]![0] as Request;
    expect(req.url).toBe('https://push.example.test/api/openrouter/chat');
  });

  // --- Zen "Go" routing (server-side opt-in; browser uses a localStorage flag) ---

  /** Drain a stream with an explicit provider+model (the shared `drain`
   * hardcodes openrouter/sonnet, which the Zen Go cases need to override). */
  async function drainAs(
    stream: ReturnType<typeof createWebStreamAdapter>,
    provider: AIProviderType,
    model: string,
  ): Promise<{ tokens: string[]; errors: Error[] }> {
    const tokens: string[] = [];
    const errors: Error[] = [];
    try {
      for await (const event of stream({
        provider,
        model,
        messages: [{ id: '1', role: 'user', content: 'hi', timestamp: 0 }],
      })) {
        if (event.type === 'text_delta') tokens.push(event.text);
      }
    } catch (err) {
      errors.push(err instanceof Error ? err : new Error(String(err)));
    }
    return { tokens, errors };
  }

  it('routes zen→Go handler (and not the regular zen handler) when zenGo is set', async () => {
    providerHandlerMocks.handleZenGoChat.mockResolvedValue(
      sseResponse(['data: {"choices":[{"delta":{"content":"hi"}}]}\n\n', 'data: [DONE]\n\n']),
    );
    const stream = createWebStreamAdapter({
      env: env(),
      origin: 'https://push.example.test',
      provider: 'zen',
      modelId: 'kimi-k2.6',
      jobId: 'job-zen-go',
      zenGo: true,
    });
    const { tokens, errors } = await drainAs(stream, 'zen', 'kimi-k2.6');
    expect(errors).toEqual([]);
    expect(tokens.join('')).toBe('hi');
    expect(providerHandlerMocks.handleZenGoChat).toHaveBeenCalledTimes(1);
    expect(providerHandlerMocks.handleZenChat).not.toHaveBeenCalled();
    const req = providerHandlerMocks.handleZenGoChat.mock.calls[0]![0] as Request;
    expect(req.url).toBe('https://push.example.test/api/zen/go/chat');
  });

  it('routes zen→regular handler when zenGo is unset', async () => {
    providerHandlerMocks.handleZenChat.mockResolvedValue(sseResponse(['data: [DONE]\n\n']));
    const stream = createWebStreamAdapter({
      env: env(),
      origin: 'https://push.example.test',
      provider: 'zen',
      modelId: 'kimi-k2.6',
      jobId: 'job-zen-regular',
    });
    await drainAs(stream, 'zen', 'kimi-k2.6');
    expect(providerHandlerMocks.handleZenChat).toHaveBeenCalledTimes(1);
    expect(providerHandlerMocks.handleZenGoChat).not.toHaveBeenCalled();
    const req = providerHandlerMocks.handleZenChat.mock.calls[0]![0] as Request;
    expect(req.url).toBe('https://push.example.test/api/zen/chat');
  });

  it('parses an Anthropic-transport Go model as native Anthropic SSE', async () => {
    // handleZenGoChat now proxies raw Anthropic Messages SSE for anthropic-transport
    // models (minimax-* / qwen-*) — no OpenAI-SSE translator. The adapter must parse
    // those `content_block_delta` frames natively via `anthropicEventStream`, not the
    // OpenAI-shaped `pumpSseBody`.
    providerHandlerMocks.handleZenGoChat.mockResolvedValue(
      sseResponse([
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}\n\n',
      ]),
    );
    const stream = createWebStreamAdapter({
      env: env(),
      origin: 'https://push.example.test',
      provider: 'zen',
      modelId: 'minimax-m2.7',
      jobId: 'job-zen-go-anthropic',
      zenGo: true,
    });
    const { tokens, errors } = await drainAs(stream, 'zen', 'minimax-m2.7');
    expect(errors).toEqual([]);
    expect(tokens.join('')).toBe('ok');
    expect(providerHandlerMocks.handleZenGoChat).toHaveBeenCalledTimes(1);
  });

  it('keeps an OpenAI-transport Go model on the OpenAI-shaped pump', async () => {
    // Counterpart to the native-Anthropic case: a non-anthropic-transport Go model
    // (e.g. kimi-k2.6) still streams OpenAI-shaped SSE and must parse via pumpSseBody.
    providerHandlerMocks.handleZenGoChat.mockResolvedValue(
      sseResponse(['data: {"choices":[{"delta":{"content":"ok"}}]}\n\n', 'data: [DONE]\n\n']),
    );
    const stream = createWebStreamAdapter({
      env: env(),
      origin: 'https://push.example.test',
      provider: 'zen',
      modelId: 'kimi-k2.6',
      jobId: 'job-zen-go-openai',
      zenGo: true,
    });
    const { tokens, errors } = await drainAs(stream, 'zen', 'kimi-k2.6');
    expect(errors).toEqual([]);
    expect(tokens.join('')).toBe('ok');
    expect(providerHandlerMocks.handleZenGoChat).toHaveBeenCalledTimes(1);
  });
});

describe('createWebStreamAdapter — user-stored key injection', () => {
  beforeEach(() => {
    Object.values(providerHandlerMocks).forEach((fn) => fn.mockReset());
  });

  function kvEnv(store = new Map<string, string>()): Env {
    return {
      ...env(),
      PUSH_SESSION_SECRET: 'test-session-secret',
      SNAPSHOT_INDEX: {
        get: async (k: string) => store.get(k) ?? null,
        put: async (k: string, v: string) => {
          store.set(k, v);
        },
      },
    } as unknown as Env;
  }

  it('injects the owner-stored key as the Authorization header', async () => {
    const e = kvEnv();
    await putUserProviderKey(e, '107059169', 'openrouter', 'sk-or-user-stored');
    providerHandlerMocks.handleOpenRouterChat.mockResolvedValue(
      new Response('data: [DONE]\n\n', {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      }),
    );
    const stream = createWebStreamAdapter({
      env: e,
      origin: 'https://push.example.test',
      provider: 'openrouter',
      modelId: 'm',
      jobId: 'job-key-1',
      ownerUserId: '107059169',
    });
    for await (const event of stream({
      provider: 'openrouter',
      model: 'm',
      messages: [{ id: '1', role: 'user', content: 'hi', timestamp: 0 }],
    })) {
      void event; // drain
    }
    const req = providerHandlerMocks.handleOpenRouterChat.mock.calls[0]![0] as Request;
    expect(req.headers.get('Authorization')).toBe('Bearer sk-or-user-stored');
  });

  it('sends no Authorization header without an ownerUserId or stored key', async () => {
    providerHandlerMocks.handleOpenRouterChat.mockResolvedValue(
      new Response('data: [DONE]\n\n', {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      }),
    );
    const stream = createWebStreamAdapter({
      env: kvEnv(),
      origin: 'https://push.example.test',
      provider: 'openrouter',
      modelId: 'm',
      jobId: 'job-key-2',
      ownerUserId: 'someone-with-no-keys',
    });
    for await (const event of stream({
      provider: 'openrouter',
      model: 'm',
      messages: [{ id: '1', role: 'user', content: 'hi', timestamp: 0 }],
    })) {
      void event; // drain
    }
    const req = providerHandlerMocks.handleOpenRouterChat.mock.calls[0]![0] as Request;
    expect(req.headers.get('Authorization')).toBeNull();
  });
});
