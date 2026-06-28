import { describe, expect, it } from 'vitest';
import { decideAutoSwitchAction, type AutoSwitchDecisionInput } from './useChatAutoSwitch';

function makeInput(overrides: Partial<AutoSwitchDecisionInput> = {}): AutoSwitchDecisionInput {
  return {
    sortedChatIds: [],
    activeChatId: '',
    activeRepoFullName: null,
    skipAutoCreate: false,
    migrationActive: false,
    conversationsLoaded: true,
    ...overrides,
  };
}

describe('decideAutoSwitchAction', () => {
  it('returns noop when no repo is selected and no chats exist', () => {
    expect(decideAutoSwitchAction(makeInput())).toEqual({ kind: 'noop' });
  });

  it('returns create when a repo is selected and no chats exist for it', () => {
    const action = decideAutoSwitchAction(makeInput({ activeRepoFullName: 'owner/repo' }));
    expect(action).toEqual({ kind: 'create' });
  });

  it('returns noop while a fork migration is in flight, even when create would otherwise fire', () => {
    const action = decideAutoSwitchAction(
      makeInput({ activeRepoFullName: 'owner/repo', migrationActive: true }),
    );
    expect(action).toEqual({ kind: 'noop' });
  });

  it('returns noop when skipAutoCreate is set even with a repo and no chats', () => {
    const action = decideAutoSwitchAction(
      makeInput({ activeRepoFullName: 'owner/repo', skipAutoCreate: true }),
    );
    expect(action).toEqual({ kind: 'noop' });
  });

  it('returns switch with the first sorted id when active chat is not in the list', () => {
    const action = decideAutoSwitchAction(
      makeInput({
        sortedChatIds: ['chat-newest', 'chat-older'],
        activeChatId: 'chat-stale',
        activeRepoFullName: 'owner/repo',
      }),
    );
    expect(action).toEqual({ kind: 'switch', chatId: 'chat-newest' });
  });

  it('returns noop when active chat is already in the sorted list', () => {
    const action = decideAutoSwitchAction(
      makeInput({
        sortedChatIds: ['chat-a', 'chat-b'],
        activeChatId: 'chat-b',
        activeRepoFullName: 'owner/repo',
      }),
    );
    expect(action).toEqual({ kind: 'noop' });
  });

  it('returns noop when migration is active, even if the active chat is missing from the list', () => {
    // The auto-switch reassignment branch must also be suppressed during a
    // fork migration — both branches share the same gate.
    const action = decideAutoSwitchAction(
      makeInput({
        sortedChatIds: ['chat-newest'],
        activeChatId: 'chat-stale',
        activeRepoFullName: 'owner/repo',
        migrationActive: true,
      }),
    );
    expect(action).toEqual({ kind: 'noop' });
  });

  it('returns noop when skipAutoCreate suppresses the switch branch', () => {
    const action = decideAutoSwitchAction(
      makeInput({
        sortedChatIds: ['chat-newest'],
        activeChatId: 'chat-stale',
        activeRepoFullName: 'owner/repo',
        skipAutoCreate: true,
      }),
    );
    expect(action).toEqual({ kind: 'noop' });
  });

  it('returns noop before IDB hydration even when a repo is selected and the seed looks empty', () => {
    // Regression: a repo session whose history lives only in IDB has an empty
    // localStorage seed, so `sortedChatIds` is empty pre-hydration. Without the
    // gate this mints a throwaway "New Chat" before hydration replaces the map
    // — the restore flash on the main sandbox-backed path (Codex P2 on #1223).
    const action = decideAutoSwitchAction(
      makeInput({ activeRepoFullName: 'owner/repo', conversationsLoaded: false }),
    );
    expect(action).toEqual({ kind: 'noop' });
  });

  it('returns noop before IDB hydration even when the active chat is missing from the seed', () => {
    // The switch branch is suppressed pre-hydration too, so a stale seed
    // cannot churn activeChatId before the real map lands.
    const action = decideAutoSwitchAction(
      makeInput({
        sortedChatIds: ['chat-newest'],
        activeChatId: 'chat-stale',
        activeRepoFullName: 'owner/repo',
        conversationsLoaded: false,
      }),
    );
    expect(action).toEqual({ kind: 'noop' });
  });

  it('creates once hydration completes for a repo with no chats', () => {
    const action = decideAutoSwitchAction(
      makeInput({ activeRepoFullName: 'owner/repo', conversationsLoaded: true }),
    );
    expect(action).toEqual({ kind: 'create' });
  });

  it('does not create when sortedChatIds is empty but no repo is selected', () => {
    // The repo gate is what distinguishes "fresh load on a repo" from
    // "no repo context at all" — without it, leaving a repo would trigger
    // an unrelated chat creation.
    expect(decideAutoSwitchAction(makeInput({ sortedChatIds: [] }))).toEqual({
      kind: 'noop',
    });
  });
});
