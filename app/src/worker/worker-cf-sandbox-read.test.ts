import { getSandbox } from '@cloudflare/sandbox';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleCloudflareSandbox } from './worker-cf-sandbox';
import type { Env } from './worker-middleware';

vi.mock('@cloudflare/sandbox', () => ({
  getSandbox: vi.fn(),
}));

const MAX_READ_BYTES = 5_000_000;
const DEFAULT_HASH = 'a'.repeat(64);

type ExecResult = { stdout?: string; stderr?: string; exitCode?: number };

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    RATE_LIMITER: {
      limit: vi.fn(async () => ({ success: true })),
    } as unknown as Env['RATE_LIMITER'],
    ASSETS: {} as Env['ASSETS'],
    Sandbox: {} as Env['Sandbox'],
    ...overrides,
  };
}

function makeReadRequest(body: Record<string, unknown>): Request {
  return new Request('https://push.example.test/api/sandbox-cf/read', {
    method: 'POST',
    headers: {
      Origin: 'https://push.example.test',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ sandboxId: 'sb-1', path: '/workspace/src/app.ts', ...body }),
  });
}

function createFakeSandbox() {
  return {
    exec: vi.fn(async (command: string): Promise<ExecResult> => {
      void command;
      return {
        stdout: '',
        stderr: '',
        exitCode: 0,
      };
    }),
  };
}

async function callRead(
  sandbox: ReturnType<typeof createFakeSandbox>,
  body: Record<string, unknown>,
): Promise<{ response: Response; payload: Record<string, unknown> }> {
  vi.mocked(getSandbox).mockReturnValue(sandbox as never);
  const request = makeReadRequest(body);
  const response = await handleCloudflareSandbox(request, makeEnv(), new URL(request.url), 'read');
  return { response, payload: (await response.json()) as Record<string, unknown> };
}

function commandList(sandbox: ReturnType<typeof createFakeSandbox>): string[] {
  return sandbox.exec.mock.calls.map(([command]) => command);
}

beforeEach(() => {
  vi.mocked(getSandbox).mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('handleCloudflareSandbox read route', () => {
  it('uses sed -n with the requested line range', async () => {
    const sandbox = createFakeSandbox();
    sandbox.exec.mockImplementation(async (command: string): Promise<ExecResult> => {
      if (command.startsWith('sed -n')) return { stdout: 'line 2\nline 3\nline 4\n', exitCode: 0 };
      if (command.includes('sha256sum')) return { stdout: `${DEFAULT_HASH}\n`, exitCode: 0 };
      if (command.startsWith('wc -l')) return { stdout: '10\n', exitCode: 0 };
      throw new Error(`Unexpected command: ${command}`);
    });

    const { payload } = await callRead(sandbox, { start_line: 2, end_line: 4 });

    expect(commandList(sandbox)).toContain(
      `sed -n '2,4p' -- "/workspace/src/app.ts" | head -c ${MAX_READ_BYTES}`,
    );
    expect(payload.content).toBe('line 2\nline 3\nline 4\n');
  });

  it('uses head -c with the read byte cap for unbounded reads', async () => {
    const sandbox = createFakeSandbox();
    sandbox.exec.mockImplementation(async (command: string): Promise<ExecResult> => {
      if (command.startsWith('head -c')) return { stdout: 'first bytes', exitCode: 0 };
      if (command.includes('sha256sum')) return { stdout: `${DEFAULT_HASH}\n`, exitCode: 0 };
      throw new Error(`Unexpected command: ${command}`);
    });

    const { payload } = await callRead(sandbox, {});
    const commands = commandList(sandbox);

    expect(commands).toContain(`head -c ${MAX_READ_BYTES} -- "/workspace/src/app.ts"`);
    expect(commands.some((command) => command.startsWith('wc -l'))).toBe(false);
    expect(commands.some((command) => command.startsWith('sed -n'))).toBe(false);
    expect(payload).toMatchObject({ content: 'first bytes', truncated: false });
  });

  it('returns the version from sha256sum output', async () => {
    const sandbox = createFakeSandbox();
    const version = '0123456789abcdef'.repeat(4);
    sandbox.exec.mockImplementation(async (command: string): Promise<ExecResult> => {
      if (command.startsWith('head -c')) return { stdout: 'content', exitCode: 0 };
      if (command.includes('sha256sum')) return { stdout: `${version}\n`, exitCode: 0 };
      throw new Error(`Unexpected command: ${command}`);
    });

    const { payload } = await callRead(sandbox, {});

    const hashCommand = commandList(sandbox).find((command) => command.includes('sha256sum'));
    expect(hashCommand).toContain('sha256sum -- "/workspace/src/app.ts"');
    expect(hashCommand).toContain("| awk '{print $1}'");
    expect(payload.version).toBe(version);
  });

  it('returns a body-level NOT_FOUND error when sha256sum fails', async () => {
    const sandbox = createFakeSandbox();
    sandbox.exec.mockImplementation(async (command: string): Promise<ExecResult> => {
      if (command.startsWith('head -c')) return { stdout: '', exitCode: 1, stderr: 'missing' };
      if (command.includes('sha256sum')) {
        return {
          stdout: '',
          stderr: 'sha256sum: /workspace/src/app.ts: No such file or directory\n',
          exitCode: 1,
        };
      }
      throw new Error(`Unexpected command: ${command}`);
    });

    const { response, payload } = await callRead(sandbox, {});

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({
      code: 'NOT_FOUND',
      content: '',
      truncated: false,
      version: null,
      workspace_revision: 0,
    });
    expect(String(payload.error)).toContain('No such file or directory');
  });

  it('truncates sed output that exceeds the read byte cap', async () => {
    const sandbox = createFakeSandbox();
    sandbox.exec.mockImplementation(async (command: string): Promise<ExecResult> => {
      if (command.startsWith('sed -n'))
        return { stdout: 'x'.repeat(MAX_READ_BYTES + 1), exitCode: 0 };
      if (command.includes('sha256sum')) return { stdout: `${DEFAULT_HASH}\n`, exitCode: 0 };
      if (command.startsWith('wc -l')) return { stdout: '1\n', exitCode: 0 };
      throw new Error(`Unexpected command: ${command}`);
    });

    const { payload } = await callRead(sandbox, { start_line: 1 });

    expect((payload.content as string).length).toBe(MAX_READ_BYTES);
    expect(payload.truncated).toBe(true);
    expect(payload.remaining_bytes).toBe(1);
  });

  it('echoes normalized start_line and end_line for range reads', async () => {
    const sandbox = createFakeSandbox();
    sandbox.exec.mockImplementation(async (command: string): Promise<ExecResult> => {
      if (command.startsWith('sed -n')) return { stdout: 'line 3\nline 4\n', exitCode: 0 };
      if (command.includes('sha256sum')) return { stdout: `${DEFAULT_HASH}\n`, exitCode: 0 };
      if (command.startsWith('wc -l')) return { stdout: '8\n', exitCode: 0 };
      throw new Error(`Unexpected command: ${command}`);
    });

    const { payload } = await callRead(sandbox, { start_line: 3, end_line: 4 });

    expect(payload).toMatchObject({
      start_line: 3,
      end_line: 4,
      truncated: true,
      truncated_at_line: 5,
    });
  });
});
