import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ChatCard } from '@/types';
import { CardRenderer } from './CardRenderer';
import { DelegationResultCard } from './DelegationResultCard';

describe('CardRenderer', () => {
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

    expect(html).toContain('Coder');
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
