import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { reconcileStreamFrame, streamSettledEnd } from '../tui-stream-frame.ts';
import { renderAssistantEntryLines } from '../tui-framers.ts';
import { createTheme } from '../tui-theme.ts';

describe('streamSettledEnd', () => {
  it('settles complete lines up to the last newline, leaving the partial tail', () => {
    // "a\nb\nc" → "a\n" and "b\n" are settled (4 bytes), "c" is the partial tail.
    assert.equal(streamSettledEnd('a\nb\nc'), 4);
  });

  it('treats a buffer with no newline as fully volatile', () => {
    assert.equal(streamSettledEnd('hello world'), 0);
  });

  it('settles everything when the buffer ends with a newline', () => {
    assert.equal(streamSettledEnd('a\nb\n'), 4);
  });

  it('freezes the boundary at an open fence (open fence stays volatile)', () => {
    // The ``` opens a fence at byte 4; everything from there is volatile.
    const text = 'pre\n```js\nconst x = 1\n';
    assert.equal(streamSettledEnd(text), 'pre\n'.length);
  });

  it('settles a closed fence as part of the prefix', () => {
    const text = 'pre\n```js\nconst x = 1\n```\nmore';
    // Up to and including the closing ``` newline is settled; "more" is volatile.
    const settled = 'pre\n```js\nconst x = 1\n```\n';
    assert.equal(streamSettledEnd(text), settled.length);
  });
});

// The invariant that makes the freeze safe: framing incrementally (settled
// prefix cached, tail reframed) must be byte-identical to framing the whole
// buffer in one pass — for every prefix, as the stream grows token by token.
describe('reconcileStreamFrame — incremental == whole, via the real framer', () => {
  const WIDTH = 64;
  const theme = createTheme({ tier: 'none', unicode: true, name: 'default' });
  const sig = `${WIDTH}::default::0`;

  const frameWhole = (text) => {
    const out = [];
    renderAssistantEntryLines(out, text, WIDTH, theme, { payloadUI: null });
    return out;
  };
  const frameChunk = (src, firstPrefixConsumed) => {
    const out = [];
    renderAssistantEntryLines(out, src, WIDTH, theme, { payloadUI: null, firstPrefixConsumed });
    return out;
  };

  // Replay `final` one character at a time, threading state as the live render
  // loop does, and assert the reconciled output matches a whole-buffer pass at
  // every step.
  const assertGrowsCorrectly = (final) => {
    let state = null;
    for (let i = 1; i <= final.length; i++) {
      const text = final.slice(0, i);
      const result = reconcileStreamFrame({ text, sig, prev: state, frameChunk });
      state = result.state;
      assert.deepEqual(
        result.lines,
        frameWhole(text),
        `mismatch at prefix length ${i}: ${JSON.stringify(text)}`,
      );
    }
  };

  it('matches for plain prose across newlines', () => {
    assertGrowsCorrectly('Here is a first line.\nAnd a second line.\nThird.');
  });

  it('matches across a closed code fence followed by prose', () => {
    assertGrowsCorrectly('Intro paragraph.\n\n```js\nconst x = 1;\nconst y = 2;\n```\n\nDone.');
  });

  it('matches while a code fence is still open (volatile tail)', () => {
    assertGrowsCorrectly('Look:\n\n```python\ndef f(x):\n    return x + 1');
  });

  it('matches with headings, bullets, quotes, and a horizontal rule', () => {
    assertGrowsCorrectly(
      '# Title\n\n- one\n- two\n\n> a quote line\n\n---\n\nclosing prose that wraps a bit',
    );
  });

  it('matches for two back-to-back fences', () => {
    assertGrowsCorrectly('```\nplain block\n```\nmid\n```ts\nconst z = 3;\n```\ntail');
  });
});

describe('reconcileStreamFrame — cache behaviour', () => {
  const sig = 'w::t::0';

  // A line-local fake framer: each non-empty source line → "<cont>:<line>",
  // recording how many source lines it framed so we can prove the settled
  // prefix isn't reframed once cached.
  const makeCounting = () => {
    const calls = [];
    const frameChunk = (src, firstPrefixConsumed) => {
      calls.push(src);
      return src
        .split('\n')
        .filter((l) => l !== '')
        .map((l) => `${firstPrefixConsumed ? 'c' : 'f'}:${l}`);
    };
    return { calls, frameChunk };
  };

  it('frames a newly-settled chunk once, then only reframes the tail', () => {
    const { calls, frameChunk } = makeCounting();

    // First pass: "a\nb" → "a\n" settles, "b" is tail.
    let r = reconcileStreamFrame({ text: 'a\nb', sig, prev: null, frameChunk });
    assert.deepEqual(r.lines, ['f:a', 'c:b']);
    // Two frame calls: settled chunk (trailing '\n' stripped → "a") and tail "b".
    assert.deepEqual(calls, ['a', 'b']);

    // Second pass: more of the tail line arrives ("b" → "bc"). Settled prefix
    // "a\n" must NOT be reframed — only the tail.
    calls.length = 0;
    r = reconcileStreamFrame({ text: 'a\nbc', sig, prev: r.state, frameChunk });
    assert.deepEqual(r.lines, ['f:a', 'c:bc']);
    assert.deepEqual(calls, ['bc']); // settled chunk not re-framed
  });

  it('extends the settled prefix when the tail line completes', () => {
    const { calls, frameChunk } = makeCounting();
    let r = reconcileStreamFrame({ text: 'a\nb', sig, prev: null, frameChunk });
    calls.length = 0;
    // "b" completes ("a\nb\n") then "c" starts.
    r = reconcileStreamFrame({ text: 'a\nb\nc', sig, prev: r.state, frameChunk });
    assert.deepEqual(r.lines, ['f:a', 'c:b', 'c:c']);
    // Newly-settled chunk (stripped → "b") framed once; tail "c" framed. "a" reused.
    assert.deepEqual(calls, ['b', 'c']);
  });

  it('resets the cache when the signature changes', () => {
    const { calls, frameChunk } = makeCounting();
    let r = reconcileStreamFrame({ text: 'a\nb', sig, prev: null, frameChunk });
    calls.length = 0;
    r = reconcileStreamFrame({ text: 'a\nb', sig: 'w2::t::0', prev: r.state, frameChunk });
    // Width changed → settled prefix reframed from scratch.
    assert.deepEqual(calls, ['a', 'b']);
    assert.deepEqual(r.lines, ['f:a', 'c:b']);
  });

  it('resets when the buffer shrinks (new stream after a commit)', () => {
    const { calls, frameChunk } = makeCounting();
    let r = reconcileStreamFrame({ text: 'old\nlong\nx', sig, prev: null, frameChunk });
    calls.length = 0;
    // New, shorter stream — must not reuse the old settled prefix.
    r = reconcileStreamFrame({ text: 'n', sig, prev: r.state, frameChunk });
    assert.deepEqual(r.lines, ['f:n']);
    assert.deepEqual(calls, ['n']);
  });
});
