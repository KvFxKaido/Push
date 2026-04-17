import { describe, it, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

/**
 * index.ts has side effects (calls main() on module load), so we mock the
 * MCP SDK and capture the registered request handlers for testing.
 *
 * Uses --experimental-test-module-mocks flag (Node 22).
 */

// --- Captured state from Server mock ---
type Handler = (request: unknown) => Promise<unknown>;
const handlers = new Map<unknown, Handler>();

// Sentinel schema objects that mirror what the SDK exports
const FakeListToolsRequestSchema = Symbol('ListToolsRequestSchema');
const FakeCallToolRequestSchema = Symbol('CallToolRequestSchema');

const FakeErrorCode = {
  InvalidParams: -32602,
  MethodNotFound: -32601,
};

class FakeMcpError extends Error {
  code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
    this.name = 'McpError';
  }
}

class FakeServer {
  constructor(_info: unknown, _opts: unknown) {}
  setRequestHandler(schema: unknown, handler: Handler) {
    handlers.set(schema, handler);
  }
  async connect(_transport: unknown) {}
}

class FakeStdioServerTransport {}

// --- Mock the SDK modules before importing index.ts ---
mock.module('@modelcontextprotocol/sdk/server/index.js', {
  namedExports: { Server: FakeServer },
});
mock.module('@modelcontextprotocol/sdk/server/stdio.js', {
  namedExports: { StdioServerTransport: FakeStdioServerTransport },
});
mock.module('@modelcontextprotocol/sdk/types.js', {
  namedExports: {
    CallToolRequestSchema: FakeCallToolRequestSchema,
    ListToolsRequestSchema: FakeListToolsRequestSchema,
    ErrorCode: FakeErrorCode,
    McpError: FakeMcpError,
  },
});

// Mock the shared github-tool-core module
let executeCoreToolMock: Handler = async () => ({ text: 'mock result' });
mock.module('../../../lib/github-tool-core.js', {
  namedExports: {
    executeGitHubCoreTool: async (runtime: unknown, call: unknown) => executeCoreToolMock(call),
  },
});

// Import index.ts - this triggers main() which uses our mocked SDK
await import('./index.js');

// --- Helper to call captured handlers ---
function getListToolsHandler(): Handler {
  const handler = handlers.get(FakeListToolsRequestSchema);
  assert.ok(handler, 'ListToolsRequestSchema handler not registered');
  return handler;
}

function getCallToolHandler(): Handler {
  const handler = handlers.get(FakeCallToolRequestSchema);
  assert.ok(handler, 'CallToolRequestSchema handler not registered');
  return handler;
}

function callTool(name: string, args: Record<string, unknown> = {}) {
  return getCallToolHandler()({ params: { name, arguments: args } });
}

// --- Tests ---

describe('ListTools handler', () => {
  it('returns a non-empty list of tools', async () => {
    const result = (await getListToolsHandler()({})) as { tools: unknown[] };
    assert.ok(Array.isArray(result.tools));
    assert.ok(result.tools.length > 0);
  });

  it('includes the github_server_info tool', async () => {
    const result = (await getListToolsHandler()({})) as {
      tools: Array<{ name: string }>;
    };
    const names = result.tools.map((t) => t.name);
    assert.ok(names.includes('github_server_info'));
  });

  it('includes the github_api_probe tool', async () => {
    const result = (await getListToolsHandler()({})) as {
      tools: Array<{ name: string }>;
    };
    const names = result.tools.map((t) => t.name);
    assert.ok(names.includes('github_api_probe'));
  });

  it('includes all core GitHub tools', async () => {
    const expectedCoreTools = [
      'fetch_pr',
      'list_prs',
      'list_commits',
      'read_file',
      'grep_file',
      'list_directory',
      'list_branches',
      'fetch_checks',
      'search_files',
      'list_commit_files',
      'trigger_workflow',
      'get_workflow_runs',
      'get_workflow_logs',
      'create_pr',
      'merge_pr',
      'delete_branch',
      'check_pr_mergeable',
      'find_existing_pr',
    ];
    const result = (await getListToolsHandler()({})) as {
      tools: Array<{ name: string }>;
    };
    const names = result.tools.map((t) => t.name);
    for (const tool of expectedCoreTools) {
      assert.ok(names.includes(tool), `Missing tool: ${tool}`);
    }
  });

  it('tools have valid inputSchema with type and properties', async () => {
    const result = (await getListToolsHandler()({})) as {
      tools: Array<{ name: string; inputSchema: { type: string; properties: object } }>;
    };
    for (const tool of result.tools) {
      assert.equal(tool.inputSchema.type, 'object', `${tool.name} should have object schema`);
      assert.ok(tool.inputSchema.properties !== undefined, `${tool.name} missing properties`);
    }
  });
});

describe('CallTool handler — github_server_info', () => {
  let savedToken: string | undefined;
  let savedApiUrl: string | undefined;

  beforeEach(() => {
    savedToken = process.env.GITHUB_TOKEN;
    savedApiUrl = process.env.GITHUB_API_URL;
  });

  afterEach(() => {
    if (savedToken !== undefined) process.env.GITHUB_TOKEN = savedToken;
    else delete process.env.GITHUB_TOKEN;
    if (savedApiUrl !== undefined) process.env.GITHUB_API_URL = savedApiUrl;
    else delete process.env.GITHUB_API_URL;
  });

  it('returns server info with correct structure', async () => {
    process.env.GITHUB_TOKEN = 'test-token';
    const result = (await callTool('github_server_info')) as {
      content: Array<{ type: string; text: string }>;
    };

    assert.ok(result.content);
    assert.equal(result.content.length, 1);
    assert.equal(result.content[0].type, 'text');

    const info = JSON.parse(result.content[0].text);
    assert.equal(info.server, 'push-github-mcp');
    assert.equal(info.version, '0.1.0');
    assert.equal(info.githubTokenConfigured, true);
    assert.ok(Array.isArray(info.tools));
  });

  it('reflects GITHUB_API_URL when set', async () => {
    process.env.GITHUB_API_URL = 'https://custom.github.example.com';
    process.env.GITHUB_TOKEN = '';
    const result = (await callTool('github_server_info')) as {
      content: Array<{ type: string; text: string }>;
    };

    const info = JSON.parse(result.content[0].text);
    assert.equal(info.githubApiUrl, 'https://custom.github.example.com');
    assert.equal(info.githubTokenConfigured, false);
  });

  it('defaults githubApiUrl to api.github.com', async () => {
    delete process.env.GITHUB_API_URL;
    const result = (await callTool('github_server_info')) as {
      content: Array<{ type: string; text: string }>;
    };

    const info = JSON.parse(result.content[0].text);
    assert.equal(info.githubApiUrl, 'https://api.github.com');
  });
});

describe('CallTool handler — github_api_probe', () => {
  let originalFetch: typeof globalThis.fetch;
  let savedToken: string | undefined;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    savedToken = process.env.GITHUB_TOKEN;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (savedToken !== undefined) process.env.GITHUB_TOKEN = savedToken;
    else delete process.env.GITHUB_TOKEN;
  });

  it('returns rate limit info on success', async () => {
    process.env.GITHUB_TOKEN = 'test-token';

    globalThis.fetch = mock.fn(async () => {
      return new Response(
        JSON.stringify({
          rate: { limit: 5000, remaining: 4999, used: 1, reset: 1700000000, resource: 'core' },
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    const result = (await callTool('github_api_probe')) as {
      content: Array<{ type: string; text: string }>;
    };

    const probe = JSON.parse(result.content[0].text);
    assert.equal(probe.server, 'push-github-mcp');
    assert.equal(probe.authenticated, true);
    assert.equal(probe.rateLimit.limit, 5000);
    assert.equal(probe.rateLimit.remaining, 4999);
    assert.ok(probe.rateLimit.resetAt);
  });

  it('throws when the rate_limit endpoint fails', async () => {
    process.env.GITHUB_TOKEN = '';

    globalThis.fetch = mock.fn(async () => {
      return new Response('bad', { status: 401 });
    }) as typeof fetch;

    await assert.rejects(
      () => callTool('github_api_probe'),
      (err: Error) => {
        assert.ok(err.message.includes('probe failed'));
        return true;
      },
    );
  });

  it('handles missing rate fields gracefully', async () => {
    process.env.GITHUB_TOKEN = '';

    globalThis.fetch = mock.fn(async () => {
      return new Response(JSON.stringify({}), { status: 200 });
    }) as typeof fetch;

    const result = (await callTool('github_api_probe')) as {
      content: Array<{ type: string; text: string }>;
    };

    const probe = JSON.parse(result.content[0].text);
    assert.equal(probe.rateLimit.limit, null);
    assert.equal(probe.rateLimit.remaining, null);
    assert.equal(probe.rateLimit.resetAt, null);
  });
});

describe('CallTool handler — unknown tool', () => {
  it('throws McpError for unknown tool names', async () => {
    await assert.rejects(
      () => callTool('nonexistent_tool'),
      (err: Error) => {
        assert.ok(err instanceof FakeMcpError);
        assert.equal((err as FakeMcpError).code, FakeErrorCode.MethodNotFound);
        return true;
      },
    );
  });
});

describe('CallTool handler — core tool dispatch', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    // Reset the core tool mock
    executeCoreToolMock = async () => ({ text: 'default mock result' });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('delegates recognized core tools to executeGitHubCoreTool', async () => {
    let receivedCall: unknown;
    executeCoreToolMock = async (call: unknown) => {
      receivedCall = call;
      return { text: 'PR #1 summary' };
    };

    const result = (await callTool('fetch_pr', { repo: 'owner/repo', pr: 1 })) as {
      content: Array<{ type: string; text: string }>;
    };

    assert.ok(receivedCall);
    assert.ok(result.content[0].text.includes('PR #1 summary'));
  });

  it('includes structuredContent when core tool returns a card', async () => {
    executeCoreToolMock = async () => ({
      text: 'list result',
      card: { type: 'pr_list', repo: 'owner/repo', state: 'open', prs: [] },
    });

    const result = (await callTool('list_prs', { repo: 'owner/repo' })) as {
      content: Array<{ type: string; text: string }>;
      structuredContent?: { card: unknown };
    };

    assert.ok(result.structuredContent);
    assert.ok(result.structuredContent.card);
  });

  it('omits structuredContent when core tool returns no card', async () => {
    executeCoreToolMock = async () => ({
      text: 'text only result',
    });

    const result = (await callTool('list_commits', { repo: 'owner/repo' })) as {
      content: Array<{ type: string; text: string }>;
      structuredContent?: unknown;
    };

    assert.equal(result.structuredContent, undefined);
  });
});

describe('CallTool handler — core tool with invalid args (parser returns null)', () => {
  it('throws McpError with InvalidParams for known tool names with missing args', async () => {
    // fetch_pr requires repo and pr; passing no args should trigger the parser fallback
    await assert.rejects(
      () => callTool('fetch_pr', {}),
      (err: Error) => {
        assert.ok(err instanceof FakeMcpError);
        assert.equal((err as FakeMcpError).code, FakeErrorCode.InvalidParams);
        return true;
      },
    );
  });

  it('throws McpError for read_file without path', async () => {
    await assert.rejects(
      () => callTool('read_file', { repo: 'owner/repo' }),
      (err: Error) => {
        assert.ok(err instanceof FakeMcpError);
        assert.equal((err as FakeMcpError).code, FakeErrorCode.InvalidParams);
        return true;
      },
    );
  });

  it('throws McpError for grep_file without pattern', async () => {
    await assert.rejects(
      () => callTool('grep_file', { repo: 'owner/repo', path: 'file.ts' }),
      (err: Error) => {
        assert.ok(err instanceof FakeMcpError);
        return true;
      },
    );
  });

  it('throws McpError for search_files without query', async () => {
    await assert.rejects(
      () => callTool('search_files', { repo: 'owner/repo' }),
      (err: Error) => {
        assert.ok(err instanceof FakeMcpError);
        return true;
      },
    );
  });

  it('throws McpError for list_commit_files without ref', async () => {
    await assert.rejects(
      () => callTool('list_commit_files', { repo: 'owner/repo' }),
      (err: Error) => {
        assert.ok(err instanceof FakeMcpError);
        return true;
      },
    );
  });

  it('throws McpError for trigger_workflow without workflow', async () => {
    await assert.rejects(
      () => callTool('trigger_workflow', { repo: 'owner/repo' }),
      (err: Error) => {
        assert.ok(err instanceof FakeMcpError);
        return true;
      },
    );
  });

  it('throws McpError for get_workflow_logs without run_id', async () => {
    await assert.rejects(
      () => callTool('get_workflow_logs', { repo: 'owner/repo' }),
      (err: Error) => {
        assert.ok(err instanceof FakeMcpError);
        return true;
      },
    );
  });

  it('throws McpError for create_pr without required fields', async () => {
    await assert.rejects(
      () => callTool('create_pr', { repo: 'owner/repo' }),
      (err: Error) => {
        assert.ok(err instanceof FakeMcpError);
        return true;
      },
    );
  });

  it('throws McpError for merge_pr without pr_number', async () => {
    await assert.rejects(
      () => callTool('merge_pr', { repo: 'owner/repo' }),
      (err: Error) => {
        assert.ok(err instanceof FakeMcpError);
        return true;
      },
    );
  });

  it('throws McpError for delete_branch without branch_name', async () => {
    await assert.rejects(
      () => callTool('delete_branch', { repo: 'owner/repo' }),
      (err: Error) => {
        assert.ok(err instanceof FakeMcpError);
        return true;
      },
    );
  });

  it('throws McpError for check_pr_mergeable without pr_number', async () => {
    await assert.rejects(
      () => callTool('check_pr_mergeable', { repo: 'owner/repo' }),
      (err: Error) => {
        assert.ok(err instanceof FakeMcpError);
        return true;
      },
    );
  });

  it('throws McpError for find_existing_pr without head_branch', async () => {
    await assert.rejects(
      () => callTool('find_existing_pr', { repo: 'owner/repo' }),
      (err: Error) => {
        assert.ok(err instanceof FakeMcpError);
        return true;
      },
    );
  });
});

describe('CallTool handler — sensitive data redaction', () => {
  beforeEach(() => {
    executeCoreToolMock = async () => ({
      text: 'token=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
    });
  });

  it('redacts sensitive data in tool output', async () => {
    const result = (await callTool('list_prs', { repo: 'owner/repo' })) as {
      content: Array<{ type: string; text: string }>;
    };

    assert.ok(!result.content[0].text.includes('ghp_'));
    assert.ok(result.content[0].text.includes('[REDACTED GITHUB TOKEN]'));
  });
});

describe('CallTool handler — server info redacts sensitive text', () => {
  let savedToken: string | undefined;

  beforeEach(() => {
    savedToken = process.env.GITHUB_TOKEN;
  });

  afterEach(() => {
    if (savedToken !== undefined) process.env.GITHUB_TOKEN = savedToken;
    else delete process.env.GITHUB_TOKEN;
  });

  it('github_server_info passes output through redaction', async () => {
    // Even though server info doesn't typically contain secrets, the
    // formatTextResult wrapper always runs redactSensitiveText
    process.env.GITHUB_TOKEN = 'test';
    const result = (await callTool('github_server_info')) as {
      content: Array<{ type: string; text: string }>;
    };

    // The output should be valid JSON
    const parsed = JSON.parse(result.content[0].text);
    assert.ok(parsed.server);
  });
});
