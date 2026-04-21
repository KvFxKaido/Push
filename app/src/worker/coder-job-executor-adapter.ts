/**
 * Tool executor adapter for the CoderJob Durable Object.
 *
 * Same shape as `coder-job-detector-adapter.ts`: a tiny local interface
 * the DO consumes, with the implementation free to live in app/src/lib
 * (same bundle) or be injected by tests. PR #4 will move the real
 * implementation to shared `lib/` — the adapter isolates that change.
 *
 * This PR (#2) ships an absolute-URL re-entry executor that calls
 * `/api/sandbox-cf/*` via the Worker's own origin. Inside a DO,
 * relative `fetch('/api/...')` cannot resolve — the origin is threaded
 * from the job-start payload.
 *
 * NOT IN SCOPE for PR #2:
 *   - Full feature parity with the Web's `executeSandboxToolCall`
 *     (which dispatches dozens of sandbox tools through the
 *     sandbox-tool-execution runtime). PR #3 / #4 will broaden the
 *     executor and wire up any tools required by the first
 *     background-job UI scenarios.
 *   - Web-search execution — stubbed with a structured error.
 *     Background jobs don't need web search in the first scenario;
 *     a real executor lands when the UI path exercises it.
 */

import type { SandboxStatusResult, SandboxToolExecResult } from '@push/lib/coder-agent-bindings';
import type { ChatCard } from '@/types';
import type { SandboxToolCall } from './coder-job-detector-adapter';

export interface CoderJobExecutorAdapter {
  executeSandboxToolCall: (
    call: SandboxToolCall,
    sandboxId: string,
    opts: { auditorProviderOverride: string; auditorModelOverride: string | undefined },
  ) => Promise<SandboxToolExecResult<ChatCard>>;
  executeWebSearch: (query: string, provider: string) => Promise<SandboxToolExecResult<ChatCard>>;
  sandboxStatus: (sandboxId: string) => Promise<SandboxStatusResult>;
}

export interface WebExecutorAdapterArgs {
  /** Absolute origin the DO should use to re-enter the Worker
   * (e.g. `https://push.example.com`). Must not have a trailing slash. */
  origin: string;
  /** Owner token issued at sandbox creation; required by
   * `/api/sandbox-cf/*` routes. */
  ownerToken: string;
}

/** Production executor — calls `/api/sandbox-cf/*` via absolute URL.
 *
 * Intentionally narrow in PR #2: forwards the sandbox call as an
 * opaque POST to `/api/sandbox-cf/tool-exec` (a route that does not
 * yet exist in this PR). Until the Worker adds a DO-friendly bulk
 * entry point, the executor returns a structured `SANDBOX_UNREACHABLE`
 * result, which the kernel surfaces to the model as a recoverable
 * error. This is deliberately visible — if a model emits a tool call
 * today in a background job, the job completes with a diagnostic
 * summary rather than silently hanging.
 *
 * PR #3 / #4 replaces this with real dispatch.
 */
export function createWebExecutorAdapter(args: WebExecutorAdapterArgs): CoderJobExecutorAdapter {
  void args.origin;
  void args.ownerToken;

  const notYetImplemented = (toolName: string): SandboxToolExecResult<ChatCard> => ({
    text:
      `[Tool Blocked — ${toolName}] Background Coder jobs do not yet dispatch this ` +
      `tool. This is a Phase 1 PR #2 limitation; full tool execution in background ` +
      `mode lands in PR #3. Stop mutation attempts and summarize your progress.`,
    structuredError: {
      type: 'SANDBOX_UNREACHABLE',
      retryable: false,
      message: `background-job executor not yet wired for ${toolName}`,
    },
  });

  return {
    executeSandboxToolCall: async (call) => notYetImplemented(call.tool),
    executeWebSearch: async () => notYetImplemented('web_search'),
    sandboxStatus: async () => ({
      error: 'background-job sandbox status probe not yet implemented (PR #3)',
      head: '',
      changedFiles: [],
    }),
  };
}
