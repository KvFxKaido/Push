import { describe, expect, it } from 'vitest';
import type { DelegationOutcome, TaskGraphNode } from '@/types';
import { executeTaskGraph, formatTaskGraphResult, validateTaskGraph } from './task-graph';

function makeDelegationOutcome(
  agent: 'coder' | 'explorer',
  summary: string,
  overrides: Partial<DelegationOutcome> = {},
): DelegationOutcome {
  return {
    agent,
    status: 'complete',
    summary,
    evidence: [],
    checks: [],
    gateVerdicts: [],
    missingRequirements: [],
    nextRequiredAction: null,
    rounds: 1,
    checkpoints: 0,
    elapsedMs: 10,
    ...overrides,
  };
}

describe('task-graph', () => {
  it('injects dependency memory into dependent task context and preserves graph memory entries', async () => {
    const contexts = new Map<string, string[]>();
    const nodes: TaskGraphNode[] = [
      {
        id: 'explore-auth',
        agent: 'explorer',
        task: 'Trace auth flow',
      },
      {
        id: 'fix-auth',
        agent: 'coder',
        task: 'Fix auth flow',
        dependsOn: ['explore-auth'],
      },
    ];

    const result = await executeTaskGraph(nodes, async (node, enrichedContext) => {
      contexts.set(node.id, enrichedContext);
      const summary =
        node.id === 'explore-auth'
          ? 'Found refresh trigger in middleware.'
          : 'Applied auth flow fix.';
      return {
        summary,
        rounds: 1,
        delegationOutcome: makeDelegationOutcome(node.agent, summary),
      };
    });

    expect(result.success).toBe(true);
    expect(result.aborted).toBe(false);
    expect(contexts.get('fix-auth')).toContain(
      '[TASK_GRAPH_MEMORY]\nDependency memory:\n- [explore-auth | explorer | complete] Found refresh trigger in middleware.\n[/TASK_GRAPH_MEMORY]',
    );
    expect(result.memoryEntries.get('explore-auth')?.summary).toBe(
      'Found refresh trigger in middleware.',
    );
    expect(result.nodeStates.get('explore-auth')?.delegationOutcome?.summary).toBe(
      'Found refresh trigger in middleware.',
    );
    expect(result.nodeStates.get('fix-auth')?.delegationOutcome?.agent).toBe('coder');
  });

  it('includes supplemental graph memory from other completed tasks with truncated summaries', async () => {
    const contexts = new Map<string, string[]>();
    const longSummary = 'B'.repeat(260);
    const nodes: TaskGraphNode[] = [
      { id: 'explore-auth', agent: 'explorer', task: 'Trace auth flow' },
      { id: 'explore-tests', agent: 'explorer', task: 'Trace test patterns' },
      { id: 'fix-auth', agent: 'coder', task: 'Fix auth flow', dependsOn: ['explore-auth'] },
    ];

    const result = await executeTaskGraph(nodes, async (node, enrichedContext) => {
      contexts.set(node.id, enrichedContext);
      const summary = node.id === 'explore-tests' ? longSummary : `${node.id} complete`;
      return {
        summary,
        rounds: 1,
        delegationOutcome: {
          ...makeDelegationOutcome(node.agent, summary),
          checks: node.id === 'explore-tests' ? [{ id: 'coverage', passed: true, output: '' }] : [],
          evidence:
            node.id === 'explore-tests' ? [{ kind: 'observation', label: 'Test patterns' }] : [],
        },
      };
    });

    expect(result.success).toBe(true);
    const fixAuthContext = contexts.get('fix-auth')?.join('\n') ?? '';
    expect(fixAuthContext).toContain('Dependency memory:');
    expect(fixAuthContext).toContain(
      '- [explore-auth | explorer | complete] explore-auth complete',
    );
    expect(fixAuthContext).toContain('Shared graph memory:');
    expect(fixAuthContext).toContain('- [explore-tests | explorer | complete]');
    expect(fixAuthContext).toContain('Evidence: Test patterns');
    expect(fixAuthContext).toContain('Checks: PASS coverage');
    expect(result.memoryEntries.get('explore-tests')?.summary.endsWith('…')).toBe(true);
  });

  it('cascades a failed task to its dependents while allowing independent work to finish', async () => {
    const nodes: TaskGraphNode[] = [
      { id: 'root', agent: 'explorer', task: 'Root task' },
      { id: 'dependent', agent: 'coder', task: 'Dependent task', dependsOn: ['root'] },
      { id: 'independent', agent: 'explorer', task: 'Independent task' },
    ];

    const result = await executeTaskGraph(nodes, async (node) => {
      if (node.id === 'root') {
        throw new Error('root failed');
      }
      return {
        summary: `${node.id} complete`,
        rounds: 1,
        delegationOutcome: makeDelegationOutcome(node.agent, `${node.id} complete`),
      };
    });

    expect(result.success).toBe(false);
    expect(result.aborted).toBe(false);
    expect(result.nodeStates.get('root')?.status).toBe('failed');
    expect(result.nodeStates.get('dependent')?.status).toBe('cancelled');
    expect(result.nodeStates.get('independent')?.status).toBe('completed');
  });

  it('retries incomplete coder tasks and stores cumulative rounds on success', async () => {
    const contexts: string[][] = [];
    const nodes: TaskGraphNode[] = [{ id: 'fix-auth', agent: 'coder', task: 'Fix auth flow' }];

    const result = await executeTaskGraph(nodes, async (node, enrichedContext) => {
      contexts.push(enrichedContext);
      if (contexts.length === 1) {
        return {
          summary: 'Auth fix still misses regression coverage.',
          rounds: 2,
          delegationOutcome: makeDelegationOutcome(
            node.agent,
            'Auth fix still misses regression coverage.',
            {
              status: 'incomplete',
              checks: [{ id: 'auth-regression', passed: false, output: 'missing test' }],
              missingRequirements: ['Add regression coverage for expired tokens'],
              nextRequiredAction: 'Add the missing test',
              rounds: 2,
            },
          ),
        };
      }

      return {
        summary: 'Auth fix and regression coverage complete.',
        rounds: 3,
        delegationOutcome: makeDelegationOutcome(
          node.agent,
          'Auth fix and regression coverage complete.',
          {
            checks: [{ id: 'auth-regression', passed: true, output: 'passed' }],
            rounds: 3,
          },
        ),
      };
    });

    const state = result.nodeStates.get('fix-auth');

    expect(result.success).toBe(true);
    expect(result.totalRounds).toBe(5);
    expect(contexts).toHaveLength(2);
    expect(contexts[1]?.join('\n')).toContain('[TODO_ENFORCER]');
    expect(contexts[1]?.join('\n')).toContain('- Add regression coverage for expired tokens');
    expect(state?.status).toBe('completed');
    expect(state?.result).toBe('Auth fix and regression coverage complete.');
    expect(state?.delegationOutcome?.rounds).toBe(5);
    expect(state?.delegationOutcome?.checks).toEqual([
      { id: 'auth-regression', passed: true, output: 'passed' },
    ]);
  });

  it('preserves final incomplete outcome when coder retries are exhausted', async () => {
    let attempts = 0;
    const nodes: TaskGraphNode[] = [{ id: 'fix-auth', agent: 'coder', task: 'Fix auth flow' }];

    const result = await executeTaskGraph(nodes, async (node) => {
      attempts++;
      const summary = `Attempt ${attempts} still incomplete.`;
      return {
        summary,
        rounds: attempts,
        delegationOutcome: makeDelegationOutcome(node.agent, summary, {
          status: 'incomplete',
          checks: [{ id: `check-${attempts}`, passed: false, output: `failure ${attempts}` }],
          missingRequirements: [`gap ${attempts}`],
          nextRequiredAction: `Address gap ${attempts}`,
          rounds: attempts,
        }),
      };
    });

    const state = result.nodeStates.get('fix-auth');

    expect(result.success).toBe(false);
    expect(result.totalRounds).toBe(6);
    expect(attempts).toBe(3);
    expect(state?.status).toBe('failed');
    expect(state?.result).toBe('Attempt 3 still incomplete.');
    expect(state?.error).toContain('Maximum completion retries (2) exhausted');
    expect(state?.error).toContain('gap 3');
    expect(state?.delegationOutcome?.summary).toBe('Attempt 3 still incomplete.');
    expect(state?.delegationOutcome?.rounds).toBe(6);
    expect(state?.delegationOutcome?.missingRequirements).toEqual(['gap 3']);
    expect(state?.delegationOutcome?.checks).toEqual([
      { id: 'check-3', passed: false, output: 'failure 3' },
    ]);
  });

  it('marks aborted work as cancelled instead of failed', async () => {
    const controller = new AbortController();
    const nodes: TaskGraphNode[] = [
      { id: 'explore-auth', agent: 'explorer', task: 'Trace auth flow' },
    ];

    const resultPromise = executeTaskGraph(
      nodes,
      async (_node, _context, signal) =>
        new Promise((_, reject) => {
          if (signal?.aborted) {
            reject(new DOMException('cancelled', 'AbortError'));
            return;
          }
          signal?.addEventListener('abort', () => {
            reject(new DOMException('cancelled', 'AbortError'));
          });
        }),
      { signal: controller.signal },
    );

    controller.abort();
    const result = await resultPromise;

    expect(result.success).toBe(false);
    expect(result.aborted).toBe(true);
    expect(result.nodeStates.get('explore-auth')?.status).toBe('cancelled');
    expect(result.nodeStates.get('explore-auth')?.error).toBe('Cancelled by user.');
    expect(formatTaskGraphResult(result)).toContain('Task graph execution cancelled by user.');
  });
});

// ---------------------------------------------------------------------------
// validateTaskGraph — characterization (Gap 3 Step 2)
// ---------------------------------------------------------------------------
//
// Until 2026-04-18 the task-graph runtime had zero direct coverage on
// its validation function — only its executor was tested. These pins
// establish the validation surface as a prerequisite for Gap 3 Step 3,
// which will modify the node runners; a change to validation that
// regresses an error type or loosens cycle detection needs to break
// these tests before the executor change has a chance to mask it.

describe('validateTaskGraph — error types', () => {
  it('returns empty_graph error and short-circuits on an empty node list', () => {
    const errors = validateTaskGraph([]);
    // Empty graph is a terminal condition — the function returns
    // immediately rather than checking anything else. Pin that the
    // only error surfaced is `empty_graph`.
    expect(errors).toHaveLength(1);
    expect(errors[0].type).toBe('empty_graph');
    expect(errors[0].message).toContain('at least one task');
  });

  it('returns duplicate_id error naming the specific id', () => {
    const nodes: TaskGraphNode[] = [
      { id: 'a', agent: 'explorer', task: 't1' },
      { id: 'a', agent: 'coder', task: 't2' },
    ];
    const errors = validateTaskGraph(nodes);
    const dup = errors.find((e) => e.type === 'duplicate_id');
    expect(dup).toBeDefined();
    expect(dup?.message).toContain('"a"');
  });

  it('returns invalid_agent error for unrecognized agent values', () => {
    const nodes: TaskGraphNode[] = [
      { id: 'a', agent: 'reviewer' as never, task: 't1' },
      { id: 'b', agent: '' as never, task: 't2' },
    ];
    const errors = validateTaskGraph(nodes);
    const invalidAgentErrors = errors.filter((e) => e.type === 'invalid_agent');
    // `validateTaskGraph` does not document an error-ordering
    // contract, so assert via set-membership rather than indexing —
    // otherwise the test is brittle to harmless refactors that
    // change iteration order or group errors by type (Copilot
    // review on PR #332).
    const invalidAgentMessages = invalidAgentErrors.map((e) => e.message);
    expect(invalidAgentErrors).toHaveLength(2);
    expect(invalidAgentMessages.some((message) => message.includes('"reviewer"'))).toBe(true);
    expect(invalidAgentMessages.some((message) => message.includes('""'))).toBe(true);
  });

  it('returns missing_dependency error naming the unknown dependency', () => {
    const nodes: TaskGraphNode[] = [
      { id: 'a', agent: 'coder', task: 't1', dependsOn: ['does-not-exist'] },
    ];
    const errors = validateTaskGraph(nodes);
    const missingDep = errors.find((e) => e.type === 'missing_dependency');
    expect(missingDep).toBeDefined();
    expect(missingDep?.message).toContain('"a"');
    expect(missingDep?.message).toContain('"does-not-exist"');
  });

  it('detects a simple two-node cycle', () => {
    const nodes: TaskGraphNode[] = [
      { id: 'a', agent: 'coder', task: 't1', dependsOn: ['b'] },
      { id: 'b', agent: 'coder', task: 't2', dependsOn: ['a'] },
    ];
    const errors = validateTaskGraph(nodes);
    expect(errors).toHaveLength(1);
    expect(errors[0].type).toBe('cycle');
    expect(errors[0].message).toContain('Cycle detected');
  });

  it('detects a three-node cycle', () => {
    const nodes: TaskGraphNode[] = [
      { id: 'a', agent: 'coder', task: 't1', dependsOn: ['c'] },
      { id: 'b', agent: 'coder', task: 't2', dependsOn: ['a'] },
      { id: 'c', agent: 'coder', task: 't3', dependsOn: ['b'] },
    ];
    const errors = validateTaskGraph(nodes);
    expect(errors.filter((e) => e.type === 'cycle')).toHaveLength(1);
  });

  it('detects a self-loop (a depends on itself)', () => {
    const nodes: TaskGraphNode[] = [{ id: 'a', agent: 'coder', task: 't', dependsOn: ['a'] }];
    const errors = validateTaskGraph(nodes);
    expect(errors).toHaveLength(1);
    expect(errors[0].type).toBe('cycle');
  });

  it('detects a cycle buried among valid nodes', () => {
    const nodes: TaskGraphNode[] = [
      { id: 'solo', agent: 'explorer', task: 't1' },
      { id: 'a', agent: 'coder', task: 't2', dependsOn: ['b'] },
      { id: 'b', agent: 'coder', task: 't3', dependsOn: ['a'] },
      { id: 'downstream', agent: 'coder', task: 't4', dependsOn: ['solo'] },
    ];
    const errors = validateTaskGraph(nodes);
    expect(errors.filter((e) => e.type === 'cycle')).toHaveLength(1);
  });
});

describe('validateTaskGraph — short-circuit and composition', () => {
  it('skips cycle detection when other structural errors are present', () => {
    // Design intent (task-graph.ts:83-88): cycle detection is
    // expensive and unreliable when the graph is malformed in other
    // ways. If any non-cycle error fires, validateTaskGraph returns
    // before running detectCycle. Pin that a graph with BOTH a
    // missing dependency AND a cycle-shaped edge surfaces only the
    // non-cycle error.
    const nodes: TaskGraphNode[] = [
      { id: 'a', agent: 'coder', task: 't1', dependsOn: ['b', 'ghost'] },
      { id: 'b', agent: 'coder', task: 't2', dependsOn: ['a'] },
    ];
    const errors = validateTaskGraph(nodes);
    expect(errors.some((e) => e.type === 'missing_dependency')).toBe(true);
    expect(errors.some((e) => e.type === 'cycle')).toBe(false);
  });

  it('composes multiple non-cycle error types in one pass', () => {
    const nodes: TaskGraphNode[] = [
      { id: 'a', agent: 'explorer', task: 't1' },
      { id: 'a', agent: 'reviewer' as never, task: 't2', dependsOn: ['ghost'] },
    ];
    const errors = validateTaskGraph(nodes);
    const types = new Set(errors.map((e) => e.type));
    expect(types.has('duplicate_id')).toBe(true);
    expect(types.has('invalid_agent')).toBe(true);
    expect(types.has('missing_dependency')).toBe(true);
    expect(types.has('cycle')).toBe(false);
  });
});

describe('validateTaskGraph — valid graph shapes', () => {
  it('accepts a single node with no dependencies', () => {
    expect(validateTaskGraph([{ id: 'a', agent: 'explorer', task: 't' }])).toEqual([]);
  });

  it('accepts a linear chain', () => {
    const nodes: TaskGraphNode[] = [
      { id: 'a', agent: 'explorer', task: 't1' },
      { id: 'b', agent: 'coder', task: 't2', dependsOn: ['a'] },
      { id: 'c', agent: 'coder', task: 't3', dependsOn: ['b'] },
    ];
    expect(validateTaskGraph(nodes)).toEqual([]);
  });

  it('accepts a diamond (fan-out then fan-in)', () => {
    const nodes: TaskGraphNode[] = [
      { id: 'top', agent: 'explorer', task: 't1' },
      { id: 'left', agent: 'coder', task: 't2', dependsOn: ['top'] },
      { id: 'right', agent: 'coder', task: 't3', dependsOn: ['top'] },
      { id: 'bottom', agent: 'coder', task: 't4', dependsOn: ['left', 'right'] },
    ];
    expect(validateTaskGraph(nodes)).toEqual([]);
  });

  it('accepts fully independent nodes (no dependencies)', () => {
    const nodes: TaskGraphNode[] = [
      { id: 'a', agent: 'explorer', task: 't1' },
      { id: 'b', agent: 'explorer', task: 't2' },
      { id: 'c', agent: 'coder', task: 't3' },
    ];
    expect(validateTaskGraph(nodes)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// executeTaskGraph — behavioral gap-fills (Gap 3 Step 2)
// ---------------------------------------------------------------------------
//
// The existing six tests above characterize dependency memory,
// supplemental memory, failure cascade, coder retries, retry
// exhaustion, and abort. These tests fill the remaining behavioral
// gaps that Gap 3 Step 3 will rely on when it modifies the node
// runners: parallelism limits, coder serialization, onProgress event
// sequencing, cascadeFailure transitive traversal, and the summary
// formatter's output shapes for each terminal state.

describe('executeTaskGraph — parallelism and serialization', () => {
  it('serializes coder nodes — at most one coder runs at a time', async () => {
    // Graph of three independent coder tasks. If serialization is
    // correct, the executor only ever has one coder in flight.
    let concurrentCoders = 0;
    let maxConcurrent = 0;
    const nodes: TaskGraphNode[] = [
      { id: 'c1', agent: 'coder', task: 't1' },
      { id: 'c2', agent: 'coder', task: 't2' },
      { id: 'c3', agent: 'coder', task: 't3' },
    ];

    const result = await executeTaskGraph(nodes, async (node) => {
      concurrentCoders++;
      if (concurrentCoders > maxConcurrent) maxConcurrent = concurrentCoders;
      // 20ms window is generous for the dispatch loop to attempt
      // concurrent dispatches — setTimeout guarantees at least N ms,
      // so CI load makes the window longer (not shorter), and this
      // keeps the test robust under heavy event-loop contention
      // (github-actions review on PR #332).
      await new Promise((r) => setTimeout(r, 20));
      concurrentCoders--;
      return {
        summary: `${node.id} done`,
        rounds: 1,
        delegationOutcome: makeDelegationOutcome(node.agent, `${node.id} done`),
      };
    });

    expect(result.success).toBe(true);
    expect(maxConcurrent).toBe(1);
  });

  it('parallelizes explorer nodes up to the default maxParallelExplorers (3)', async () => {
    // Six independent explorer tasks. The default cap is 3, so the
    // executor should have up to 3 explorers in flight at a time.
    let concurrentExplorers = 0;
    let maxConcurrent = 0;
    const nodes: TaskGraphNode[] = Array.from({ length: 6 }, (_, i) => ({
      id: `e${i}`,
      agent: 'explorer' as const,
      task: `t${i}`,
    }));

    const result = await executeTaskGraph(nodes, async (node) => {
      concurrentExplorers++;
      if (concurrentExplorers > maxConcurrent) maxConcurrent = concurrentExplorers;
      await new Promise((r) => setTimeout(r, 20));
      concurrentExplorers--;
      return {
        summary: `${node.id} done`,
        rounds: 1,
        delegationOutcome: makeDelegationOutcome(node.agent, `${node.id} done`),
      };
    });

    expect(result.success).toBe(true);
    expect(maxConcurrent).toBe(3);
  });

  it('honors a custom maxParallelExplorers override', async () => {
    let concurrentExplorers = 0;
    let maxConcurrent = 0;
    const nodes: TaskGraphNode[] = Array.from({ length: 4 }, (_, i) => ({
      id: `e${i}`,
      agent: 'explorer' as const,
      task: `t${i}`,
    }));

    const result = await executeTaskGraph(
      nodes,
      async (node) => {
        concurrentExplorers++;
        if (concurrentExplorers > maxConcurrent) maxConcurrent = concurrentExplorers;
        await new Promise((r) => setTimeout(r, 20));
        concurrentExplorers--;
        return {
          summary: `${node.id} done`,
          rounds: 1,
          delegationOutcome: makeDelegationOutcome(node.agent, `${node.id} done`),
        };
      },
      { maxParallelExplorers: 2 },
    );

    expect(result.success).toBe(true);
    expect(maxConcurrent).toBe(2);
  });

  it('allows an explorer and a coder to run concurrently when independent', async () => {
    const concurrentByAgent = { explorer: 0, coder: 0 };
    let sawExplorerAndCoderConcurrent = false;
    const nodes: TaskGraphNode[] = [
      { id: 'e1', agent: 'explorer', task: 'explore' },
      { id: 'c1', agent: 'coder', task: 'code' },
    ];

    const result = await executeTaskGraph(nodes, async (node) => {
      concurrentByAgent[node.agent]++;
      if (concurrentByAgent.explorer > 0 && concurrentByAgent.coder > 0) {
        sawExplorerAndCoderConcurrent = true;
      }
      await new Promise((r) => setTimeout(r, 20));
      concurrentByAgent[node.agent]--;
      return {
        summary: `${node.id} done`,
        rounds: 1,
        delegationOutcome: makeDelegationOutcome(node.agent, `${node.id} done`),
      };
    });

    expect(result.success).toBe(true);
    expect(sawExplorerAndCoderConcurrent).toBe(true);
  });
});

describe('executeTaskGraph — progress event sequencing', () => {
  it('emits task_ready then task_started then task_completed in order for a successful node', async () => {
    const events: Array<{ type: string; taskId?: string }> = [];
    const nodes: TaskGraphNode[] = [{ id: 'solo', agent: 'explorer', task: 't' }];

    await executeTaskGraph(
      nodes,
      async () => ({
        summary: 'done',
        rounds: 1,
        delegationOutcome: makeDelegationOutcome('explorer', 'done'),
      }),
      {
        onProgress: (event) => events.push({ type: event.type, taskId: event.taskId }),
      },
    );

    const soloEvents = events.filter((e) => e.taskId === 'solo').map((e) => e.type);
    expect(soloEvents).toEqual(['task_ready', 'task_started', 'task_completed']);
  });

  it('emits task_failed (not task_completed) when executor throws', async () => {
    const events: string[] = [];
    const nodes: TaskGraphNode[] = [{ id: 'boom', agent: 'explorer', task: 't' }];

    await executeTaskGraph(
      nodes,
      async () => {
        throw new Error('kaboom');
      },
      { onProgress: (event) => events.push(event.type) },
    );

    expect(events).toContain('task_failed');
    expect(events).not.toContain('task_completed');
  });

  it('emits graph_complete with the correct status phrasing for each terminal state', async () => {
    const nodes: TaskGraphNode[] = [{ id: 'solo', agent: 'explorer', task: 't' }];
    let successDetail = '';
    await executeTaskGraph(
      nodes,
      async () => ({
        summary: 'ok',
        rounds: 1,
        delegationOutcome: makeDelegationOutcome('explorer', 'ok'),
      }),
      {
        onProgress: (event) => {
          if (event.type === 'graph_complete') successDetail = event.detail ?? '';
        },
      },
    );
    expect(successDetail).toBe('All tasks completed.');

    let failedDetail = '';
    await executeTaskGraph(
      [{ id: 'bad', agent: 'explorer', task: 't' }],
      async () => {
        throw new Error('x');
      },
      {
        onProgress: (event) => {
          if (event.type === 'graph_complete') failedDetail = event.detail ?? '';
        },
      },
    );
    expect(failedDetail).toBe('Some tasks failed.');

    const controller = new AbortController();
    let cancelledDetail = '';
    const promise = executeTaskGraph(
      [{ id: 'slow', agent: 'explorer', task: 't' }],
      async (_n, _c, signal) =>
        new Promise((_, reject) => {
          signal?.addEventListener('abort', () => reject(new DOMException('x', 'AbortError')));
        }),
      {
        signal: controller.signal,
        onProgress: (event) => {
          if (event.type === 'graph_complete') cancelledDetail = event.detail ?? '';
        },
      },
    );
    controller.abort();
    await promise;
    expect(cancelledDetail).toBe('Task graph cancelled by user.');
  });
});

describe('executeTaskGraph — cascadeFailure transitive behavior', () => {
  it('cancels transitive dependents across multiple levels', async () => {
    // Graph: root → mid → leaf. Root fails, both mid and leaf must
    // cascade to cancelled. Existing coverage only pins one-level
    // cascade (dependent of failed); this pins the transitive step.
    const nodes: TaskGraphNode[] = [
      { id: 'root', agent: 'explorer', task: 't1' },
      { id: 'mid', agent: 'coder', task: 't2', dependsOn: ['root'] },
      { id: 'leaf', agent: 'coder', task: 't3', dependsOn: ['mid'] },
    ];

    const result = await executeTaskGraph(nodes, async (node) => {
      if (node.id === 'root') throw new Error('root failed');
      return {
        summary: `${node.id} done`,
        rounds: 1,
        delegationOutcome: makeDelegationOutcome(node.agent, `${node.id} done`),
      };
    });

    expect(result.nodeStates.get('root')?.status).toBe('failed');
    expect(result.nodeStates.get('mid')?.status).toBe('cancelled');
    expect(result.nodeStates.get('leaf')?.status).toBe('cancelled');
  });

  it('emits task_cancelled events for each transitively-cascaded node', async () => {
    const cancelledIds: string[] = [];
    const nodes: TaskGraphNode[] = [
      { id: 'root', agent: 'explorer', task: 't1' },
      { id: 'mid', agent: 'coder', task: 't2', dependsOn: ['root'] },
      { id: 'leaf', agent: 'coder', task: 't3', dependsOn: ['mid'] },
    ];

    await executeTaskGraph(
      nodes,
      async (node) => {
        if (node.id === 'root') throw new Error('x');
        return {
          summary: 'ok',
          rounds: 1,
          delegationOutcome: makeDelegationOutcome(node.agent, 'ok'),
        };
      },
      {
        onProgress: (event) => {
          if (event.type === 'task_cancelled' && event.taskId) cancelledIds.push(event.taskId);
        },
      },
    );

    expect(cancelledIds).toContain('mid');
    expect(cancelledIds).toContain('leaf');
  });
});

describe('executeTaskGraph — pre-dispatch abort', () => {
  it('returns aborted with no executor calls when signal is already aborted at entry', async () => {
    const controller = new AbortController();
    controller.abort();
    let executorCalls = 0;
    const nodes: TaskGraphNode[] = [
      { id: 'a', agent: 'explorer', task: 't1' },
      { id: 'b', agent: 'coder', task: 't2', dependsOn: ['a'] },
    ];

    const result = await executeTaskGraph(
      nodes,
      async () => {
        executorCalls++;
        return {
          summary: 'should-not-run',
          rounds: 1,
          delegationOutcome: makeDelegationOutcome('explorer', 'x'),
        };
      },
      { signal: controller.signal },
    );

    expect(result.aborted).toBe(true);
    expect(executorCalls).toBe(0);
    expect(result.nodeStates.get('a')?.status).toBe('cancelled');
    expect(result.nodeStates.get('b')?.status).toBe('cancelled');
  });
});

describe('formatTaskGraphResult — output shapes', () => {
  it('formats all-success summary with OK icons and elapsed seconds', async () => {
    const nodes: TaskGraphNode[] = [
      { id: 'a', agent: 'explorer', task: 't1' },
      { id: 'b', agent: 'coder', task: 't2', dependsOn: ['a'] },
    ];
    const result = await executeTaskGraph(nodes, async (node) => ({
      summary: `${node.id} summary`,
      rounds: 1,
      delegationOutcome: makeDelegationOutcome(node.agent, `${node.id} summary`),
    }));

    const formatted = formatTaskGraphResult(result);
    expect(formatted).toContain('All tasks completed successfully.');
    expect(formatted).toContain('a [explorer, OK');
    expect(formatted).toContain('b [coder, OK');
    expect(formatted).toContain('a summary');
    expect(formatted).toContain('Total: 2 tasks');
  });

  it('formats mixed success/failure with FAILED and CANCELLED markers', async () => {
    const nodes: TaskGraphNode[] = [
      { id: 'ok', agent: 'explorer', task: 't1' },
      { id: 'bad', agent: 'explorer', task: 't2' },
      { id: 'downstream', agent: 'coder', task: 't3', dependsOn: ['bad'] },
    ];
    const result = await executeTaskGraph(nodes, async (node) => {
      if (node.id === 'bad') throw new Error('boom');
      return {
        summary: `${node.id} summary`,
        rounds: 1,
        delegationOutcome: makeDelegationOutcome(node.agent, `${node.id} summary`),
      };
    });

    const formatted = formatTaskGraphResult(result);
    expect(formatted).toContain('Some tasks failed or were cancelled.');
    expect(formatted).toContain('ok [explorer, OK');
    expect(formatted).toContain('bad [explorer, FAILED');
    expect(formatted).toContain('boom');
    expect(formatted).toContain('downstream [coder, CANCELLED');
  });
});

// ---------------------------------------------------------------------------
// DelegationOutcome propagation edge cases
// ---------------------------------------------------------------------------

describe('executeTaskGraph — DelegationOutcome edge cases', () => {
  it('tolerates executors that return undefined delegationOutcome', async () => {
    // Not every executor path produces a structured DelegationOutcome
    // (e.g., legacy callers). Pin that the graph still completes and
    // the node state reflects the raw summary without a delegationOutcome
    // field.
    const nodes: TaskGraphNode[] = [{ id: 'solo', agent: 'explorer', task: 't' }];
    const result = await executeTaskGraph(nodes, async () => ({
      summary: 'legacy-shape',
      rounds: 1,
      // delegationOutcome intentionally omitted
    }));

    expect(result.success).toBe(true);
    const state = result.nodeStates.get('solo');
    expect(state?.status).toBe('completed');
    expect(state?.result).toBe('legacy-shape');
    expect(state?.delegationOutcome).toBeUndefined();
  });

  it('does not build a memoryEntry for a completed node with an empty summary', async () => {
    // buildTaskGraphMemoryEntry (task-graph.ts:229) returns null when
    // the summary is empty/whitespace. Pin that the node still
    // completes but contributes no memory entry to downstream tasks.
    const nodes: TaskGraphNode[] = [
      { id: 'quiet', agent: 'explorer', task: 't1' },
      { id: 'downstream', agent: 'coder', task: 't2', dependsOn: ['quiet'] },
    ];

    const contexts = new Map<string, string[]>();
    const result = await executeTaskGraph(nodes, async (node, enrichedContext) => {
      contexts.set(node.id, enrichedContext);
      if (node.id === 'quiet') {
        return {
          summary: '   ',
          rounds: 1,
          delegationOutcome: makeDelegationOutcome(node.agent, '   '),
        };
      }
      return {
        summary: 'downstream done',
        rounds: 1,
        delegationOutcome: makeDelegationOutcome(node.agent, 'downstream done'),
      };
    });

    expect(result.success).toBe(true);
    expect(result.memoryEntries.has('quiet')).toBe(false);
    // Downstream context should not contain a TASK_GRAPH_MEMORY
    // section since the only completed dep contributed no entry.
    const downstreamContext = contexts.get('downstream')?.join('\n') ?? '';
    expect(downstreamContext).not.toContain('[TASK_GRAPH_MEMORY]');
  });
});
