/**
 * Turn Policy tests — verifies hook evaluation order, role scoping,
 * and the bridge to ToolHookRegistry.
 */

import { describe, it, expect } from 'vitest';
import { TurnPolicyRegistry, type TurnContext, type AgentRole } from './turn-policy';
import { resetCoderPolicy } from './turn-policy-factory';
import type { ChatMessage } from '@/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCtx(overrides: Partial<TurnContext> = {}): TurnContext {
  return {
    role: 'coder' as AgentRole,
    round: 0,
    maxRounds: 30,
    sandboxId: 'test-sandbox',
    allowedRepo: 'test/repo',
    ...overrides,
  };
}

function makeMsg(content: string, role: 'user' | 'assistant' = 'user'): ChatMessage {
  return { id: `msg-${Date.now()}`, role, content, timestamp: Date.now() };
}

// ---------------------------------------------------------------------------
// TurnPolicyRegistry basics
// ---------------------------------------------------------------------------

describe('TurnPolicyRegistry', () => {
  it('returns null when no policies are registered', async () => {
    const registry = new TurnPolicyRegistry();
    const ctx = makeCtx();
    expect(await registry.evaluateBeforeModel([], ctx)).toBeNull();
    expect(await registry.evaluateAfterModel('hello', [], ctx)).toBeNull();
    expect(await registry.evaluateBeforeTool('sandbox_exec', {}, ctx)).toBeNull();
    expect(await registry.evaluateAfterTool('sandbox_exec', {}, 'ok', false, ctx)).toBeNull();
  });

  it('scopes hooks to the correct role', async () => {
    const registry = new TurnPolicyRegistry();
    registry.register({
      name: 'coder-only',
      role: 'coder',
      beforeToolExec: [() => ({ action: 'deny', reason: 'coder says no' })],
    });

    const coderCtx = makeCtx({ role: 'coder' });
    const explorerCtx = makeCtx({ role: 'explorer' });

    const coderResult = await registry.evaluateBeforeTool('sandbox_exec', {}, coderCtx);
    expect(coderResult).toEqual({ action: 'deny', reason: 'coder says no' });

    const explorerResult = await registry.evaluateBeforeTool('sandbox_exec', {}, explorerCtx);
    expect(explorerResult).toBeNull();
  });

  it('first non-null result wins (short-circuit)', async () => {
    const registry = new TurnPolicyRegistry();
    const calls: string[] = [];

    registry.register({
      name: 'policy-a',
      role: 'coder',
      afterModelCall: [
        () => {
          calls.push('a');
          return null;
        },
        () => {
          calls.push('b');
          return { action: 'inject', message: makeMsg('correction') };
        },
        () => {
          calls.push('c');
          return null;
        }, // should not run
      ],
    });

    const ctx = makeCtx();
    const result = await registry.evaluateAfterModel('test', [], ctx);

    expect(result?.action).toBe('inject');
    expect(calls).toEqual(['a', 'b']);
  });

  it('multiple policies for same role evaluate in registration order', async () => {
    const registry = new TurnPolicyRegistry();
    const calls: string[] = [];

    registry.register({
      name: 'first',
      role: 'coder',
      afterModelCall: [
        () => {
          calls.push('first');
          return null;
        },
      ],
    });
    registry.register({
      name: 'second',
      role: 'coder',
      afterModelCall: [
        () => {
          calls.push('second');
          return { action: 'halt', summary: 'stop' };
        },
      ],
    });

    const ctx = makeCtx();
    const result = await registry.evaluateAfterModel('test', [], ctx);

    expect(calls).toEqual(['first', 'second']);
    expect(result).toEqual({ action: 'halt', summary: 'stop' });
  });

  it('halt results propagate correctly', async () => {
    const registry = new TurnPolicyRegistry();
    registry.register({
      name: 'halt-test',
      role: 'explorer',
      afterModelCall: [() => ({ action: 'halt', summary: 'Explorer exceeded round limit' })],
    });

    const ctx = makeCtx({ role: 'explorer' });
    const result = await registry.evaluateAfterModel('', [], ctx);
    expect(result).toEqual({ action: 'halt', summary: 'Explorer exceeded round limit' });
  });

  it('deregister removes all policies for a role', async () => {
    const registry = new TurnPolicyRegistry();
    registry.register({
      name: 'coder-a',
      role: 'coder',
      afterModelCall: [() => ({ action: 'halt', summary: 'stop' })],
    });
    registry.register({
      name: 'explorer-a',
      role: 'explorer',
      afterModelCall: [() => ({ action: 'halt', summary: 'explorer stop' })],
    });

    // Deregister coder
    registry.deregister('coder');

    // Coder policies gone
    const coderCtx = makeCtx({ role: 'coder' });
    expect(await registry.evaluateAfterModel('test', [], coderCtx)).toBeNull();

    // Explorer policies still present
    const explorerCtx = makeCtx({ role: 'explorer' });
    expect(await registry.evaluateAfterModel('test', [], explorerCtx)).not.toBeNull();
  });

  it('resetCoderPolicy replaces coder state with a fresh instance', async () => {
    const registry = new TurnPolicyRegistry();

    // Register a stateful coder policy that always halts
    let callCount = 0;
    registry.register({
      name: 'coder-stateful',
      role: 'coder',
      afterModelCall: [
        () => {
          callCount++;
          return { action: 'halt', summary: `call-${callCount}` };
        },
      ],
    });

    const ctx = makeCtx({ role: 'coder' });
    await registry.evaluateAfterModel('test', [], ctx);
    expect(callCount).toBe(1);

    // Reset replaces the old policy
    resetCoderPolicy(registry);

    // Old policy's closure is gone — callCount shouldn't increment
    const result = await registry.evaluateAfterModel('test', [], ctx);
    // The new coder policy (from createCoderPolicy) will have its own hooks
    // The key assertion: old stateful hooks are removed
    expect(callCount).toBe(1); // not incremented
    // New policy's afterModelCall should still evaluate (non-null or null depending on input)
    // Just verify we get a result from the fresh policy, not the old one
    expect(result?.action === 'halt' ? result.summary : '').not.toBe('call-2');
  });
});

// ---------------------------------------------------------------------------
// toToolHookRegistry bridge
// ---------------------------------------------------------------------------

describe('toToolHookRegistry bridge', () => {
  it('converts beforeToolExec deny into a ToolHookRegistry pre-hook deny', async () => {
    const registry = new TurnPolicyRegistry();
    registry.register({
      name: 'readonly-gate',
      role: 'explorer',
      beforeToolExec: [
        (toolName) => {
          if (toolName === 'sandbox_write_file') {
            return { action: 'deny', reason: 'Explorer is read-only' };
          }
          return null;
        },
      ],
    });

    const ctx = makeCtx({ role: 'explorer' });
    const hookRegistry = registry.toToolHookRegistry(ctx);

    expect(hookRegistry.pre.length).toBe(1);

    // Simulate tool-hooks evaluation
    const preHook = hookRegistry.pre[0];
    const denyResult = await preHook.hook(
      'sandbox_write_file',
      {},
      { sandboxId: 'test', allowedRepo: 'test/repo' },
    );
    expect(denyResult.decision).toBe('deny');

    const allowResult = await preHook.hook(
      'repo_read',
      {},
      { sandboxId: 'test', allowedRepo: 'test/repo' },
    );
    expect(allowResult.decision).toBe('passthrough');
  });

  it('returns empty hooks when no beforeToolExec registered', () => {
    const registry = new TurnPolicyRegistry();
    registry.register({
      name: 'no-tool-hooks',
      role: 'coder',
      afterModelCall: [() => null],
    });

    const ctx = makeCtx();
    const hookRegistry = registry.toToolHookRegistry(ctx);
    expect(hookRegistry.pre.length).toBe(0);
    expect(hookRegistry.post.length).toBe(0);
  });
});
