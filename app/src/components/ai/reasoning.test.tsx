import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Reasoning, ReasoningContent, ReasoningTrigger } from './reasoning';

function attrOfSlot(html: string, slot: string, attr: string): string | null {
  const el = html.match(new RegExp(`<[^>]*data-slot="${slot}"[^>]*>`))?.[0];
  return el?.match(new RegExp(`${attr}="([^"]*)"`))?.[1] ?? null;
}

describe('Reasoning', () => {
  it('links trigger aria-controls to content id (single Collapsible root)', () => {
    const html = renderToStaticMarkup(
      <Reasoning open>
        <ReasoningTrigger />
        <ReasoningContent>trace</ReasoningContent>
      </Reasoning>,
    );
    const ariaControls = attrOfSlot(html, 'collapsible-trigger', 'aria-controls');
    const contentId = attrOfSlot(html, 'collapsible-content', 'id');
    expect(ariaControls).toBeTruthy();
    expect(ariaControls).toBe(contentId);
  });

  it('renders the streaming vs settled label', () => {
    const streaming = renderToStaticMarkup(
      <Reasoning open isStreaming>
        <ReasoningTrigger />
      </Reasoning>,
    );
    const settled = renderToStaticMarkup(
      <Reasoning open>
        <ReasoningTrigger />
      </Reasoning>,
    );
    expect(streaming).toContain('Reasoning');
    expect(settled).toContain('Thought process');
  });

  it('renders arbitrary content children (e.g. a markdown renderer)', () => {
    const html = renderToStaticMarkup(
      <Reasoning open>
        <ReasoningContent>
          <article data-testid="md">hello</article>
        </ReasoningContent>
      </Reasoning>,
    );
    expect(html).toContain('data-testid="md"');
    expect(html).toContain('hello');
  });

  it('keeps content collapsed (unmounted) when closed', () => {
    const html = renderToStaticMarkup(
      <Reasoning open={false}>
        <ReasoningTrigger />
        <ReasoningContent>secret-trace</ReasoningContent>
      </Reasoning>,
    );
    expect(html).not.toContain('secret-trace');
  });
});
