import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatCard, ChatMessage } from '@/types';
import type { AnyToolCall } from './tool-dispatch';

const {
  mockEstimateContextTokens,
  mockGetContextBudget,
  mockGetDirtyFilesWithProvenance,
  mockGetSandboxEnvironment,
} = vi.hoisted(() => ({
  mockEstimateContextTokens: vi.fn(),
  mockGetContextBudget: vi.fn(),
  mockGetDirtyFilesWithProvenance: vi.fn(),
  mockGetSandboxEnvironment: vi.fn(),
}));

vi.mock('./orchestrator', () => ({
  estimateContextTokens: (...args: unknown[]) => mockEstimateContextTokens(...args),
  getContextBudget: (...args: unknown[]) => mockGetContextBudget(...args),
}));

vi.mock('./file-awareness-ledger', () => ({
  fileLedger: {
    getDirtyFilesWithProvenance: (...args: unknown[]) => mockGetDirtyFilesWithProvenance(...args),
  },
}));

vi.mock('./sandbox-client', () => ({
  getSandboxEnvironment: (...args: unknown[]) => mockGetSandboxEnvironment(...args),
}));

import {
  appendCardsToLatestToolCall,
  buildToolMeta,
  buildToolResultMessage,
  buildToolResultMetaLine,
  getToolName,
  getToolStatusDetail,
  getToolStatusLabel,
  markLastAssistantToolCall,
} from './chat-tool-messages';

function assistantMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'assistant-1',
    role: 'assistant',
    content: 'hello',
    timestamp: 1,
    status: 'streaming',
    ...overrides,
  };
}

function userMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'user-1',
    role: 'user',
    content: 'hi',
    timestamp: 1,
    status: 'done',
    ...overrides,
  };
}

describe('chat-tool-messages', () => {
  beforeEach(() => {
    mockEstimateContextTokens.mockReset().mockReturnValue(4096);
    mockGetContextBudget.mockReset().mockReturnValue({ maxTokens: 128000 });
    mockGetDirtyFilesWithProvenance.mockReset().mockReturnValue([]);
    mockGetSandboxEnvironment.mockReset().mockReturnValue(null);
  });

  it('maps tool calls to user-facing status labels', () => {
    const sandboxExec: AnyToolCall = {
      source: 'sandbox',
      call: { tool: 'sandbox_exec', args: { command: 'npm test' } },
    } as AnyToolCall;
    const delegateExplorer: AnyToolCall = {
      source: 'delegate',
      call: { tool: 'delegate_explorer', args: { task: 'Inspect flow' } },
    };

    expect(getToolStatusLabel(sandboxExec)).toBe('Executing in sandbox...');
    expect(getToolStatusLabel(delegateExplorer)).toBe('Delegating to Explorer...');
  });

  it('extracts tool-specific detail for the status banner', () => {
    // Sandbox exec — show the command. The user's complaint that
    // motivated this surface: "all I see is 'executing in sandbox' with
    // a blinking light" — the detail tells them *which* command is
    // running.
    const sandboxExec: AnyToolCall = {
      source: 'sandbox',
      call: { tool: 'sandbox_exec', args: { command: 'npm install && npm run test' } },
    } as AnyToolCall;
    expect(getToolStatusDetail(sandboxExec)).toBe('npm install && npm run test');

    // File-targeted tools — show the path.
    const readFile: AnyToolCall = {
      source: 'sandbox',
      call: { tool: 'sandbox_read_file', args: { path: 'src/lib/foo.ts' } },
    } as AnyToolCall;
    expect(getToolStatusDetail(readFile)).toBe('src/lib/foo.ts');

    // Delegations — show the task summary.
    const delegateCoder: AnyToolCall = {
      source: 'delegate',
      call: { tool: 'delegate_coder', args: { task: 'Fix the failing test in foo.ts' } },
    };
    expect(getToolStatusDetail(delegateCoder)).toBe('Fix the failing test in foo.ts');

    // Web search — show the query.
    const webSearch: AnyToolCall = {
      source: 'web-search',
      call: { tool: 'web_search', args: { query: 'latest React 19 changes' } },
    };
    expect(getToolStatusDetail(webSearch)).toBe('latest React 19 changes');
  });

  it('truncates overly long detail strings with an ellipsis', () => {
    // 70-char command — truncated to 60 with an ellipsis suffix so the
    // user sees the value was cut. Keeps the status line scannable on
    // mobile.
    const longCommand = 'a'.repeat(70);
    const sandboxExec: AnyToolCall = {
      source: 'sandbox',
      call: { tool: 'sandbox_exec', args: { command: longCommand } },
    } as AnyToolCall;
    const detail = getToolStatusDetail(sandboxExec);
    expect(detail).toBeDefined();
    expect(detail!.length).toBeLessThanOrEqual(60);
    expect(detail).toMatch(/…$/);
  });

  it('returns undefined when the tool has no useful detail or args are empty', () => {
    // Empty command — nothing to show.
    const emptyExec: AnyToolCall = {
      source: 'sandbox',
      call: { tool: 'sandbox_exec', args: { command: '   ' } },
    } as AnyToolCall;
    expect(getToolStatusDetail(emptyExec)).toBeUndefined();

    // Tool we don't have a detail extractor for. `sandbox_status` is not a
    // declared SandboxToolCall variant — that's the point of the test, so
    // we double-cast to bypass the union check.
    const sandboxStatus = {
      source: 'sandbox',
      call: { tool: 'sandbox_status', args: {} },
    } as unknown as AnyToolCall;
    expect(getToolStatusDetail(sandboxStatus)).toBeUndefined();
  });

  it('extracts tool names for provenance tracking', () => {
    const webSearch: AnyToolCall = {
      source: 'web-search',
      call: { tool: 'web_search', args: { query: 'latest React 19 changes' } },
    };

    expect(getToolName(webSearch)).toBe('web');
  });

  it('builds meta lines with dirty-file provenance counts', () => {
    mockGetDirtyFilesWithProvenance.mockReturnValue([
      { modifiedBy: 'agent' },
      { modifiedBy: 'user' },
      { modifiedBy: 'unknown' },
    ]);

    const metaLine = buildToolResultMetaLine(
      3,
      [assistantMessage({ content: 'First message' }), userMessage({ content: 'Second message' })],
      'openrouter',
      'claude-sonnet-4.6:nitro',
      { dirty: true, files: 3 },
    );

    expect(metaLine).toContain('[meta] round=3');
    expect(metaLine).toContain('pressure=low pct=3');
    expect(metaLine).toContain('dirty=true files=3');
    expect(metaLine).toContain('by:[agent=1,user=1,unknown=1]');
  });

  it('emits workspace pulse lines when requested', () => {
    mockGetSandboxEnvironment.mockReturnValue({
      tools: { node: 'v22.0.0' },
      warnings: ['Low disk space: 420M'],
    });

    const metaLine = buildToolResultMetaLine(
      2,
      [assistantMessage({ content: 'Inspect repo state' })],
      'openrouter',
      'claude-sonnet-4.6:nitro',
      {
        dirty: true,
        files: 2,
        branch: 'feature/runtime-contract',
        head: 'abc1234',
        changedFiles: ['src/a.ts', 'src/b.ts'],
      },
      { includePulse: true, pulseReason: 'mutation' },
    );

    expect(metaLine).toContain('[pulse]');
    expect(metaLine).toContain('"reason":"mutation"');
    expect(metaLine).toContain('"branch":"feature/runtime-contract"');
    expect(metaLine).toContain('"head":"abc1234"');
    expect(metaLine).toContain('"changedFiles":["src/a.ts","src/b.ts"]');
    expect(metaLine).toContain('"warnings":["Low disk space: 420M"]');
  });

  it('builds tool result messages with wrapped content and tool metadata', () => {
    const toolMeta = buildToolMeta({
      toolName: 'sandbox_exec',
      source: 'sandbox',
      provider: 'openrouter',
      durationMs: 42,
      isError: false,
    });

    const message = buildToolResultMessage({
      id: 'tool-result-1',
      timestamp: 100,
      text: '[Tool Result] ok',
      metaLine: '[meta] round=1',
      toolMeta,
    });

    expect(message).toMatchObject({
      id: 'tool-result-1',
      role: 'user',
      status: 'done',
      isToolResult: true,
      toolMeta,
    });
    expect(message.content).toContain('[meta] round=1');
    expect(message.content).toContain('[Tool Result] ok');
    // No branch passed -> message left unstamped, deferring to the
    // read-boundary fallback.
    expect(message.branch).toBeUndefined();
  });

  it('stamps the provided branch on the tool result message', () => {
    const toolMeta = buildToolMeta({
      toolName: 'delegate_coder',
      source: 'delegate',
      provider: 'openrouter',
      durationMs: 100,
      isError: false,
    });

    const message = buildToolResultMessage({
      id: 'tool-result-2',
      timestamp: 200,
      text: '[Tool Result] coder done',
      toolMeta,
      branch: 'main',
    });

    // Critical for R11: when the caller passes the dispatch-time
    // originBranch, the resulting message stamps that branch verbatim.
    expect(message.branch).toBe('main');
  });

  it('marks the last assistant message as a completed tool call', () => {
    const toolMeta = buildToolMeta({
      toolName: 'sandbox_exec',
      source: 'sandbox',
      provider: 'openrouter',
      durationMs: 0,
      isError: true,
    });

    const messages = markLastAssistantToolCall(
      [userMessage(), assistantMessage({ content: 'streaming...' })],
      {
        content: '{"tool":"sandbox_exec"}',
        thinking: 'Need to inspect the repo',
        malformed: true,
        toolMeta,
      },
    );

    expect(messages[1]).toMatchObject({
      content: '{"tool":"sandbox_exec"}',
      thinking: 'Need to inspect the repo',
      status: 'done',
      isToolCall: true,
      isMalformed: true,
      toolMeta,
    });
  });

  it('attaches non-sandbox-state cards to the latest assistant tool call', () => {
    const cards: ChatCard[] = [
      { type: 'sandbox-state', data: {} as never },
      {
        type: 'test-results',
        data: {
          framework: 'npm',
          passed: 1,
          failed: 0,
          skipped: 0,
          total: 1,
          durationMs: 50,
          exitCode: 0,
          output: 'ok',
          truncated: false,
        },
      },
    ];

    const messages = appendCardsToLatestToolCall(
      [
        assistantMessage({ id: 'assistant-0', isToolCall: true }),
        userMessage(),
        assistantMessage({ id: 'assistant-1', isToolCall: true }),
      ],
      cards,
    );

    expect(messages[0].cards).toBeUndefined();
    expect(messages[2].cards).toHaveLength(1);
    expect(messages[2].cards?.[0].type).toBe('test-results');
  });
});
