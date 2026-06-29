import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApprovalCardData } from '@/types';
import {
  buildApprovalCardData,
  registerApproval,
  requestApproval,
  resolveApproval,
  setApprovalCardInjector,
  setApprovalCardResolver,
} from './approval-bridge';

const REQ = {
  toolName: 'sandbox_exec',
  reason: 'Matched a destructive pattern',
  recoveryPath: 'use a non-destructive command',
  category: 'destructive_sandbox',
  args: { command: 'rm -rf node_modules' },
};

afterEach(() => {
  setApprovalCardInjector(null);
  setApprovalCardResolver(null);
});

describe('approval-bridge', () => {
  it('resolveApproval resolves a registered promise with the decision', async () => {
    const approved = registerApproval('a1');
    expect(resolveApproval('a1', true)).toBe(true);
    await expect(approved).resolves.toBe(true);
  });

  it('resolveApproval on an unknown id is a logged no-op', () => {
    expect(resolveApproval('never-registered', true)).toBe(false);
  });

  it('a second resolve finds no waiter (stale card actioned after Stop)', async () => {
    const decision = registerApproval('dup');
    expect(resolveApproval('dup', false)).toBe(true);
    await expect(decision).resolves.toBe(false);
    // The user then clicks the still-visible card; no waiter remains → false,
    // which the handler maps to an 'expired' card instead of false success.
    expect(resolveApproval('dup', true)).toBe(false);
  });

  it('fails closed (denies) when no injector is registered', async () => {
    setApprovalCardInjector(null);
    await expect(requestApproval('chat-1', REQ)).resolves.toBe(false);
  });

  it('injects a card and resolves on the card decision', async () => {
    let injected: ApprovalCardData | undefined;
    setApprovalCardInjector((_chatId, data) => {
      injected = data;
    });

    const decision = requestApproval('chat-1', REQ);
    // requestApproval has no await before the injector, so the card payload is
    // available synchronously.
    expect(injected).toBeDefined();
    expect(injected?.command).toBe('rm -rf node_modules');
    expect(injected?.category).toBe('destructive_sandbox');
    expect(injected?.status).toBe('pending');

    resolveApproval(injected!.approvalId, true);
    await expect(decision).resolves.toBe(true);
  });

  it('skips injection and denies when the turn is already aborted', async () => {
    const injector = vi.fn();
    setApprovalCardInjector(injector);
    const controller = new AbortController();
    controller.abort();
    await expect(requestApproval('chat-1', REQ, controller.signal)).resolves.toBe(false);
    expect(injector).not.toHaveBeenCalled();
  });

  it('denies and expires the card when the turn aborts while pending', async () => {
    let injected: ApprovalCardData | undefined;
    setApprovalCardInjector((_chatId, data) => {
      injected = data;
    });
    const resolver = vi.fn();
    setApprovalCardResolver(resolver);
    const controller = new AbortController();
    const decision = requestApproval('chat-1', REQ, controller.signal);
    controller.abort();
    await expect(decision).resolves.toBe(false);
    expect(resolver).toHaveBeenCalledWith('chat-1', injected?.approvalId, 'expired');
  });

  it('coerces an unknown gate category to the caution band', () => {
    const data = buildApprovalCardData({
      approvalId: 'a',
      toolName: 'sandbox_exec',
      category: 'something_new',
      reason: 'r',
      recoveryPath: 'p',
      args: { command: 'ls' },
    });
    expect(data.category).toBe('destructive_sandbox');
    expect(data.command).toBe('ls');
    expect(data.reason).toBe('r · p');
  });
});
