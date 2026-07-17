import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { groupSilveryTranscriptRows } from '../silvery/transcript-groups.ts';

function tool(id, toolName, overrides = {}) {
  return {
    id,
    kind: 'tool',
    role: 'coder',
    text: toolName,
    toolName,
    pending: false,
    ...overrides,
  };
}

describe('groupSilveryTranscriptRows', () => {
  it('folds consecutive settled tools into a mixed-verb summary without changing the rows', () => {
    const rows = [
      tool('read-a', 'read_file', { target: 'a.ts' }),
      tool('read-b', 'read_file', { target: 'b.ts' }),
      tool('exec', 'sandbox_exec', { target: 'pnpm test' }),
    ];

    const display = groupSilveryTranscriptRows(rows);

    assert.equal(display.length, 1);
    const group = display[0];
    assert.equal(group?.kind, 'tool_group');
    assert.equal(group?.id, 'tool-group-read-a');
    // The exec bucket holds one call, so it renders its concrete target rather
    // than a count of one — which was discarding the `pnpm test` this very
    // fixture supplies. Was 'Read 2 files, Ran 1 command'.
    assert.equal(group?.summary, 'Read 2 files, Ran pnpm test');
    assert.deepEqual(
      group?.items.map((item) => item.id),
      ['read-a', 'read-b', 'exec'],
    );
    assert.equal(group?.items[0], rows[0]);
  });

  it('keeps pending, failed, and singleton tools visible as group boundaries', () => {
    const first = tool('first', 'read_file');
    const failed = tool('failed', 'read_file', { isError: true });
    const pending = tool('pending', 'read_file', { pending: true });
    const message = {
      id: 'message',
      kind: 'message',
      role: 'assistant',
      text: 'Next I will inspect the tests.',
    };
    const rows = [
      first,
      failed,
      tool('between', 'read_file'),
      pending,
      message,
      tool('group-a', 'read_file'),
      tool('group-b', 'read_file'),
    ];

    const display = groupSilveryTranscriptRows(rows);

    assert.deepEqual(
      display.map((item) => item.kind),
      ['tool', 'tool', 'tool', 'tool', 'message', 'tool_group'],
    );
    assert.equal(display[0], first);
    assert.equal(display[1], failed);
    assert.equal(display[3], pending);
    assert.equal(display[4], message);
    assert.equal(display[5]?.summary, 'Read 2 files');
  });
});
