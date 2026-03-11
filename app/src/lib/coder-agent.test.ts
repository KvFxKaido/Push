import { describe, expect, it } from 'vitest';
import type { ChatMessage, CoderObservation } from '@/types';
import {
  applyObservationUpdates,
  detectUpdateStateCall,
  formatCoderState,
  formatCoderStateDiff,
  invalidateObservationDependencies,
  normalizeTrimmedRoleAlternation,
} from './coder-agent';

function msg(
  id: string,
  role: ChatMessage['role'],
  content: string,
  extras: Partial<ChatMessage> = {},
): ChatMessage {
  return {
    id,
    role,
    content,
    timestamp: 1,
    ...extras,
  };
}

function hasConsecutiveUsers(messages: ChatMessage[]): boolean {
  for (let i = 1; i < messages.length; i++) {
    if (messages[i - 1].role === 'user' && messages[i].role === 'user') return true;
  }
  return false;
}

describe('normalizeTrimmedRoleAlternation', () => {
  it('drops boundary tool-result user messages', () => {
    const messages: ChatMessage[] = [
      msg('seed', 'user', 'Task: do work'),
      msg('tool', 'user', '[TOOL_RESULT] huge payload', { isToolResult: true }),
      msg('assistant', 'assistant', 'next round'),
    ];

    normalizeTrimmedRoleAlternation(messages, 4, () => 123);

    expect(messages).toHaveLength(2);
    expect(messages[0].content).toBe('Task: do work');
    expect(messages[1].role).toBe('assistant');
  });

  it('inserts an assistant bridge instead of merging non-tool user content into seed', () => {
    const messages: ChatMessage[] = [
      msg('seed', 'user', 'Task: do work'),
      msg('checkpoint', 'user', '[CHECKPOINT RESPONSE] try B'),
      msg('assistant', 'assistant', 'continuing'),
    ];

    normalizeTrimmedRoleAlternation(messages, 7, () => 456);

    expect(messages[0].content).toBe('Task: do work');
    expect(messages[1].role).toBe('assistant');
    expect(messages[1].content).toContain('[Context bridge]');
    expect(messages[2].role).toBe('user');
    expect(messages[2].content).toContain('[CHECKPOINT RESPONSE]');
    expect(hasConsecutiveUsers(messages)).toBe(false);
  });

  it('merges additional non-seed user runs after the bridge', () => {
    const messages: ChatMessage[] = [
      msg('seed', 'user', 'Task: do work'),
      msg('user-1', 'user', 'first user follow-up'),
      msg('user-2', 'user', 'second user follow-up'),
      msg('assistant', 'assistant', 'continuing'),
    ];

    normalizeTrimmedRoleAlternation(messages, 9, () => 789);

    expect(messages[0].role).toBe('user');
    expect(messages[1].role).toBe('assistant');
    expect(messages[2].role).toBe('user');
    expect(messages[3].role).toBe('assistant');
    expect(messages[2].content).toContain('first user follow-up');
    expect(messages[2].content).toContain('second user follow-up');
    expect(hasConsecutiveUsers(messages)).toBe(false);
  });

  it('drops tool-result users that appear after a bridged non-tool user', () => {
    const messages: ChatMessage[] = [
      msg('seed', 'user', 'Task: do work'),
      msg('user', 'user', 'checkpoint guidance'),
      msg('tool', 'user', '[TOOL_RESULT] payload', { isToolResult: true }),
      msg('assistant', 'assistant', 'continuing'),
    ];

    normalizeTrimmedRoleAlternation(messages, 11, () => 999);

    expect(messages.some((m) => m.isToolResult)).toBe(false);
    expect(messages[0].content).toBe('Task: do work');
    expect(hasConsecutiveUsers(messages)).toBe(false);
  });
});

describe('coder working memory observations', () => {
  it('parses observation updates and removals from coder_update_state calls', () => {
    const parsed = detectUpdateStateCall(`{"tool":"coder_update_state","args":{"observations":[{"id":"adapter-pattern","text":"The adapter lives in lib/adapter.ts","dependsOn":["app/src/lib/adapter.ts"]},{"id":"legacy-note","remove":true}]}}`);

    expect(parsed).toEqual({
      observations: [
        {
          id: 'adapter-pattern',
          text: 'The adapter lives in lib/adapter.ts',
          dependsOn: ['app/src/lib/adapter.ts'],
        },
        {
          id: 'legacy-note',
          remove: true,
        },
      ],
    });
  });

  it('merges observations by id, clears stale flags, and removes entries', () => {
    const existing: CoderObservation[] = [
      {
        id: 'adapter-pattern',
        text: 'Old location',
        dependsOn: ['app/src/old.ts'],
        stale: true,
        staleReason: 'app/src/old.ts was modified at round 2',
        addedAtRound: 1,
      },
      {
        id: 'legacy-note',
        text: 'Delete me',
        addedAtRound: 2,
      },
    ];

    const next = applyObservationUpdates(existing, [
      {
        id: 'adapter-pattern',
        text: 'New location',
        dependsOn: ['app/src/new.ts'],
      },
      {
        id: 'legacy-note',
        remove: true,
      },
      {
        id: 'routing',
        text: 'Routing is centralized',
      },
    ], 4);

    expect(next).toEqual([
      {
        id: 'adapter-pattern',
        text: 'New location',
        dependsOn: ['app/src/new.ts'],
        addedAtRound: 1,
      },
      {
        id: 'routing',
        text: 'Routing is centralized',
        addedAtRound: 4,
      },
    ]);
  });

  it('marks matching observations stale when a dependency is mutated (normalizes paths)', () => {
    const observations: CoderObservation[] = [
      {
        id: 'adapter-pattern',
        text: 'Adapter lives in app/src/foo.ts',
        dependsOn: ['app/src/foo.ts'],  // agent uses relative path
        addedAtRound: 1,
      },
      {
        id: 'unrelated',
        text: 'Other note',
        dependsOn: ['app/src/bar.ts'],
        addedAtRound: 1,
      },
    ];

    // Harness fires with /workspace/-prefixed path — should still match
    const next = invalidateObservationDependencies(observations, '/workspace/app/src/foo.ts', 5);

    expect(next?.[0]).toEqual({
      id: 'adapter-pattern',
      text: 'Adapter lives in app/src/foo.ts',
      dependsOn: ['app/src/foo.ts'],
      stale: true,
      staleReason: '/workspace/app/src/foo.ts was modified at round 5',
      staleAtRound: 5,
      addedAtRound: 1,
    });
    expect(next?.[1]).toEqual(observations[1]);
  });

  it('formats fresh and stale observations while auto-expiring old stale entries', () => {
    const formatted = formatCoderState({
      plan: 'Check the adapter flow',
      observations: [
        {
          id: 'adapter-pattern',
          text: 'Adapter lives in app/src/foo.ts',
          dependsOn: ['app/src/foo.ts'],
          addedAtRound: 2,
        },
        {
          id: 'stale-note',
          text: 'This needs re-validation',
          stale: true,
          staleReason: 'app/src/foo.ts was modified at round 6',
          staleAtRound: 6,
          addedAtRound: 2,
        },
        {
          id: 'expired-note',
          text: 'Drop this one',
          stale: true,
          staleReason: 'app/src/old.ts was modified at round 1',
          staleAtRound: 1,
          addedAtRound: 0,
        },
      ],
    }, 7);

    expect(formatted).toContain('adapter-pattern: Adapter lives in app/src/foo.ts');
    expect(formatted).toContain('[STALE — app/src/foo.ts was modified at round 6] stale-note: This needs re-validation');
    expect(formatted).not.toContain('expired-note');
  });

  it('includes observations in coder state diffs when they become stale', () => {
    const previous = {
      observations: [
        {
          id: 'adapter-pattern',
          text: 'Adapter lives in app/src/foo.ts',
          dependsOn: ['app/src/foo.ts'],
          addedAtRound: 1,
        },
      ],
    };

    const current = {
      observations: [
        {
          id: 'adapter-pattern',
          text: 'Adapter lives in app/src/foo.ts',
          dependsOn: ['app/src/foo.ts'],
          stale: true,
          staleReason: 'app/src/foo.ts was modified at round 3',
          staleAtRound: 3,
          addedAtRound: 1,
        },
      ],
    };

    const diff = formatCoderStateDiff(current, previous, 3);

    expect(diff).toContain('[STALE — app/src/foo.ts was modified at round 3] adapter-pattern: Adapter lives in app/src/foo.ts');
  });
});
