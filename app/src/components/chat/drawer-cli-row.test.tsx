/**
 * drawer-cli-row.test — SSR coverage for the CLI-session row component
 * the drawer uses alongside `useDaemonCliSessions`. The drawer body
 * sits inside a radix Sheet whose portal isn't serialized by
 * `renderToStaticMarkup` — exercising it would need a DOM test
 * runner the repo doesn't ship today. The row component lives in its
 * own module so the SSR test can cover the visible surface (label
 * fallbacks, the live/idle badge, the title hover payload) without
 * that dependency.
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

import type { DaemonCliSession } from '@/types';

import { CliSessionRow } from './drawer-cli-row';

function makeCliSession(overrides: Partial<DaemonCliSession> = {}): DaemonCliSession {
  return {
    sessionId: 'sess_abc_def123',
    updatedAt: Date.now() - 60_000,
    provider: 'openrouter',
    model: 'claude-3-5-sonnet',
    cwd: '/Users/dev/proj',
    sessionName: 'Review auth middleware',
    lastUserMessage: 'tighten the regex',
    mode: 'tui',
    state: 'idle',
    activeRunId: null,
    ...overrides,
  };
}

describe('CliSessionRow', () => {
  it('renders the session name with the idle CLI badge', () => {
    const html = renderToStaticMarkup(<CliSessionRow session={makeCliSession()} />);
    expect(html).toContain('Review auth middleware');
    // The aria-label distinguishes idle vs running so screen readers
    // can convey the session state without parsing visual badges.
    expect(html).toContain('aria-label="CLI session"');
    expect(html).not.toContain('aria-label="CLI session, running"');
  });

  it('renders the Connected indicator with the workspace tag', () => {
    // Claude Code-style row: these rows only exist while a live daemon
    // connection feeds them, so every row carries the green Connected
    // indicator plus the cwd basename as the workspace tag.
    const html = renderToStaticMarkup(<CliSessionRow session={makeCliSession()} />);
    expect(html).toContain('Connected');
    expect(html).toContain('· proj ·');
  });

  it('falls back to the sessionId as the workspace tag when cwd is empty', () => {
    const html = renderToStaticMarkup(
      <CliSessionRow session={makeCliSession({ sessionId: 'sess_no_cwd', cwd: '' })} />,
    );
    expect(html).toContain('· sess_no_cwd ·');
  });

  it('flips the badge to a live indicator when the session is mid-run', () => {
    const html = renderToStaticMarkup(
      <CliSessionRow session={makeCliSession({ state: 'running', activeRunId: 'run_xyz' })} />,
    );
    expect(html).toContain('CLI · live');
    expect(html).toContain('aria-label="CLI session, running"');
  });

  it('falls back to the last user message when sessionName is empty', () => {
    const html = renderToStaticMarkup(
      <CliSessionRow
        session={makeCliSession({
          sessionId: 'sess_no_name',
          sessionName: '',
          lastUserMessage: 'investigate the segfault',
        })}
      />,
    );
    expect(html).toContain('investigate the segfault');
  });

  it('falls back to the sessionId when both name and last message are empty', () => {
    const html = renderToStaticMarkup(
      <CliSessionRow
        session={makeCliSession({
          sessionId: 'sess_truly_blank',
          sessionName: '',
          lastUserMessage: '',
        })}
      />,
    );
    expect(html).toContain('sess_truly_blank');
  });

  it('exposes provider/model and full sessionId via the row title for hover/long-press', () => {
    const html = renderToStaticMarkup(
      <CliSessionRow
        session={makeCliSession({
          sessionId: 'sess_inspect',
          provider: 'openrouter',
          model: 'claude-3-5-sonnet',
          cwd: '/Users/dev/proj',
        })}
      />,
    );
    expect(html).toContain('openrouter/claude-3-5-sonnet');
    expect(html).toContain('sess_inspect');
    expect(html).toContain('/Users/dev/proj');
  });
});
