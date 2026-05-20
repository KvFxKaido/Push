import { describe, expect, it } from 'vitest';
import type { AnyToolCall } from '@/lib/tool-dispatch';
import { shouldSkipDelegationOutcomeRecording } from './chat-send-helpers';

// Pins the Codex P1 contract from PR #603: `plan_tasks` wrapper
// outcomes carry agent='coder' or 'explorer' but the inner per-task
// nodes already record their own outcomes via the task-graph handler.
// Counting the wrapper too would double-count and could falsely break
// a later direct `delegate_coder` call. The recordDelegationOutcome
// closure uses this predicate to skip the wrapper.

describe('shouldSkipDelegationOutcomeRecording', () => {
  it('returns true for plan_tasks delegation calls (inner nodes record their own outcomes)', () => {
    const call = {
      source: 'delegate',
      call: { tool: 'plan_tasks', args: { tasks: [] } },
    } as unknown as AnyToolCall;
    expect(shouldSkipDelegationOutcomeRecording(call)).toBe(true);
  });

  it('returns false for delegate_coder so the outcome counts toward the per-agent breaker', () => {
    const call = {
      source: 'delegate',
      call: { tool: 'delegate_coder', args: { task: 'fix the bug' } },
    } as unknown as AnyToolCall;
    expect(shouldSkipDelegationOutcomeRecording(call)).toBe(false);
  });

  it('returns false for delegate_explorer so the outcome counts toward the per-agent breaker', () => {
    const call = {
      source: 'delegate',
      call: { tool: 'delegate_explorer', args: { task: 'trace the flow' } },
    } as unknown as AnyToolCall;
    expect(shouldSkipDelegationOutcomeRecording(call)).toBe(false);
  });

  it('returns false for non-delegation tools — the breaker silently ignores them anyway', () => {
    const call = {
      source: 'sandbox',
      call: { tool: 'sandbox_read_file', args: { path: '/a' } },
    } as unknown as AnyToolCall;
    expect(shouldSkipDelegationOutcomeRecording(call)).toBe(false);
  });
});
