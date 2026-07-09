import type { ComponentProps } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ChatInput } from './ChatInput';

function buildProps(
  overrides: Partial<ComponentProps<typeof ChatInput>> = {},
): ComponentProps<typeof ChatInput> {
  const providerControls: NonNullable<ComponentProps<typeof ChatInput>['providerControls']> = {
    selectedProvider: 'zen',
    availableProviders: [['zen', 'OpenCode Zen', true] as const],
    isProviderLocked: false,
    lockedProvider: null,
    lockedModel: null,
    onSelectBackend: vi.fn(),
    modelControls: {
      zen: {
        kind: 'picker',
        provider: 'zen',
        value: 'big-pickle',
        options: ['big-pickle', 'grok-code'],
        onChange: vi.fn(),
        isLocked: false,
        ariaLabel: 'Select OpenCode Zen model',
      },
    },
  };

  return {
    onSend: vi.fn(),
    providerControls,
    ...overrides,
  };
}

describe('ChatInput', () => {
  it('shows the selected provider model instead of falling back to demo', () => {
    const html = renderToStaticMarkup(<ChatInput {...buildProps()} />);

    expect(html).toContain('big-pickle');
    expect(html).not.toContain('>demo<');
  });

  it('shows queued follow-up status while streaming', () => {
    const html = renderToStaticMarkup(
      <ChatInput {...buildProps({ isStreaming: true, queuedFollowUpCount: 2 })} />,
    );

    expect(html).toContain('2 follow-ups queued');
  });

  it('shows pending steering status while streaming', () => {
    const html = renderToStaticMarkup(
      <ChatInput {...buildProps({ isStreaming: true, pendingSteerCount: 1 })} />,
    );

    expect(html).toContain('Steering update captured. It will apply after the current step.');
  });

  it('renders the linked-libraries chip strip when libraryEnabled + linkedLibraryIds is non-empty', () => {
    const html = renderToStaticMarkup(
      <ChatInput
        {...buildProps({
          libraryEnabled: true,
          linkedLibraryIds: ['lib-abc12345-6789-4def-90ab-cdef01234567'],
          onSetLinkedLibraries: vi.fn(),
        })}
      />,
    );
    // The "Linked" header appears in the chip strip.
    expect(html).toContain('Linked');
    // The short-id fallback (truncated UUID) shows until names resolve
    // — `useChatLibrary` returns an empty collection list in this
    // server-rendered context. First 8 chars + ellipsis.
    expect(html).toContain('lib-abc1');
    // The unlink button is rendered for each chip.
    expect(html).toContain('aria-label="Unlink');
  });

  it('does not render the chip strip when linkedLibraryIds is empty or undefined', () => {
    const empty = renderToStaticMarkup(
      <ChatInput {...buildProps({ libraryEnabled: true, linkedLibraryIds: [] })} />,
    );
    expect(empty).not.toMatch(/<span[^>]*>Linked</);

    const undef = renderToStaticMarkup(<ChatInput {...buildProps({ libraryEnabled: true })} />);
    expect(undef).not.toMatch(/<span[^>]*>Linked</);
  });
});
