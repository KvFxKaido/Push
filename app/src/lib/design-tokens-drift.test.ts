import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { identityPalette } from '@push/lib/design-tokens';

// app/tailwind.config.js is CommonJS-syntax inside an ESM-typed package (Tailwind
// loads it through its own jiti loader), so it can't be imported or required
// here. Read it as text and pull the `'token': '#hex'` literals out instead.
// This is the cross-boundary lock: the config can't import the shared TS palette
// at build time, so this test fails CI if the two ever disagree on a shared
// token (same intent as cli/tests/protocol-drift.test.mjs). The TUI imports the
// palette directly, so it needs no such guard.
const configSrc = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../../tailwind.config.js'),
  'utf8',
);

// The `':` anchor keeps a prefix token (push-fg) from matching its longer
// siblings (push-fg-secondary, …).
function webToken(name: string): string | undefined {
  return configSrc.match(new RegExp(`'${name}':\\s*'(#[0-9a-fA-F]{6})'`))?.[1];
}

describe('design-tokens drift guard', () => {
  // web Tailwind token → the shared identity value it must mirror.
  const expectations: Array<[string, string]> = [
    ['push-fg', identityPalette.fg.primary],
    ['push-fg-secondary', identityPalette.fg.secondary],
    ['push-fg-muted', identityPalette.fg.muted],
    ['push-fg-dim', identityPalette.fg.dim],
    ['push-surface', identityPalette.surface.base],
    ['push-surface-raised', identityPalette.surface.raised],
    ['push-edge', identityPalette.edge.default],
    ['push-edge-hover', identityPalette.edge.hover],
    ['push-status-success', identityPalette.state.success],
    ['push-status-warning', identityPalette.state.warning],
    ['push-status-error', identityPalette.state.error],
    ['push-accent', identityPalette.accent.sky],
    ['push-sky', identityPalette.accent.skyMid],
    ['push-link', identityPalette.accent.link],
  ];

  it.each(expectations)('web token %s mirrors the shared identity palette', (token, shared) => {
    expect(webToken(token)).toBe(shared);
  });
});
