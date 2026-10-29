import { describe, expect, it } from 'vitest';
import { translateCoderStatus } from './inline-coder-status';

describe('translateCoderStatus', () => {
  it('maps tool execution to phase-first Editing, keeping the detail', () => {
    expect(translateCoderStatus('Coder executing...', 'sandbox_exec')).toEqual({
      phase: 'Editing',
      detail: 'sandbox_exec',
      thinking: false,
    });
  });

  it('reads a read-only batch / read tool as Exploring', () => {
    expect(translateCoderStatus('Coder executing...', '3 parallel reads').phase).toBe('Exploring');
    expect(translateCoderStatus('Coder executing...', 'read_file').phase).toBe('Exploring');
  });

  it('treats a batch with mutations as Editing, not Exploring', () => {
    expect(translateCoderStatus('Coder executing...', '3 parallel reads + 1 mutation').phase).toBe(
      'Editing',
    );
  });

  it('reads the GitHub PR/CI inspection tools (#895 parity) as Exploring', () => {
    for (const tool of [
      'list_prs',
      'fetch_pr',
      'get_workflow_runs',
      'check_pr_mergeable',
      'find_existing_pr',
    ]) {
      expect(translateCoderStatus('Coder executing...', tool).phase).toBe('Exploring');
    }
  });

  it('keeps mutating/exec tools as Editing', () => {
    for (const tool of ['sandbox_exec', 'write_file', 'create_artifact', 'commit_and_push']) {
      expect(translateCoderStatus('Coder executing...', tool).phase).toBe('Editing');
    }
  });

  it('maps acceptance checks to Verifying', () => {
    expect(translateCoderStatus('Running acceptance checks...').phase).toBe('Verifying');
    expect(translateCoderStatus('Checking...', 'criterion A').phase).toBe('Verifying');
  });

  it('maps the terminal state to a neutral wrap-up, dropping internal halt reasons', () => {
    expect(translateCoderStatus('Coder stopped', 'Cognitive drift — halted')).toEqual({
      phase: 'Wrapping up…',
      thinking: false,
    });
  });

  it('routes round-start / reasoning / loop / resume dead air to thinking', () => {
    for (const phase of [
      'Coder working...',
      'Coder reasoning',
      'Coder loop',
      'Coder resuming...',
      'Context reset',
      'Coder checkpoint',
    ]) {
      expect(translateCoderStatus(phase, 'x')).toEqual({ phase: 'Thinking…', thinking: true });
    }
  });

  it('hides internal mechanics (Context reset / Checkpoint skipped) as thinking', () => {
    expect(translateCoderStatus('Context reset', 'Phase: editing')).toEqual({
      phase: 'Thinking…',
      thinking: true,
    });
    expect(translateCoderStatus('Checkpoint skipped', 'oops')).toEqual({
      phase: 'Thinking…',
      thinking: true,
    });
  });

  it('preserves deliberate user-facing signals (label + detail), not thinking (review #896)', () => {
    expect(translateCoderStatus('Health check', 'Sandbox unreachable — validating...')).toEqual({
      phase: 'Health check',
      detail: 'Sandbox unreachable — validating...',
      thinking: false,
    });
    for (const signal of ['Drift detected', 'Needs more detail', 'Policy intervention']) {
      const r = translateCoderStatus(signal, 'why');
      expect(r).toEqual({ phase: signal, detail: 'why', thinking: false });
    }
  });

  it('hides any future internal "Coder …" phase but never leaks it verbatim', () => {
    const r = translateCoderStatus('Coder doing something new...', 'raw detail');
    expect(r.thinking).toBe(true);
    expect(r.phase).toBe('Thinking…');
    expect(r.phase).not.toContain('Coder');
  });
});
