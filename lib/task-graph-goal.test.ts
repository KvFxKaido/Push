import { describe, expect, it } from 'vitest';
import type { TaskGraphNode } from './runtime-contract.ts';
import { validateTaskGraphAgainstGoal, formatGoalRejection } from './task-graph.ts';
import type { UserGoalAnchor } from './user-goal-anchor.ts';

const anchorMinimal: UserGoalAnchor = { initialAsk: 'ship the goal anchor feature' };

const anchorFull: UserGoalAnchor = {
  initialAsk: 'fix the sandbox restart bug',
  currentWorkingGoal: 'narrow to the controller layer',
  constraints: ['preserve typed-tool branch swaps', 'no UI rewrite'],
  doNot: ['bypass the desync guard'],
  lastRefreshedAt: '2026-05-14T11:45:00Z',
};

function makeNode(id: string, overrides: Partial<TaskGraphNode> = {}): TaskGraphNode {
  return {
    id,
    agent: 'explorer',
    task: `task ${id}`,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// validateTaskGraphAgainstGoal
// ---------------------------------------------------------------------------

describe('validateTaskGraphAgainstGoal', () => {
  it('returns no errors when every node has a populated addresses field', () => {
    const nodes: TaskGraphNode[] = [
      makeNode('a', { addresses: 'Initial ask' }),
      makeNode('b', { addresses: 'Current working goal' }),
    ];
    expect(validateTaskGraphAgainstGoal(nodes, { anchor: anchorFull })).toEqual([]);
  });

  it('flags every node missing addresses', () => {
    const nodes: TaskGraphNode[] = [
      makeNode('a'),
      makeNode('b', { addresses: 'Initial ask' }),
      makeNode('c', { addresses: '' }),
    ];
    const errors = validateTaskGraphAgainstGoal(nodes, { anchor: anchorMinimal });
    expect(errors).toHaveLength(2);
    expect(errors.map((e) => e.nodeId)).toEqual(['a', 'c']);
    expect(errors.every((e) => e.type === 'missing_addresses')).toBe(true);
  });

  it('treats whitespace-only addresses as missing', () => {
    const nodes: TaskGraphNode[] = [makeNode('a', { addresses: '   \n\t  ' })];
    const errors = validateTaskGraphAgainstGoal(nodes, { anchor: anchorMinimal });
    expect(errors).toHaveLength(1);
  });

  it('includes the valid reference names in the per-node message', () => {
    // Cooperating models reading the rejection should see what valid
    // addresses strings look like for the specific anchor in play.
    const nodes: TaskGraphNode[] = [makeNode('a')];
    const errorMin = validateTaskGraphAgainstGoal(nodes, { anchor: anchorMinimal })[0];
    expect(errorMin.message).toContain('"Initial ask"');
    expect(errorMin.message).not.toContain('"Current working goal"');
    expect(errorMin.message).not.toContain('a specific Constraint');

    const errorFull = validateTaskGraphAgainstGoal(nodes, { anchor: anchorFull })[0];
    expect(errorFull.message).toContain('"Initial ask"');
    expect(errorFull.message).toContain('"Current working goal"');
    expect(errorFull.message).toContain('a specific Constraint');
  });

  it("does not validate node identity or dependency shape — that is validateTaskGraph's job", () => {
    // Goal validation is orthogonal to structural validation: a graph
    // with duplicate ids but populated addresses still passes the goal
    // gate. Structural errors surface separately via validateTaskGraph.
    const nodes: TaskGraphNode[] = [
      makeNode('a', { addresses: 'Initial ask' }),
      makeNode('a', { addresses: 'Initial ask' }),
    ];
    expect(validateTaskGraphAgainstGoal(nodes, { anchor: anchorMinimal })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// formatGoalRejection
// ---------------------------------------------------------------------------

describe('formatGoalRejection', () => {
  it('emits a [Goal Alignment Required] block with offending tasks and the goal', () => {
    const errors = [
      {
        type: 'missing_addresses' as const,
        nodeId: 'fix-auth',
        task: 'Refactor the auth module',
        message: 'irrelevant for this test',
      },
    ];
    const body = formatGoalRejection(errors, anchorMinimal);
    expect(body.startsWith('[Goal Alignment Required]')).toBe(true);
    expect(body).toContain('fix-auth');
    expect(body).toContain('Refactor the auth module');
    expect(body).toContain('[USER_GOAL]');
    expect(body).toContain('Initial ask: ship the goal anchor feature');
    expect(body).toContain('Re-emit `plan_tasks`');
  });

  it('lists every offending task as a separate bullet', () => {
    const errors = [
      {
        type: 'missing_addresses' as const,
        nodeId: 'a',
        task: 'task a',
        message: 'x',
      },
      {
        type: 'missing_addresses' as const,
        nodeId: 'b',
        task: 'task b',
        message: 'x',
      },
    ];
    const body = formatGoalRejection(errors, anchorMinimal);
    expect(body).toContain('- a ("task a")');
    expect(body).toContain('- b ("task b")');
  });

  it('renders the full v2 anchor when fields are populated', () => {
    const body = formatGoalRejection(
      [
        {
          type: 'missing_addresses' as const,
          nodeId: 'a',
          task: 'task',
          message: 'x',
        },
      ],
      anchorFull,
    );
    expect(body).toContain('Current working goal: narrow to the controller layer');
    expect(body).toContain('Constraints: preserve typed-tool branch swaps; no UI rewrite');
    expect(body).toContain('Do not: bypass the desync guard');
  });
});
