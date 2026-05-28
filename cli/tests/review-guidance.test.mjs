import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { resolveReviewGuidance } from '../../lib/review-guidance.ts';

describe('resolveReviewGuidance (lib core)', () => {
  it('prefers the working copy over the committed copy', async () => {
    let fetchCalled = false;
    const result = await resolveReviewGuidance({
      readWorkingCopy: async () => '# REVIEW.md\nworking copy',
      fetchCommitted: async () => {
        fetchCalled = true;
        return '# REVIEW.md\ncommitted';
      },
    });
    assert.equal(result, '# REVIEW.md\nworking copy');
    assert.equal(fetchCalled, false, 'committed fetch should be skipped when working copy hits');
  });

  it('falls back to the committed copy when the working copy is empty', async () => {
    const result = await resolveReviewGuidance({
      readWorkingCopy: async () => '   ',
      fetchCommitted: async () => '# REVIEW.md\ncommitted',
    });
    assert.equal(result, '# REVIEW.md\ncommitted');
  });

  it('falls back to the committed copy when the working-copy read throws', async () => {
    const result = await resolveReviewGuidance({
      readWorkingCopy: async () => {
        throw new Error('sandbox down');
      },
      fetchCommitted: async () => '# REVIEW.md\ncommitted',
    });
    assert.equal(result, '# REVIEW.md\ncommitted');
  });

  it('trims surrounding whitespace from the resolved content', async () => {
    const result = await resolveReviewGuidance({
      readWorkingCopy: async () => '\n\n# REVIEW.md\nbody\n\n',
    });
    assert.equal(result, '# REVIEW.md\nbody');
  });

  it('returns null when neither source yields content', async () => {
    const result = await resolveReviewGuidance({
      readWorkingCopy: async () => null,
      fetchCommitted: async () => '',
    });
    assert.equal(result, null);
  });

  it('never throws when both sources fail, returning null', async () => {
    const result = await resolveReviewGuidance({
      readWorkingCopy: async () => {
        throw new Error('working copy down');
      },
      fetchCommitted: async () => {
        throw new Error('github down');
      },
    });
    assert.equal(result, null);
  });

  it('returns null when no sources are provided', async () => {
    assert.equal(await resolveReviewGuidance({}), null);
  });
});
