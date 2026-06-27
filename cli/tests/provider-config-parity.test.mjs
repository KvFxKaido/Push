import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { PROVIDER_CONFIGS } from '../provider.ts';
import { getCliProviderDefinitions } from '../../lib/provider-definition.ts';

const webProviderSource = readFileSync(
  new URL('../../app/src/lib/providers.ts', import.meta.url),
  'utf8',
);

function extractWebProviderEnvKey(source, providerId) {
  const escapedId = providerId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = source.match(new RegExp(`type:\\s*'${escapedId}'[\\s\\S]*?envKey:\\s*'([^']+)'`));
  assert.ok(match, `Expected to find web provider envKey for ${providerId}`);
  return match[1];
}

function withClearedCliEnv(fn) {
  const envVars = new Set();
  for (const def of getCliProviderDefinitions()) {
    assert.ok(def.cli, `Expected ${def.id} to carry CLI metadata`);
    envVars.add(def.cli.modelEnvVar);
    for (const envVar of def.cli.urlEnvVars) envVars.add(envVar);
  }

  const previous = new Map();
  for (const envVar of envVars) {
    previous.set(envVar, process.env[envVar]);
    delete process.env[envVar];
  }

  try {
    return fn();
  } finally {
    for (const [envVar, value] of previous) {
      if (value === undefined) {
        delete process.env[envVar];
      } else {
        process.env[envVar] = value;
      }
    }
  }
}

describe('provider config parity', () => {
  const cliDefinitions = getCliProviderDefinitions();

  it('derives the CLI provider roster from provider-definition.ts', () => {
    assert.deepEqual(
      Object.keys(PROVIDER_CONFIGS),
      cliDefinitions.map((def) => def.id),
    );
  });

  it('keeps CLI provider ids, defaults, URLs, and stream shapes in sync with the registry', () => {
    withClearedCliEnv(() => {
      for (const def of cliDefinitions) {
        const cfg = PROVIDER_CONFIGS[def.id];
        assert.ok(cfg, `Expected PROVIDER_CONFIGS to include ${def.id}`);
        assert.ok(def.cli, `Expected ${def.id} to carry CLI metadata`);
        assert.ok(def.defaultModel, `Expected ${def.id} to carry defaultModel`);
        assert.equal(cfg.id, def.id);
        assert.equal(cfg.url, def.cli.defaultUrl);
        assert.equal(cfg.defaultModel, def.defaultModel);
        assert.equal(cfg.requiresKey, true);
        assert.equal(cfg.streamShape ?? 'openai-compat', def.streamShape);
      }
    });
  });

  it('keeps CLI API key fallbacks compatible with the registry and web env keys', () => {
    for (const def of cliDefinitions) {
      const cfg = PROVIDER_CONFIGS[def.id];
      assert.ok(cfg, `Expected PROVIDER_CONFIGS to include ${def.id}`);
      const expectedEnv = def.cli?.apiKeyEnvVars ?? def.apiKeyEnvVars;
      assert.deepEqual(cfg.apiKeyEnv, expectedEnv);
      const webEnvKey = extractWebProviderEnvKey(webProviderSource, def.id);
      assert.ok(
        cfg.apiKeyEnv.includes(webEnvKey),
        `Expected ${def.id} apiKeyEnv to include ${webEnvKey}`,
      );
    }
  });

  it('keeps CLI URL and model overrides live', () => {
    const def = cliDefinitions.find((entry) => entry.id === 'zen');
    assert.ok(def?.cli, 'Expected zen to carry CLI metadata');
    const cfg = PROVIDER_CONFIGS.zen;
    const [urlEnv] = def.cli.urlEnvVars;
    const modelEnv = def.cli.modelEnvVar;
    const previousUrl = process.env[urlEnv];
    const previousModel = process.env[modelEnv];
    try {
      process.env[urlEnv] = 'https://rotated.example/v1/chat/completions';
      process.env[modelEnv] = 'rotated-model';
      assert.equal(cfg.url, 'https://rotated.example/v1/chat/completions');
      assert.equal(cfg.defaultModel, 'rotated-model');
    } finally {
      if (previousUrl === undefined) delete process.env[urlEnv];
      else process.env[urlEnv] = previousUrl;
      if (previousModel === undefined) delete process.env[modelEnv];
      else process.env[modelEnv] = previousModel;
    }
  });
});
