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
    getDirtyFilesWithProvenance: (...args: unknown[]) =>
      mockGetDirtyFilesWithProvenance(...args),
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
      [
        assistantMessage({ content: 'First message' }),
        userMessage({ content: 'Second message' }),
      ],
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
