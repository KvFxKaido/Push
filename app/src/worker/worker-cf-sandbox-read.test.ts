import { getSandbox } from '@cloudflare/sandbox';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleCloudflareSandbox } from './worker-cf-sandbox';
import type { Env } from './worker-middleware';

vi.mock('@cloudflare/sandbox', () => ({
  getSandbox: vi.fn(),
}));

const MAX_READ_BYTES = 5_000_000;
const PROBE_BYTES = MAX_READ_BYTES + 1;
const DEFAULT_HASH = 'a'.repeat(64);
const DEFAULT_OWNER_TOKEN = 'test-owner-token';

type ExecResult = { stdout?: string; stderr?: string; exitCode?: number };

// SANDBOX_TOKENS mock — auth gate landed in PR #355 and now gates every
// non-create route. Return a record matching DEFAULT_OWNER_TOKEN for any
// sandboxId so read tests don't have to care about auth.
function makeTokensKV() {
  return {
    get: vi.fn(async (_key: string, type?: unknown) => {
      const record = { token: DEFAULT_OWNER_TOKEN, createdAt: Date.now() };
      if (type === 'json') return record;
      return JSON.stringify(record);
    }),
    put: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
  };
}

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    RATE_LIMITER: {
      limit: vi.fn(async () => ({ success: true })),
    } as unknown as Env['RATE_LIMITER'],
    ASSETS: {} as Env['ASSETS'],
    Sandbox: {} as Env['Sandbox'],
    SANDBOX_TOKENS: makeTokensKV() as unknown as Env['SANDBOX_TOKENS'],
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
    body: JSON.stringify({
      sandbox_id: 'sb-1',
      owner_token: DEFAULT_OWNER_TOKEN,
      path: '/workspace/src/app.ts',
      ...body,
    }),
  });
}

function createFakeSandbox() {
  return {
    exec: vi.fn(async (command: string): Promise<ExecResult> => {
      void command;
      return { stdout: '', stderr: '', exitCode: 0 };
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

// Default stub — answers every command shape the handler fires with a
// benign success. Individual tests override specific commands.
function defaultExec(): (cmd: string) => Promise<ExecResult> {
  return async (command: string): Promise<ExecResult> => {
    if (command.startsWith('stat -c %s')) return { stdout: '42\n', exitCode: 0 };
    if (command.startsWith('sed -n')) return { stdout: 'line 2\nline 3\n', exitCode: 0 };
    if (command.startsWith('head -c')) return { stdout: 'first bytes', exitCode: 0 };
    if (command.includes('sha256sum')) return { stdout: `${DEFAULT_HASH}\n`, exitCode: 0 };
    if (command.startsWith('awk')) return { stdout: '10\n', exitCode: 0 };
    throw new Error(`Unexpected command: ${command}`);
  };
}

beforeEach(() => {
  vi.mocked(getSandbox).mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('handleCloudflareSandbox read route', () => {
  it('uses sed -n with the requested line range and probes MAX+1 bytes', async () => {
    const sandbox = createFakeSandbox();
    sandbox.exec.mockImplementation(defaultExec());

    const { payload } = await callRead(sandbox, { start_line: 2, end_line: 4 });

    expect(commandList(sandbox)).toContain(
      `sed -n '2,4p' -- '/workspace/src/app.ts' | head -c ${PROBE_BYTES}`,
    );
    expect(payload.start_line).toBe(2);
    expect(payload.end_line).toBe(4);
  });

  it('uses head -c MAX+1 for unbounded reads and skips awk line count', async () => {
    const sandbox = createFakeSandbox();
    sandbox.exec.mockImplementation(defaultExec());

    const { payload } = await callRead(sandbox, {});
    const commands = commandList(sandbox);

    expect(commands).toContain(`head -c ${PROBE_BYTES} -- '/workspace/src/app.ts'`);
    expect(commands.some((c) => c.startsWith('awk'))).toBe(false);
    expect(commands.some((c) => c.startsWith('sed -n'))).toBe(false);
    expect(payload).toMatchObject({ content: 'first bytes', truncated: false });
  });

  it('returns the version from sha256sum output via simple pipeline', async () => {
    const sandbox = createFakeSandbox();
    const version = '0123456789abcdef'.repeat(4);
    sandbox.exec.mockImplementation(async (command: string): Promise<ExecResult> => {
      if (command.startsWith('stat')) return { stdout: '100\n', exitCode: 0 };
      if (command.startsWith('head -c')) return { stdout: 'content', exitCode: 0 };
      if (command.includes('sha256sum')) return { stdout: `${version}\n`, exitCode: 0 };
      throw new Error(`Unexpected command: ${command}`);
    });

    const { payload } = await callRead(sandbox, {});
    const hashCommand = commandList(sandbox).find((c) => c.includes('sha256sum'));

    expect(hashCommand).toBe(`sha256sum -- '/workspace/src/app.ts' | awk '{print $1}'`);
    expect(payload.version).toBe(version);
  });

  it('uses stat -c %s as the authoritative existence probe (NOT_FOUND on fail)', async () => {
    const sandbox = createFakeSandbox();
    sandbox.exec.mockImplementation(async (command: string): Promise<ExecResult> => {
      if (command.startsWith('stat')) {
        return {
          stdout: '',
          stderr: "stat: cannot statx '/workspace/src/app.ts': No such file or directory\n",
          exitCode: 1,
        };
      }
      // Other commands succeed vacuously — handler should short-circuit on stat.
      return { stdout: '', exitCode: 0 };
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
    expect(String(payload.error)).toContain('No such file');
  });

  it('detects truncation when content exceeds the cap (byte path uses >, not >=)', async () => {
    const sandbox = createFakeSandbox();
    sandbox.exec.mockImplementation(async (command: string): Promise<ExecResult> => {
      if (command.startsWith('stat')) return { stdout: `${MAX_READ_BYTES + 200}\n`, exitCode: 0 };
      if (command.startsWith('head -c')) return { stdout: 'x'.repeat(PROBE_BYTES), exitCode: 0 };
      if (command.includes('sha256sum')) return { stdout: `${DEFAULT_HASH}\n`, exitCode: 0 };
      throw new Error(`Unexpected command: ${command}`);
    });

    const { payload } = await callRead(sandbox, {});

    expect((payload.content as string).length).toBe(MAX_READ_BYTES);
    expect(payload.truncated).toBe(true);
    // remaining_bytes comes from stat now, not from the post-decode buffer.
    expect(payload.remaining_bytes).toBe(200);
  });

  it('does NOT mark a file as truncated when its size equals the cap exactly', async () => {
    const sandbox = createFakeSandbox();
    sandbox.exec.mockImplementation(async (command: string): Promise<ExecResult> => {
      if (command.startsWith('stat')) return { stdout: `${MAX_READ_BYTES}\n`, exitCode: 0 };
      // Content stream returns exactly MAX bytes — head -c MAX+1 capped at EOF.
      if (command.startsWith('head -c')) return { stdout: 'x'.repeat(MAX_READ_BYTES), exitCode: 0 };
      if (command.includes('sha256sum')) return { stdout: `${DEFAULT_HASH}\n`, exitCode: 0 };
      throw new Error(`Unexpected command: ${command}`);
    });

    const { payload } = await callRead(sandbox, {});

    expect((payload.content as string).length).toBe(MAX_READ_BYTES);
    expect(payload.truncated).toBe(false);
    expect(payload.remaining_bytes).toBeUndefined();
  });

  it('echoes requested range verbatim without clamping against line count', async () => {
    // start_line past EOF used to be clamped, which desynced metadata from the
    // empty content sed returned. After the fix, echo the request verbatim.
    const sandbox = createFakeSandbox();
    sandbox.exec.mockImplementation(async (command: string): Promise<ExecResult> => {
      if (command.startsWith('stat')) return { stdout: '5\n', exitCode: 0 };
      if (command.startsWith('sed -n')) return { stdout: '', exitCode: 0 };
      if (command.includes('sha256sum')) return { stdout: `${DEFAULT_HASH}\n`, exitCode: 0 };
      if (command.startsWith('awk')) return { stdout: '3\n', exitCode: 0 };
      throw new Error(`Unexpected command: ${command}`);
    });

    const { payload } = await callRead(sandbox, { start_line: 100, end_line: 200 });

    expect(payload.start_line).toBe(100);
    expect(payload.end_line).toBe(200);
    expect(payload.content).toBe('');
  });

  it('counts lines via awk END{print NR} for trailing-newline-less files', async () => {
    const sandbox = createFakeSandbox();
    sandbox.exec.mockImplementation(async (command: string): Promise<ExecResult> => {
      if (command.startsWith('stat')) return { stdout: '20\n', exitCode: 0 };
      if (command.startsWith('sed -n')) return { stdout: 'line 1\nline 2', exitCode: 0 };
      if (command.includes('sha256sum')) return { stdout: `${DEFAULT_HASH}\n`, exitCode: 0 };
      if (command.startsWith('awk')) return { stdout: '2\n', exitCode: 0 };
      throw new Error(`Unexpected command: ${command}`);
    });

    const { payload } = await callRead(sandbox, { start_line: 1, end_line: 5 });
    const lineCountCommand = commandList(sandbox).find((c) => c.startsWith('awk'));

    expect(lineCountCommand).toBe(`awk 'END{print NR}' -- '/workspace/src/app.ts'`);
    expect(payload.content).toBe('line 1\nline 2');
  });

  it('single-quotes path and does not execute shell expansions ($(), backticks)', async () => {
    // This is the critical RCE test. If JSON.stringify were still used, the
    // path `$(whoami)` would be wrapped as `"$(whoami)"` which expands under
    // the shell. Single-quoted, it stays literal.
    const sandbox = createFakeSandbox();
    sandbox.exec.mockImplementation(defaultExec());
    vi.mocked(getSandbox).mockReturnValue(sandbox as never);

    const maliciousPath = '/tmp/$(whoami)`id`.txt';
    const request = new Request('https://push.example.test/api/sandbox-cf/read', {
      method: 'POST',
      headers: {
        Origin: 'https://push.example.test',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        sandbox_id: 'sb-1',
        owner_token: DEFAULT_OWNER_TOKEN,
        path: maliciousPath,
      }),
    });
    await handleCloudflareSandbox(request, makeEnv(), new URL(request.url), 'read');

    // Every command gets the path wrapped in SINGLE quotes — no $ or `
    // interpretation possible inside those.
    const expectedQuoted = `'/tmp/$(whoami)\`id\`.txt'`;
    for (const cmd of commandList(sandbox)) {
      expect(cmd).toContain(expectedQuoted);
      // Negative assertion — the path must NOT appear double-quoted.
      expect(cmd).not.toContain(`"${maliciousPath}"`);
    }
  });

  it('single-quotes paths containing literal single quotes via the escape trick', async () => {
    const sandbox = createFakeSandbox();
    sandbox.exec.mockImplementation(defaultExec());
    vi.mocked(getSandbox).mockReturnValue(sandbox as never);

    const trickyPath = `/tmp/it's-a-file.txt`;
    const request = new Request('https://push.example.test/api/sandbox-cf/read', {
      method: 'POST',
      headers: {
        Origin: 'https://push.example.test',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        sandbox_id: 'sb-1',
        owner_token: DEFAULT_OWNER_TOKEN,
        path: trickyPath,
      }),
    });
    await handleCloudflareSandbox(request, makeEnv(), new URL(request.url), 'read');

    // Expected quoting: 'it'\''s-a-file.txt' — close, escape-quote, reopen.
    const expectedQuoted = `'/tmp/it'\\''s-a-file.txt'`;
    for (const cmd of commandList(sandbox)) {
      expect(cmd).toContain(expectedQuoted);
    }
  });
});
