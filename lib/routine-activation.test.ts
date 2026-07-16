import { describe, expect, it } from 'vitest';
import {
  ALL_ROUTINE_WATCH_EVENTS,
  classifyPullRequestAction,
  classifyWebhookEvent,
  isRoutineWatchEvent,
  matchRoutines,
  type RoutineLike,
  type RoutineWatchEvent,
} from './routine-activation';

const routine = (name: string, watch: RoutineWatchEvent[]): RoutineLike => ({
  descriptor: { name, description: `${name} routine`, watch },
});

describe('classifyPullRequestAction', () => {
  it('maps the three first-review actions', () => {
    expect(classifyPullRequestAction('opened')).toBe('pr_opened');
    expect(classifyPullRequestAction('reopened')).toBe('pr_reopened');
    expect(classifyPullRequestAction('ready_for_review')).toBe('pr_ready_for_review');
  });

  it('excludes synchronize — a new commit is not a first-review moment', () => {
    expect(classifyPullRequestAction('synchronize')).toBeNull();
  });

  it('returns null for other actions and empty input', () => {
    expect(classifyPullRequestAction('closed')).toBeNull();
    expect(classifyPullRequestAction('labeled')).toBeNull();
    expect(classifyPullRequestAction('')).toBeNull();
    expect(classifyPullRequestAction(null)).toBeNull();
    expect(classifyPullRequestAction(undefined)).toBeNull();
  });

  it('does not inherit Object.prototype keys as actions', () => {
    // A payload action of `constructor`/`toString` must miss, not resolve to an
    // inherited member of the lookup table.
    expect(classifyPullRequestAction('constructor')).toBeNull();
    expect(classifyPullRequestAction('toString')).toBeNull();
    expect(classifyPullRequestAction('__proto__')).toBeNull();
  });
});

describe('classifyWebhookEvent', () => {
  it('classifies the reviewable pull_request actions', () => {
    expect(classifyWebhookEvent('pull_request', { action: 'opened' })).toEqual({
      ok: true,
      event: 'pr_opened',
    });
    expect(classifyWebhookEvent('pull_request', { action: 'reopened' })).toEqual({
      ok: true,
      event: 'pr_reopened',
    });
    expect(classifyWebhookEvent('pull_request', { action: 'ready_for_review' })).toEqual({
      ok: true,
      event: 'pr_ready_for_review',
    });
  });

  it('classifies both comment events coarsely, without judging the content', () => {
    // Payload-shape only: a comment with no trigger phrase still classifies.
    // Whether it carries `@bot review` is the routine's call, not the vocabulary's.
    expect(classifyWebhookEvent('issue_comment', { action: 'created' })).toEqual({
      ok: true,
      event: 'pr_comment',
    });
    expect(classifyWebhookEvent('pull_request_review_comment', {})).toEqual({
      ok: true,
      event: 'pr_comment',
    });
  });

  // These reason strings are the receiver's skip body, which is the only sink an
  // operator can read in GitHub's delivery log. Pinned so a refactor can't
  // quietly turn a named skip back into an anonymous one.
  it('names the offending action on a pull_request miss', () => {
    expect(classifyWebhookEvent('pull_request', { action: 'closed' })).toEqual({
      ok: false,
      reason: 'action:closed',
    });
    expect(classifyWebhookEvent('pull_request', { action: 'synchronize' })).toEqual({
      ok: false,
      reason: 'action:synchronize',
    });
  });

  it('reports an actionless pull_request as an empty action, not a missing event', () => {
    expect(classifyWebhookEvent('pull_request', {})).toEqual({ ok: false, reason: 'action:' });
    expect(classifyWebhookEvent('pull_request', null)).toEqual({ ok: false, reason: 'action:' });
    expect(classifyWebhookEvent('pull_request', undefined)).toEqual({
      ok: false,
      reason: 'action:',
    });
  });

  it('names the offending event on a non-PR delivery', () => {
    expect(classifyWebhookEvent('push', {})).toEqual({ ok: false, reason: 'event:push' });
    expect(classifyWebhookEvent('check_suite', { action: 'completed' })).toEqual({
      ok: false,
      reason: 'event:check_suite',
    });
  });

  it('reports a missing event name as event:none', () => {
    expect(classifyWebhookEvent(null, {})).toEqual({ ok: false, reason: 'event:none' });
    expect(classifyWebhookEvent(undefined, {})).toEqual({ ok: false, reason: 'event:none' });
    expect(classifyWebhookEvent('', {})).toEqual({ ok: false, reason: 'event:none' });
  });

  it('tolerates a non-object payload without throwing', () => {
    expect(classifyWebhookEvent('pull_request', 'not-an-object')).toEqual({
      ok: false,
      reason: 'action:',
    });
    expect(classifyWebhookEvent('pull_request', 42)).toEqual({ ok: false, reason: 'action:' });
  });
});

describe('isRoutineWatchEvent', () => {
  it('accepts every event in the vocabulary', () => {
    for (const event of ALL_ROUTINE_WATCH_EVENTS) {
      expect(isRoutineWatchEvent(event)).toBe(true);
    }
  });

  it('rejects near-misses and non-strings', () => {
    expect(isRoutineWatchEvent('ci_failed')).toBe(false);
    expect(isRoutineWatchEvent('pr_synchronize')).toBe(false);
    expect(isRoutineWatchEvent('PR_OPENED')).toBe(false);
    expect(isRoutineWatchEvent(null)).toBe(false);
    expect(isRoutineWatchEvent(undefined)).toBe(false);
    expect(isRoutineWatchEvent(1)).toBe(false);
  });
});

describe('matchRoutines', () => {
  it('returns the routines watching the event', () => {
    const registry = [routine('a', ['pr_opened']), routine('b', ['pr_comment'])];
    expect(matchRoutines('pr_opened', registry).map((r) => r.descriptor.name)).toEqual(['a']);
    expect(matchRoutines('pr_comment', registry).map((r) => r.descriptor.name)).toEqual(['b']);
  });

  it('returns every match, in registry order — fan-out is the general case', () => {
    const registry = [
      routine('first', ['pr_opened', 'pr_comment']),
      routine('second', ['pr_opened']),
      routine('third', ['pr_comment']),
    ];
    expect(matchRoutines('pr_opened', registry).map((r) => r.descriptor.name)).toEqual([
      'first',
      'second',
    ]);
  });

  it('returns empty when nothing watches the event, rather than throwing', () => {
    const registry = [routine('a', ['pr_opened'])];
    expect(matchRoutines('pr_comment', registry)).toEqual([]);
  });

  it('returns empty for an empty registry and for a never-activating routine', () => {
    expect(matchRoutines('pr_opened', [])).toEqual([]);
    expect(matchRoutines('pr_opened', [routine('inert', [])])).toEqual([]);
  });
});
