import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ComponentProps } from 'react';
import type { GitHubUser } from '@/types';
import { OnboardingScreen } from './OnboardingScreen';

function buildProps(
  overrides: Partial<ComponentProps<typeof OnboardingScreen>> = {},
): ComponentProps<typeof OnboardingScreen> {
  return {
    onConnect: vi.fn(async () => true),
    onConnectOAuth: vi.fn(),
    onStartWorkspace: vi.fn(),
    onStartChat: vi.fn(),
    onInstallApp: vi.fn(),
    onConnectInstallationId: vi.fn(async () => true),
    loading: false,
    error: null,
    validatedUser: null,
    isAppAuth: false,
    ...overrides,
  };
}

describe('OnboardingScreen', () => {
  it('renders the default entry state with OAuth, Install, and PAT options', () => {
    const html = renderToStaticMarkup(<OnboardingScreen {...buildProps()} />);

    expect(html).toContain('Connect with GitHub');
    expect(html).toContain('Install GitHub App');
    expect(html).toContain('Use Personal Access Token');
    expect(html).toContain('Already installed? Enter installation ID');
    // No-account shortcuts are present.
    expect(html).toContain('Chat');
    expect(html).toContain('Workspace');
  });

  it('renders the connected state with the user login when a validated user is present', () => {
    const validatedUser: GitHubUser = { login: 'octocat', avatar_url: '' };
    const html = renderToStaticMarkup(
      <OnboardingScreen {...buildProps({ validatedUser, isAppAuth: true })} />,
    );

    expect(html).toContain('Connected as');
    expect(html).toContain('octocat');
    expect(html).toContain('GitHub App');
    // Auth entry buttons are not shown once connected.
    expect(html).not.toContain('Connect with GitHub</span>');
  });

  it('renders the loading state on the OAuth button while connecting', () => {
    const html = renderToStaticMarkup(<OnboardingScreen {...buildProps({ loading: true })} />);

    expect(html).toContain('Connecting…');
  });

  it('renders the error banner when an error is present and no user is validated', () => {
    const html = renderToStaticMarkup(
      <OnboardingScreen {...buildProps({ error: 'invalid token' })} />,
    );

    expect(html).toContain('invalid token');
  });

  it('falls back to the default entry state when an error accompanies a stale validated user', () => {
    const validatedUser: GitHubUser = { login: 'octocat', avatar_url: '' };
    const html = renderToStaticMarkup(
      <OnboardingScreen {...buildProps({ validatedUser, error: 'stale error' })} />,
    );

    // The "Connected as" banner only appears when no error is set.
    expect(html).not.toContain('Connected as');
    expect(html).toContain('stale error');
  });
});
