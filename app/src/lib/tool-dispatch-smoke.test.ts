import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock networked/tool side-effect modules before importing dispatch.
vi.mock('./sandbox-client', () => ({
  execInSandbox: vi.fn(),
  findReferencesInSandbox: vi.fn(),
  readFromSandbox: vi.fn(),
  writeToSandbox: vi.fn(),
  batchWriteToSandbox: vi.fn(),
  getSandboxDiff: vi.fn(),
  listDirectory: vi.fn(),
  downloadFromSandbox: vi.fn(),
}));

vi.mock('./auditor-agent', () => ({
  runAuditor: vi.fn(),
}));

vi.mock('./edit-metrics', () => ({
  recordWriteFileMetric: vi.fn(),
  recordReadFileMetric: vi.fn(),
}));

import { detectAnyToolCall, executeAnyToolCall } from './tool-dispatch';
import * as sandboxClient from './sandbox-client';
import { runAuditor } from './auditor-agent';
import { fileLedger } from './file-awareness-ledger';
import { createToolHookRegistry } from './tool-hooks';

describe('tool-dispatch smoke -- sandbox_search_replace', () => {
  beforeEach(() => {
    vi.mocked(sandboxClient.readFromSandbox).mockReset();
    vi.mocked(sandboxClient.writeToSandbox).mockReset();
    vi.mocked(sandboxClient.execInSandbox).mockReset();
    vi.mocked(sandboxClient.getSandboxDiff).mockReset();
    vi.mocked(runAuditor).mockReset();
    fileLedger.reset();
  });

  it('detects and executes search_replace through unified dispatch (literal replace + no second read)', async () => {
    const path = '/workspace/src/app.ts';
    const fileContent = 'const token = "foo";\n';

    vi.mocked(sandboxClient.readFromSandbox)
      .mockResolvedValueOnce({
        content: fileContent,
        truncated: false,
        version: 'v1',
      })
      // Post-write verification read-back (non-critical).
      .mockResolvedValueOnce({ content: 'c', truncated: false, version: 'v2' });

    vi.mocked(sandboxClient.writeToSandbox).mockResolvedValue({
      ok: true,
      new_version: 'v2',
      bytes_written: 24,
    });
    vi.mocked(sandboxClient.execInSandbox).mockResolvedValue({
      stdout: '',
      stderr: '',
      exitCode: 0,
      truncated: false,
    });

    const callText = [
      '```json',
      JSON.stringify({
        tool: 'sandbox_search_replace',
        args: { path, search: 'foo', replace: '$1$&$$' },
      }),
      '```',
    ].join('\n');

    const detected = detectAnyToolCall(callText);
    expect(detected).not.toBeNull();
    expect(detected?.source).toBe('sandbox');
    if (!detected || detected.source !== 'sandbox') {
      throw new Error('Expected a sandbox tool call');
    }
    expect(detected.call.tool).toBe('sandbox_search_replace');

    const result = await executeAnyToolCall(detected, 'KvFxKaido/Push', 'sb-123');

    expect(result.text).toContain('Edited /workspace/src/app.ts');
    // 2 calls: initial search_replace read + post-write verification
    expect(vi.mocked(sandboxClient.readFromSandbox)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(sandboxClient.writeToSandbox)).toHaveBeenCalledWith(
      'sb-123',
      path,
      'const token = "$1$&$$";\n',
      'v1',
    );
  });

  it('passes the chat-locked provider/model into sandbox_prepare_commit audits', async () => {
    vi.mocked(sandboxClient.execInSandbox).mockResolvedValue({
      exitCode: 0,
      stdout: '',
      stderr: '',
      truncated: false,
    });
    vi.mocked(sandboxClient.getSandboxDiff).mockResolvedValue({
      diff: 'diff --git a/src/app.ts b/src/app.ts\n+console.log("hi");\n',
      truncated: false,
    });
    vi.mocked(runAuditor).mockResolvedValue({
      verdict: 'safe',
      card: {
        verdict: 'safe',
        summary: 'No issues found.',
        risks: [],
        filesReviewed: 1,
      },
    });

    const callText = [
      '```json',
      JSON.stringify({
        tool: 'sandbox_prepare_commit',
        args: { message: 'test commit' },
      }),
      '```',
    ].join('\n');

    const detected = detectAnyToolCall(callText);
    expect(detected).not.toBeNull();
    expect(detected?.source).toBe('sandbox');
    if (!detected || detected.source !== 'sandbox') {
      throw new Error('Expected a sandbox tool call');
    }

    await executeAnyToolCall(
      detected,
      'KvFxKaido/Push',
      'sb-123',
      false,
      'main',
      'openrouter',
      'anthropic/claude-sonnet-4.6:nitro',
    );

    expect(runAuditor).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Function),
      expect.objectContaining({
        source: 'sandbox-prepare-commit',
      }),
      expect.any(Object),
      expect.objectContaining({
        providerOverride: 'openrouter',
        modelOverride: 'anthropic/claude-sonnet-4.6:nitro',
      }),
      expect.any(Array),
    );
  });

  it('applies pre-hook arg rewrites before executing ask_user', async () => {
    const hooks = createToolHookRegistry();
    hooks.pre.push({
      matcher: 'ask_user',
      hook: () => ({
        decision: 'allow',
        modifiedArgs: { question: 'Rewritten question' },
      }),
    });

    const result = await executeAnyToolCall(
      {
        source: 'ask-user',
        call: {
          tool: 'ask_user',
          args: {
            question: 'Original question',
            options: [{ id: 'a', label: 'A' }],
            multiSelect: false,
          },
        },
      },
      'KvFxKaido/Push',
      null,
      false,
      'main',
      undefined,
      undefined,
      hooks,
    );

    expect(result.card?.type).toBe('ask-user');
    if (result.card?.type !== 'ask-user') {
      throw new Error('Expected ask-user card');
    }
    expect(result.card.data.question).toBe('Rewritten question');
  });

  it('short-circuits execution when a pre-hook denies a tool', async () => {
    const hooks = createToolHookRegistry();
    hooks.pre.push({
      matcher: 'ask_user',
      hook: () => ({
        decision: 'deny',
        reason: 'Blocked by test hook.',
      }),
    });

    const result = await executeAnyToolCall(
      {
        source: 'ask-user',
        call: {
          tool: 'ask_user',
          args: {
            question: 'Original question',
            options: [{ id: 'a', label: 'A' }],
            multiSelect: false,
          },
        },
      },
      'KvFxKaido/Push',
      null,
      false,
      'main',
      undefined,
      undefined,
      hooks,
    );

    expect(result.text).toContain('[Tool Blocked]');
    expect(result.card).toBeUndefined();
  });

  it('applies post-hook result overrides after tool execution', async () => {
    const hooks = createToolHookRegistry();
    hooks.post.push({
      matcher: 'ask_user',
      hook: () => ({
        resultOverride: '[Tool Result] Hook override applied.',
      }),
    });

    const result = await executeAnyToolCall(
      {
        source: 'ask-user',
        call: {
          tool: 'ask_user',
          args: {
            question: 'Original question',
            options: [{ id: 'a', label: 'A' }],
            multiSelect: false,
          },
        },
      },
      'KvFxKaido/Push',
      null,
      false,
      'main',
      undefined,
      undefined,
      hooks,
    );

    expect(result.text).toBe('[Tool Result] Hook override applied.');
    expect(result.card?.type).toBe('ask-user');
  });
});
