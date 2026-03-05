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
import { fileLedger } from './file-awareness-ledger';

describe('tool-dispatch smoke -- sandbox_search_replace', () => {
  beforeEach(() => {
    vi.mocked(sandboxClient.readFromSandbox).mockReset();
    vi.mocked(sandboxClient.writeToSandbox).mockReset();
    vi.mocked(sandboxClient.execInSandbox).mockReset();
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
});

