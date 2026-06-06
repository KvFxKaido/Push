import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { parseStructured } from '../../lib/structured-output.ts';
import { ReviewerResponseSchema } from '../../lib/review-schema.ts';
import { parsePlannerResponse } from '../../lib/planner-core.ts';

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

// ---------------------------------------------------------------------------
// Planner response parsing
// ---------------------------------------------------------------------------

describe('parsePlannerResponse', () => {
  it('parses a plan and shapes optional feature fields', () => {
    const plan = parsePlannerResponse(
      JSON.stringify({
        approach: 'do the thing',
        features: [
          {
            id: 'f1',
            description: 'first',
            files: ['a.ts', 7, 'b.ts'],
            verifyCommand: 'npm test',
            dependsOn: ['f0', null],
            addresses: '  goal  ',
          },
        ],
      }),
    );
    assert.notEqual(plan, null);
    assert.equal(plan.approach, 'do the thing');
    assert.deepEqual(plan.features[0], {
      id: 'f1',
      description: 'first',
      files: ['a.ts', 'b.ts'], // non-string members filtered
      verifyCommand: 'npm test',
      dependsOn: ['f0'], // null filtered
      addresses: 'goal', // trimmed
    });
  });

  it('unwraps a fenced response and defaults a missing approach to ""', () => {
    const plan = parsePlannerResponse('```json\n{"features":[{"id":"f1","description":"d"}]}\n```');
    assert.notEqual(plan, null);
    assert.equal(plan.approach, '');
    assert.deepEqual(plan.features, [{ id: 'f1', description: 'd' }]);
  });

  it('drops features missing id or description', () => {
    const plan = parsePlannerResponse(
      JSON.stringify({
        features: [
          { id: 'ok', description: 'keep' },
          { id: 'no-desc' },
          { description: 'no-id' },
          'not-an-object',
        ],
      }),
    );
    assert.notEqual(plan, null);
    assert.deepEqual(plan.features, [{ id: 'ok', description: 'keep' }]);
  });

  it('returns null when no usable features survive', () => {
    const plan = parsePlannerResponse(JSON.stringify({ approach: 'x', features: [{ id: 'a' }] }));
    assert.equal(plan, null);
  });

  it('returns null on unparseable input', () => {
    assert.equal(parsePlannerResponse('not json <<<'), null);
  });

  it('recovers a trailing-comma response via repair', () => {
    const plan = parsePlannerResponse('{"features":[{"id":"f1","description":"d"},],}');
    assert.notEqual(plan, null);
    assert.deepEqual(plan.features, [{ id: 'f1', description: 'd' }]);
  });
});
