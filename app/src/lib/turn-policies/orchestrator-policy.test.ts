import { describe, it, expect } from 'vitest';
import { createOrchestratorPolicy } from './orchestrator-policy';
import type { TurnContext } from '../turn-policy';
import type { ChatMessage } from '@/types';

function makeCtx(round = 0): TurnContext {
  return {
    role: 'orchestrator',
    round,
    maxRounds: 100,
    sandboxId: null,
    allowedRepo: 'test/repo',
  };
}

function makeMsg(content: string, role: 'user' | 'assistant' = 'user'): ChatMessage {
  return { id: `msg-${Date.now()}-${Math.random()}`, role, content, timestamp: Date.now() };
}

describe('Orchestrator Policy — ungrounded completion', () => {
  const policy = createOrchestratorPolicy();
  const guard = policy.afterModelCall![0];
  const ctx = makeCtx();

  it('passes through when no completion claim is made', async () => {
    const response = 'Let me investigate this by delegating to the Explorer agent.';
    expect(await guard(response, [], ctx)).toBeNull();
  });

  it('passes through completion claims with artifact evidence', async () => {
    const response = 'Done! I modified src/auth.ts to fix the token refresh bug.';
    expect(await guard(response, [], ctx)).toBeNull();
  });

  it('passes through completion claims with PR reference', async () => {
    const response = 'All changes have been made and a PR has been created.';
    expect(await guard(response, [], ctx)).toBeNull();
  });

  it('passes through completion claims grounded by delegation result', async () => {
    const messages = [
      makeMsg('[Coder completed — 5 rounds, 2 files changed]'),
    ];
    const response = 'The task is done.';
    expect(await guard(response, messages, ctx)).toBeNull();
  });

  it('nudges on ungrounded completion claim', async () => {
    const response = 'Everything is done and completed.';
    const result = await guard(response, [], ctx);
    expect(result).not.toBeNull();
    expect(result!.action).toBe('inject');
    if (result!.action === 'inject') {
      expect(result!.message.content).toContain('UNGROUNDED_COMPLETION');
    }
  });

  it('passes through conditional/question responses', async () => {
    const response = 'Would you like me to implement this? If so, I can get it done.';
    expect(await guard(response, [], ctx)).toBeNull();
  });

  it('passes through when recent messages have acceptance criteria', async () => {
    const messages = [
      makeMsg('[Acceptance Criteria] 3/3 passed'),
    ];
    const response = 'The implementation is completed.';
    expect(await guard(response, messages, ctx)).toBeNull();
  });
});
