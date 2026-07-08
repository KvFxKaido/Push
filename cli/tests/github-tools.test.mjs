import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  executeToolCall as _rawExecuteToolCall,
  isGitHubToolName,
  isReadOnlyToolCall,
  getGitHubToolProtocol,
  getGitHubToolProtocolAsync,
  GITHUB_PUBLIC_TOOL_NAMES,
  GITHUB_READ_ONLY_PUBLIC_TOOL_NAMES,
} from '../tools.ts';
import {
  createCliGitHubRuntime,
  hasEnvGitHubToken,
  resolveGitHubToken,
  resetGhCliTokenCache,
} from '../github-runtime.ts';
import { getEffectiveCapabilities, roleCanUseTool } from '../../lib/capabilities.ts';

// Default role: orchestrator (the surface that advertises GitHub tools).
const executeToolCall = (call, root, opts = {}) =>
  _rawExecuteToolCall(call, root, { role: 'orchestrator', ...opts });

const GITHUB_TOKEN_ENV_VARS = ['PUSH_GITHUB_TOKEN', 'GITHUB_TOKEN', 'GH_TOKEN'];

describe('GitHub tool registry wiring', () => {
  it('advertises the full public-name surface (read + write)', () => {
    for (const name of ['pr', 'prs', 'commits', 'repo_read', 'branches', 'checks', 'repo_search']) {
      assert.ok(GITHUB_PUBLIC_TOOL_NAMES.has(name), `expected read tool ${name}`);
    }
    for (const name of ['pr_create', 'pr_merge', 'branch_delete', 'workflow_run']) {
      assert.ok(GITHUB_PUBLIC_TOOL_NAMES.has(name), `expected write tool ${name}`);
    }
  });

  it('classifies read-only vs write GitHub tools for parallelization', () => {
    assert.equal(isReadOnlyToolCall({ tool: 'pr' }), true);
    assert.equal(isReadOnlyToolCall({ tool: 'repo_read' }), true);
    assert.equal(isReadOnlyToolCall({ tool: 'pr_check' }), true);
    // Write tools are NOT read-only.
    assert.equal(isReadOnlyToolCall({ tool: 'pr_create' }), false);
    assert.equal(isReadOnlyToolCall({ tool: 'pr_merge' }), false);
    assert.equal(GITHUB_READ_ONLY_PUBLIC_TOOL_NAMES.has('pr_create'), false);
  });

  it('does not misclassify a CLI-native tool as GitHub', () => {
    assert.equal(isGitHubToolName('git_commit'), false);
    assert.equal(isGitHubToolName('read_file'), false); // CLI-native, not the GitHub repo_read
    assert.equal(isGitHubToolName('pr'), true);
  });
});

describe('GitHub tool capability gating (token-presence)', () => {
  it('write GitHub caps are stripped in local-daemon without a remote', () => {
    // No remoteGitHubAvailable → pr:write absent (the historical strip).
    assert.equal(roleCanUseTool('orchestrator', 'create_pr', 'local-daemon'), false);
    assert.equal(roleCanUseTool('orchestrator', 'merge_pr', 'local-daemon'), false);
    assert.equal(roleCanUseTool('coder', 'create_pr', 'local-daemon'), false);
  });

  it('write GitHub caps are grantable in local-daemon when a remote is available', () => {
    const opts = { remoteGitHubAvailable: true };
    assert.equal(roleCanUseTool('orchestrator', 'create_pr', 'local-daemon', opts), true);
    assert.equal(roleCanUseTool('orchestrator', 'merge_pr', 'local-daemon', opts), true);
    assert.equal(roleCanUseTool('orchestrator', 'trigger_workflow', 'local-daemon', opts), true);
  });

  it('read-only GitHub caps are unaffected by the remote flag', () => {
    // pr:read / repo:read are never in the remote-only strip set.
    assert.equal(roleCanUseTool('orchestrator', 'fetch_pr', 'local-daemon'), true);
    assert.equal(roleCanUseTool('explorer', 'fetch_pr', 'local-daemon'), true);
    assert.equal(roleCanUseTool('explorer', 'list_prs', 'local-daemon'), true);
  });

  it('the remote flag widens only pr:write/workflow:trigger, not git:push', () => {
    const caps = getEffectiveCapabilities('orchestrator', 'local-daemon', {
      remoteGitHubAvailable: true,
    });
    // git:push is stripped by the orchestrator-specific remote-git rule, NOT
    // the remoteGitHub flag's remote-only set — so the flag must not resurrect
    // it (push needs a configured git remote, not a GitHub API token).
    assert.equal(caps.has('git:push'), false);
    // git:commit / git:branch are LOCAL ops kept in local-daemon regardless of
    // the flag (real working tree — PR #700).
    assert.equal(caps.has('git:commit'), true);
    assert.equal(caps.has('git:branch'), true);
    // pr:write / workflow:trigger ARE restored by the GitHub-remote flag.
    assert.equal(caps.has('pr:write'), true);
    assert.equal(caps.has('workflow:trigger'), true);
  });
});

describe('GitHub tool dispatch (no token)', () => {
  const saved = {};
  let savedPath;
  beforeEach(() => {
    for (const k of GITHUB_TOKEN_ENV_VARS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    savedPath = process.env.PATH;
    process.env.PATH = '';
    resetGhCliTokenCache();
  });
  afterEach(() => {
    for (const k of GITHUB_TOKEN_ENV_VARS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
    resetGhCliTokenCache();
  });

  it('hasEnvGitHubToken reflects env presence', () => {
    assert.equal(hasEnvGitHubToken(), false);
    process.env.PUSH_GITHUB_TOKEN = 'ghp_test';
    assert.equal(hasEnvGitHubToken(), true);
  });

  it('getGitHubToolProtocol is empty without a token, populated with one', () => {
    assert.equal(getGitHubToolProtocol(), '');
    process.env.GITHUB_TOKEN = 'ghp_test';
    const proto = getGitHubToolProtocol();
    assert.match(proto, /GITHUB TOOLS/);
    assert.match(proto, /pr_create/);
  });

  it('getGitHubToolProtocolAsync advertises when only env supplies the token', async () => {
    assert.equal(await getGitHubToolProtocolAsync(), '');
    process.env.PUSH_GITHUB_TOKEN = 'ghp_env';
    const proto = await getGitHubToolProtocolAsync();
    assert.match(proto, /GITHUB TOOLS/);
  });

  it('resolveGitHubToken prefers PUSH_GITHUB_TOKEN over GITHUB_TOKEN', async () => {
    process.env.GITHUB_TOKEN = 'ghp_generic';
    process.env.PUSH_GITHUB_TOKEN = 'ghp_push';
    assert.equal(await resolveGitHubToken(), 'ghp_push');
  });
});

describe('GitHub tool dispatch (with token, mocked fetch)', () => {
  const saved = {};
  const originalFetch = globalThis.fetch;
  beforeEach(() => {
    for (const k of GITHUB_TOKEN_ENV_VARS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    resetGhCliTokenCache();
    process.env.PUSH_GITHUB_TOKEN = 'ghp_test_token';
  });
  afterEach(() => {
    for (const k of GITHUB_TOKEN_ENV_VARS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    resetGhCliTokenCache();
    globalThis.fetch = originalFetch;
  });

  it('routes a read-only GitHub tool (prs) through the core to the GitHub API', async () => {
    let calledUrl = null;
    let calledAuth = null;
    globalThis.fetch = async (url, options) => {
      calledUrl = String(url);
      calledAuth = options?.headers?.Authorization ?? null;
      return new Response(
        JSON.stringify([
          { number: 7, title: 'Add widget', state: 'open', user: { login: 'octocat' } },
        ]),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    };

    const result = await executeToolCall(
      { tool: 'prs', args: { repo: 'owner/repo' } },
      process.cwd(),
    );
    assert.equal(result.ok, true, result.text);
    assert.match(calledUrl, /api\.github\.com\/repos\/owner\/repo\/pulls/);
    assert.equal(calledAuth, 'token ghp_test_token');
    assert.match(result.text, /Add widget/);
  });

  it('blocks a write GitHub tool (pr_create) for the read-only explorer role', async () => {
    let fetched = false;
    globalThis.fetch = async () => {
      fetched = true;
      return new Response('{}', { status: 200 });
    };
    // Capture the symmetric structured log so operators can grep the denial —
    // returning the block only to the model (structuredError) is not enough.
    const errCalls = [];
    const originalError = console.error;
    console.error = (...args) => {
      errCalls.push(args);
    };
    let result;
    try {
      result = await _rawExecuteToolCall(
        { tool: 'pr_create', args: { repo: 'owner/repo', title: 't', head: 'f', base: 'main' } },
        process.cwd(),
        { role: 'explorer' },
      );
    } finally {
      console.error = originalError;
    }
    assert.equal(result.ok, false);
    assert.equal(result.structuredError?.code, 'ROLE_CAPABILITY_DENIED');
    assert.equal(fetched, false, 'must not hit the API when capability-denied');

    const denialLog = errCalls
      .map(([m]) => {
        try {
          return JSON.parse(m);
        } catch {
          return null;
        }
      })
      .find((p) => p && p.event === 'role_capability_denied');
    assert.ok(denialLog, 'expected a role_capability_denied structured log on stderr');
    assert.equal(denialLog.type, 'ROLE_CAPABILITY_DENIED');
    assert.equal(denialLog.role, 'explorer');
    assert.equal(denialLog.tool, 'create_pr');
    assert.deepEqual(denialLog.required, ['pr:write']);
    assert.deepEqual(
      new Set(denialLog.granted),
      new Set(getEffectiveCapabilities('explorer', 'local-daemon')),
    );
  });

  it('converts a thrown GitHub core error into a structured tool result (no rejection)', async () => {
    // A network-layer throw (timeout / DNS) must not reject executeToolCall —
    // the engine would treat it as a fatal run error instead of a recoverable
    // tool result the model can react to.
    globalThis.fetch = async () => {
      throw new Error('GitHub API timed out after 15s');
    };
    // Use a read tool so capability gating is not in play.
    const result = await executeToolCall(
      { tool: 'pr', args: { repo: 'owner/repo', pr: 1 } },
      process.cwd(),
    );
    assert.equal(result.ok, false);
    assert.ok(result.structuredError, 'expected a structured error');
    assert.match(result.text, /GitHub — pr/);
  });

  it('allows a write GitHub tool (pr_create) for orchestrator when a token is present', async () => {
    let calledUrl = null;
    let method = null;
    globalThis.fetch = async (url, options) => {
      calledUrl = String(url);
      method = options?.method ?? 'GET';
      return new Response(
        JSON.stringify({ number: 42, html_url: 'https://github.com/owner/repo/pull/42' }),
        { status: 201, headers: { 'Content-Type': 'application/json' } },
      );
    };
    const result = await executeToolCall(
      {
        tool: 'pr_create',
        args: { repo: 'owner/repo', title: 'My PR', body: 'b', head: 'feat', base: 'main' },
      },
      process.cwd(),
    );
    assert.equal(result.ok, true, result.text);
    assert.match(calledUrl, /api\.github\.com\/repos\/owner\/repo\/pulls/);
    assert.equal(method, 'POST');
  });
});

describe('createCliGitHubRuntime', () => {
  it('builds auth headers only when a token is present', () => {
    const withTok = createCliGitHubRuntime('ghp_abc');
    assert.equal(withTok.buildHeaders().Authorization, 'token ghp_abc');
    const noTok = createCliGitHubRuntime('');
    assert.equal(noTok.buildHeaders().Authorization, undefined);
  });

  it('builds api urls against api.github.com and decodes base64', () => {
    const rt = createCliGitHubRuntime('ghp_abc');
    assert.equal(rt.buildApiUrl('/repos/o/r'), 'https://api.github.com/repos/o/r');
    assert.equal(rt.buildApiUrl('repos/o/r'), 'https://api.github.com/repos/o/r');
    assert.equal(rt.decodeBase64(Buffer.from('hello', 'utf8').toString('base64')), 'hello');
  });

  it('redacts secrets in tool output text', () => {
    const rt = createCliGitHubRuntime('ghp_abc');
    const { text, redacted } = rt.redactSensitiveText('token ghp_0123456789abcdefghij0123');
    assert.equal(redacted, true);
    assert.match(text, /REDACTED GITHUB TOKEN/);
  });
});
