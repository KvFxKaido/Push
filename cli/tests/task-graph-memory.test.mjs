/**
 * Tests for writeTaskGraphResultMemory — the helper that persists
 * typed memory records for each completed node in a task-graph
 * result. Verifies:
 *   - Every completed node produces a record; non-completed nodes
 *     skip writing (matches web semantics at useAgentDelegation.ts:1606).
 *   - Scope fields flow through correctly (repoFullName, branch,
 *     chatId, taskGraphId, and role/taskId derived from the node).
 *   - A write failure on one node doesn't abort writes for
 *     subsequent nodes (error isolation).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildTypedMemoryBlockForNode, writeTaskGraphResultMemory } from '../task-graph-memory.ts';
import { createInMemoryStore } from '../../lib/context-memory-store.ts';
import { writeExplorerMemory } from '../../lib/context-memory.ts';

function makeCompletedNodeState(id, agent, overrides = {}) {
  return {
    node: { id, agent, task: `Task ${id}` },
    status: 'completed',
    result: `${id} summary`,
    delegationOutcome: {
      agent,
      status: 'complete',
      summary: `${id} summary`,
      evidence: [],
      checks: [],
      gateVerdicts: [],
      missingRequirements: [],
      nextRequiredAction: null,
      rounds: 1,
      checkpoints: 0,
      elapsedMs: 10,
    },
    ...overrides,
  };
}

function makeResult(states) {
  return {
    success: true,
    aborted: false,
    memoryEntries: new Map(),
    nodeStates: new Map(states.map((s) => [s.node.id, s])),
    summary: '',
    wallTimeMs: 0,
    totalRounds: 0,
  };
}

const scope = {
  repoFullName: 'owner/repo',
  branch: 'main',
  chatId: 'sess-abc',
  taskGraphId: 'graph_123',
};

// ---------------------------------------------------------------------------
// Happy path + scope threading
// ---------------------------------------------------------------------------

describe('writeTaskGraphResultMemory — happy path', () => {
  it('writes one record per completed node with the correct scope fields', async () => {
    const store = createInMemoryStore();
    const result = makeResult([
      makeCompletedNodeState('explore-auth', 'explorer'),
      makeCompletedNodeState('fix-auth', 'coder'),
    ]);

    await writeTaskGraphResultMemory(result, scope, { store });

    const records = await store.list();
    assert.equal(records.length, 2);

    const byTask = new Map(records.map((r) => [r.scope.taskId, r]));
    const explorer = byTask.get('explore-auth');
    const coder = byTask.get('fix-auth');

    assert.equal(explorer?.scope.repoFullName, 'owner/repo');
    assert.equal(explorer?.scope.branch, 'main');
    assert.equal(explorer?.scope.chatId, 'sess-abc');
    assert.equal(explorer?.scope.taskGraphId, 'graph_123');
    assert.equal(explorer?.scope.role, 'explorer');
    assert.equal(explorer?.kind, 'finding');
    assert.ok(explorer?.summary.includes('explore-auth'));

    assert.equal(coder?.scope.role, 'coder');
    assert.equal(coder?.kind, 'task_outcome');
    assert.ok(coder?.summary.includes('fix-auth'));
  });

  it('skips nodes that are not completed (failed, cancelled, pending)', async () => {
    const store = createInMemoryStore();
    const result = makeResult([
      makeCompletedNodeState('done', 'explorer'),
      {
        node: { id: 'failed', agent: 'coder', task: 'Task failed' },
        status: 'failed',
        error: 'boom',
        delegationOutcome: undefined,
      },
      {
        node: { id: 'cancelled', agent: 'coder', task: 'Task cancelled' },
        status: 'cancelled',
        error: 'cancelled',
        delegationOutcome: undefined,
      },
      {
        node: { id: 'pending', agent: 'explorer', task: 'Task pending' },
        status: 'pending',
      },
    ]);

    await writeTaskGraphResultMemory(result, scope, { store });

    const records = await store.list();
    assert.equal(records.length, 1);
    assert.equal(records[0].scope.taskId, 'done');
  });

  it('handles a fully-empty result (no completed nodes) without writing or throwing', async () => {
    const store = createInMemoryStore();
    const result = makeResult([
      {
        node: { id: 'x', agent: 'coder', task: 'Task x' },
        status: 'failed',
        error: 'e',
        delegationOutcome: undefined,
      },
    ]);

    await writeTaskGraphResultMemory(result, scope, { store });
    assert.equal((await store.list()).length, 0);
  });
});

// ---------------------------------------------------------------------------
// Error isolation
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// buildTypedMemoryBlockForNode — retrieval helper
// ---------------------------------------------------------------------------

describe('buildTypedMemoryBlockForNode', () => {
  it('returns null when no records match the scope', async () => {
    const store = createInMemoryStore();
    const block = await buildTypedMemoryBlockForNode({
      node: { id: 'solo', agent: 'explorer', task: 'Investigate the auth flow' },
      scope,
      store,
    });
    assert.equal(block, null);
  });

  it('returns a formatted memory block when relevant records exist', async () => {
    const store = createInMemoryStore();
    await writeExplorerMemory({
      scope: {
        repoFullName: scope.repoFullName,
        branch: scope.branch,
        chatId: scope.chatId,
      },
      summary: 'Auth middleware reads token from cookie at middleware.ts:42',
      relatedFiles: ['middleware.ts'],
      store,
    });

    const block = await buildTypedMemoryBlockForNode({
      node: {
        id: 'fix-auth',
        agent: 'coder',
        task: 'Fix the auth flow',
        files: ['middleware.ts'],
      },
      scope,
      store,
    });

    assert.ok(typeof block === 'string' && block.length > 0, 'expected a non-empty block');
    assert.ok(block.includes('middleware.ts:42'), 'block should include the seeded summary');
  });

  it('returns null when scope has no repoFullName', async () => {
    // repoFullName is required to scope any retrieval; without it
    // there's nothing to query against.
    const store = createInMemoryStore();
    const block = await buildTypedMemoryBlockForNode({
      node: { id: 'x', agent: 'explorer', task: 't' },
      scope: { repoFullName: '' },
      store,
    });
    assert.equal(block, null);
  });

  it('degrades gracefully when the store throws on retrieval', async () => {
    // Simulate a broken store. The helper must log and return null
    // rather than propagating the error up into the delegation loop.
    const brokenStore = createInMemoryStore();
    brokenStore.list = () => {
      throw new Error('simulated retrieval failure');
    };

    const originalWarn = process.stderr.write.bind(process.stderr);
    const warnings = [];
    process.stderr.write = (chunk, ...rest) => {
      warnings.push(String(chunk));
      return true;
    };
    try {
      const block = await buildTypedMemoryBlockForNode({
        node: { id: 'x', agent: 'explorer', task: 't' },
        scope,
        store: brokenStore,
      });
      assert.equal(block, null);
      assert.ok(warnings.some((w) => w.includes('task_graph_memory_retrieve_failed')));
    } finally {
      process.stderr.write = originalWarn;
    }
  });
});

describe('writeTaskGraphResultMemory — error isolation', () => {
  it('continues writing subsequent nodes when one write throws', async () => {
    const store = createInMemoryStore();
    const originalWrite = store.write;
    let writeCount = 0;
    // Make the first write fail; subsequent writes succeed.
    store.write = (record) => {
      writeCount++;
      if (writeCount === 1) throw new Error('simulated write failure');
      return originalWrite.call(store, record);
    };

    const result = makeResult([
      makeCompletedNodeState('first', 'explorer'),
      makeCompletedNodeState('second', 'coder'),
      makeCompletedNodeState('third', 'explorer'),
    ]);

    const errors = [];
    await writeTaskGraphResultMemory(result, scope, {
      store,
      onWriteError: (nodeId, err) => errors.push({ nodeId, err }),
    });

    // First node's write threw, so the record didn't land. Second and
    // third succeeded.
    const records = await store.list();
    const ids = records.map((r) => r.scope.taskId).sort();
    assert.deepEqual(ids, ['second', 'third']);

    assert.equal(errors.length, 1);
    assert.equal(errors[0].nodeId, 'first');
    assert.ok(errors[0].err instanceof Error);
    assert.ok(errors[0].err.message.includes('simulated write failure'));
  });
});
