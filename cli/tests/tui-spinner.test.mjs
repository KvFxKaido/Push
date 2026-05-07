import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectSpinnerName,
  isSpinnerName,
  MOOD_VERBS,
  moodVerb,
  SPINNER_NAMES,
  SPINNERS,
  spinnerFrame,
  VERB_BY_TOOL,
  verbForActivity,
} from '../tui-spinner.ts';

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

// ─── SPINNERS registry ──────────────────────────────────────────

describe('SPINNERS registry', () => {
  it('contains the expected set of spinners', () => {
    assert.deepEqual([...SPINNER_NAMES].sort(), [
      'braille',
      'breathe',
      'helix',
      'off',
      'orbit',
      'pulse',
    ]);
  });

  it('every non-off variant has a non-empty, single-cell Braille frame array', () => {
    for (const name of SPINNER_NAMES) {
      if (name === 'off') continue;
      const variant = SPINNERS[name];
      assert.ok(variant, `missing variant: ${name}`);
      assert.ok(
        Array.isArray(variant.frames) && variant.frames.length > 0,
        `${name} needs at least one frame`,
      );
      for (const frame of variant.frames) {
        assert.equal(typeof frame, 'string', `${name} frame must be a string`);
        // All prototype frames are Braille (U+2800–U+28FF) or the Braille
        // blank (U+2800). Keep the set legible at a 1-cell status dot.
        for (const ch of frame) {
          const code = ch.codePointAt(0);
          assert.ok(
            code >= 0x2800 && code <= 0x28ff,
            `${name} contains non-Braille codepoint U+${code.toString(16)}`,
          );
        }
      }
    }
  });

  it('every variant has a label + description', () => {
    for (const name of SPINNER_NAMES) {
      const v = SPINNERS[name];
      assert.ok(typeof v.label === 'string' && v.label.length > 0);
      assert.ok(typeof v.description === 'string' && v.description.length > 0);
    }
  });
});

// ─── isSpinnerName ──────────────────────────────────────────────

describe('isSpinnerName', () => {
  it('accepts every registered spinner name', () => {
    for (const name of SPINNER_NAMES) {
      assert.equal(isSpinnerName(name), true);
    }
  });
  it('rejects unknown strings and non-strings', () => {
    for (const bad of ['rain', '', null, undefined, 42, {}]) {
      assert.equal(isSpinnerName(bad), false);
    }
  });
  it('rejects Object.prototype keys (does not use `in`)', () => {
    for (const key of ['constructor', 'toString', 'hasOwnProperty', '__proto__', 'valueOf']) {
      assert.equal(isSpinnerName(key), false, `must reject prototype key: ${key}`);
    }
  });
});

// ─── spinnerFrame ───────────────────────────────────────────────

describe('spinnerFrame', () => {
  it('returns null for off', () => {
    assert.equal(spinnerFrame('off', 0), null);
    assert.equal(spinnerFrame('off', 999), null);
  });

  it('wraps tick by frames.length', () => {
    for (const name of SPINNER_NAMES) {
      if (name === 'off') continue;
      const frames = SPINNERS[name].frames;
      for (let tick = 0; tick < frames.length * 3; tick++) {
        assert.equal(spinnerFrame(name, tick), frames[tick % frames.length]);
      }
    }
  });

  it('is pure — same inputs produce same output', () => {
    for (const name of ['braille', 'orbit', 'pulse', 'breathe', 'helix']) {
      assert.equal(spinnerFrame(name, 7), spinnerFrame(name, 7));
    }
  });

  it('handles large ticks without overflow glitches', () => {
    for (const name of ['braille', 'orbit', 'pulse', 'breathe', 'helix']) {
      const frames = SPINNERS[name].frames;
      const huge = 1_000_000 + 3;
      assert.equal(spinnerFrame(name, huge), frames[huge % frames.length]);
    }
  });
});

// ─── detectSpinnerName ──────────────────────────────────────────

describe('detectSpinnerName', () => {
  it('returns null when PUSH_SPINNER unset and reduced-motion off', () => {
    withEnv(
      { PUSH_SPINNER: undefined, PUSH_REDUCED_MOTION: undefined, REDUCED_MOTION: undefined },
      () => {
        assert.equal(detectSpinnerName(), null);
      },
    );
  });

  it('returns the named spinner from PUSH_SPINNER', () => {
    withEnv(
      { PUSH_SPINNER: 'braille', PUSH_REDUCED_MOTION: undefined, REDUCED_MOTION: undefined },
      () => {
        assert.equal(detectSpinnerName(), 'braille');
      },
    );
  });

  it('is case-insensitive and tolerates whitespace', () => {
    withEnv(
      { PUSH_SPINNER: '  ORBIT  ', PUSH_REDUCED_MOTION: undefined, REDUCED_MOTION: undefined },
      () => {
        assert.equal(detectSpinnerName(), 'orbit');
      },
    );
  });

  it('returns null for unknown values', () => {
    withEnv(
      { PUSH_SPINNER: 'sparkle', PUSH_REDUCED_MOTION: undefined, REDUCED_MOTION: undefined },
      () => {
        assert.equal(detectSpinnerName(), null);
      },
    );
  });

  it('reduced-motion forces off regardless of PUSH_SPINNER', () => {
    withEnv({ PUSH_SPINNER: 'helix', PUSH_REDUCED_MOTION: '1', REDUCED_MOTION: undefined }, () => {
      assert.equal(detectSpinnerName(), 'off');
    });
  });
});

// ─── verbForActivity ───────────────────────────────────────────

describe('verbForActivity', () => {
  it('returns null when activity is null', () => {
    assert.equal(verbForActivity(null), null);
  });

  it('maps thinking and streaming to fixed verbs', () => {
    assert.equal(verbForActivity({ kind: 'thinking' }), 'thinking');
    assert.equal(verbForActivity({ kind: 'streaming' }), 'replying');
  });

  it('maps known tool names via VERB_BY_TOOL', () => {
    assert.equal(verbForActivity({ kind: 'tool', toolName: 'read_file' }), 'reading');
    assert.equal(verbForActivity({ kind: 'tool', toolName: 'edit_file' }), 'editing');
    assert.equal(verbForActivity({ kind: 'tool', toolName: 'git_commit' }), 'committing');
    assert.equal(verbForActivity({ kind: 'tool', toolName: 'delegate_coder' }), 'coding');
    assert.equal(verbForActivity({ kind: 'tool', toolName: 'delegate_explorer' }), 'exploring');
    assert.equal(verbForActivity({ kind: 'tool', toolName: 'sandbox_exec' }), 'running');
  });

  it('falls back to "working" for unknown tool names', () => {
    assert.equal(verbForActivity({ kind: 'tool', toolName: 'unheard_of_tool' }), 'working');
  });

  it('keeps verbs short enough to fit a narrow header (<=10 chars)', () => {
    const verbs = [
      verbForActivity({ kind: 'thinking' }),
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
      'sandbox_prepare_commit',
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
