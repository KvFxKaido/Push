/**
 * Characterization tests for the step-3 tracing spine pass.
 *
 * These tests pin the contract that when a caller threads a
 * `CorrelationContext` through the tool-execution seams, the resulting
 * `withActiveSpan` call emits the canonical `push.*` attributes defined
 * by `lib/correlation-context.ts`.
 *
 * Scope (per the Architecture Remediation Plan step 3):
 *   - `chat-tool-execution.ts:executeTool` (chat-layer tool execution)
 *   - `agent-loop-utils.ts:executeReadOnlyTool` (explorer read-only path)
 *
 * These two functions are the pure, testable seams through which the
 * sandbox-tools dispatcher is ultimately reached. Pinning their span
 * attributes here gives the "a single failing tool call can be followed
 * end-to-end across surfaces from one query" signal that step 3 needs.
 *
 * The coder-agent spans (`tool.execute` web-search and sandbox variants)
 * use the same `correlationToSpanAttributes(...)` spread pattern — they
 * are covered by typecheck + code review rather than a unit test because
 * mocking the full coder-agent loop is out of proportion for a purely
 * additive attribute change.
 *
 * The useAgentDelegation hook's 8 span sites are covered by the same
 * typecheck + review boundary for the same reason: the change at each
 * site is a mechanical `correlationToSpanAttributes(...)` spread that
 * cannot alter runtime behavior.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Attributes } from '@opentelemetry/api';
import type { CorrelationContext } from '@push/lib/correlation-context';

// ---------------------------------------------------------------------------
// Mocks must be set up before importing the modules under test
// ---------------------------------------------------------------------------

type CapturedSpan = { name: string; attributes: Attributes | undefined };
const capturedSpans: CapturedSpan[] = [];

/**
 * Mock `app/src/lib/tracing` so `withActiveSpan` becomes a pass-through
 * that records the attributes it was handed. The fake span object only
 * needs the methods our code under test calls (`setAttribute`,
 * `setStatus`) — the real OTel span shape is not under test here.
 */
vi.mock('./tracing', () => {
  const fakeSpan = {
    setAttribute: vi.fn(),
    setStatus: vi.fn(),
    recordException: vi.fn(),
  };
  return {
    withActiveSpan: vi.fn(
      async (
        name: string,
        options: { attributes?: Attributes },
        fn: (span: typeof fakeSpan, ctx: unknown) => Promise<unknown>,
      ) => {
        capturedSpans.push({ name, attributes: options.attributes });
        return fn(fakeSpan, {});
      },
    ),
    setSpanAttributes: vi.fn(),
    recordSpanError: vi.fn(),
    SpanKind: { INTERNAL: 1 },
    SpanStatusCode: { OK: 1, ERROR: 2 },
  };
});

// `chat-tool-execution.ts` lives in `app/src/lib/` and imports
// `@/lib/tracing` via the `@` alias — mock that path too so the mock
// above applies to the module's import as well.
vi.mock('@/lib/tracing', () => {
  const fakeSpan = {
    setAttribute: vi.fn(),
    setStatus: vi.fn(),
    recordException: vi.fn(),
  };
  return {
    withActiveSpan: vi.fn(
      async (
        name: string,
        options: { attributes?: Attributes },
        fn: (span: typeof fakeSpan, ctx: unknown) => Promise<unknown>,
      ) => {
        capturedSpans.push({ name, attributes: options.attributes });
        return fn(fakeSpan, {});
      },
    ),
    setSpanAttributes: vi.fn(),
    recordSpanError: vi.fn(),
    SpanKind: { INTERNAL: 1 },
    SpanStatusCode: { OK: 1, ERROR: 2 },
  };
});

// `executeAnyToolCall` is what `executeTool` reaches into — stub it to
// return a minimal result. The behavior under test is the attribute
// bag, not the downstream dispatch logic.
vi.mock('@/lib/tool-dispatch', async () => {
  const actual = await vi.importActual<typeof import('@/lib/tool-dispatch')>('@/lib/tool-dispatch');
  return {
    ...actual,
    executeAnyToolCall: vi.fn(async () => ({ text: 'stub result' })),
  };
});

// ---------------------------------------------------------------------------
// Imports — after the mocks are set up
// ---------------------------------------------------------------------------

import { executeTool, type ToolExecRunContext } from './chat-tool-execution';
import { executeReadOnlyTool } from './agent-loop-utils';
import type { AnyToolCall } from './tool-dispatch';
import type { ToolHookRegistry } from './tool-hooks';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

function makeReadToolCall(): AnyToolCall {
  return {
    source: 'sandbox',
    call: {
      tool: 'sandbox_read_file',
      args: { path: '/workspace/app.ts' },
    },
  } as AnyToolCall;
}

function makeCorrelation(overrides: Partial<CorrelationContext> = {}): CorrelationContext {
  return {
    surface: 'web',
    chatId: 'c-test',
    runId: 'r-test',
    executionId: 'x-test',
    toolCallId: 'tc-test',
    ...overrides,
  };
}

function lastSpanAttributes(): Record<string, unknown> {
  const last = capturedSpans[capturedSpans.length - 1];
  expect(last).toBeDefined();
  return (last.attributes ?? {}) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// chat-tool-execution.ts — executeTool
// ---------------------------------------------------------------------------

describe('executeTool -- correlation span attributes', () => {
  beforeEach(() => {
    capturedSpans.length = 0;
  });

  it('emits all canonical push.* attributes when ctx.correlation is supplied', async () => {
    const ctx: ToolExecRunContext = {
      repoFullName: 'owner/repo',
      chatId: 'c-test',
      sandboxId: 'sb-1',
      role: 'orchestrator',
      isMainProtected: false,
      defaultBranch: 'main',
      provider: 'openrouter',
      model: 'claude-opus-4-6',
      correlation: makeCorrelation({
        taskGraphId: 'tg-test',
        taskId: 'task-42',
      }),
    };

    await executeTool(makeReadToolCall(), ctx);

    const attrs = lastSpanAttributes();
    expect(attrs['push.surface']).toBe('web');
    expect(attrs['push.chat_id']).toBe('c-test');
    expect(attrs['push.run_id']).toBe('r-test');
    expect(attrs['push.execution_id']).toBe('x-test');
    expect(attrs['push.tool_call_id']).toBe('tc-test');
    expect(attrs['push.task_graph_id']).toBe('tg-test');
    expect(attrs['push.task_id']).toBe('task-42');

    // Pre-existing attributes from the tool-execute span are preserved.
    expect(attrs['push.tool.name']).toBe('sandbox_read_file');
    expect(attrs['push.tool.source']).toBe('sandbox');
    expect(attrs['push.has_repo']).toBe(true);
    expect(attrs['push.has_sandbox']).toBe(true);
  });

  it('emits no correlation attributes when ctx.correlation is undefined', async () => {
    const ctx: ToolExecRunContext = {
      repoFullName: 'owner/repo',
      chatId: null,
      sandboxId: 'sb-1',
      role: 'orchestrator',
      isMainProtected: false,
      defaultBranch: 'main',
      provider: 'openrouter',
      model: 'claude-opus-4-6',
      // correlation intentionally omitted
    };

    await executeTool(makeReadToolCall(), ctx);

    const attrs = lastSpanAttributes();
    expect(attrs['push.surface']).toBeUndefined();
    expect(attrs['push.chat_id']).toBeUndefined();
    expect(attrs['push.run_id']).toBeUndefined();
    expect(attrs['push.execution_id']).toBeUndefined();
    expect(attrs['push.tool_call_id']).toBeUndefined();
    // The pre-existing span attributes still flow through unchanged.
    expect(attrs['push.tool.name']).toBe('sandbox_read_file');
  });

  it('only emits the subset of correlation fields that are set', async () => {
    const ctx: ToolExecRunContext = {
      repoFullName: null,
      chatId: 'c-only',
      sandboxId: null,
      role: 'orchestrator',
      isMainProtected: false,
      defaultBranch: undefined,
      provider: 'openrouter',
      model: undefined,
      correlation: { surface: 'web', chatId: 'c-only' },
    };

    await executeTool(makeReadToolCall(), ctx);

    const attrs = lastSpanAttributes();
    expect(attrs['push.surface']).toBe('web');
    expect(attrs['push.chat_id']).toBe('c-only');
    expect(attrs['push.run_id']).toBeUndefined();
    expect(attrs['push.execution_id']).toBeUndefined();
    expect(attrs['push.tool_call_id']).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// agent-loop-utils.ts — executeReadOnlyTool
// ---------------------------------------------------------------------------

describe('executeReadOnlyTool -- correlation span attributes', () => {
  beforeEach(() => {
    capturedSpans.length = 0;
  });

  // A fake runtime that returns a canned result, so we don't exercise
  // the real WebToolExecutionRuntime. The span attribute bag is what
  // the test cares about.
  const fakeRuntime = {
    execute: vi.fn(async () => ({ text: 'ok', card: undefined, structuredError: undefined })),
  };
  const fakeHooks: ToolHookRegistry = {
    beforeToolCall: () => null,
    afterToolCall: () => null,
  } as unknown as ToolHookRegistry;

  it('emits all canonical push.* attributes when options.correlation is supplied', async () => {
    const correlation = makeCorrelation({
      taskGraphId: 'tg-explore',
      taskId: 'task-explore',
    });

    await executeReadOnlyTool(
      makeReadToolCall(),
      'owner/repo',
      'sb-explorer',
      'openrouter',
      'claude-opus-4-6',
      fakeHooks,
      {
        correlation,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        runtime: fakeRuntime as any,
        role: 'explorer',
      },
    );

    const attrs = lastSpanAttributes();
    expect(attrs['push.surface']).toBe('web');
    expect(attrs['push.chat_id']).toBe('c-test');
    expect(attrs['push.run_id']).toBe('r-test');
    expect(attrs['push.execution_id']).toBe('x-test');
    expect(attrs['push.tool_call_id']).toBe('tc-test');
    expect(attrs['push.task_graph_id']).toBe('tg-explore');
    expect(attrs['push.task_id']).toBe('task-explore');

    // Pre-existing attributes preserved.
    expect(attrs['push.tool.name']).toBe('sandbox_read_file');
    expect(attrs['push.tool.source']).toBe('sandbox');
    expect(attrs['push.agent.role']).toBe('explorer');
  });

  it('emits no correlation attributes when options.correlation is omitted', async () => {
    await executeReadOnlyTool(
      makeReadToolCall(),
      'owner/repo',
      'sb-explorer',
      'openrouter',
      'claude-opus-4-6',
      fakeHooks,
      {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        runtime: fakeRuntime as any,
        role: 'explorer',
      },
    );

    const attrs = lastSpanAttributes();
    expect(attrs['push.chat_id']).toBeUndefined();
    expect(attrs['push.run_id']).toBeUndefined();
    expect(attrs['push.execution_id']).toBeUndefined();
    expect(attrs['push.tool_call_id']).toBeUndefined();
    // Non-correlation attributes still emitted.
    expect(attrs['push.tool.name']).toBe('sandbox_read_file');
    expect(attrs['push.agent.role']).toBe('explorer');
  });

  it('reports the explicit role on the span (required field, no default)', async () => {
    await executeReadOnlyTool(
      makeReadToolCall(),
      'owner/repo',
      'sb-explorer',
      'openrouter',
      'claude-opus-4-6',
      fakeHooks,
      {
        role: 'explorer',
        correlation: makeCorrelation(),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        runtime: fakeRuntime as any,
      },
    );

    const attrs = lastSpanAttributes();
    expect(attrs['push.agent.role']).toBe('explorer');
    expect(attrs['push.chat_id']).toBe('c-test');
  });
});
