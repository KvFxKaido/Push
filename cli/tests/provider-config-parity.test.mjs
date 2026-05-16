import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const cliProviderSource = readFileSync(new URL('../provider.ts', import.meta.url), 'utf8');
const webProviderSource = readFileSync(
  new URL('../../app/src/lib/providers.ts', import.meta.url),
  'utf8',
);
const sharedProviderModelSource = readFileSync(
  new URL('../../lib/provider-models.ts', import.meta.url),
  'utf8',
);

function extractExportedStringConstant(source, exportName) {
  const match = source.match(new RegExp(`export const ${exportName}\\s*=\\s*'([^']+)';`));
  assert.ok(match, `Expected to find exported string constant ${exportName}`);
  return match[1];
}

function extractUnionMembers(source, typeName) {
  const match = source.match(new RegExp(`export type ${typeName}\\s*=\\s*([^;]+);`));
  assert.ok(match, `Expected to find union type ${typeName}`);
  return [...match[1].matchAll(/'([^']+)'/g)].map(([, value]) => value);
}

function extractProviderConfigsBlock(source) {
  const match = source.match(/export const PROVIDER_CONFIGS[^=]*= \{([\s\S]*?)\n\};/);
  assert.ok(match, 'Expected to find PROVIDER_CONFIGS');
  return match[1];
}

function extractCliProviderIds(source) {
  const block = extractProviderConfigsBlock(source);
  return [...block.matchAll(/^\s{2}([a-z]+):\s*\{/gm)].map(([, id]) => id);
}

function extractCliProviderEntry(source, providerId) {
  const block = extractProviderConfigsBlock(source);
  const escapedId = providerId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = block.match(
    new RegExp(`^\\s{2}${escapedId}:\\s*\\{([\\s\\S]*?)^\\s{2}\\},?$`, 'm'),
  );
  assert.ok(match, `Expected to find CLI provider entry ${providerId}`);

  const entry = match[1];
  const idMatch = entry.match(/id:\s*'([^']+)'/);
  const apiKeyEnvMatch = entry.match(/apiKeyEnv:\s*\[([\s\S]*?)\]/);

  assert.ok(idMatch, `Expected CLI provider ${providerId} to define id`);
  assert.ok(apiKeyEnvMatch, `Expected CLI provider ${providerId} to define apiKeyEnv`);

  return {
    id: idMatch[1],
    entry,
    apiKeyEnv: [...apiKeyEnvMatch[1].matchAll(/'([^']+)'/g)].map(([, value]) => value),
  };
}

function extractWebProviderEnvKey(source, providerId) {
  const escapedId = providerId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = source.match(new RegExp(`type:\\s*'${escapedId}'[\\s\\S]*?envKey:\\s*'([^']+)'`));
  assert.ok(match, `Expected to find web provider envKey for ${providerId}`);
  return match[1];
}

describe('provider config parity', () => {
  const allWebProviderIds = extractUnionMembers(webProviderSource, 'PreferredProvider');
  // CLI only implements the four built-in providers; azure/bedrock/vertex are
  // advanced connectors deferred per the Web-CLI Parity Plan. `anthropic` is
  // deferred until the openai-anthropic-bridge promotes from `app/src/lib/` to
  // shared `lib/` and the CLI gains a non-OpenAI-compat stream adapter — both
  // belong in the CLI Anthropic follow-up PR, not this Worker-side wiring.
  const CLI_DEFERRED_PROVIDERS = new Set(['azure', 'bedrock', 'vertex', 'cloudflare', 'anthropic']);
  const providerIds = allWebProviderIds.filter((id) => !CLI_DEFERRED_PROVIDERS.has(id));
  const defaultConstByProvider = {
    ollama: 'OLLAMA_DEFAULT_MODEL',
    openrouter: 'OPENROUTER_DEFAULT_MODEL',
    zen: 'ZEN_DEFAULT_MODEL',
    nvidia: 'NVIDIA_DEFAULT_MODEL',
    kilocode: 'KILOCODE_DEFAULT_MODEL',
    blackbox: 'BLACKBOX_DEFAULT_MODEL',
    openadapter: 'OPENADAPTER_DEFAULT_MODEL',
  };

  it('keeps the CLI provider roster in sync with the web provider set', () => {
    assert.deepEqual(extractCliProviderIds(cliProviderSource).sort(), [...providerIds].sort());
  });

  it('keeps CLI provider ids and default models in sync with web defaults', () => {
    for (const providerId of providerIds) {
      const entry = extractCliProviderEntry(cliProviderSource, providerId);
      assert.equal(entry.id, providerId);
      assert.match(
        entry.entry,
        new RegExp(
          `defaultModel:\\s*process\\.env\\.[A-Z0-9_]+\\s*\\|\\|\\s*${defaultConstByProvider[providerId]}`,
        ),
        `Expected ${providerId} default model to reference ${defaultConstByProvider[providerId]}`,
      );
      assert.ok(
        extractExportedStringConstant(sharedProviderModelSource, defaultConstByProvider[providerId])
          .length > 0,
        `Expected shared model constant ${defaultConstByProvider[providerId]} to resolve to a non-empty value`,
      );
    }
  });

  it('keeps CLI API key fallbacks compatible with the web provider env keys', () => {
    for (const providerId of providerIds) {
      const entry = extractCliProviderEntry(cliProviderSource, providerId);
      const webEnvKey = extractWebProviderEnvKey(webProviderSource, providerId);
      assert.ok(
        entry.apiKeyEnv.includes(webEnvKey),
        `Expected ${providerId} apiKeyEnv to include ${webEnvKey}`,
      );
    }
  });
});
