import { describe, expect, it } from 'vitest';
import { classifySandboxUnreachableRecovery } from './sandbox-recovery-policy';

describe('classifySandboxUnreachableRecovery', () => {
  it('allows safe automatic retry for read-only sandbox calls', () => {
    expect(
      classifySandboxUnreachableRecovery({
        source: 'sandbox',
        call: { tool: 'sandbox_read_file', args: { path: 'src/app.ts' } },
      }),
    ).toEqual({
      action: 'safe-read-retry',
      toolName: 'sandbox_read_file',
      toolSource: 'sandbox',
      reason: 'read_only_tool',
    });
  });

  it('requires recovery plus inspection for mutating sandbox calls', () => {
    expect(
      classifySandboxUnreachableRecovery({
        source: 'sandbox',
        call: { tool: 'sandbox_exec', args: { command: 'npm test' } },
      }),
    ).toEqual({
      action: 'recover-inspect',
      toolName: 'sandbox_exec',
      toolSource: 'sandbox',
      reason: 'mutation_may_have_dispatched',
    });
  });

  it('treats commit and push delivery tools as recover-inspect operations', () => {
    expect(
      classifySandboxUnreachableRecovery({
        source: 'sandbox',
        call: { tool: 'prepare_push', args: {} },
      }).action,
    ).toBe('recover-inspect');
    expect(
      classifySandboxUnreachableRecovery({
        source: 'sandbox',
        call: { tool: 'sandbox_commit', args: { message: 'checkpoint' } },
      }).action,
    ).toBe('recover-inspect');
  });
});
