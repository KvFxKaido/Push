import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatByteSize, findLastAssistantText, findLastCodeBlock } from '../tui-copy.ts';

describe('formatByteSize', () => {
  it('renders small counts in bytes', () => {
    assert.equal(formatByteSize(0), '0 B');
    assert.equal(formatByteSize(42), '42 B');
    assert.equal(formatByteSize(1023), '1023 B');
  });

  it('switches to KB at 1024', () => {
    assert.equal(formatByteSize(1024), '1.0 KB');
    assert.equal(formatByteSize(1536), '1.5 KB');
  });

  it('switches to MB at 1 MiB', () => {
    assert.equal(formatByteSize(1024 * 1024), '1.0 MB');
    assert.equal(formatByteSize(5 * 1024 * 1024), '5.0 MB');
  });
});

describe('findLastAssistantText', () => {
  it('returns null when transcript is empty', () => {
    assert.equal(findLastAssistantText({ transcript: [] }), null);
  });

  it('returns null when there are no assistant entries', () => {
    const state = {
      transcript: [
        { role: 'user', text: 'hi' },
        { role: 'status', text: 'running' },
      ],
    };
    assert.equal(findLastAssistantText(state), null);
  });

  it('returns the most recent assistant text', () => {
    const state = {
      transcript: [
        { role: 'assistant', text: 'first' },
        { role: 'user', text: 'then' },
        { role: 'assistant', text: 'most recent' },
        { role: 'status', text: 'after' },
      ],
    };
    assert.equal(findLastAssistantText(state), 'most recent');
  });

  it('skips assistant entries with empty or missing text', () => {
    const state = {
      transcript: [
        { role: 'assistant', text: 'real content' },
        { role: 'assistant', text: '' },
        { role: 'assistant' },
      ],
    };
    assert.equal(findLastAssistantText(state), 'real content');
  });
});

describe('findLastCodeBlock', () => {
  it('returns null when no assistant entries have code blocks', () => {
    const state = {
      transcript: [
        { role: 'assistant', text: 'just prose, no fences here' },
        { role: 'user', text: '```fake```' }, // user entries are ignored
      ],
    };
    assert.equal(findLastCodeBlock(state), null);
  });

  it('returns the body of a single fenced block', () => {
    const state = {
      transcript: [
        { role: 'assistant', text: 'Here is some code:\n```js\nconst x = 1;\n```\nDone.' },
      ],
    };
    assert.equal(findLastCodeBlock(state), 'const x = 1;');
  });

  it('returns the last block when a message has multiple', () => {
    const state = {
      transcript: [
        {
          role: 'assistant',
          text: '```\nfirst\n```\n\nmiddle prose\n\n```sh\nsecond\n```',
        },
      ],
    };
    assert.equal(findLastCodeBlock(state), 'second');
  });

  it('searches newest-first across multiple assistant entries', () => {
    const state = {
      transcript: [
        { role: 'assistant', text: '```py\nold = True\n```' },
        { role: 'user', text: 'follow up' },
        { role: 'assistant', text: 'no code in this reply' },
      ],
    };
    // The newest assistant reply has no code, so we fall back to the older one.
    assert.equal(findLastCodeBlock(state), 'old = True');
  });

  it('handles blocks without a language tag', () => {
    const state = {
      transcript: [{ role: 'assistant', text: '```\nplain\n```' }],
    };
    assert.equal(findLastCodeBlock(state), 'plain');
  });

  it('preserves inner newlines but strips the trailing one', () => {
    const state = {
      transcript: [{ role: 'assistant', text: '```\nline1\nline2\n```' }],
    };
    assert.equal(findLastCodeBlock(state), 'line1\nline2');
  });
});
