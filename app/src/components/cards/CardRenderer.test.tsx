import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ChatCard } from '@/types';
import { CardRenderer } from './CardRenderer';
import { DelegationResultCard } from './DelegationResultCard';

describe('CardRenderer', () => {
  it('preserves legacy artifact source as escaped, read-only text', () => {
    const card = {
      type: 'artifact',
      data: {
        record: {
          title: 'Saved demo',
          kind: 'html',
          source: '<script>alert(1)</script>',
          files: [{ path: 'index.html', content: '<iframe src="https://example.com" />' }],
        },
      },
    } as unknown as ChatCard;
    const html = renderToStaticMarkup(<CardRenderer card={card} />);
    expect(html).toContain('Saved demo');
    expect(html).toContain('html');
    expect(html).toContain('index.html');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('&lt;iframe');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<iframe');
  });

  it('tolerates malformed persisted artifacts', () => {
    const card = { type: 'artifact', data: null } as unknown as ChatCard;
    expect(renderToStaticMarkup(<CardRenderer card={card} />)).toContain('Legacy artifact');
  });
  it('renders the delegation result card', () => {
    const html = renderToStaticMarkup(
      <DelegationResultCard
        data={{
          agent: 'coder',
          status: 'complete',
          summary: 'Implemented the auth refresh fix.',
          checksPassed: 1,
          checksTotal: 1,
          fileCount: 2,
          rounds: 4,
          checkpoints: 0,
          elapsedMs: 3200,
          gateVerdicts: [],
          missingRequirements: [],
        }}
      />,
    );

    // The Coder role renders as the phase-first display label (see
    // lib/role-display.ts) rather than the internal role name.
    expect(html).toContain('Editing');
    expect(html).toContain('Implemented the auth refresh fix.');
    expect(html).toContain('2 file');
  });

  it('renders a tombstone for unknown card types', () => {
    const legacyCard = {
      type: 'browser-screenshot',
      data: {
        url: 'https://example.com',
      },
    } as unknown as ChatCard;

    const html = renderToStaticMarkup(<CardRenderer card={legacyCard} />);
    expect(html).toContain('[browser-screenshot]');
    expect(html).toContain('card type no longer supported');
  });
});
