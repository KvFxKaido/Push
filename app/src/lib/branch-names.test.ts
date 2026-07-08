import { describe, expect, it } from 'vitest';
import { deriveBranchNameFromPrompt, deriveBranchNameFromPromptSuggestion } from './branch-names';

describe('deriveBranchNameFromPrompt', () => {
  it('namespaces a slug of the first line under the prefix', () => {
    expect(deriveBranchNameFromPrompt('Add a dark mode toggle', 'push')).toBe(
      'push/add-a-dark-mode-toggle',
    );
  });

  it('caps the slug at 8 words', () => {
    expect(
      deriveBranchNameFromPrompt('one two three four five six seven eight nine ten', 'work'),
    ).toBe('work/one-two-three-four-five-six-seven-eight');
  });

  it('uses only the first non-empty line and unwraps code fences', () => {
    expect(deriveBranchNameFromPrompt('```\nfix the crash\n```', 'push')).toBe(
      'push/fix-the-crash',
    );
  });

  it('strips characters that are invalid in a branch name', () => {
    expect(deriveBranchNameFromPrompt('Fix the bug!! (urgent)', 'push')).toBe(
      'push/fix-the-bug-urgent',
    );
  });

  it('falls back to "session" for an empty prompt', () => {
    expect(deriveBranchNameFromPrompt('   ', 'push')).toBe('push/session');
  });

  it('bounds the slug to 48 chars with no trailing hyphen', () => {
    const name = deriveBranchNameFromPrompt(
      'supercalifragilisticexpialidocious antidisestablishmentarianism pneumonoultramicroscopic',
      'push',
    );
    const slug = name.slice('push/'.length);
    expect(slug.length).toBeLessThanOrEqual(48);
    expect(slug.endsWith('-')).toBe(false);
  });
});

describe('deriveBranchNameFromPromptSuggestion', () => {
  it('forces the repo prefix even when the worker returns only a topic', () => {
    expect(deriveBranchNameFromPromptSuggestion('stop-draft-branches', 'owner-repo')).toBe(
      'owner-repo/stop-draft-branches',
    );
  });

  it('strips labels, refs, quotes, and a repeated prefix', () => {
    expect(
      deriveBranchNameFromPromptSuggestion(
        'Branch name: "refs/heads/owner-repo/native-gates"',
        'owner-repo',
      ),
    ).toBe('owner-repo/native-gates');
  });

  it('does not accept a different namespace from the worker', () => {
    expect(deriveBranchNameFromPromptSuggestion('feature/native-push-gates', 'owner-repo')).toBe(
      'owner-repo/native-push-gates',
    );
  });

  it('bounds verbose worker output with no trailing hyphen', () => {
    const name = deriveBranchNameFromPromptSuggestion(
      'one two three four five six seven eight nine ten eleven twelve',
      'push',
    );
    expect(name).toBe('push/one-two-three-four-five-six-seven-eight');
  });
});
