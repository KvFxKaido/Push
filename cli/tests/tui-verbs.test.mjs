/**
 * tui-verbs.test.mjs — the status-verb vocabulary.
 *
 * The spinner-registry / spinnerFrame / detectSpinnerName / motion-switch
 * blocks that used to sit here went with the code they covered: nothing had
 * painted a spinner frame since the Silvery migration, and these tests passing
 * is precisely why that went unnoticed for as long as it did. What remains
 * covers the part the header actually renders.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  isReducedMotion,
  MOOD_VERBS,
  moodVerb,
  VERB_BY_TOOL,
  verbForActivity,
} from '../tui-verbs.ts';

function withEnv(vars, fn) {
  const prev = {};
  for (const k of Object.keys(vars)) prev[k] = process.env[k];
  try {
    for (const [k, v] of Object.entries(vars)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    return fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

describe('verbForActivity', () => {
  it('returns null when activity is null', () => {
    assert.equal(verbForActivity(null), null);
  });

  it('maps streaming to a fixed verb', () => {
    assert.equal(verbForActivity({ kind: 'streaming' }), 'replying');
  });

  it('renders the quiet state as a seeded mood verb, not the literal "thinking"', () => {
    // The reasoning modal now consumes reasoning-token events, but this header
    // state remains deliberately broader: it also covers "running, nothing
    // observable yet" for non-reasoning models. A mood verb is the honest
    // label for that shared state; Ctrl+G carries the precise reasoning fact.
    const verb = verbForActivity({ kind: 'thinking' }, 'sess_abc123');
    assert.ok(MOOD_VERBS.includes(verb), `expected a mood verb, got: ${verb}`);
    assert.notEqual(verb, 'thinking');
  });

  it('keeps the quiet verb stable for a session (the header repaints ~7x/s)', () => {
    // Not cosmetic: the shimmer sweep repaints this row every tick. A verb that
    // re-rolled per frame would strobe.
    const first = verbForActivity({ kind: 'thinking' }, 'sess_stable');
    for (let i = 0; i < 20; i += 1) {
      assert.equal(verbForActivity({ kind: 'thinking' }, 'sess_stable'), first);
    }
  });

  it('maps known tool names via VERB_BY_TOOL', () => {
    assert.equal(verbForActivity({ kind: 'tool', toolName: 'read_file' }), 'reading');
    assert.equal(verbForActivity({ kind: 'tool', toolName: 'edit_file' }), 'editing');
    assert.equal(verbForActivity({ kind: 'tool', toolName: 'git_commit' }), 'committing');
    // Delegation verbs derive from the shared display seam (lib/role-display.ts):
    // coder → "Editing" → 'editing', explorer → "Exploring" → 'exploring'.
    assert.equal(verbForActivity({ kind: 'tool', toolName: 'delegate_coder' }), 'editing');
    assert.equal(verbForActivity({ kind: 'tool', toolName: 'delegate_explorer' }), 'exploring');
    assert.equal(verbForActivity({ kind: 'tool', toolName: 'sandbox_exec' }), 'running');
  });

  it('falls back to "working" for unknown tool names', () => {
    assert.equal(verbForActivity({ kind: 'tool', toolName: 'unheard_of_tool' }), 'working');
  });

  it('keeps verbs short enough to fit a narrow header (<=10 chars)', () => {
    const verbs = [
      ...MOOD_VERBS,
      verbForActivity({ kind: 'streaming' }),
      ...Object.values(VERB_BY_TOOL),
      'working',
    ];
    for (const v of verbs) {
      assert.ok(typeof v === 'string' && v.length > 0 && v.length <= 10, `verb too long: ${v}`);
    }
  });

  it('VERB_BY_TOOL covers the canonical tool vocabulary', () => {
    // Spot-check the broad categories so we notice if a category drops
    // out of the map. This is not exhaustive (new tools are expected to
    // land via the 'working' fallback until they're explicitly mapped).
    for (const k of [
      // CLI-local handlers
      'read_file',
      'list_dir',
      'search_files',
      'web_search',
      'fetch_url',
      'write_file',
      'edit_file',
      'exec',
      'git_commit',
      'git_create_branch',
      // Canonical names from lib/tool-registry.ts
      'sandbox_read_file',
      'sandbox_write_file',
      'sandbox_edit_file',
      'sandbox_exec',
      'sandbox_run_tests',
      'sandbox_check_types',
      'sandbox_commit',
      'sandbox_create_branch',
      'sandbox_switch_branch',
      'plan_tasks',
      'todo_write',
      'create_pr',
      'merge_pr',
      // Delegation
      'delegate_coder',
      'delegate_explorer',
      'delegate_reviewer',
      'delegate_auditor',
    ]) {
      assert.ok(VERB_BY_TOOL[k], `missing canonical tool: ${k}`);
    }
  });
});

describe('moodVerb', () => {
  it('returns the same verb for the same seed (deterministic)', () => {
    const a = moodVerb('sess_abc123');
    const b = moodVerb('sess_abc123');
    assert.equal(a, b);
  });

  it('distributes different seeds across the pool', () => {
    // Sample a handful of seeds; we don't promise uniformity, just that
    // we don't always return the same verb.
    const seeds = ['sess_a', 'sess_b', 'sess_c', 'sess_d', 'sess_e', 'sess_f'];
    const verbs = new Set(seeds.map(moodVerb));
    assert.ok(verbs.size >= 2, `expected variety across seeds, got: ${[...verbs].join(',')}`);
  });

  it('returns the first pool entry for missing/empty seeds', () => {
    assert.equal(moodVerb(''), MOOD_VERBS[0]);
    assert.equal(moodVerb(null), MOOD_VERBS[0]);
    assert.equal(moodVerb(undefined), MOOD_VERBS[0]);
  });

  it('returned verb is always a member of the pool', () => {
    for (const seed of ['x', 'y', 'long-session-id-12345']) {
      assert.ok(MOOD_VERBS.includes(moodVerb(seed)), `unexpected verb for ${seed}`);
    }
  });

  it('pool entries fit the narrow header width (≤8 chars)', () => {
    for (const v of MOOD_VERBS) {
      assert.ok(v.length > 0 && v.length <= 8, `mood verb out of bounds: ${v}`);
    }
  });
});

describe('isReducedMotion', () => {
  // Untested before this file was rewritten, despite gating every animation in
  // the TUI — it rode in on the spinner module and the spinner tests covered
  // the frames, not the guard.
  it('is off when unset', () => {
    withEnv({ PUSH_REDUCED_MOTION: undefined, REDUCED_MOTION: undefined }, () => {
      assert.equal(isReducedMotion(), false);
    });
  });

  it('honors either env name', () => {
    withEnv({ PUSH_REDUCED_MOTION: '1', REDUCED_MOTION: undefined }, () => {
      assert.equal(isReducedMotion(), true);
    });
    withEnv({ PUSH_REDUCED_MOTION: undefined, REDUCED_MOTION: '1' }, () => {
      assert.equal(isReducedMotion(), true);
    });
  });

  it('treats explicit falsey values as off, not as "set therefore on"', () => {
    for (const value of ['', '0', 'false', 'no', 'FALSE', ' No ']) {
      withEnv({ PUSH_REDUCED_MOTION: value, REDUCED_MOTION: undefined }, () => {
        assert.equal(isReducedMotion(), false, `expected off for ${JSON.stringify(value)}`);
      });
    }
  });
});
