import { afterEach, describe, expect, it, vi } from 'vitest';
import { CloudflareSandboxProvider } from './cloudflare-sandbox-provider';
import { ModalSandboxProvider, createSandboxProvider } from './modal-sandbox-provider';

describe('createSandboxProvider', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('defaults to Cloudflare Sandbox when PUSH_SANDBOX_PROVIDER is unset', () => {
    vi.stubEnv('PUSH_SANDBOX_PROVIDER', '');

    expect(createSandboxProvider()).toBeInstanceOf(CloudflareSandboxProvider);
  });

  it('uses Modal only when explicitly selected', () => {
    vi.stubEnv('PUSH_SANDBOX_PROVIDER', 'modal');

    expect(createSandboxProvider()).toBeInstanceOf(ModalSandboxProvider);
  });

  it('lets an explicit provider override the environment', () => {
    vi.stubEnv('PUSH_SANDBOX_PROVIDER', 'modal');

    expect(createSandboxProvider({ provider: 'cloudflare' })).toBeInstanceOf(
      CloudflareSandboxProvider,
    );
  });
});
