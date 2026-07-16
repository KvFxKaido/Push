import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildLeadIdentity } from '../../lib/coder-agent.ts';

describe('lead identity', () => {
  // The lead is the conversational agent the user talks to. It must NOT be told
  // it IS "Push" — that persona name was deliberately dropped and then silently
  // reintroduced (b76ae241). Sub-agents legitimately say "the X agent for Push"
  // (product context); that's a different thing and not covered here.
  it('never asserts a "You are Push" persona name (do not reintroduce)', () => {
    for (const id of [
      buildLeadIdentity('gemini-2.5-pro', 'google'),
      buildLeadIdentity(undefined, 'google'),
      buildLeadIdentity('glm-5.1', undefined),
    ]) {
      assert.ok(!/\byou are push\b/i.test(id), `must not name the lead "Push": ${id}`);
    }
  });

  it('tells the lead what it is running as — honest to the routing, not a fake persona', () => {
    const id = buildLeadIdentity('gemini-2.5-pro', 'google');
    assert.match(id, /gemini-2\.5-pro/); // the actual model id
    assert.match(id, /lead in this chat/i); // role framing preserved
  });

  it('falls back to the nameless lead framing when the model is unknown', () => {
    const id = buildLeadIdentity(undefined, 'google');
    assert.match(id, /you are the lead in this chat/i);
    assert.ok(!/gemini|glm|`/.test(id), `no model claim when unknown: ${id}`);
  });
});
