import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AnyToolCall } from '@/lib/tool-dispatch';
import type { BranchDesyncContext } from './branch-desync';
import {
  applySandboxExecBranchDesync,
  applyStampedSandboxExecBranchDesync,
  decideSandboxExecBranchDesync,
} from './branch-desync';

function sandboxExec(command = 'git rebase origin/main'): AnyToolCall {
  return {
    source: 'sandbox',
    call: { tool: 'sandbox_exec', args: { command } },
  } as unknown as AnyToolCall;
}

function context(branch = 'main') {
  const onBranchSwitch = vi.fn();
  const onBranchDesync = vi.fn();
  const appendRunEvent = vi.fn();
  const ctx = {
    chatId: 'chat-1',
    appendRunEvent,
    activeChatIdRef: { current: 'chat-1' },
    conversationsRef: { current: {} },
    branchInfoRef: { current: { currentBranch: branch, defaultBranch: 'main' } },
    setConversations: vi.fn(),
    dirtyConversationIdsRef: { current: new Set<string>() },
    runtimeHandlersRef: { current: { onBranchSwitch, onBranchDesync } },
  } as unknown as BranchDesyncContext;
  return { ctx, onBranchSwitch, onBranchDesync, appendRunEvent };
}

describe('decideSandboxExecBranchDesync', () => {
  it('returns match when the stamp equals the tracked branch', () => {
    expect(
      decideSandboxExecBranchDesync({
        expected: 'main',
        actual: 'main',
        command: 'git status',
      }),
    ).toEqual({ kind: 'match', expected: 'main', actual: 'main' });
  });

  it('returns reconcile when the sandbox moved to another branch', () => {
    expect(
      decideSandboxExecBranchDesync({
        expected: 'main',
        actual: 'feature/desynced',
        command: 'git rebase origin/main',
      }),
    ).toEqual({
      kind: 'reconcile',
      expected: 'main',
      actual: 'feature/desynced',
      command: 'git rebase origin/main',
    });
  });

  it('returns detached for a HEAD stamp without reconciling to a branch', () => {
    expect(
      decideSandboxExecBranchDesync({
        expected: 'main',
        actual: 'HEAD',
        command: 'git checkout HEAD~1',
      }),
    ).toEqual({
      kind: 'detached',
      expected: 'main',
      actual: 'HEAD',
      command: 'git checkout HEAD~1',
    });
  });

  it('returns no_stamp when the provider omitted the branch', () => {
    expect(
      decideSandboxExecBranchDesync({
        expected: 'main',
        command: 'npm test',
      }),
    ).toEqual({ kind: 'no_stamp' });
  });
});

describe('applySandboxExecBranchDesync', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('emits and reconciles toward sandbox HEAD through the governed switch handler', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { ctx, onBranchSwitch, onBranchDesync, appendRunEvent } = context('main');

    const decision = applySandboxExecBranchDesync(
      sandboxExec(),
      { text: 'ok', branch: 'topic' },
      ctx,
    );

    expect(decision).toEqual({
      kind: 'reconcile',
      expected: 'main',
      actual: 'topic',
      command: 'git rebase origin/main',
    });
    expect(appendRunEvent).toHaveBeenCalledWith('chat-1', {
      type: 'branch_desync',
      expected: 'main',
      actual: 'topic',
      command: 'git rebase origin/main',
    });
    expect(onBranchDesync).toHaveBeenCalledWith({
      expected: 'main',
      actual: 'topic',
      command: 'git rebase origin/main',
      reconciled: true,
    });
    expect(onBranchSwitch).toHaveBeenCalledWith('topic');
    expect(log).toHaveBeenCalledWith(
      JSON.stringify({
        level: 'info',
        event: 'branch_desync_detected_reconciled',
        expected: 'main',
        actual: 'topic',
        command: 'git rebase origin/main',
      }),
    );
  });

  it('surfaces detached HEAD without switching tracked branches', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { ctx, onBranchSwitch, onBranchDesync, appendRunEvent } = context('main');

    const decision = applySandboxExecBranchDesync(
      sandboxExec('git checkout HEAD~1'),
      {
        text: 'ok',
        branch: 'HEAD',
      },
      ctx,
    );

    expect(decision.kind).toBe('detached');
    expect(appendRunEvent).toHaveBeenCalledWith('chat-1', {
      type: 'branch_desync',
      expected: 'main',
      actual: 'HEAD',
      command: 'git checkout HEAD~1',
    });
    expect(onBranchDesync).toHaveBeenCalledWith({
      expected: 'main',
      actual: 'HEAD',
      command: 'git checkout HEAD~1',
      reconciled: false,
    });
    expect(onBranchSwitch).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      JSON.stringify({
        level: 'info',
        event: 'branch_desync_detected_detached',
        expected: 'main',
        actual: 'HEAD',
        command: 'git checkout HEAD~1',
      }),
    );
  });

  it('is silent on matching stamps and non-exec tool calls', () => {
    const { ctx, onBranchSwitch, onBranchDesync, appendRunEvent } = context('main');

    expect(
      applySandboxExecBranchDesync(sandboxExec(), { text: 'ok', branch: 'main' }, ctx),
    ).toEqual({ kind: 'match', expected: 'main', actual: 'main' });
    const readCall = {
      source: 'sandbox',
      call: { tool: 'sandbox_read_file', args: { path: 'a.ts' } },
    } as unknown as AnyToolCall;
    expect(applySandboxExecBranchDesync(readCall, { text: 'ok', branch: 'topic' }, ctx)).toEqual({
      kind: 'no_stamp',
    });

    expect(appendRunEvent).not.toHaveBeenCalled();
    expect(onBranchDesync).not.toHaveBeenCalled();
    expect(onBranchSwitch).not.toHaveBeenCalled();
  });
});

describe('applyStampedSandboxExecBranchDesync (inline lane entry point)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reconciles a kernel-teed stamp through the same governed path', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { ctx, onBranchSwitch, onBranchDesync, appendRunEvent } = context('main');

    const decision = applyStampedSandboxExecBranchDesync(
      { command: 'git rebase origin/main', branch: 'topic' },
      ctx,
    );

    expect(decision.kind).toBe('reconcile');
    expect(appendRunEvent).toHaveBeenCalledWith('chat-1', {
      type: 'branch_desync',
      expected: 'main',
      actual: 'topic',
      command: 'git rebase origin/main',
    });
    expect(onBranchDesync).toHaveBeenCalledWith({
      expected: 'main',
      actual: 'topic',
      command: 'git rebase origin/main',
      reconciled: true,
    });
    expect(onBranchSwitch).toHaveBeenCalledWith('topic');
  });

  it('no-ops without a stamp', () => {
    const { ctx, onBranchSwitch, onBranchDesync, appendRunEvent } = context('main');

    expect(applyStampedSandboxExecBranchDesync({ command: 'npm test' }, ctx)).toEqual({
      kind: 'no_stamp',
    });
    expect(appendRunEvent).not.toHaveBeenCalled();
    expect(onBranchDesync).not.toHaveBeenCalled();
    expect(onBranchSwitch).not.toHaveBeenCalled();
  });
});
