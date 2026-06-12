// Pins for the resume picker's workspace scoping (cli/tui-fuzzy.ts
// `scopeSessionsToWorkspace`). The TUI resume modal defaults to sessions
// whose cwd matches the active workspace — same contract as the REPL's
// cwd-scoped startup picker — with `a` toggling to all workspaces. The
// scope must be an EXACT path match: prefix matching would conflate
// nested checkouts (~/projects/Push vs ~/projects/Push-fork worktrees).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { scopeSessionsToWorkspace } from '../tui-fuzzy.ts';

const CWD = '/home/user/projects/push';

function session(id, cwd) {
  return { sessionId: id, cwd, provider: 'zen', model: 'm' };
}

describe('scopeSessionsToWorkspace', () => {
  it('keeps only sessions whose cwd exactly matches the workspace', () => {
    const rows = [
      session('here-1', CWD),
      session('elsewhere', '/home/user/projects/other'),
      session('here-2', CWD),
    ];
    assert.deepEqual(
      scopeSessionsToWorkspace(rows, CWD).map((s) => s.sessionId),
      ['here-1', 'here-2'],
    );
  });

  it('does not prefix-match nested or sibling checkouts', () => {
    const rows = [
      session('nested', `${CWD}/packages/app`),
      session('sibling', `${CWD}-fork`),
      session('exact', CWD),
    ];
    assert.deepEqual(
      scopeSessionsToWorkspace(rows, CWD).map((s) => s.sessionId),
      ['exact'],
    );
  });

  it('treats sessions without a cwd as outside every workspace', () => {
    const rows = [session('no-cwd', undefined), session('exact', CWD)];
    assert.deepEqual(
      scopeSessionsToWorkspace(rows, CWD).map((s) => s.sessionId),
      ['exact'],
    );
  });

  it('returns empty (the caller falls back to all) when nothing matches', () => {
    const rows = [session('a', '/somewhere'), session('b', '/elsewhere')];
    assert.deepEqual(scopeSessionsToWorkspace(rows, CWD), []);
  });
});
