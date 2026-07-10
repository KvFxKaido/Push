import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  PROVIDER_DEFINITIONS,
  REAL_PROVIDERS,
  findProviderDefinition,
  getAdapterRoutedProviderIds,
  getBuiltInSettingsProviderDefinitions,
  getCliProviderDefinitions,
  getFailoverProviderOrder,
  getProviderApiKeyStorageKey,
  getInitialFallbackProviderOrder,
  getProviderIconDefinition,
  getProviderModelStorageKey,
  getProviderDisplayName,
  getProviderDefinition,
  getProviderSettingsDefinition,
  getProviderStreamShape,
  getProviderTimeoutDisplayName,
  providerCarriesReasoningBlocksByDefault,
  providerConsumesContentBlocksByDefault,
  providerForApiKeyStorageKey,
  providerDefinitionsCoverCanonicalIds,
} from '../../lib/provider-definition.ts';
import { ALL_PROVIDERS } from '../../lib/provider-contract.ts';
import {
  SHARED_PROVIDER_DEFAULT_MODELS,
  SHARED_PROVIDER_MODEL_CATALOG,
} from '../../lib/provider-models.ts';

const VALID_STREAM_SHAPES = new Set(['openai-compat', 'openai-responses', 'anthropic', 'gemini']);
const KEBAB_ID = /^[a-z][a-z0-9-]*$/;

const EXPECTED_INITIAL_FALLBACK_ORDER = [
  'ollama',
  'openrouter',
  'zai',
  'kimi',
  'huggingface',
  'cloudflare',
  'zen',
  'nvidia',
  'fireworks',
  'deepseek',
  'sakana',
  'anthropic',
  'openai',
  'xai',
  'google',
];

const EXPECTED_FAILOVER_ORDER = [
  'ollama',
  'openrouter',
  'zai',
  'kimi',
  'huggingface',
  'cloudflare',
  'zen',
  'nvidia',
  'fireworks',
  'deepseek',
  'sakana',
  'anthropic',
  'openai',
  'xai',
  'google',
];

const EXPECTED_CLI_PROVIDER_ORDER = [
  'ollama',
  'openrouter',
  'kimi',
  'zai',
  'huggingface',
  'zen',
  'nvidia',
  'fireworks',
  'deepseek',
  'sakana',
  'openai',
  'xai',
  'anthropic',
  'google',
];

const EXPECTED_BUILT_IN_SETTINGS_ORDER = [
  'ollama',
  'openrouter',
  'kimi',
  'zai',
  'huggingface',
  'anthropic',
  'openai',
  'xai',
  'google',
  'deepseek',
  'nvidia',
  'zen',
  'fireworks',
  'sakana',
];

// Drift-detector: internal consistency of every ProviderDefinition entry and
// coverage of every real provider id. Stream factories and per-model transport
// hooks remain runtime-owned exceptions, but provider-keyed metadata should not
// be re-declared by hand.
describe('ProviderDefinition', () => {
  it('has at least one entry', () => {
    assert.ok(PROVIDER_DEFINITIONS.length > 0);
  });

  it('covers every canonical real provider id exactly once', () => {
    const realProviderIds = ALL_PROVIDERS.filter((provider) => provider !== 'demo');
    assert.deepEqual([...REAL_PROVIDERS].sort(), [...realProviderIds].sort());
    assert.equal(providerDefinitionsCoverCanonicalIds(), true);
  });

  it('ids are unique', () => {
    const ids = PROVIDER_DEFINITIONS.map((def) => def.id);
    assert.equal(new Set(ids).size, ids.length, `duplicate ids in ${ids.join(', ')}`);
  });

  it('webProxyPaths are unique', () => {
    const paths = PROVIDER_DEFINITIONS.map((def) => def.webProxyPath).filter(Boolean);
    assert.equal(
      new Set(paths).size,
      paths.length,
      `duplicate webProxyPaths in ${paths.join(', ')}`,
    );
  });

  it('modelsProxyPaths are unique', () => {
    const paths = PROVIDER_DEFINITIONS.map((def) => def.modelsProxyPath).filter(Boolean);
    assert.equal(
      new Set(paths).size,
      paths.length,
      `duplicate modelsProxyPaths in ${paths.join(', ')}`,
    );
  });

  it('preserves initial provider fallback order', () => {
    assert.deepEqual([...getInitialFallbackProviderOrder()], EXPECTED_INITIAL_FALLBACK_ORDER);
  });

  it('preserves same-shape failover order', () => {
    assert.deepEqual([...getFailoverProviderOrder()], EXPECTED_FAILOVER_ORDER);
  });

  it('marks every real provider as adapter-routed', () => {
    assert.deepEqual([...getAdapterRoutedProviderIds()].sort(), [...REAL_PROVIDERS].sort());
  });

  it('declares the CLI provider roster and live override env vars', () => {
    const cliDefinitions = getCliProviderDefinitions();
    assert.deepEqual(
      cliDefinitions.map((def) => def.id),
      EXPECTED_CLI_PROVIDER_ORDER,
    );
    for (const def of cliDefinitions) {
      assert.ok(def.cli, `${def.id} missing cli metadata`);
      assert.ok(def.defaultModel, `${def.id} missing defaultModel`);
      assert.ok(def.apiKeyEnvVars || def.cli.apiKeyEnvVars, `${def.id} missing api key env vars`);
      assert.equal(typeof def.cli.order, 'number', `${def.id} missing numeric CLI order`);
      assert.equal(new URL(def.cli.defaultUrl).protocol, 'https:');
      for (const envVar of def.cli.urlEnvVars) {
        assert.match(envVar, /^[A-Z][A-Z0-9_]*$/, `${def.id} URL env is not SCREAMING_SNAKE_CASE`);
      }
      assert.match(
        def.cli.modelEnvVar,
        /^[A-Z][A-Z0-9_]*$/,
        `${def.id} model env is not SCREAMING_SNAKE_CASE`,
      );
    }
  });

  it('exposes display names and legacy timeout names from the registry', () => {
    assert.equal(getProviderDisplayName('openrouter'), 'OpenRouter');
    assert.equal(getProviderDisplayName('demo'), 'Demo');
    assert.equal(getProviderTimeoutDisplayName('ollama'), 'Ollama Cloud');
    assert.equal(getProviderTimeoutDisplayName('openai'), 'OpenAI');
  });

  it('declares built-in settings order and key copy from the registry', () => {
    const definitions = getBuiltInSettingsProviderDefinitions();
    assert.deepEqual(
      definitions.map((def) => def.id),
      EXPECTED_BUILT_IN_SETTINGS_ORDER,
    );
    for (const def of definitions) {
      assert.equal(def.settings.keyStorageKey, `${def.id}_api_key`);
      assert.equal(def.settings.modelStorageKey, `${def.id}_model`);
      assert.ok(def.settings.keyPlaceholder?.trim(), `${def.id} missing keyPlaceholder`);
      assert.ok(def.settings.keySaveLabel?.trim(), `${def.id} missing keySaveLabel`);
      assert.ok(def.settings.keyHint?.trim(), `${def.id} missing keyHint`);
    }
  });

  it('exposes settings/icon/storage helpers from the registry', () => {
    assert.equal(getProviderSettingsDefinition('openrouter').envKey, 'VITE_OPENROUTER_API_KEY');
    assert.equal(getProviderIconDefinition('openai').fallbackText, 'GPT');
    assert.equal(getProviderApiKeyStorageKey('deepseek'), 'deepseek_api_key');
    assert.equal(getProviderModelStorageKey('cloudflare'), 'cloudflare_model');
    assert.equal(providerForApiKeyStorageKey('anthropic_api_key'), 'anthropic');
    assert.equal(providerForApiKeyStorageKey('cloudflare_api_key'), null);
    assert.equal(providerForApiKeyStorageKey('tavily_api_key'), null);
  });

  it('exposes provider route defaults from the registry', () => {
    assert.equal(getProviderStreamShape('deepseek'), 'anthropic');
    assert.equal(getProviderStreamShape('openrouter'), 'openai-responses');
    assert.equal(getProviderStreamShape('openai'), 'openai-responses');
    assert.equal(providerConsumesContentBlocksByDefault('anthropic'), true);
    assert.equal(providerConsumesContentBlocksByDefault('google'), true);
    assert.equal(providerConsumesContentBlocksByDefault('openrouter'), false);
    assert.equal(providerCarriesReasoningBlocksByDefault('deepseek'), true);
    assert.equal(providerCarriesReasoningBlocksByDefault('zen'), false);
  });

  for (const def of PROVIDER_DEFINITIONS) {
    describe(def.id, () => {
      it('id is kebab-case', () => {
        assert.match(def.id, KEBAB_ID);
      });

      it('displayName is non-empty', () => {
        assert.ok(def.displayName.trim().length > 0);
      });

      it('icon metadata is complete', () => {
        assert.ok(def.icon.src.trim(), `${def.id} missing icon src`);
        assert.ok(def.icon.alt.trim(), `${def.id} missing icon alt`);
        assert.ok(def.icon.fallbackText.trim(), `${def.id} missing icon fallback`);
      });

      it('settings metadata is complete', () => {
        assert.ok(def.settings.description.trim(), `${def.id} missing settings description`);
        assert.ok(def.settings.envKey.trim(), `${def.id} missing settings envKey`);
        assert.ok(def.settings.envUrl.trim(), `${def.id} missing settings envUrl`);
        assert.equal(
          typeof def.settings.modelContextWindow,
          'number',
          `${def.id} missing modelContextWindow`,
        );
        assert.ok(def.settings.modelContextWindow > 0, `${def.id} context must be positive`);
        if (def.settings.keyStorageKey) {
          assert.match(def.settings.keyStorageKey, /^[a-z][a-z0-9-]*_api_key$/);
        }
        if (def.settings.modelStorageKey) {
          assert.match(def.settings.modelStorageKey, /^[a-z][a-z0-9-]*_model$/);
        }
      });

      it('baseUrl parses as https URL when declared', () => {
        if (!def.baseUrl) return;
        const url = new URL(def.baseUrl);
        assert.equal(url.protocol, 'https:');
      });

      it('webProxyPath starts with /api/ when declared', () => {
        if (!def.webProxyPath) return;
        assert.ok(def.webProxyPath.startsWith('/api/'), `got "${def.webProxyPath}"`);
      });

      it('modelsProxyPath starts with /api/ when declared', () => {
        if (!def.modelsProxyPath) return;
        assert.ok(def.modelsProxyPath.startsWith('/api/'), `got "${def.modelsProxyPath}"`);
      });

      it('streamShape is valid', () => {
        assert.ok(
          VALID_STREAM_SHAPES.has(def.streamShape),
          `unknown streamShape "${def.streamShape}"`,
        );
      });

      it('fallback policy booleans are explicit', () => {
        assert.equal(typeof def.initialFallbackEligible, 'boolean');
        assert.equal(typeof def.failoverEligible, 'boolean');
        assert.equal(typeof def.adapterRouted, 'boolean');
      });

      it('models is non-empty when declared', () => {
        if (!def.models) return;
        assert.ok(def.models.length > 0);
      });

      it('defaultModel appears in models when both are declared', () => {
        if (!def.defaultModel || !def.models) return;
        assert.ok(
          def.models.includes(def.defaultModel),
          `defaultModel "${def.defaultModel}" not in models [${def.models.join(', ')}]`,
        );
      });

      it('apiKeyEnvVars is non-empty when declared', () => {
        if (!def.apiKeyEnvVars) return;
        assert.ok(def.apiKeyEnvVars.length > 0);
      });

      it('apiKeyEnvVars are all SCREAMING_SNAKE_CASE when declared', () => {
        for (const name of def.apiKeyEnvVars ?? []) {
          assert.match(name, /^[A-Z][A-Z0-9_]*$/, `env var "${name}" is not SCREAMING_SNAKE_CASE`);
        }
      });

      it('matches lib/provider-models.ts catalog entry when shared', () => {
        // ProviderDefinition is the canonical source; provider-models.ts is
        // its data backing for providers with a shared web+CLI static catalog.
        const catalogModels = SHARED_PROVIDER_MODEL_CATALOG[def.id];
        const catalogDefault = SHARED_PROVIDER_DEFAULT_MODELS[def.id];
        if (!catalogModels && !catalogDefault) return;
        assert.ok(def.models, `ProviderDefinition "${def.id}" omitted models`);
        assert.ok(def.defaultModel, `ProviderDefinition "${def.id}" omitted defaultModel`);
        assert.equal(def.defaultModel, catalogDefault);
        assert.deepEqual([...def.models], [...catalogModels]);
      });
    });
  }
});

// Cross-registry drift: as each direct provider is wired end-to-end, its
// ProviderDefinition entry must align with the surrounding registries. The
// assertions land per-provider so a provider that hasn't shipped yet (e.g.
// the OpenAI / Google PRs in this track) doesn't fail the suite prematurely.
describe('anthropic cross-registry wiring', () => {
  it('appears in AIProviderType', async () => {
    // `AIProviderType` derives from the `ALL_PROVIDERS` const array (the single
    // id-vocabulary source); a regex match on the array entry catches accidental
    // removals.
    const fs = await import('node:fs');
    const url = new URL('../../lib/provider-contract.ts', import.meta.url);
    const source = fs.readFileSync(url, 'utf8');
    assert.match(source, /^\s+'anthropic',$/m);
  });

  it('has worker provider handlers declared in worker-providers.ts', async () => {
    const fs = await import('node:fs');
    const url = new URL('../../app/src/worker/worker-providers.ts', import.meta.url);
    const source = fs.readFileSync(url, 'utf8');
    assert.match(
      source,
      /anthropic:\s*\{\s*chat:\s*handleAnthropicChat,\s*models:\s*handleAnthropicModels\s*\}/,
    );
  });

  it('has a stream-adapter factory in orchestrator-provider-routing.ts', async () => {
    const fs = await import('node:fs');
    const url = new URL('../../app/src/lib/orchestrator-provider-routing.ts', import.meta.url);
    const source = fs.readFileSync(url, 'utf8');
    assert.match(source, /anthropic:\s*anthropicStream/);
  });

  it('has a coder-job dispatch case for background runs', async () => {
    const fs = await import('node:fs');
    const url = new URL('../../app/src/worker/coder-job-stream-adapter.ts', import.meta.url);
    const source = fs.readFileSync(url, 'utf8');
    assert.match(source, /case 'anthropic':\s*\n\s*return handleAnthropicChat/);
  });
});

describe('openai cross-registry wiring', () => {
  it('appears in AIProviderType', async () => {
    const fs = await import('node:fs');
    const url = new URL('../../lib/provider-contract.ts', import.meta.url);
    const source = fs.readFileSync(url, 'utf8');
    assert.match(source, /^\s+'openai',$/m);
  });

  it('has worker provider handlers declared in worker-providers.ts', async () => {
    const fs = await import('node:fs');
    const url = new URL('../../app/src/worker/worker-providers.ts', import.meta.url);
    const source = fs.readFileSync(url, 'utf8');
    assert.match(
      source,
      /openai:\s*\{\s*chat:\s*handleOpenAIChat,\s*models:\s*handleOpenAIModels\s*\}/,
    );
  });

  it('has a stream-adapter factory in orchestrator-provider-routing.ts', async () => {
    const fs = await import('node:fs');
    const url = new URL('../../app/src/lib/orchestrator-provider-routing.ts', import.meta.url);
    const source = fs.readFileSync(url, 'utf8');
    assert.match(source, /openai:\s*openaiStream/);
  });

  it('has a coder-job dispatch case for background runs', async () => {
    const fs = await import('node:fs');
    const url = new URL('../../app/src/worker/coder-job-stream-adapter.ts', import.meta.url);
    const source = fs.readFileSync(url, 'utf8');
    assert.match(source, /case 'openai':\s*\n\s*return handleOpenAIChat/);
  });
});

describe('google cross-registry wiring', () => {
  it('appears in AIProviderType', async () => {
    const fs = await import('node:fs');
    const url = new URL('../../lib/provider-contract.ts', import.meta.url);
    const source = fs.readFileSync(url, 'utf8');
    assert.match(source, /^\s+'google',$/m);
  });

  it('has worker provider handlers declared in worker-providers.ts', async () => {
    const fs = await import('node:fs');
    const url = new URL('../../app/src/worker/worker-providers.ts', import.meta.url);
    const source = fs.readFileSync(url, 'utf8');
    assert.match(
      source,
      /google:\s*\{\s*chat:\s*handleGoogleChat,\s*models:\s*handleGoogleModels\s*\}/,
    );
  });

  it('has a stream-adapter factory in orchestrator-provider-routing.ts', async () => {
    const fs = await import('node:fs');
    const url = new URL('../../app/src/lib/orchestrator-provider-routing.ts', import.meta.url);
    const source = fs.readFileSync(url, 'utf8');
    assert.match(source, /google:\s*geminiStream/);
  });

  it('has a coder-job dispatch case for background runs', async () => {
    const fs = await import('node:fs');
    const url = new URL('../../app/src/worker/coder-job-stream-adapter.ts', import.meta.url);
    const source = fs.readFileSync(url, 'utf8');
    assert.match(source, /case 'google':\s*\n\s*return handleGoogleChat/);
  });
});

describe('ProviderDefinition lookup helpers', () => {
  it('getProviderDefinition returns each registered entry', () => {
    for (const def of PROVIDER_DEFINITIONS) {
      assert.equal(getProviderDefinition(def.id), def);
    }
  });

  it('getProviderDefinition throws for unknown id', () => {
    // @ts-expect-error: deliberate invalid id for runtime check.
    assert.throws(() => getProviderDefinition('not-a-provider'), /No ProviderDefinition/);
  });

  it('findProviderDefinition returns undefined for unknown id', () => {
    assert.equal(findProviderDefinition('not-a-provider'), undefined);
  });

  it('findProviderDefinition resolves a known id', () => {
    assert.ok(findProviderDefinition('openai'));
  });
});
