import { describe, expect, it } from 'vitest';
import { makeDaemonModelCatalogStub } from '@/test-utils/model-catalog-test-stubs';
import { BUILT_IN_SETTINGS_PROVIDER_ORDER } from './settings-shared';
import { buildSettingsBuiltInProviders } from './settings-built-in-provider-builder';

describe('buildSettingsBuiltInProviders', () => {
  it('has a builder for every registry-derived built-in settings provider', () => {
    // BUILT_IN_SETTINGS_PROVIDER_ORDER derives from the live registry
    // (`settings.builtInOrder`) but `BuiltInSettingsProviderId` is a
    // hand-pinned union behind an `as` cast — so a new provider that declares
    // `builtInOrder` without a builder entry compiles clean and then crashes
    // the Settings sheet at render (`BUILT_IN_PROVIDER_BUILDERS[id]` is
    // undefined). Execute the real construction over the real order so that
    // drift fails here instead of in production.
    const catalog = makeDaemonModelCatalogStub({ cloudflareModel: '@cf/test/model' });
    const providers = buildSettingsBuiltInProviders({
      catalog: catalog as never,
      isProviderLocked: false,
      lockedProvider: null,
      isModelLocked: false,
    });
    for (const providerId of BUILT_IN_SETTINGS_PROVIDER_ORDER) {
      expect(providers[providerId], `missing builder output for "${providerId}"`).toBeDefined();
      expect(typeof providers[providerId].setKey).toBe('function');
    }
  });
});
