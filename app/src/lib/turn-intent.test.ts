import { describe, expect, it } from 'vitest';
import { classifyTurnIntent } from './turn-intent';

describe('classifyTurnIntent', () => {
  it('classifies coding imperatives as task even when phrased as a question', () => {
    for (const text of [
      'fix the failing auth test',
      'add a test for the reviewer schema',
      'implement provider routing prefs',
      'refactor the auditor gate',
      'can you update the openrouter body?',
      'remove the dead code in chat-send',
      'rename responseFormat to schemaFormat',
    ]) {
      expect(classifyTurnIntent(text)).toBe('task');
    }
  });

  it('classifies the reported conversational misfires as conversational', () => {
    // The three messages from the bug report (screenshots).
    expect(classifyTurnIntent('What changed recently in Push?')).toBe('conversational');
    expect(classifyTurnIntent('Could you eli5 what the structured outputs changes?')).toBe(
      'conversational',
    );
    expect(classifyTurnIntent("Just making sure you weren't looping")).toBe('conversational');
  });

  it('classifies questions, meta, and acknowledgements as conversational', () => {
    for (const text of [
      'why did the auditor flag that?',
      'how does the inline lane work',
      'explain the turn policy registry',
      'are you stuck?',
      'what are you doing',
      'stop',
      'never mind',
      'thanks!',
      'hey',
    ]) {
      expect(classifyTurnIntent(text)).toBe('conversational');
    }
  });

  it('treats polite read-only summary/recap requests as conversational (no trailing ?)', () => {
    // Codex P2: these have no coding imperative and no '?', so without the
    // explanatory verbs they would fall through to `task` and re-trigger the
    // very guard this routing avoids.
    for (const text of [
      'can you summarize the diff',
      'could you summarize the latest changes',
      'please summarize the diff',
      'recap what you did',
      'describe the change for me',
      'go over the reviewer wiring',
    ]) {
      expect(classifyTurnIntent(text)).toBe('conversational');
    }
  });

  it('treats read-only review phrasing as conversational instead of Coder-task work', () => {
    for (const text of [
      'take a look at the diff',
      'look over this PR',
      'review PR 945',
      'please inspect the pull request changes',
      'check out the latest change',
    ]) {
      expect(classifyTurnIntent(text)).toBe('conversational');
    }
  });

  it('keeps review phrasing task-shaped when it chains into a mutation', () => {
    expect(classifyTurnIntent('review the PR and fix the failing test')).toBe('task');
    expect(classifyTurnIntent('look over the diff then address the comments')).toBe('task');
  });

  it('treats response-only and read-only imperatives as conversational', () => {
    for (const text of [
      'say hello',
      'return the result',
      'answer with JSON',
      'read target.txt',
      'please report the current status',
    ]) {
      expect(classifyTurnIntent(text)).toBe('conversational');
    }
    expect(classifyTurnIntent('read target.txt and update the parser')).toBe('task');
  });

  it('treats advice-seeking framing as conversational despite a coding keyword', () => {
    expect(classifyTurnIntent('should I refactor this?')).toBe('conversational');
    expect(classifyTurnIntent('do you think we should add a cache here?')).toBe('conversational');
  });

  it('defaults empty / whitespace input to task (attachment-only turns stay inline)', () => {
    expect(classifyTurnIntent('')).toBe('task');
    expect(classifyTurnIntent('   ')).toBe('task');
  });

  it('defaults ambiguous non-question statements to task (preserves inline behavior)', () => {
    expect(classifyTurnIntent('the openrouter adapter')).toBe('task');
    expect(classifyTurnIntent('lets keep going with phase 2')).toBe('task');
  });
});
