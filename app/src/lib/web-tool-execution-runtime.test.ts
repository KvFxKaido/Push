/**
 * Regression tests for the runtime-level role capability invariant in
 * `WebToolExecutionRuntime` (step 6 of the Architecture Remediation Plan).
 *
 * The invariant these tests pin:
 *
 *   When `context.role === 'explorer'`, a mutating tool call must be
 *   refused at the runtime layer **before** any pre-hook, approval gate,
 *   Protect Main check, or per-source executor runs — even when the
 *   Explorer turn-policy hook has not been registered and when the
 *   read-only tool registry was not in use.
 *
 * This is the "runtime-hard" backstop behind the existing policy-shaped
 * hook at `explorer-policy.ts:20` and the Explorer allowlist wired into
 * the hook registry. If a future refactor of `useAgentDelegation.ts` or
 * `explorer-agent.ts` accidentally drops the policy hook, the runtime
 * layer must still refuse.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the per-source executors so we can (a) observe that they were
// never called when the invariant refuses a mutation, and (b) provide a
// trivial success path for the tool calls that the invariant does allow
// through.
vi.mock('./sandbox-tools', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./sandbox-tools')>();
  return {
    ...actual,
    executeSandboxToolCall: vi.fn(async () => ({
      text: '[mock sandbox executor] ok',
    })),
  };
});

vi.mock('./github-tools', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./github-tools')>();
  return {
    ...actual,
    executeToolCall: vi.fn(async () => ({
      text: '[mock github executor] ok',
    })),
  };
});

vi.mock('./sandbox-client', () => ({
  execInSandbox: vi.fn(async () => ({
    stdout: '',
    stderr: '',
    exitCode: 0,
    truncated: false,
  })),
}));

import { WebToolExecutionRuntime } from './web-tool-execution-runtime';
import * as sandboxTools from './sandbox-tools';
import * as githubTools from './github-tools';
import type { AnyToolCall } from './tool-dispatch';

function mutationCall(): AnyToolCall {
  return {
    source: 'sandbox',
    call: {
      tool: 'sandbox_write_file',
      args: { path: '/workspace/src/app.ts', content: 'mutated' },
    },
  };
}

function readCall(): AnyToolCall {
  return {
    source: 'sandbox',
    call: {
      tool: 'sandbox_read_file',
      args: { path: '/workspace/src/app.ts' },
    },
  };
}

describe('WebToolExecutionRuntime — runtime-level role capability invariant', () => {
  const runtime = new WebToolExecutionRuntime();

  beforeEach(() => {
    vi.mocked(sandboxTools.executeSandboxToolCall).mockClear();
    vi.mocked(githubTools.executeToolCall).mockClear();
  });

  describe('role=explorer refuses mutation even when hooks and gates are absent', () => {
    it('refuses sandbox_write_file with ROLE_CAPABILITY_DENIED', async () => {
      const result = await runtime.execute(mutationCall(), {
        allowedRepo: 'owner/repo',
        sandboxId: 'sb-1',
        isMainProtected: false,
        // The point of the test: the Explorer turn-policy hook is NOT
        // registered here (no `hooks` field). The read-only allowlist
        // from `explorer-constants` is not enforced at this level. The
        // only defense is the runtime invariant.
        hooks: undefined,
        approvalGates: undefined,
        capabilityLedger: undefined,
        role: 'explorer',
      });

      expect(result.structuredError).toBeDefined();
      expect(result.structuredError?.type).toBe('ROLE_CAPABILITY_DENIED');
      expect(result.structuredError?.retryable).toBe(false);
      expect(result.text).toContain('[Tool Blocked');
      expect(result.text).toContain('sandbox_write_file');
      // The detail line exposes the capability mismatch so logs can
      // show why the refusal happened.
      expect(result.structuredError?.detail).toContain('repo:write');
      expect(result.structuredError?.detail).toContain('repo:read');
    });

    it('never reaches the sandbox executor', async () => {
      await runtime.execute(mutationCall(), {
        allowedRepo: 'owner/repo',
        sandboxId: 'sb-1',
        isMainProtected: false,
        role: 'explorer',
      });
      expect(vi.mocked(sandboxTools.executeSandboxToolCall)).not.toHaveBeenCalled();
    });

    it('also refuses sandbox_edit_range, sandbox_search_replace, sandbox_exec, sandbox_run_tests, and sandbox_prepare_commit', async () => {
      const blockedCalls: AnyToolCall[] = [
        {
          source: 'sandbox',
          call: {
            tool: 'sandbox_edit_range',
            args: { path: '/workspace/a.ts', start_line: 1, end_line: 2, content: 'x' },
          },
        },
        {
          source: 'sandbox',
          call: {
            tool: 'sandbox_search_replace',
            args: { path: '/workspace/a.ts', search: 'a', replace: 'b' },
          },
        },
        {
          source: 'sandbox',
          call: { tool: 'sandbox_exec', args: { command: 'ls' } },
        },
        {
          source: 'sandbox',
          call: { tool: 'sandbox_run_tests', args: {} },
        },
        {
          source: 'sandbox',
          call: { tool: 'sandbox_prepare_commit', args: { message: 'x' } },
        },
      ];

      for (const call of blockedCalls) {
        const result = await runtime.execute(call, {
          allowedRepo: 'owner/repo',
          sandboxId: 'sb-1',
          isMainProtected: false,
          role: 'explorer',
        });
        expect(result.structuredError?.type).toBe('ROLE_CAPABILITY_DENIED');
      }

      expect(vi.mocked(sandboxTools.executeSandboxToolCall)).not.toHaveBeenCalled();
    });

    it('emits a paired toolExecutionComplete event on denial so observers see a terminal lifecycle', async () => {
      // Copilot PR #295 review finding: the ROLE_CAPABILITY_DENIED
      // early-return must pair its toolExecutionStart with a matching
      // complete event, otherwise any attached emitter sees the tool
      // as in-flight forever.
      const events: Array<{
        kind: 'start' | 'complete' | 'malformed';
        payload: unknown;
      }> = [];
      const emit = {
        toolExecutionStart: (event: unknown) => events.push({ kind: 'start', payload: event }),
        toolExecutionComplete: (event: unknown) =>
          events.push({ kind: 'complete', payload: event }),
        toolCallMalformed: (event: unknown) => events.push({ kind: 'malformed', payload: event }),
      };

      await runtime.execute(mutationCall(), {
        allowedRepo: 'owner/repo',
        sandboxId: 'sb-1',
        isMainProtected: false,
        role: 'explorer',
        emit,
      });

      const kinds = events.map((e) => e.kind);
      expect(kinds).toEqual(['start', 'complete']);
      const completeEvent = events[1].payload as {
        toolName: string;
        durationMs: number;
        error?: { type: string; retryable?: boolean };
      };
      expect(completeEvent.toolName).toBe('sandbox_write_file');
      expect(completeEvent.error?.type).toBe('ROLE_CAPABILITY_DENIED');
      expect(completeEvent.error?.retryable).toBe(false);
      expect(typeof completeEvent.durationMs).toBe('number');
    });
  });

  describe('role=explorer allows read-only tools through the runtime layer', () => {
    it('allows sandbox_read_file — the per-source executor is reached', async () => {
      const result = await runtime.execute(readCall(), {
        allowedRepo: 'owner/repo',
        sandboxId: 'sb-1',
        isMainProtected: false,
        role: 'explorer',
      });

      expect(result.structuredError).toBeUndefined();
      expect(result.text).toBe('[mock sandbox executor] ok');
      expect(vi.mocked(sandboxTools.executeSandboxToolCall)).toHaveBeenCalledTimes(1);
    });

    it('allows GitHub read tools', async () => {
      const call: AnyToolCall = {
        source: 'github',
        call: { tool: 'read_file', args: { repo: 'owner/repo', path: 'README.md' } },
      };
      const result = await runtime.execute(call, {
        allowedRepo: 'owner/repo',
        sandboxId: 'sb-1',
        isMainProtected: false,
        role: 'explorer',
      });

      expect(result.structuredError).toBeUndefined();
      expect(vi.mocked(githubTools.executeToolCall)).toHaveBeenCalledTimes(1);
    });

    it('allows GitHub PR read tools (pr:read grant)', async () => {
      // Regression pin for the Codex P1 finding on PR #295: without
      // `pr:read` in the Explorer capability grant, `fetch_pr` and
      // friends returned ROLE_CAPABILITY_DENIED even though they are
      // in `EXPLORER_ALLOWED_TOOLS`. The grant was widened alongside
      // the runtime invariant; these tools must now pass through.
      const prReadCalls: AnyToolCall[] = [
        {
          source: 'github',
          call: { tool: 'fetch_pr', args: { repo: 'owner/repo', pr: 42 } },
        },
        {
          source: 'github',
          call: { tool: 'list_prs', args: { repo: 'owner/repo' } },
        },
        {
          source: 'github',
          call: { tool: 'check_pr_mergeable', args: { repo: 'owner/repo', pr_number: 1 } },
        },
        {
          source: 'github',
          call: { tool: 'find_existing_pr', args: { repo: 'owner/repo', head_branch: 'f' } },
        },
      ];

      for (const call of prReadCalls) {
        const result = await runtime.execute(call, {
          allowedRepo: 'owner/repo',
          sandboxId: 'sb-1',
          isMainProtected: false,
          role: 'explorer',
        });
        expect(result.structuredError).toBeUndefined();
      }

      expect(vi.mocked(githubTools.executeToolCall)).toHaveBeenCalledTimes(prReadCalls.length);
    });

    it('allows GitHub workflow read tools (workflow:read grant)', async () => {
      // Regression pin for the Codex P1 finding: `get_workflow_runs`
      // and `get_workflow_logs` are in `EXPLORER_ALLOWED_TOOLS` but
      // require `workflow:read`, which was also missing from the
      // Explorer grant alongside `pr:read`.
      const workflowReadCalls: AnyToolCall[] = [
        {
          source: 'github',
          call: { tool: 'get_workflow_runs', args: { repo: 'owner/repo' } },
        },
        {
          source: 'github',
          call: { tool: 'get_workflow_logs', args: { repo: 'owner/repo', run_id: 1 } },
        },
      ];

      for (const call of workflowReadCalls) {
        const result = await runtime.execute(call, {
          allowedRepo: 'owner/repo',
          sandboxId: 'sb-1',
          isMainProtected: false,
          role: 'explorer',
        });
        expect(result.structuredError).toBeUndefined();
      }

      expect(vi.mocked(githubTools.executeToolCall)).toHaveBeenCalledTimes(
        workflowReadCalls.length,
      );
    });

    it('still refuses write-side GitHub tools (pr:write / workflow:trigger)', async () => {
      // The grant widened for read capabilities; it must NOT have
      // accidentally picked up write grants. Verify the invariant
      // still fires for the mutating GitHub tools Explorer never had.
      const writeCalls: AnyToolCall[] = [
        {
          source: 'github',
          call: {
            tool: 'create_pr',
            args: { repo: 'owner/repo', title: 't', body: 'b', head: 'f', base: 'main' },
          },
        },
        {
          source: 'github',
          call: { tool: 'merge_pr', args: { repo: 'owner/repo', pr_number: 1 } },
        },
        {
          source: 'github',
          call: { tool: 'delete_branch', args: { repo: 'owner/repo', branch_name: 'f' } },
        },
        {
          source: 'github',
          call: { tool: 'trigger_workflow', args: { repo: 'owner/repo', workflow: 'w.yml' } },
        },
      ];

      for (const call of writeCalls) {
        const result = await runtime.execute(call, {
          allowedRepo: 'owner/repo',
          sandboxId: 'sb-1',
          isMainProtected: false,
          role: 'explorer',
        });
        expect(result.structuredError?.type).toBe('ROLE_CAPABILITY_DENIED');
      }
    });
  });

  describe('role=coder passes the runtime invariant for mutation tools', () => {
    it('allows sandbox_write_file (coder has repo:write)', async () => {
      const result = await runtime.execute(mutationCall(), {
        allowedRepo: 'owner/repo',
        sandboxId: 'sb-1',
        isMainProtected: false,
        role: 'coder',
      });

      expect(result.structuredError).toBeUndefined();
      expect(result.text).toBe('[mock sandbox executor] ok');
      expect(vi.mocked(sandboxTools.executeSandboxToolCall)).toHaveBeenCalledTimes(1);
    });
  });

  describe('no role opts out of the runtime invariant', () => {
    it('leaves mutation unblocked when context.role is undefined (backward compatibility)', async () => {
      // Callers that have not opted in (deep-reviewer today, and every
      // pre-step-6 call site) must not see a behavior change.
      const result = await runtime.execute(mutationCall(), {
        allowedRepo: 'owner/repo',
        sandboxId: 'sb-1',
        isMainProtected: false,
        // role: undefined
      });

      expect(result.structuredError).toBeUndefined();
      expect(vi.mocked(sandboxTools.executeSandboxToolCall)).toHaveBeenCalledTimes(1);
    });
  });

  describe('unknown tool names fail open', () => {
    it('allows a tool whose name is not in the capability map through the runtime invariant', async () => {
      // The capability map in `lib/capabilities.ts` explicitly documents
      // a fail-open policy for unknown tools (forward-compat). The
      // runtime invariant inherits that behavior: an unknown name is
      // not the runtime layer's problem to reject — other layers will
      // catch it (detection, dispatch, per-source executor).
      const unknownCall = {
        source: 'sandbox',
        // A made-up name that isn't in TOOL_CAPABILITIES or the sandbox
        // tool registry. Cast is needed because SandboxToolCall is a
        // discriminated union of known names.
        call: { tool: 'sandbox_unknown_future_tool', args: {} },
      } as unknown as AnyToolCall;

      const result = await runtime.execute(unknownCall, {
        allowedRepo: 'owner/repo',
        sandboxId: 'sb-1',
        isMainProtected: false,
        role: 'explorer',
      });

      // The invariant didn't reject it — the downstream dispatcher sees
      // the call. (Our mock swallows it and returns success.)
      expect(result.structuredError?.type).not.toBe('ROLE_CAPABILITY_DENIED');
    });
  });
});

/**
 * Phase 1.d chat-layer wiring: when the chat round loop carries a
 * `localDaemonBinding` (set on the SendLoopContext from a
 * `kind: 'local-pc'` workspace session), the runtime must forward that
 * binding into `executeSandboxToolCall`'s options bag so the sandbox
 * dispatcher can fork to `execLocalDaemon`. PR #511 added the dispatch
 * seam in `sandbox-tools.ts`; these tests pin the upstream half of the
 * contract — the seam is reachable through the runtime, not just from
 * unit tests that call `executeSandboxToolCall` directly.
 */
describe('WebToolExecutionRuntime — local-daemon binding propagation', () => {
  const runtime = new WebToolExecutionRuntime();

  const binding = {
    port: 49152,
    token: 'pushd_test_token_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    boundOrigin: 'http://localhost:5173',
  };

  beforeEach(() => {
    vi.mocked(sandboxTools.executeSandboxToolCall).mockClear();
  });

  it('forwards localDaemonBinding into executeSandboxToolCall options', async () => {
    await runtime.execute(
      {
        source: 'sandbox',
        call: { tool: 'sandbox_exec', args: { command: 'echo hello' } },
      },
      {
        allowedRepo: 'owner/repo',
        sandboxId: null,
        isMainProtected: false,
        localDaemonBinding: binding,
      },
    );

    expect(vi.mocked(sandboxTools.executeSandboxToolCall)).toHaveBeenCalledTimes(1);
    const [, , options] = vi.mocked(sandboxTools.executeSandboxToolCall).mock.calls[0];
    expect(options?.localDaemonBinding).toBe(binding);
  });

  it('does NOT short-circuit on missing sandboxId when a binding is present', async () => {
    // local-pc WorkspaceSession records carry `sandboxId: null` by
    // construction — the binding is the transport. This pins the
    // runtime-layer guard (mirrors the PR #511 fix at the
    // executeSandboxToolCall layer).
    const result = await runtime.execute(
      {
        source: 'sandbox',
        call: { tool: 'sandbox_exec', args: { command: 'pwd' } },
      },
      {
        allowedRepo: 'owner/repo',
        sandboxId: null,
        isMainProtected: false,
        localDaemonBinding: binding,
      },
    );

    expect(result.structuredError?.type).not.toBe('SANDBOX_UNREACHABLE');
    expect(vi.mocked(sandboxTools.executeSandboxToolCall)).toHaveBeenCalledTimes(1);
  });

  it('keeps the short-circuit when neither sandboxId nor binding is supplied', async () => {
    const result = await runtime.execute(
      {
        source: 'sandbox',
        call: { tool: 'sandbox_exec', args: { command: 'pwd' } },
      },
      {
        allowedRepo: 'owner/repo',
        sandboxId: null,
        isMainProtected: false,
      },
    );

    expect(result.structuredError?.type).toBe('SANDBOX_UNREACHABLE');
    expect(vi.mocked(sandboxTools.executeSandboxToolCall)).not.toHaveBeenCalled();
  });

  it('routes to the sandbox executor when sandboxId is present (binding absent)', async () => {
    // Cloud sessions: binding is null, sandboxId carries the container
    // id. Ensure the existing cloud path is unchanged.
    await runtime.execute(
      {
        source: 'sandbox',
        call: { tool: 'sandbox_exec', args: { command: 'ls' } },
      },
      {
        allowedRepo: 'owner/repo',
        sandboxId: 'sb-cloud-1',
        isMainProtected: false,
      },
    );

    expect(vi.mocked(sandboxTools.executeSandboxToolCall)).toHaveBeenCalledTimes(1);
    const [, sandboxIdArg, options] = vi.mocked(sandboxTools.executeSandboxToolCall).mock.calls[0];
    expect(sandboxIdArg).toBe('sb-cloud-1');
    expect(options?.localDaemonBinding).toBeUndefined();
  });
});
