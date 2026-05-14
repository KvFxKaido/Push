import { describe, expect, it } from 'vitest';
import {
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
