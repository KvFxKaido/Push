import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { PushMarkdownRenderer } from './PushMarkdownRenderer';

function render(text: string, isStreaming = false): string {
  return renderToStaticMarkup(<PushMarkdownRenderer text={text} isStreaming={isStreaming} />);
}

function renderPlain(text: string, isStreaming = false): string {
  return renderToStaticMarkup(
    <PushMarkdownRenderer text={text} isStreaming={isStreaming} enableCodeHighlight={false} />,
  );
}

describe('PushMarkdownRenderer (Streamdown adapter)', () => {
  // 1. Plain paragraphs
  it('renders plain paragraphs', () => {
    const html = render('First paragraph.\n\nSecond paragraph.');
    expect(html).toContain('First paragraph.');
    expect(html).toContain('Second paragraph.');
    expect(html).toContain('<p');
  });

  // 2. Nested lists (the legacy regex parser could not do this)
  it('renders nested lists with real list semantics', () => {
    const html = render('- top\n  - nested a\n  - nested b\n- second');
    expect(html).toContain('<ul');
    expect(html).toContain('list-disc');
    expect(html).toContain('nested a');
    // A nested <ul> appears inside an <li>.
    expect(html.match(/<ul/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it('renders ordered lists', () => {
    const html = render('1. one\n2. two\n3. three');
    expect(html).toContain('<ol');
    expect(html).toContain('list-decimal');
    expect(html).toContain('three');
  });

  // 3. Tables (GFM) — legacy parser had no table support
  it('renders GFM tables wrapped in a horizontal scroller', () => {
    const html = render('| A | B |\n| --- | --- |\n| 1 | 2 |');
    expect(html).toContain('<table');
    expect(html).toContain('overflow-x-auto');
    expect(html).toContain('<th');
    expect(html).toContain('<td');
    expect(html).toContain('>A<');
    expect(html).toContain('>2<');
  });

  // 4. Unclosed code fence mid-stream
  it('renders an unterminated code fence cleanly while streaming', () => {
    const html = render('Here is code:\n```\nnpm install streamdown', true);
    expect(html).toContain('<pre');
    expect(html).toContain('npm install streamdown');
    // No raw backticks leaked into the output.
    expect(html).not.toContain('```');
  });

  // 6. Links
  it('renders links with new-tab + hardened rel', () => {
    const html = render('See [Push](https://example.com/docs).');
    expect(html).toContain('href="https://example.com/docs"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('text-push-accent');
    expect(html).toContain('>Push<');
  });

  // Security: images are disallowed (parity with the legacy parser + no remote loads)
  it('does not render markdown images', () => {
    const html = render('![alt](https://evil.example/tracker.png)');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('tracker.png');
  });

  describe('with code highlighting (default)', () => {
    // 5. Inline code — Streamdown's themed chip (Push shadcn `bg-muted`)
    it('renders inline code as a chip, not a block', () => {
      const html = render('Run `npm test` now.');
      expect(html).toContain('data-streamdown="inline-code"');
      expect(html).toContain('npm test');
      expect(html).not.toContain('data-streamdown="code-block"');
    });

    // Fenced blocks render through Streamdown's Shiki CodeBlock
    it('renders a fenced code block with the highlighter structure', () => {
      const html = render('```ts\nconst x = 1;\n```');
      expect(html).toContain('data-streamdown="code-block"');
      // Shiki token spans, with the code text intact.
      expect(html).toContain('const x = 1;');
      expect(html).toContain('--sdm'); // Shiki CSS-variable token styling
    });

    // 8. Long code lines on mobile — body is a horizontal scroller
    it('keeps long code lines scrollable rather than wrapping', () => {
      const longLine = 'const x = ' + "'a'.repeat().".repeat(20) + 'end;';
      const html = render('```\n' + longLine + '\n```');
      expect(html).toContain('data-streamdown="code-block"');
      expect(html).toContain('overflow-x-auto');
      expect(html).toContain('end;');
    });
  });

  describe('with code highlighting disabled', () => {
    // 5. Inline code — Push chip
    it('renders inline code as a Push-styled chip', () => {
      const html = renderPlain('Run `npm test` now.');
      expect(html).toContain('<code');
      expect(html).toContain('npm test');
      expect(html).toContain('bg-push-surface');
      expect(html).not.toContain('<pre');
    });

    // 8. Long code lines — plain Push pre with horizontal scroll, no Shiki
    it('renders fenced blocks as plain scrollable Push code', () => {
      const longLine = 'const x = ' + "'a'.repeat().".repeat(20) + 'end;';
      const html = renderPlain('```\n' + longLine + '\n```');
      expect(html).toContain('<pre');
      expect(html).toContain('overflow-x-auto');
      expect(html).toContain('whitespace-pre');
      expect(html).toContain('end;');
      // No Shiki / Streamdown code-block chrome.
      expect(html).not.toContain('data-streamdown="code-block"');
      expect(html).not.toContain('--sdm');
    });
  });
});
