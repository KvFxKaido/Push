// Drift test for the user-facing role display vocabulary.
//
// `lib/role-display.ts` is the single source of truth for human-visible role
// phrasing (CLAUDE.md "one source of truth per vocabulary"). This pins the
// table so a change to what users read is a deliberate, reviewed edit — not an
// accidental side effect of touching a runtime role. Internal role strings
// (the `AgentRole` enum, capability tables, event payloads) are intentionally
// NOT pinned here; they live with the runtime contract.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  ROLE_DISPLAY,
  getRoleDisplay,
  getRoleLabel,
  getSourceLabel,
  getSubagentDisplay,
  getSubagentLabel,
} from '../../lib/role-display.ts';

describe('role-display vocabulary map', () => {
  it('pins the user-facing display for every role', () => {
    assert.deepEqual(ROLE_DISPLAY, {
      orchestrator: { phase: null, name: null, showActorName: false },
      explorer: { phase: 'Exploring', name: null, showActorName: false },
      coder: { phase: 'Editing', name: null, showActorName: false },
      reviewer: { phase: 'Reviewing', name: 'Reviewer', showActorName: true },
      auditor: { phase: 'Verifying', name: 'Auditor', showActorName: true },
    });
  });

  it('reads Explorer and Coder as phases, not named actors', () => {
    assert.equal(getRoleDisplay('explorer').phase, 'Exploring');
    assert.equal(getRoleDisplay('explorer').showActorName, false);
    assert.equal(getRoleDisplay('coder').phase, 'Editing');
    assert.equal(getRoleDisplay('coder').showActorName, false);
  });

  it('keeps Reviewer and Auditor names for trust', () => {
    assert.equal(getRoleDisplay('reviewer').name, 'Reviewer');
    assert.equal(getRoleDisplay('reviewer').showActorName, true);
    assert.equal(getRoleDisplay('auditor').name, 'Auditor');
    assert.equal(getRoleDisplay('auditor').showActorName, true);
  });

  it('gives the Orchestrator no user-visible phase or name', () => {
    assert.deepEqual(getRoleDisplay('orchestrator'), {
      phase: null,
      name: null,
      showActorName: false,
    });
  });

  it('falls back to neutral phase language for unknown/missing roles', () => {
    assert.deepEqual(getRoleDisplay('totally-unknown'), {
      phase: 'Working',
      name: null,
      showActorName: false,
    });
    assert.equal(getRoleDisplay(undefined).phase, 'Working');
    assert.equal(getRoleDisplay(null).name, null);
  });

  it('exposes the Background Coder label only through the background context', () => {
    const bg = getRoleDisplay('coder', { background: true });
    assert.equal(bg.name, 'Background Coder');
    assert.equal(bg.showActorName, true);
    // Phase is preserved; background is a presentation context, not a role.
    assert.equal(bg.phase, 'Editing');
    // Background context only applies to the Coder.
    assert.equal(getRoleDisplay('explorer', { background: true }).name, null);
  });

  it('getRoleLabel always resolves to a non-null string (name → phase → Working)', () => {
    // Trust-bearing roles surface their name; phase-first roles surface their
    // phase; the Orchestrator (no name, no phase) and unknown roles fall back to
    // neutral 'Working'. This is the null-safe label for direct interpolation.
    assert.equal(getRoleLabel('auditor'), 'Auditor');
    assert.equal(getRoleLabel('reviewer'), 'Reviewer');
    assert.equal(getRoleLabel('coder'), 'Editing');
    assert.equal(getRoleLabel('explorer'), 'Exploring');
    assert.equal(getRoleLabel('orchestrator'), 'Working');
    assert.equal(getRoleLabel('totally-unknown'), 'Working');
    assert.equal(getRoleLabel(undefined), 'Working');
    assert.equal(getRoleLabel('coder', { background: true }), 'Background Coder');
  });

  it('getSourceLabel names the emitter (orchestrator → Assistant, system → System)', () => {
    assert.equal(getSourceLabel('system'), 'System');
    assert.equal(getSourceLabel('orchestrator'), 'Assistant');
    assert.equal(getSourceLabel('coder'), 'Editing');
    assert.equal(getSourceLabel('explorer'), 'Exploring');
    assert.equal(getSourceLabel('reviewer'), 'Reviewer');
    assert.equal(getSourceLabel('auditor'), 'Auditor');
    assert.equal(getSourceLabel('mystery'), 'Working');
  });

  it('maps RunEventSubagent supersets through the seam', () => {
    assert.equal(getSubagentDisplay('planner').phase, 'Planning');
    assert.equal(getSubagentDisplay('planner').showActorName, false);
    assert.deepEqual(getSubagentDisplay('deep_reviewer'), ROLE_DISPLAY.reviewer);
    assert.equal(getSubagentDisplay('task_graph').name, 'Task Graph');
  });

  it('composes a single phase-first subagent label, never "Planner" as a fallback', () => {
    assert.equal(getSubagentLabel('coder'), 'Editing');
    assert.equal(getSubagentLabel('explorer'), 'Exploring');
    assert.equal(getSubagentLabel('reviewer'), 'Reviewer');
    assert.equal(getSubagentLabel('deep_reviewer'), 'Reviewer');
    assert.equal(getSubagentLabel('auditor'), 'Auditor');
    assert.equal(getSubagentLabel('planner'), 'Planning');
    assert.equal(getSubagentLabel('task_graph'), 'Task Graph');
    // The old org-chart fallback ("Planner") is gone: unknown → neutral.
    assert.equal(getSubagentLabel('mystery'), 'Working');
    assert.equal(getSubagentLabel(undefined), 'Working');
  });
});
