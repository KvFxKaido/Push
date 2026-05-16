import { describe, expect, it } from 'vitest';
import {
  deriveCurrentWorkingGoal,
  deriveUserGoalAnchor,
  formatUserGoalBlock,
  formatUserGoalMarkdown,
  parseUserGoalMarkdown,
  USER_GOAL_HEADER,
  USER_GOAL_FOOTER,
  USER_GOAL_MAX_INITIAL_ASK_CHARS,
  type UserGoalAnchor,
} from './user-goal-anchor';

// ---------------------------------------------------------------------------
// deriveUserGoalAnchor — input handling
// ---------------------------------------------------------------------------

describe('deriveUserGoalAnchor', () => {
  it('returns null when the seed is missing', () => {
    expect(deriveUserGoalAnchor({})).toBeNull();
    expect(deriveUserGoalAnchor({ firstUserTurn: null })).toBeNull();
    expect(deriveUserGoalAnchor({ firstUserTurn: undefined })).toBeNull();
  });

  it('returns null when the seed is whitespace only', () => {
    expect(deriveUserGoalAnchor({ firstUserTurn: '   ' })).toBeNull();
    expect(deriveUserGoalAnchor({ firstUserTurn: '\n\t\n' })).toBeNull();
  });

  it('keeps short seeds verbatim', () => {
    const anchor = deriveUserGoalAnchor({ firstUserTurn: '  help with X  ' });
    expect(anchor).toEqual({ initialAsk: 'help with X' });
  });

  it('truncates seeds longer than the cap with an ellipsis', () => {
    const long = 'x'.repeat(USER_GOAL_MAX_INITIAL_ASK_CHARS + 50);
    const anchor = deriveUserGoalAnchor({ firstUserTurn: long });
    expect(anchor?.initialAsk).toHaveLength(USER_GOAL_MAX_INITIAL_ASK_CHARS);
    expect(anchor?.initialAsk.endsWith('...')).toBe(true);
  });

  it('formats a branch label when both repo and name are provided', () => {
    const anchor = deriveUserGoalAnchor({
      firstUserTurn: 'ship the anchor feature',
      branch: { repoFullName: 'KvFxKaido/Push', name: 'feat/user-goal-anchor' },
    });
    expect(anchor).toEqual({
      initialAsk: 'ship the anchor feature',
      branchLabel: 'KvFxKaido/Push@feat/user-goal-anchor',
    });
  });

  it('falls back to whichever branch field is present', () => {
    expect(
      deriveUserGoalAnchor({
        firstUserTurn: 'x',
        branch: { name: 'main' },
      }),
    ).toEqual({ initialAsk: 'x', branchLabel: 'main' });

    expect(
      deriveUserGoalAnchor({
        firstUserTurn: 'x',
        branch: { repoFullName: 'a/b', name: '' },
      }),
    ).toEqual({ initialAsk: 'x', branchLabel: 'a/b' });
  });

  it('omits the branch label when both branch fields are missing', () => {
    const anchor = deriveUserGoalAnchor({
      firstUserTurn: 'x',
      branch: { repoFullName: '', name: null },
    });
    expect(anchor).toEqual({ initialAsk: 'x' });
  });
});

// ---------------------------------------------------------------------------
// deriveCurrentWorkingGoal + redirect detection
//
// Reduces the over-pinning of the original first-user-turn: when the user
// has clearly redirected mid-conversation, the latest matching turn lands
// in `currentWorkingGoal` so the rendered anchor reflects where the chat
// actually is. Detection is conservative — false negatives leave the goal
// stale, false positives shift it away from the seed, and we prefer the
// former.
// ---------------------------------------------------------------------------

describe('deriveCurrentWorkingGoal — redirect detection', () => {
  it('returns null when there are no recent turns', () => {
    expect(deriveCurrentWorkingGoal([], 'seed')).toBeNull();
  });

  it('returns null when no recent turn looks like a redirect', () => {
    const turns = ['seed', 'ok lets go', 'looks good', 'yes', 'what about Y?'];
    expect(deriveCurrentWorkingGoal(turns, 'seed')).toBeNull();
  });

  it('skips the seed turn even when it contains a redirect phrase', () => {
    // The seed is the initialAsk slot; it should never double-populate the
    // working goal. Only later turns count as redirects.
    const turns = ['actually, lets do X', 'ok', 'sounds good'];
    expect(deriveCurrentWorkingGoal(turns, 'actually, lets do X')).toBeNull();
  });

  it('picks the most recent redirect when multiple are present', () => {
    const turns = ['help with X', 'actually, lets focus on Y instead', 'ok', 'wait, pivot to Z'];
    expect(deriveCurrentWorkingGoal(turns, 'help with X')).toBe('wait, pivot to Z');
  });

  it('ignores redirects older than the scan window', () => {
    // Scan window is 6 turns from the tail. A redirect at position 0 of a
    // 10-turn list should not be returned.
    const turns = [
      'help with X',
      'actually, lets do Y',
      ...Array.from({ length: 8 }, (_, i) => `follow-up ${i}`),
    ];
    expect(deriveCurrentWorkingGoal(turns, 'help with X')).toBeNull();
  });

  it('truncates an overlong redirect to the same cap as initialAsk', () => {
    const long = `actually, ${'x'.repeat(USER_GOAL_MAX_INITIAL_ASK_CHARS + 100)}`;
    const result = deriveCurrentWorkingGoal(['seed', long], 'seed');
    expect(result).not.toBeNull();
    expect(result?.length).toBe(USER_GOAL_MAX_INITIAL_ASK_CHARS);
    expect(result?.endsWith('...')).toBe(true);
  });

  it('detects the canonical redirect phrasings', () => {
    const cases: ReadonlyArray<string> = [
      'Actually, lets do X instead',
      'instead, focus on Y',
      'Wait, I think we should pivot',
      "let's reset",
      'let me reset',
      'forget that, focus on Z',
      'scrap that idea',
      'nevermind, switch to Y',
      'Hold on, the actual goal is X',
      'hold up — wrong file',
      'hang on a sec',
      'change of plans',
      'switch focus to the auditor',
      'switch to Y',
      'we should pivot here',
      'on second thought, lets do Y',
      'we were supposed to be doing a doc sweep',
      'we should be doing the audit',
      'we got off-track',
      'we got pulled off the doc sweep',
      'uh oh, context problem',
      "let's pivot to the audit",
    ];
    for (const turn of cases) {
      expect(deriveCurrentWorkingGoal(['seed', turn], 'seed')).toBe(turn);
    }
  });

  it('does not false-positive on common affirmations or short replies', () => {
    const cases: ReadonlyArray<string> = [
      'yes',
      "yeah let's do it",
      'ok',
      'sure go ahead',
      'sounds good',
      'continue',
      'thanks',
      'good',
      'what do you think we should tackle next?',
      'what about Y instead of X?', // contains "instead" mid-phrase only
    ];
    for (const turn of cases) {
      expect(
        deriveCurrentWorkingGoal(['seed', turn], 'seed'),
        `should not flag: ${turn}`,
      ).toBeNull();
    }
  });
});

describe('deriveUserGoalAnchor — recentUserTurns wiring', () => {
  it('populates currentWorkingGoal from a recent redirect', () => {
    const anchor = deriveUserGoalAnchor({
      firstUserTurn: 'help with the TS7 question',
      recentUserTurns: [
        'help with the TS7 question',
        'what should we tackle next?',
        'uh oh, we got pulled off-track. We were supposed to be doing a doc sweep.',
      ],
    });
    expect(anchor?.initialAsk).toBe('help with the TS7 question');
    expect(anchor?.currentWorkingGoal).toBe(
      'uh oh, we got pulled off-track. We were supposed to be doing a doc sweep.',
    );
  });

  it('leaves currentWorkingGoal unset when no redirect is present', () => {
    const anchor = deriveUserGoalAnchor({
      firstUserTurn: 'help with X',
      recentUserTurns: ['help with X', 'thanks', 'ok continue'],
    });
    expect(anchor).toEqual({ initialAsk: 'help with X' });
  });

  it('preserves v1 behaviour when recentUserTurns is omitted', () => {
    const anchor = deriveUserGoalAnchor({ firstUserTurn: 'ship X' });
    expect(anchor).toEqual({ initialAsk: 'ship X' });
  });
});

// ---------------------------------------------------------------------------
// formatUserGoalBlock — format pin (drift detector)
//
// The exact text shape is part of the wire vocabulary the model reads. v2
// fields slot in AFTER `Initial ask:` and `Branch:` so existing transcripts'
// anchors remain a prefix of the v2 anchor (cache stability). Update these
// snapshots when fields are added — that's the load-bearing review step.
// ---------------------------------------------------------------------------

describe('formatUserGoalBlock — v1 format pin', () => {
  it('emits header, initial ask, footer when only the seed is set', () => {
    const block = formatUserGoalBlock({ initialAsk: 'fix the sandbox restart bug' });
    expect(block).toBe(
      ['[USER_GOAL]', 'Initial ask: fix the sandbox restart bug', '[/USER_GOAL]'].join('\n'),
    );
  });

  it('emits the branch line second, before the footer, when present', () => {
    const block = formatUserGoalBlock({
      initialAsk: 'fix the sandbox restart bug',
      branchLabel: 'KvFxKaido/Push@feat/anchor',
    });
    expect(block).toBe(
      [
        '[USER_GOAL]',
        'Initial ask: fix the sandbox restart bug',
        'Branch: KvFxKaido/Push@feat/anchor',
        '[/USER_GOAL]',
      ].join('\n'),
    );
  });

  it('uses the public header/footer constants verbatim', () => {
    const block = formatUserGoalBlock({ initialAsk: 'x' });
    expect(block.startsWith(`${USER_GOAL_HEADER}\n`)).toBe(true);
    expect(block.endsWith(`\n${USER_GOAL_FOOTER}`)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// formatUserGoalBlock — v2 format pin (drift detector)
//
// v2 fields slot in after v1's `Initial ask:` + `Branch:`. A v1 transcript's
// anchor remains a prefix of the v2 anchor so prompt-cache prefixes stay
// stable when a conversation upgrades. Update these snapshots when fields
// are added — that's the load-bearing review step.
// ---------------------------------------------------------------------------

describe('formatUserGoalBlock — v2 format pin', () => {
  it('emits all v2 fields in the canonical order', () => {
    const block = formatUserGoalBlock({
      initialAsk: 'ship the anchor feature',
      branchLabel: 'KvFxKaido/Push@feat/anchor',
      currentWorkingGoal: 'wire goal.md round-trip + CLI auto-seed',
      constraints: ['preserve prompt cache prefix', 'no LLM call on auto-seed'],
      doNot: ['overwrite an existing goal.md'],
      lastRefreshedAt: '2026-05-14T11:45:00Z',
    });
    expect(block).toBe(
      [
        '[USER_GOAL]',
        'Initial ask: ship the anchor feature',
        'Branch: KvFxKaido/Push@feat/anchor',
        'Current working goal: wire goal.md round-trip + CLI auto-seed',
        'Constraints: preserve prompt cache prefix; no LLM call on auto-seed',
        'Do not: overwrite an existing goal.md',
        'Last refreshed: 2026-05-14T11:45:00Z',
        '[/USER_GOAL]',
      ].join('\n'),
    );
  });

  it('omits empty v2 fields so partial anchors stay clean', () => {
    const block = formatUserGoalBlock({
      initialAsk: 'x',
      currentWorkingGoal: 'y',
      constraints: [],
      doNot: undefined,
    });
    expect(block).toBe(
      ['[USER_GOAL]', 'Initial ask: x', 'Current working goal: y', '[/USER_GOAL]'].join('\n'),
    );
  });

  it('keeps a v1 anchor as a strict prefix of the v2-extended anchor', () => {
    const v1: UserGoalAnchor = { initialAsk: 'ship X' };
    const v2: UserGoalAnchor = {
      initialAsk: 'ship X',
      currentWorkingGoal: 'narrow to the file store',
      lastRefreshedAt: '2026-05-14T11:45:00Z',
    };
    const v1Block = formatUserGoalBlock(v1);
    const v2Block = formatUserGoalBlock(v2);
    // Drop the footer line from v1 so the prefix check compares the body.
    const v1Body = v1Block.split('\n').slice(0, -1).join('\n');
    expect(v2Block.startsWith(v1Body + '\n')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// goal.md — markdown serialize + parse round-trip
// ---------------------------------------------------------------------------

describe('formatUserGoalMarkdown / parseUserGoalMarkdown', () => {
  const canonical: UserGoalAnchor = {
    initialAsk: 'ship the anchor feature',
    currentWorkingGoal: 'wire goal.md + auto-seed',
    constraints: ['preserve cache prefix', 'no LLM call on auto-seed'],
    doNot: ['overwrite existing goal.md'],
    lastRefreshedAt: '2026-05-14T11:45:00Z',
  };

  it('emits a stable canonical markdown shape', () => {
    expect(formatUserGoalMarkdown(canonical)).toMatchInlineSnapshot(`
      "# Goal

      ## Initial ask

      ship the anchor feature

      ## Current working goal

      wire goal.md + auto-seed

      ## Constraints

      - preserve cache prefix
      - no LLM call on auto-seed

      ## Do not

      - overwrite existing goal.md

      ## Last refreshed

      2026-05-14T11:45:00Z
      "
    `);
  });

  it('round-trips canonical content (format → parse → equal)', () => {
    const md = formatUserGoalMarkdown(canonical);
    const parsed = parseUserGoalMarkdown(md);
    expect(parsed).toEqual(canonical);
  });

  it('parses a minimal file with only Initial ask', () => {
    const parsed = parseUserGoalMarkdown(`# Goal\n\n## Initial ask\n\nhelp with X\n`);
    expect(parsed).toEqual({ initialAsk: 'help with X' });
  });

  it('returns null when Initial ask is missing', () => {
    expect(parseUserGoalMarkdown('# Goal\n\n## Current working goal\n\nfoo\n')).toBeNull();
    expect(parseUserGoalMarkdown('')).toBeNull();
    expect(parseUserGoalMarkdown('not even markdown')).toBeNull();
  });

  it('returns null when Initial ask is present but whitespace-only', () => {
    // Copilot review on PR #549: without trim-before-null-check the parser
    // returned `{ initialAsk: '' }`, blocking the v1 runtime fallback and
    // emitting an empty `[USER_GOAL]` block. Trim first, null on empty.
    expect(parseUserGoalMarkdown('# Goal\n\n## Initial ask\n\n   \n\n')).toBeNull();
    expect(parseUserGoalMarkdown('# Goal\n\n## Initial ask\n\n')).toBeNull();
    expect(parseUserGoalMarkdown('# Goal\n\n## Initial ask\n\n\t\n')).toBeNull();
  });

  it('caps parsed initialAsk at the same budget as runtime derivation', () => {
    // Codex review on PR #549: an uncapped value in goal.md was bypassing
    // the 500-char cap when re-read on subsequent rounds.
    const long = 'x'.repeat(2000);
    const md = `# Goal\n\n## Initial ask\n\n${long}\n`;
    const parsed = parseUserGoalMarkdown(md);
    expect(parsed?.initialAsk).toHaveLength(USER_GOAL_MAX_INITIAL_ASK_CHARS);
    expect(parsed?.initialAsk.endsWith('...')).toBe(true);
  });

  it('handles CRLF line endings (cross-platform editors)', () => {
    const md = '# Goal\r\n\r\n## Initial ask\r\n\r\nhelp with X\r\n';
    expect(parseUserGoalMarkdown(md)).toEqual({ initialAsk: 'help with X' });
  });

  it('accepts both `-` and `*` bullet markers', () => {
    const md = `# Goal

## Initial ask

x

## Constraints

- dash bullet
* star bullet
  - indented dash
`;
    const parsed = parseUserGoalMarkdown(md);
    expect(parsed?.constraints).toEqual(['dash bullet', 'star bullet', 'indented dash']);
  });

  it('drops empty bullet lists rather than emitting an empty array', () => {
    const md = `# Goal

## Initial ask

x

## Constraints

## Do not

`;
    const parsed = parseUserGoalMarkdown(md);
    expect(parsed?.constraints).toBeUndefined();
    expect(parsed?.doNot).toBeUndefined();
  });

  it('ignores unknown sections without failing', () => {
    const md = `# Goal

## Initial ask

x

## Some other section the user wrote

free-form notes
`;
    const parsed = parseUserGoalMarkdown(md);
    expect(parsed).toEqual({ initialAsk: 'x' });
  });
});
