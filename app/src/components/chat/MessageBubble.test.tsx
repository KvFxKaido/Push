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
      content: 'workspace/app && npm audit fix && npx vitest run src/lib/orchestrator.test.ts && npm audit --json","workdir":"/workspace"}}',
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
      content: 'workspace/app && npm audit fix && npx vitest run src/lib/orchestrator.test.ts && npm audit --json","workdir":"/workspace"}}',
      isMalformed: true,
      cards: [legacyCard],
    });

    const html = renderToStaticMarkup(<MessageBubble message={message} />);
    expect(html).not.toContain('npm audit fix');
    expect(html).toContain('[browser-screenshot]');
  });
});
