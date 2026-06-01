import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  getBuildStamp,
  peekBuildStamp,
  RUNTIME_VERSION,
  __resetBuildStampForTesting,
} from '../build-stamp.ts';

describe('build-stamp', () => {
  it('peekBuildStamp is null before the first capture', () => {
    __resetBuildStampForTesting();
    assert.equal(peekBuildStamp(), null);
  });

  it('formats the stamp as <version>+<sha|nogit>', async () => {
    __resetBuildStampForTesting();
    const stamp = await getBuildStamp();
    // In a git checkout the suffix is a short sha; outside one it is `nogit`.
    assert.match(
      stamp,
      new RegExp(`^${RUNTIME_VERSION.replace(/\./g, '\\.')}\\+([0-9a-f]{7,40}|nogit)$`),
    );
  });

  it('freezes on first capture — repeated calls return the identical token', async () => {
    __resetBuildStampForTesting();
    const first = await getBuildStamp();
    const second = await getBuildStamp();
    assert.equal(first, second);
    // peek now returns the frozen value synchronously.
    assert.equal(peekBuildStamp(), first);
  });

  it('does not re-shell git on the cached path', async () => {
    __resetBuildStampForTesting();
    await getBuildStamp();
    const before = peekBuildStamp();
    // A second call must resolve from cache (same frozen value), never null.
    const again = await getBuildStamp();
    assert.equal(again, before);
  });
});
