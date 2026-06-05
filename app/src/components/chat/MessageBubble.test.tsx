import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ChatCard, ChatMessage } from '@/types';
import { MessageBubble } from './MessageBubble';

function assistantMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'assistant-1',
    role: 'assistant',
    content: '',
    timestamp: 1,
    status: 'done',
    ...overrides,
  };
}

describe('MessageBubble', () => {
  it('hides malformed assistant messages with no cards', () => {
    const message = assistantMessage({
      content:
        'workspace/app && npm audit fix && npx vitest run src/lib/orchestrator.test.ts && npm audit --json","workdir":"/workspace"}}',
      isMalformed: true,
    });

    const html = renderToStaticMarkup(<MessageBubble message={message} />);
    expect(html).toBe('');
  });

  it('keeps cards visible while hiding malformed assistant text', () => {
    const legacyCard = {
      type: 'browser-screenshot',
      data: { url: 'https://example.com' },
    } as unknown as ChatCard;

    const message = assistantMessage({
      content:
        'workspace/app && npm audit fix && npx vitest run src/lib/orchestrator.test.ts && npm audit --json","workdir":"/workspace"}}',
      isMalformed: true,
      cards: [legacyCard],
    });

    const html = renderToStaticMarkup(<MessageBubble message={message} />);
    expect(html).not.toContain('npm audit fix');
    expect(html).toContain('[browser-screenshot]');
  });

  it('wraps streaming assistant words in shimmer spans', () => {
    const message = assistantMessage({ content: 'hello world', status: 'streaming' });
    const html = renderToStaticMarkup(<MessageBubble message={message} />);
    expect(html).toContain('class="stream-word"');
    // Each visible word becomes its own span; whitespace stays unwrapped.
    expect(html.match(/class="stream-word"/g)?.length).toBe(2);
    expect(html).toContain('hello');
    expect(html).toContain('world');
  });

  it('does not wrap words once the message has settled', () => {
    const message = assistantMessage({ content: 'hello world', status: 'done' });
    const html = renderToStaticMarkup(<MessageBubble message={message} />);
    expect(html).not.toContain('stream-word');
    expect(html).toContain('hello world');
  });

  it('hides malformed tool JSON before any renderer (sanitation is upstream)', () => {
    // Fixture case 7: malformed tool JSON. Hiding happens in displayContentText /
    // hasContent, ahead of the markdown renderer, so it is renderer-agnostic —
    // the Streamdown adapter never receives this text.
    const message = assistantMessage({
      content: '{"tool": "repo_read", "args": {"path": "READ',
      isMalformed: true,
    });
    const html = renderToStaticMarkup(<MessageBubble message={message} />);
    expect(html).toBe('');
    expect(html).not.toContain('repo_read');
  });

  it('strips non-http(s) markdown link schemes, keeping the link text as plain', () => {
    const message = assistantMessage({
      content: '[js](javascript:alert(1)) [data](data:text/html,<b>x</b>) [safe](https://ok.com)',
      status: 'done',
    });
    const html = renderToStaticMarkup(<MessageBubble message={message} />);
    // Dangerous schemes never reach an href...
    expect(html).not.toContain('javascript:');
    expect(html).not.toContain('data:text/html');
    // ...but their visible text is preserved as plain, non-clickable content.
    expect(html).toContain('js');
    expect(html).toContain('data');
    // A plain http(s) link still renders as a real anchor.
    expect(html).toContain('href="https://ok.com"');
  });

  it('leaves code blocks unshimmered while streaming', () => {
    const message = assistantMessage({
      content: 'run this:\n```\nnpm install\n```',
      status: 'streaming',
    });
    const html = renderToStaticMarkup(<MessageBubble message={message} />);
    // Prose outside the fence still shimmers...
    expect(html).toContain('class="stream-word"');
    // ...but the code text is not split into word spans.
    expect(html).toContain('npm install');
    expect(html).not.toMatch(/stream-word"[^>]*>npm</);
  });
});
