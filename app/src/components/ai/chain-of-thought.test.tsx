import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  ChainOfThought,
  ChainOfThoughtContent,
  ChainOfThoughtHeader,
  ChainOfThoughtStep,
} from './chain-of-thought';

/** Extract an attribute value from the element carrying `data-slot="<slot>"`. */
function attrOfSlot(html: string, slot: string, attr: string): string | null {
  const el = html.match(new RegExp(`<[^>]*data-slot="${slot}"[^>]*>`))?.[0];
  return el?.match(new RegExp(`${attr}="([^"]*)"`))?.[1] ?? null;
}

describe('ChainOfThought a11y wiring', () => {
  it("links the trigger's aria-controls to the content id (single Collapsible root)", () => {
    const html = renderToStaticMarkup(
      <ChainOfThought defaultOpen>
        <ChainOfThoughtHeader>Reasoning</ChainOfThoughtHeader>
        <ChainOfThoughtContent>
          <ChainOfThoughtStep label="step" />
        </ChainOfThoughtContent>
      </ChainOfThought>,
    );
    const ariaControls = attrOfSlot(html, 'collapsible-trigger', 'aria-controls');
    const contentId = attrOfSlot(html, 'collapsible-content', 'id');
    expect(ariaControls).toBeTruthy();
    expect(contentId).toBeTruthy();
    // The regression this guards: two independent roots gave the trigger an
    // aria-controls that pointed at a non-existent content id.
    expect(ariaControls).toBe(contentId);
  });

  it('applies a custom connector class over the default bg-border', () => {
    const html = renderToStaticMarkup(
      <ChainOfThought defaultOpen>
        <ChainOfThoughtContent>
          <ChainOfThoughtStep label="a" hasConnector connectorClassName="bg-push-edge" />
        </ChainOfThoughtContent>
      </ChainOfThought>,
    );
    // twMerge dedupes the two bg tokens → the override wins, the default drops.
    expect(html).toContain('bg-push-edge');
    expect(html).not.toContain('bg-border');
  });

  it('omits the connector on the final step', () => {
    const withRail = renderToStaticMarkup(
      <ChainOfThought defaultOpen>
        <ChainOfThoughtContent>
          <ChainOfThoughtStep label="a" hasConnector />
        </ChainOfThoughtContent>
      </ChainOfThought>,
    );
    const noRail = renderToStaticMarkup(
      <ChainOfThought defaultOpen>
        <ChainOfThoughtContent>
          <ChainOfThoughtStep label="a" hasConnector={false} />
        </ChainOfThoughtContent>
      </ChainOfThought>,
    );
    expect(withRail).toContain('w-px');
    expect(noRail).not.toContain('w-px');
  });
});
