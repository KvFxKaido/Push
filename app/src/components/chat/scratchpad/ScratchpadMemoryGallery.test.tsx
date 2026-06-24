import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ScratchpadMemory } from '@/hooks/useScratchpad';
import { ScratchpadMemoryGallery } from './ScratchpadMemoryGallery';

function memory(overrides: Partial<ScratchpadMemory> = {}): ScratchpadMemory {
  return {
    id: 'mem-1',
    name: 'Release checklist',
    content: 'Bump version, run tests, tag the release.',
    updatedAt: Date.now() - 60_000,
    ...overrides,
  };
}

describe('ScratchpadMemoryGallery', () => {
  const noop = vi.fn();

  it('renders nothing when there are no memories', () => {
    const html = renderToStaticMarkup(
      <ScratchpadMemoryGallery memories={[]} activeMemoryId={null} onLoad={noop} onDelete={noop} />,
    );
    expect(html).toBe('');
  });

  it('renders a card per memory with its name and a content preview', () => {
    const html = renderToStaticMarkup(
      <ScratchpadMemoryGallery
        memories={[
          memory({ id: 'mem-1', name: 'Release checklist' }),
          memory({ id: 'mem-2', name: 'API notes', content: 'Endpoints and auth flow.' }),
        ]}
        activeMemoryId={null}
        onLoad={noop}
        onDelete={noop}
      />,
    );
    expect(html).toContain('Release checklist');
    expect(html).toContain('API notes');
    expect(html).toContain('Bump version');
    expect(html).toContain('Endpoints and auth flow');
    // The reader overlay is closed on first render — no canvas/dialog yet.
    expect(html).not.toContain('role="dialog"');
  });

  it('assigns a stable morph name to each collapsed card', () => {
    const html = renderToStaticMarkup(
      <ScratchpadMemoryGallery
        memories={[memory({ id: 'abc-123' })]}
        activeMemoryId={null}
        onLoad={noop}
        onDelete={noop}
      />,
    );
    expect(html).toContain('view-transition-name:scratch-card-abc-123');
  });

  it('marks the Current notes row as editing when no memory is active', () => {
    const html = renderToStaticMarkup(
      <ScratchpadMemoryGallery
        memories={[memory()]}
        activeMemoryId={null}
        onLoad={noop}
        onDelete={noop}
      />,
    );
    expect(html).toContain('Current notes');
    expect(html).toContain('editing');
  });

  it('shows an empty-note fallback when a memory has no content', () => {
    const html = renderToStaticMarkup(
      <ScratchpadMemoryGallery
        memories={[memory({ content: '   ' })]}
        activeMemoryId={null}
        onLoad={noop}
        onDelete={noop}
      />,
    );
    expect(html).toContain('Empty note');
  });
});
