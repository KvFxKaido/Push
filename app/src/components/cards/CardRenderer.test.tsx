import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ChatCard } from '@/types';
import { CardRenderer } from './CardRenderer';

describe('CardRenderer', () => {
  it('renders a tombstone for unknown card types', () => {
    const legacyCard = {
      type: 'browser-screenshot',
      data: { url: 'https://example.com' },
    } as unknown as ChatCard;

    const html = renderToStaticMarkup(<CardRenderer card={legacyCard} />);
    expect(html).toContain('[browser-screenshot]');
    expect(html).toContain('card type no longer supported');
  });
});
