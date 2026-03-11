import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock networked/tool side-effect modules before importing dispatch.
vi.mock('./sandbox-client', () => ({
  execInSandbox: vi.fn(),
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
      // If the delegated edit does a second read instead of using prefetch, this
      // would fail the flow. The expected behavior is exactly one read.
      .mockResolvedValueOnce({
        content: '',
        truncated: false,
        error: 'permission denied',
      } as unknown as sandboxClient.FileReadResult);

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
    expect(vi.mocked(sandboxClient.readFromSandbox)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sandboxClient.writeToSandbox)).toHaveBeenCalledWith(
      'sb-123',
      path,
      'const token = "$1$&$$";\n',
      'v1',
    );
  });

  it('passes the chat-locked provider/model into sandbox_prepare_commit audits', async () => {
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
      expect.objectContaining({
        providerOverride: 'openrouter',
        modelOverride: 'anthropic/claude-sonnet-4.6:nitro',
      }),
    );
  });
});
