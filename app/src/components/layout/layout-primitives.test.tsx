import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { PageScaffold, HeaderBar, StatusBanner, SectionCard } from './index';

// These tests pin the public-API shape of the layout primitives. They
// snapshot-check key class fragments rather than full markup so trivial
// child reorderings don't churn the file — the contract is "this prop
// produces this token/class", not "this exact DOM string".

describe('PageScaffold', () => {
  it('applies the page gradient and safe-area utilities', () => {
    const html = renderToStaticMarkup(
      <PageScaffold>
        <div>body</div>
      </PageScaffold>,
    );
    expect(html).toContain('bg-push-grad-page');
    expect(html).toContain('safe-area-top');
    expect(html).toContain('safe-area-bottom');
  });

  it('maps width="sm" to max-w-sm and width="lg" to max-w-2xl', () => {
    const sm = renderToStaticMarkup(
      <PageScaffold width="sm">
        <div>x</div>
      </PageScaffold>,
    );
    const lg = renderToStaticMarkup(
      <PageScaffold width="lg">
        <div>x</div>
      </PageScaffold>,
    );
    expect(sm).toContain('max-w-sm');
    expect(lg).toContain('max-w-2xl');
  });

  it('vertically centers when align="center"', () => {
    const html = renderToStaticMarkup(
      <PageScaffold align="center">
        <div>x</div>
      </PageScaffold>,
    );
    expect(html).toContain('items-center');
    expect(html).toContain('justify-center');
  });

  it('renders the header slot outside the scroll container', () => {
    const html = renderToStaticMarkup(
      <PageScaffold header={<div data-testid="hdr">H</div>}>
        <div>body</div>
      </PageScaffold>,
    );
    // Header should appear before the scroll wrapper class.
    const hdrIdx = html.indexOf('data-testid="hdr"');
    const scrollIdx = html.indexOf('overflow-y-auto');
    expect(hdrIdx).toBeGreaterThan(-1);
    expect(scrollIdx).toBeGreaterThan(hdrIdx);
  });
});

describe('HeaderBar', () => {
  it('renders a back button only when `back` is provided', () => {
    const withBack = renderToStaticMarkup(<HeaderBar back={() => {}} title="t" />);
    const withoutBack = renderToStaticMarkup(<HeaderBar title="t" />);
    expect(withBack).toContain('aria-label="Back"');
    expect(withoutBack).not.toContain('aria-label="Back"');
    // Without back, the cell is reserved so the title stays centered.
    expect(withoutBack).toContain('aria-hidden');
  });

  it('respects custom backLabel', () => {
    const html = renderToStaticMarkup(<HeaderBar back={() => {}} backLabel="Close" />);
    expect(html).toContain('aria-label="Close"');
  });

  it('renders title and subtitle in the centered slot', () => {
    const html = renderToStaticMarkup(<HeaderBar title="Pair Remote" subtitle="experimental" />);
    expect(html).toContain('Pair Remote');
    expect(html).toContain('experimental');
    expect(html).toContain('text-push-fg');
  });
});

describe('StatusBanner', () => {
  it('uses the warning palette for variant="warning"', () => {
    const html = renderToStaticMarkup(<StatusBanner variant="warning">Heads up</StatusBanner>);
    expect(html).toContain('push-status-warning');
    expect(html).toContain('Heads up');
    expect(html).toContain('role="alert"');
  });

  it('uses the error palette for variant="error"', () => {
    const html = renderToStaticMarkup(<StatusBanner variant="error">Boom</StatusBanner>);
    expect(html).toContain('push-status-error');
    expect(html).toContain('role="alert"');
  });

  it('uses status role for non-actionable variants', () => {
    const info = renderToStaticMarkup(<StatusBanner variant="info">FYI</StatusBanner>);
    const success = renderToStaticMarkup(<StatusBanner variant="success">Done</StatusBanner>);
    expect(info).toContain('role="status"');
    expect(success).toContain('role="status"');
  });

  it('renders a dismiss button when onDismiss is set', () => {
    const html = renderToStaticMarkup(
      <StatusBanner variant="info" onDismiss={() => {}}>
        x
      </StatusBanner>,
    );
    expect(html).toContain('aria-label="Dismiss"');
  });

  it('omits the icon when icon={null}', () => {
    const withIcon = renderToStaticMarkup(<StatusBanner variant="info">x</StatusBanner>);
    const noIcon = renderToStaticMarkup(
      <StatusBanner variant="info" icon={null}>
        x
      </StatusBanner>,
    );
    // The default Info svg has an lucide class; ensure it's gone when nulled.
    expect(withIcon).toContain('lucide');
    expect(noIcon.includes('lucide-info')).toBe(false);
  });
});

describe('SectionCard', () => {
  it('uses HUB_PANEL_SURFACE for default variant and SUBTLE for variant="subtle"', () => {
    const panel = renderToStaticMarkup(<SectionCard>body</SectionCard>);
    const subtle = renderToStaticMarkup(<SectionCard variant="subtle">body</SectionCard>);
    // Both panels carry the rounded-[20px]/[18px] markers from hub-styles.
    expect(panel).toContain('rounded-[20px]');
    expect(subtle).toContain('rounded-[18px]');
  });

  it('renders title and description when provided', () => {
    const html = renderToStaticMarkup(
      <SectionCard title="Connection" description="Paste the bundle below.">
        <div>field</div>
      </SectionCard>,
    );
    expect(html).toContain('Connection');
    expect(html).toContain('Paste the bundle below.');
  });

  it('honors padding override', () => {
    const html = renderToStaticMarkup(<SectionCard padding="px-6 py-5">x</SectionCard>);
    expect(html).toContain('px-6');
    expect(html).toContain('py-5');
  });
});
