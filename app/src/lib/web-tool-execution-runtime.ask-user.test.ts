/**
 * ask_user × approval-mode behavior in `WebToolExecutionRuntime`.
 *
 * Supervised/autonomous: ask_user surfaces a blocking question card and the
 * loop waits for a human tap. Full Auto: there's no human, so the runtime
 * (not just the FULL_AUTO_BLOCK prompt) auto-resolves the call — no card,
 * a synthetic "proceed yourself" result — so the round loop keeps moving
 * instead of stalling on a card that's hidden inside a collapsed group.
 */

import { describe, expect, it, vi } from 'vitest';

const getApprovalModeMock = vi.fn<() => string>();
vi.mock('./approval-mode', () => ({
  getApprovalMode: () => getApprovalModeMock(),
}));

// The runtime module imports the per-source executors; stub the ones with
// real side effects so importing the module is inert. ask_user never reaches
// them, but the mocks keep the import graph hermetic.
vi.mock('./sandbox-client', () => ({
  execInSandbox: vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0, truncated: false })),
}));

import { WebToolExecutionRuntime } from './web-tool-execution-runtime';
import type { AnyToolCall } from './tool-dispatch';

function askUserCall(): AnyToolCall {
  return {
    source: 'ask-user',
    call: {
      tool: 'ask_user',
      args: {
        question: 'What should we tackle next in Push?',
        options: [
          { id: 'a', label: 'Implement auto-branch-on-commit' },
          { id: 'b', label: 'Decompose TUI' },
        ],
      },
    },
  } as AnyToolCall;
}

describe('WebToolExecutionRuntime — ask_user × approval mode', () => {
  const runtime = new WebToolExecutionRuntime();

  it('emits a blocking ask-user card in supervised mode', async () => {
    getApprovalModeMock.mockReturnValue('supervised');
    const result = await runtime.execute(askUserCall(), {
      allowedRepo: 'owner/repo',
      sandboxId: 'sb-1',
      isMainProtected: false,
      role: 'orchestrator',
    });
    expect(result.card?.type).toBe('ask-user');
    expect(result.text).toContain('wait for their response');
  });

  it('auto-resolves with no card in full-auto mode', async () => {
    getApprovalModeMock.mockReturnValue('full-auto');
    const result = await runtime.execute(askUserCall(), {
      allowedRepo: 'owner/repo',
      sandboxId: 'sb-1',
      isMainProtected: false,
      role: 'orchestrator',
    });
    expect(result.card).toBeUndefined();
    expect(result.text).toContain('Full Auto');
    expect(result.text).toContain('continue without asking');
  });
});
