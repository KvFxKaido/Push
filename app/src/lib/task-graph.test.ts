import { describe, expect, it } from 'vitest';
import type { DelegationOutcome, TaskGraphNode } from '@/types';
import { executeTaskGraph, formatTaskGraphResult } from './task-graph';

function makeDelegationOutcome(
  agent: 'coder' | 'explorer',
  summary: string,
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
      const summary = node.id === 'explore-auth'
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
    expect(result.memoryEntries.get('explore-auth')?.summary).toBe('Found refresh trigger in middleware.');
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
      const summary = node.id === 'explore-tests'
        ? longSummary
        : `${node.id} complete`;
      return {
        summary,
        rounds: 1,
        delegationOutcome: {
          ...makeDelegationOutcome(node.agent, summary),
          checks: node.id === 'explore-tests' ? [{ id: 'coverage', passed: true, output: '' }] : [],
          evidence: node.id === 'explore-tests' ? [{ kind: 'observation', label: 'Test patterns' }] : [],
        },
      };
    });

    expect(result.success).toBe(true);
    const fixAuthContext = contexts.get('fix-auth')?.join('\n') ?? '';
    expect(fixAuthContext).toContain('Dependency memory:');
    expect(fixAuthContext).toContain('- [explore-auth | explorer | complete] explore-auth complete');
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

  it('marks aborted work as cancelled instead of failed', async () => {
    const controller = new AbortController();
    const nodes: TaskGraphNode[] = [
      { id: 'explore-auth', agent: 'explorer', task: 'Trace auth flow' },
    ];

    const resultPromise = executeTaskGraph(
      nodes,
      async (_node, _context, signal) => new Promise((_, reject) => {
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
