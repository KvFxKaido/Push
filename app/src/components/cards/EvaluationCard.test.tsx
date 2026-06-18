import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { EvaluationCardData } from '@/types';
import { EvaluationCard } from './EvaluationCard';

function cardData(overrides: Partial<EvaluationCardData> = {}): EvaluationCardData {
  return {
    verdict: 'incomplete',
    summary: 'The turn left work undone.',
    gaps: ['Add tests', 'Wire up the handler'],
    confidence: 'high',
    ...overrides,
  };
}

describe('EvaluationCard', () => {
  it('renders an incomplete verdict header, summary, and each gap', () => {
    const html = renderToStaticMarkup(<EvaluationCard data={cardData()} />);
    expect(html).toContain('Needs follow-up');
    expect(html).toContain('The turn left work undone.');
    expect(html).toContain('Add tests');
    expect(html).toContain('Wire up the handler');
  });

  it('renders a complete verdict header and omits the gap list when there are no gaps', () => {
    const html = renderToStaticMarkup(
      <EvaluationCard data={cardData({ verdict: 'complete', summary: 'All done.', gaps: [] })} />,
    );
    expect(html).toContain('Complete');
    expect(html).toContain('All done.');
  });
});
