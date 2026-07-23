import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { taskProgressEventToTranscript } from '../tui-task-progress.ts';

describe('task progress transcript renderer', () => {
  it('renders the task ledger as a compact checklist', () => {
    const entry = taskProgressEventToTranscript({
      type: 'task.ledger_snapshot',
      payload: {
        steps: [
          { id: 'a', content: 'Read code', activeForm: 'Reading code', status: 'completed' },
          { id: 'b', content: 'Write fix', activeForm: 'Writing fix', status: 'in_progress' },
        ],
      },
    });
    assert.equal(entry?.role, 'status');
    assert.match(entry?.text ?? '', /Task progress · 1\/2 done/);
    assert.match(entry?.text ?? '', /\[~\] Writing fix/);
  });

  it('renders firing and clearing drift transitions', () => {
    const stalled = taskProgressEventToTranscript({
      type: 'task.drift_changed',
      payload: {
        health: 'possibly_stalled',
        active: [{ detail: 'read activity found no new target for 4 rounds' }],
      },
    });
    assert.equal(stalled?.role, 'warning');
    assert.match(stalled?.text ?? '', /possibly stalled/);

    const resumed = taskProgressEventToTranscript({
      type: 'task.drift_changed',
      payload: { health: 'working', cleared: ['no_novel_reads'] },
    });
    assert.equal(resumed?.role, 'status');
    assert.match(resumed?.text ?? '', /cleared no_novel_reads/);
  });
});
