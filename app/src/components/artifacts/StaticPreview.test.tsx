import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ArtifactRecord } from '@push/lib/artifacts/types';

interface CapturedSandpackProps {
  template?: string;
  files?: Record<string, unknown>;
  options?: Record<string, unknown>;
  customSetup?: { dependencies?: Record<string, string> };
}

// Mock @codesandbox/sandpack-react before importing the component so the
// (DOM-heavy, postMessage-using) Sandpack runtime never instantiates
// during SSR. The mock just records the props it received so the test
// can assert template + entry resolution without rendering an iframe.
const sandpackProps: { current: CapturedSandpackProps | null } = { current: null };

vi.mock('@codesandbox/sandpack-react', () => ({
  Sandpack: (props: CapturedSandpackProps) => {
    sandpackProps.current = props;
    return <div data-testid="sandpack-stub">sandpack:{JSON.stringify(props.template)}</div>;
  },
}));

const { StaticPreview } = await import('./StaticPreview');

function htmlRecord(): Extract<ArtifactRecord, { kind: 'static-html' }> {
  return {
    id: 'a-1',
    title: 'Landing',
    kind: 'static-html',
    status: 'ready',
    updatedAt: 0,
    scope: { repoFullName: 'KvFxKaido/Push', branch: 'main' },
    author: { surface: 'web', role: 'orchestrator', createdAt: 0 },
    files: [{ path: 'index.html', content: '<h1>hi</h1>' }],
  };
}

function reactRecord(): Extract<ArtifactRecord, { kind: 'static-react' }> {
  return {
    id: 'a-2',
    title: 'Counter demo',
    kind: 'static-react',
    status: 'ready',
    updatedAt: 0,
    scope: { repoFullName: 'KvFxKaido/Push', branch: 'main' },
    author: { surface: 'web', role: 'orchestrator', createdAt: 0 },
    files: [{ path: '/App.js', content: 'export default () => null' }],
    dependencies: { 'lucide-react': '^0.500.0' },
  };
}

describe('StaticPreview', () => {
  function takeProps(): CapturedSandpackProps {
    const captured = sandpackProps.current as CapturedSandpackProps | null;
    if (!captured) throw new Error('Sandpack mock did not receive any props');
    return captured;
  }

  it('uses the static template for static-html records', () => {
    sandpackProps.current = null;
    const html = renderToStaticMarkup(<StaticPreview record={htmlRecord()} />);
    expect(html).toContain('Static HTML');
    const captured = takeProps();
    expect(captured.template).toBe('static');
    expect(captured.options?.activeFile).toBe('/index.html');
  });

  it('uses the react template and forwards model-supplied dependencies', () => {
    sandpackProps.current = null;
    const html = renderToStaticMarkup(<StaticPreview record={reactRecord()} />);
    expect(html).toContain('React');
    const captured = takeProps();
    expect(captured.template).toBe('react');
    expect(captured.customSetup?.dependencies?.['lucide-react']).toBe('^0.500.0');
  });

  it('exposes an Expand affordance', () => {
    const html = renderToStaticMarkup(<StaticPreview record={htmlRecord()} />);
    expect(html).toContain('Expand');
  });

  it('normalises file paths so unprefixed keys gain a leading slash', () => {
    sandpackProps.current = null;
    const r = {
      ...reactRecord(),
      files: [{ path: 'App.js', content: 'export default () => null' }],
    };
    renderToStaticMarkup(<StaticPreview record={r} />);
    const files = takeProps().files ?? {};
    expect(Object.keys(files)).toContain('/App.js');
  });
});
