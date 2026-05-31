/**
 * Pins the unified malformed-call shape: the dispatcher kernel now surfaces the
 * attempted `tool` name on malformed candidates via `rawToolName`, so both
 * surfaces can attribute a malformed call (e.g. `{"tool":"pr"}` with no args)
 * to its source without re-parsing the truncated sample. This is what keeps the
 * CLI `github_tool_turn_*` measurement honest in the malformed/early branch —
 * it replaces the earlier regex-on-sample hack.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { detectAllToolCalls } from '../tools.ts';
import { getToolSourceFromName } from '../../lib/tool-registry.ts';

function fenced(json) {
  return '```json\n' + json + '\n```';
}

describe('detectAllToolCalls — malformed rawToolName', () => {
  it('surfaces the attempted GitHub tool name on a missing-args malformed call', () => {
    const detected = detectAllToolCalls(fenced('{"tool":"pr"}'));
    assert.equal(detected.calls.length, 0);
    assert.equal(detected.malformed.length, 1);
    assert.equal(detected.malformed[0].reason, 'missing_args_object');
    assert.equal(detected.malformed[0].rawToolName, 'pr');
    // Which is what the usage emit checks to classify the turn as "used".
    assert.equal(getToolSourceFromName(detected.malformed[0].rawToolName), 'github');
  });

  it('surfaces a non-GitHub tool name so it is NOT miscounted as a GitHub attempt', () => {
    const detected = detectAllToolCalls(fenced('{"tool":"write_file"}'));
    assert.equal(detected.malformed.length, 1);
    assert.equal(detected.malformed[0].rawToolName, 'write_file');
    assert.notEqual(getToolSourceFromName(detected.malformed[0].rawToolName), 'github');
  });

  it('recovers the GitHub tool name even when the JSON fails to parse', () => {
    // Regression guard: a malformed-but-named call that fails JSON parsing
    // (not just missing `args`) must still attribute to GitHub. The kernel
    // best-effort-extracts the name from the sample, so this no longer needs a
    // per-surface regex.
    const detected = detectAllToolCalls(fenced('{"tool":"repo_read", "args": }'));
    assert.equal(detected.malformed.length, 1);
    assert.equal(detected.malformed[0].reason, 'json_parse_error');
    assert.equal(detected.malformed[0].rawToolName, 'repo_read');
    assert.equal(getToolSourceFromName(detected.malformed[0].rawToolName), 'github');
  });
});
