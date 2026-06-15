import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { parseStructured } from '../../lib/structured-output.ts';
import { ReviewerResponseSchema } from '../../lib/review-schema.ts';

// ---------------------------------------------------------------------------
// Shared review schema (consumed by reviewer-agent + deep-reviewer-agent)
// ---------------------------------------------------------------------------

describe('ReviewerResponseSchema', () => {
  it('parses a canonical review payload', () => {
    const r = parseStructured(
      JSON.stringify({
        summary: 'Looks good',
        comments: [{ file: 'a.ts', severity: 'warning', comment: 'nit', line: 12 }],
      }),
      ReviewerResponseSchema,
    );
    assert.equal(r.ok, true);
    assert.equal(r.data.summary, 'Looks good');
    assert.deepEqual(r.data.comments, [
      { file: 'a.ts', severity: 'warning', comment: 'nit', line: 12 },
    ]);
  });

  it('applies defaults and drops empty-comment findings', () => {
    const r = parseStructured(
      JSON.stringify({
        comments: [
          { severity: 'bogus', comment: 'kept' }, // unknown severity -> note, file -> unknown
          { file: 'b.ts', comment: '' }, // empty comment -> filtered out
          { file: 'c.ts', comment: 'x', line: -3 }, // bad line -> omitted
        ],
      }),
      ReviewerResponseSchema,
    );
    assert.equal(r.ok, true);
    assert.equal(r.data.summary, 'No summary provided.');
    assert.deepEqual(r.data.comments, [
      { file: 'unknown', severity: 'note', comment: 'kept' },
      { file: 'c.ts', severity: 'note', comment: 'x' },
    ]);
    // The dropped/omitted shapes carry no `line` key.
    assert.equal('line' in r.data.comments[1], false);
  });

  it('coerces a bare primitive to an empty review (top-level catch)', () => {
    const r = parseStructured('42', ReviewerResponseSchema);
    assert.equal(r.ok, true);
    assert.deepEqual(r.data, { summary: 'No summary provided.', comments: [] });
  });

  it('repairs a trailing comma before validating', () => {
    const r = parseStructured('{"summary":"ok","comments":[],}', ReviewerResponseSchema);
    assert.equal(r.ok, true);
    assert.equal(r.data.summary, 'ok');
  });
});
