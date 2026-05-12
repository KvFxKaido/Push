/**
 * LocalPcPairing.test.tsx — SSR-style render coverage for the
 * pairing panel. Matches the testing style used elsewhere in
 * `app/src/sections/*.test.tsx` (renderToStaticMarkup, no DOM env).
 *
 * Behavior that depends on a live DOM (button clicks invoking
 * createLocalDaemonBinding, async status transitions) is covered
 * upstream: the adapter is exercised end-to-end in
 * `app/src/lib/local-daemon-binding.test.ts`, including the
 * subprotocol auth handshake and ok/fail response paths.
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { LocalPcPairing } from './LocalPcPairing';

describe('LocalPcPairing', () => {
  const noop = () => {};

  it('renders the pair-this-PC headline and form labels', () => {
    const html = renderToStaticMarkup(<LocalPcPairing onPaired={noop} onCancel={noop} />);
    expect(html).toContain('Pair Local PC');
    expect(html).toContain('Run this on your PC');
    expect(html).toContain('Port');
    expect(html).toContain('Bearer token');
  });

  it('includes the pairing command with an explicit --origin flag', () => {
    const html = renderToStaticMarkup(<LocalPcPairing onPaired={noop} />);
    // Origin defaults to the placeholder when window is unavailable
    // (SSR); the important assertion is that the flag is wired in
    // and the command text is reachable by copy-paste.
    expect(html).toContain('push daemon pair --origin');
  });

  it('masks the token input with type=password to avoid shoulder-surfing', () => {
    const html = renderToStaticMarkup(<LocalPcPairing onPaired={noop} />);
    // The token input is the only password-typed field on the panel.
    expect(html).toContain('type="password"');
  });

  it('wraps the inputs in a <form> so Enter submits and Chrome stops warning about a stray password field', () => {
    const html = renderToStaticMarkup(<LocalPcPairing onPaired={noop} />);
    // The form has an explicit aria-label so screen readers describe it,
    // and the submit button is type=submit so keyboard Enter triggers
    // pair without an extra onKeyDown handler.
    expect(html).toContain('<form');
    expect(html).toContain('aria-label="Local PC pairing"');
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*>[\s\S]*?Pair this PC/);
  });

  it('marks the pair button disabled until both fields are filled', () => {
    const html = renderToStaticMarkup(<LocalPcPairing onPaired={noop} />);
    // On first render the form is empty, so the submit must be disabled.
    // React renders the `disabled` attribute before children, so just
    // check both pieces are present in the same `<button>` element.
    expect(html).toMatch(/<button[^>]*disabled[^>]*>[\s\S]*?Pair this PC[\s\S]*?<\/button>/);
  });

  it('renders the back affordance when onCancel is provided', () => {
    const withCancel = renderToStaticMarkup(<LocalPcPairing onPaired={noop} onCancel={noop} />);
    expect(withCancel).toContain('Back to hub');
  });

  it('omits the back affordance when onCancel is missing', () => {
    const withoutCancel = renderToStaticMarkup(<LocalPcPairing onPaired={noop} />);
    expect(withoutCancel).not.toContain('Back to hub');
  });
});
