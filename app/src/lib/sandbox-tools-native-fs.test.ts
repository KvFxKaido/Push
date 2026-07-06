import { describe, expect, it, vi, beforeEach } from 'vitest';

// Control the native FS seam directly: resolveNativeFs returns our fake backend
// (or null) so the dispatcher's `if (nativeFs)` forks are exercised without a
// real device/plugin. Everything else in sandbox-tools loads for real.
const fakeBackend = vi.hoisted(() => ({
  readFile: vi.fn(async () => ({ content: 'file body', truncated: false, totalLines: 1 })),
  writeFile: vi.fn(async () => ({ ok: true, bytesWritten: 9 })),
  listDir: vi.fn(async () => ({
    entries: [{ name: 'a.ts', type: 'file' as const, size: 3 }],
    truncated: false,
  })),
}));
const nativeFs = vi.hoisted(() => ({
  resolveNativeFs: vi.fn((): typeof fakeBackend | null => fakeBackend),
}));

vi.mock('./native-fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./native-fs')>()),
  resolveNativeFs: nativeFs.resolveNativeFs,
}));

import { executeSandboxToolCall } from './sandbox-tools';

const scope = { repoFullName: 'owner/repo', branch: 'main' };

beforeEach(() => {
  fakeBackend.readFile.mockClear();
  fakeBackend.writeFile.mockClear();
  fakeBackend.listDir.mockClear();
  nativeFs.resolveNativeFs.mockReturnValue(fakeBackend);
});

describe('sandbox-tools native FS routing', () => {
  it('routes sandbox_read_file to the on-device clone', async () => {
    const result = await executeSandboxToolCall(
      { tool: 'sandbox_read_file', args: { path: '/workspace/a.ts' } },
      '',
      { nativeFsScope: scope },
    );
    expect(fakeBackend.readFile).toHaveBeenCalledWith('/workspace/a.ts', {
      startLine: undefined,
      endLine: undefined,
    });
    expect(result.text).toContain('[Tool Result — sandbox_read_file]');
    expect(result.text).toContain('file body');
  });

  it('routes sandbox_write_file to the on-device clone', async () => {
    const result = await executeSandboxToolCall(
      { tool: 'sandbox_write_file', args: { path: '/workspace/a.ts', content: 'x' } },
      '',
      { nativeFsScope: scope },
    );
    expect(fakeBackend.writeFile).toHaveBeenCalledWith('/workspace/a.ts', 'x');
    expect(result.text).toContain('[Tool Result — sandbox_write_file]');
    expect(result.text).toContain('Bytes written: 9');
  });

  it('routes sandbox_list_dir to the on-device clone', async () => {
    const result = await executeSandboxToolCall(
      { tool: 'sandbox_list_dir', args: { path: '/workspace' } },
      '',
      { nativeFsScope: scope },
    );
    expect(fakeBackend.listDir).toHaveBeenCalledWith('/workspace');
    expect(result.text).toContain('[Tool Result — sandbox_list_dir]');
    expect(result.text).toContain('a.ts');
  });

  it('refuses sandbox_exec on-device with a typed, non-retryable error', async () => {
    const result = await executeSandboxToolCall(
      { tool: 'sandbox_exec', args: { command: 'echo hi' } },
      '',
      { nativeFsScope: scope },
    );
    expect(result.structuredError?.type).toBe('NATIVE_TOOL_UNSUPPORTED');
    expect(result.structuredError?.retryable).toBe(false);
    expect(fakeBackend.readFile).not.toHaveBeenCalled();
  });

  it('refuses a sensitive path before touching the clone', async () => {
    const result = await executeSandboxToolCall(
      { tool: 'sandbox_read_file', args: { path: '/workspace/.env' } },
      '',
      { nativeFsScope: scope },
    );
    expect(fakeBackend.readFile).not.toHaveBeenCalled();
    expect(result.text.toLowerCase()).toContain('.env');
  });

  it('falls through to the cloud path when no native clone resolves', async () => {
    nativeFs.resolveNativeFs.mockReturnValue(null);
    // sandboxId '' + no binding + no native → the no-sandbox guard fires,
    // proving the dispatcher did NOT take the native fork.
    const result = await executeSandboxToolCall(
      { tool: 'sandbox_read_file', args: { path: '/workspace/a.ts' } },
      '',
      { nativeFsScope: scope },
    );
    expect(fakeBackend.readFile).not.toHaveBeenCalled();
    expect(result.text).toContain('No active sandbox');
  });
});
