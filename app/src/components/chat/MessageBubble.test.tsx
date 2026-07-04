import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ChatCard, ChatMessage } from '@/types';
import { MessageBubble } from './MessageBubble';
import { createMessageViewStateStore, MessageViewStateContext } from '@/hooks/useMessageViewState';

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

  it('draws the hexagon avatar while the reply streams', () => {
    const message = assistantMessage({ content: 'hello', status: 'streaming' });
    const html = renderToStaticMarkup(<MessageBubble message={message} />);
    // The avatar path carries the streaming trace class only while streaming.
    expect(html).toContain('hex-thinking');
  });

  it('auto-opens the reasoning trace while streaming', () => {
    const message = assistantMessage({
      content: 'answer has started',
      thinking: 'still reasoning through the next step',
      status: 'streaming',
    });

    const html = renderToStaticMarkup(<MessageBubble message={message} />);
    // The disclosure coexists with the answer, showing its streaming label.
    expect(html).toContain('Reasoning');
    expect(html).not.toContain('Thought process');
    expect(html).toContain('answer');
    // Auto-follows streaming: with no manual toggle the pane is open, so the
    // trace is visible live (not tucked behind a collapsed disclosure).
    expect(html).toContain('still reasoning through the next step');
  });

  it('tucks the reasoning trace once settled (no manual toggle)', () => {
    const message = assistantMessage({
      content: 'the answer',
      thinking: 'private reasoning trace',
      status: 'done',
    });

    const html = renderToStaticMarkup(<MessageBubble message={message} />);
    expect(html).toContain('Thought process');
    // Settled + untoggled → auto-collapsed, so the trace is unmounted.
    expect(html).not.toContain('private reasoning trace');
  });

  it("pins the user's manual collapse against the streaming auto-open", () => {
    const store = createMessageViewStateStore();
    // User collapsed it during streaming: pinned closed despite auto-open.
    store.set('assistant-1', { reasoningExpanded: false, reasoningUserSet: true });
    const message = assistantMessage({
      thinking: 'reasoning the user hid',
      status: 'streaming',
    });

    const html = renderToStaticMarkup(
      <MessageViewStateContext.Provider value={store}>
        <MessageBubble message={message} />
      </MessageViewStateContext.Provider>,
    );
    expect(html).toContain('Reasoning');
    // Pinned closed wins over the streaming auto-open.
    expect(html).not.toContain('reasoning the user hid');
  });

  it('settles the hexagon avatar to a static stroke once done', () => {
    const message = assistantMessage({ content: 'hello', status: 'done' });
    const html = renderToStaticMarkup(<MessageBubble message={message} />);
    expect(html).not.toContain('hex-thinking');
  });

  it('renders the pill stream caret while streaming', () => {
    const message = assistantMessage({ content: 'hello', status: 'streaming' });
    const html = renderToStaticMarkup(<MessageBubble message={message} />);
    // The caret is the pill; the experimental hexagon caret variant was reverted.
    expect(html).toContain('stream-caret');
    expect(html).not.toContain('stream-caret-hex');
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

  it('renders the assistant action row hidden AND non-interactive at rest', () => {
    // opacity-0 alone still receives taps (Codex P2), so the invisible row could
    // fire Copy/Regenerate/Pin — pointer-events must be gated too. It reveals on
    // hover (pointer) or long-press (touch); the always-on touch fallback is gone.
    const message = assistantMessage({ content: 'hello', status: 'done' });
    const html = renderToStaticMarkup(<MessageBubble message={message} onPin={() => {}} />);
    expect(html).toContain('pointer-events-none');
    expect(html).toContain('group-hover/assistant:pointer-events-auto');
    expect(html).not.toContain('[@media(hover:none)]');
  });

  it('gates the user message action row the same way', () => {
    const message: ChatMessage = {
      id: 'user-1',
      role: 'user',
      content: 'hi',
      timestamp: 1,
      status: 'done',
    };
    const html = renderToStaticMarkup(<MessageBubble message={message} onEdit={() => {}} />);
    expect(html).toContain('pointer-events-none');
    expect(html).toContain('group-hover/user:pointer-events-auto');
  });

  // Revealed (touch long-press): the action row must be INTERACTIVE, i.e. carry
  // `pointer-events-auto` and NOT a co-present `pointer-events-none`. Tailwind v4
  // emits `.pointer-events-none` after `.pointer-events-auto`, so when both were
  // applied the resting `-none` won — the row showed (opacity-100 wins) but every
  // button was dead. These pin the mutually-exclusive class swap.
  function renderRevealed(message: ChatMessage) {
    const store = createMessageViewStateStore();
    store.set(message.id, { actionsRevealed: true });
    return renderToStaticMarkup(
      <MessageViewStateContext.Provider value={store}>
        <MessageBubble message={message} onPin={() => {}} onEdit={() => {}} />
      </MessageViewStateContext.Provider>,
    );
  }

  it('makes the revealed assistant action row interactive (no resting pointer-events-none)', () => {
    const html = renderRevealed(assistantMessage({ id: 'assistant-rev', content: 'hello' }));
    expect(html).toContain('pointer-events-auto group-hover/assistant');
    expect(html).not.toContain('pointer-events-none group-hover/assistant');
  });

  it('makes the revealed user action row interactive (no resting pointer-events-none)', () => {
    const message: ChatMessage = {
      id: 'user-rev',
      role: 'user',
      content: 'hi',
      timestamp: 1,
      status: 'done',
    };
    const html = renderRevealed(message);
    expect(html).toContain('pointer-events-auto group-hover/user');
    expect(html).not.toContain('pointer-events-none group-hover/user');
  });
});
