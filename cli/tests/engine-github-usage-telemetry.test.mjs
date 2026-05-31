/**
 * Pins `malformedSampleTargetsGithub` — the best-effort recovery that keeps
 * the CLI `github_tool_turn_*` measurement honest when a GitHub call arrives
 * malformed (lands in `detected.malformed`, not `detected.calls`). A malformed
 * `{"tool":"pr"}` is still intent to use the GitHub schema, so it must count as
 * "used"; an unrelated or unrecoverable sample must not.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { malformedSampleTargetsGithub } from '../engine.ts';

describe('malformedSampleTargetsGithub', () => {
  it('recognizes a malformed read-only GitHub call', () => {
    assert.equal(malformedSampleTargetsGithub('{"tool":"pr"}'), true);
    assert.equal(malformedSampleTargetsGithub('{ "tool" : "repo_read", "args": {'), true);
  });

  it('recognizes a malformed write GitHub call', () => {
    assert.equal(malformedSampleTargetsGithub('{"tool":"pr_create","args":{"repo":'), true);
  });

  it('does not count a non-GitHub tool as a GitHub attempt', () => {
    assert.equal(malformedSampleTargetsGithub('{"tool":"write_file","args":{'), false);
    assert.equal(malformedSampleTargetsGithub('{"tool":"exec"}'), false);
  });

  it('returns false when no tool name is recoverable from the sample', () => {
    assert.equal(malformedSampleTargetsGithub('not json at all'), false);
    assert.equal(malformedSampleTargetsGithub(''), false);
    assert.equal(malformedSampleTargetsGithub('{"args":{"repo":"a/b"}}'), false);
  });

  it('does not count an unknown tool name', () => {
    assert.equal(malformedSampleTargetsGithub('{"tool":"definitely_not_a_tool"}'), false);
  });
});
