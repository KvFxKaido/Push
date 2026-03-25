import { describe, it, expect } from 'vitest';
import { createExplorerPolicy } from './explorer-policy';
import { EXPLORER_ALLOWED_TOOLS } from '../explorer-agent';
import type { TurnContext } from '../turn-policy';

function makeCtx(round = 0): TurnContext {
  return {
    role: 'explorer',
    round,
    maxRounds: 14,
    sandboxId: 'test',
    allowedRepo: 'test/repo',
  };
}

describe('Explorer Policy — read-only gate', () => {
  const policy = createExplorerPolicy();
  const gate = policy.beforeToolExec![0];
  const ctx = makeCtx();

  it('allows tools in the EXPLORER_ALLOWED_TOOLS set', async () => {
    // These canonical names are in the allowed set
    for (const tool of EXPLORER_ALLOWED_TOOLS) {
      expect(await gate(tool, {}, ctx)).toBeNull();
    }
  });

  it('denies tools not in the allowed set', async () => {
    const result = await gate('sandbox_write_file', {}, ctx);
    expect(result).not.toBeNull();
    expect(result!.action).toBe('deny');
    expect(result!.reason).toContain('read-only');
  });

  it('denies made-up tool names', async () => {
    const result = await gate('delegate_coder', {}, ctx);
    expect(result).not.toBeNull();
    expect(result!.action).toBe('deny');
  });
});

describe('Explorer Policy — no-empty-report', () => {
  const policy = createExplorerPolicy();
  const guard = policy.afterModelCall![0];
  const ctx = makeCtx();

  it('passes through well-formed reports', async () => {
    const report = `Summary: The auth flow uses JWT tokens.
Findings: Token refresh happens in auth-provider.ts:42.
Relevant files: src/auth-provider.ts, src/hooks/useAuth.ts
Open questions: None.
Recommended next step: Delegate to Coder.`;

    expect(await guard(report, [], ctx)).toBeNull();
  });

  it('passes through tool call responses', async () => {
    const toolCall = '{"tool": "repo_read", "args": {"path": "src/index.ts"}}';
    expect(await guard(toolCall, [], ctx)).toBeNull();
  });

  it('nudges on empty/vague responses', async () => {
    const result = await guard('I looked at the code.', [], ctx);
    expect(result).not.toBeNull();
    expect(result!.action).toBe('inject');
  });

  it('nudges on short responses missing required sections', async () => {
    const result = await guard('The function is in utils.ts', [], ctx);
    expect(result).not.toBeNull();
    expect(result!.action).toBe('inject');
  });
});
