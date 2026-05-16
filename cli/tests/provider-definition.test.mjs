import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  PROVIDER_DEFINITIONS,
  findProviderDefinition,
  getProviderDefinition,
} from '../../lib/provider-definition.ts';
import {
  SHARED_PROVIDER_DEFAULT_MODELS,
  SHARED_PROVIDER_MODEL_CATALOG,
} from '../../lib/provider-models.ts';

const VALID_STREAM_SHAPES = new Set(['openai-compat', 'anthropic', 'gemini']);
const KEBAB_ID = /^[a-z][a-z0-9-]*$/;

// Drift-detector: internal consistency of every ProviderDefinition entry.
// Cross-registry assertions (CLI PROVIDER_CONFIGS, web PROVIDER_URLS, Worker
// dispatch, Settings UI) get added per-provider as each follow-up PR lands —
// they would fail today because no direct provider is wired end-to-end yet.
describe('ProviderDefinition', () => {
  it('has at least one entry', () => {
    assert.ok(PROVIDER_DEFINITIONS.length > 0);
  });

  it('ids are unique', () => {
    const ids = PROVIDER_DEFINITIONS.map((def) => def.id);
    assert.equal(new Set(ids).size, ids.length, `duplicate ids in ${ids.join(', ')}`);
  });

  it('webProxyPaths are unique', () => {
    const paths = PROVIDER_DEFINITIONS.map((def) => def.webProxyPath);
    assert.equal(
      new Set(paths).size,
      paths.length,
      `duplicate webProxyPaths in ${paths.join(', ')}`,
    );
  });

  for (const def of PROVIDER_DEFINITIONS) {
    describe(def.id, () => {
      it('id is kebab-case', () => {
        assert.match(def.id, KEBAB_ID);
      });

      it('displayName is non-empty', () => {
        assert.ok(def.displayName.trim().length > 0);
      });

      it('baseUrl parses as https URL', () => {
        const url = new URL(def.baseUrl);
        assert.equal(url.protocol, 'https:');
      });

      it('webProxyPath starts with /api/', () => {
        assert.ok(def.webProxyPath.startsWith('/api/'), `got "${def.webProxyPath}"`);
      });

      it('streamShape is valid', () => {
        assert.ok(
          VALID_STREAM_SHAPES.has(def.streamShape),
          `unknown streamShape "${def.streamShape}"`,
        );
      });

      it('models is non-empty', () => {
        assert.ok(def.models.length > 0);
      });

      it('defaultModel appears in models', () => {
        assert.ok(
          def.models.includes(def.defaultModel),
          `defaultModel "${def.defaultModel}" not in models [${def.models.join(', ')}]`,
        );
      });

      it('apiKeyEnvVars is non-empty', () => {
        assert.ok(def.apiKeyEnvVars.length > 0);
      });

      it('apiKeyEnvVars are all SCREAMING_SNAKE_CASE', () => {
        for (const name of def.apiKeyEnvVars) {
          assert.match(name, /^[A-Z][A-Z0-9_]*$/, `env var "${name}" is not SCREAMING_SNAKE_CASE`);
        }
      });

      it('matches lib/provider-models.ts catalog entry', () => {
        // ProviderDefinition is the canonical source; provider-models.ts is
        // its data backing. If these drift the curated lists in dropdowns
        // would disagree with the lists the runtime sees.
        const catalogModels = SHARED_PROVIDER_MODEL_CATALOG[def.id];
        const catalogDefault = SHARED_PROVIDER_DEFAULT_MODELS[def.id];
        assert.ok(catalogModels, `no SHARED_PROVIDER_MODEL_CATALOG entry for "${def.id}"`);
        assert.ok(catalogDefault, `no SHARED_PROVIDER_DEFAULT_MODELS entry for "${def.id}"`);
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
    // The union is types-only at runtime, but provider-contract.ts is the
    // single declaration site — a regex match catches accidental removals.
    const fs = await import('node:fs');
    const url = new URL('../../lib/provider-contract.ts', import.meta.url);
    const source = fs.readFileSync(url, 'utf8');
    assert.match(source, /\|\s*'anthropic'/);
  });

  it('has a worker proxy route declared in app/worker.ts', async () => {
    const fs = await import('node:fs');
    const url = new URL('../../app/worker.ts', import.meta.url);
    const source = fs.readFileSync(url, 'utf8');
    assert.match(source, /handler:\s*handleAnthropicChat/);
    assert.match(source, /'\/api\/anthropic\/chat'/);
  });

  it('has a stream-adapter dispatch case in orchestrator-provider-routing.ts', async () => {
    const fs = await import('node:fs');
    const url = new URL('../../app/src/lib/orchestrator-provider-routing.ts', import.meta.url);
    const source = fs.readFileSync(url, 'utf8');
    assert.match(
      source,
      /case 'anthropic':\s*\n\s*stream = \(req\) => normalizeReasoning\(anthropicStream/,
    );
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
    assert.match(source, /\|\s*'openai'/);
  });

  it('has worker proxy routes declared in app/worker.ts', async () => {
    const fs = await import('node:fs');
    const url = new URL('../../app/worker.ts', import.meta.url);
    const source = fs.readFileSync(url, 'utf8');
    assert.match(source, /handler:\s*handleOpenAIChat/);
    assert.match(source, /'\/api\/openai\/chat'/);
    assert.match(source, /handler:\s*handleOpenAIModels/);
    assert.match(source, /'\/api\/openai\/models'/);
  });

  it('has a stream-adapter dispatch case in orchestrator-provider-routing.ts', async () => {
    const fs = await import('node:fs');
    const url = new URL('../../app/src/lib/orchestrator-provider-routing.ts', import.meta.url);
    const source = fs.readFileSync(url, 'utf8');
    assert.match(
      source,
      /case 'openai':\s*\n\s*stream = \(req\) => normalizeReasoning\(openaiStream/,
    );
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
    assert.match(source, /\|\s*'google'/);
  });

  it('has worker proxy routes declared in app/worker.ts', async () => {
    const fs = await import('node:fs');
    const url = new URL('../../app/worker.ts', import.meta.url);
    const source = fs.readFileSync(url, 'utf8');
    assert.match(source, /handler:\s*handleGoogleChat/);
    assert.match(source, /'\/api\/google\/chat'/);
    assert.match(source, /handler:\s*handleGoogleModels/);
    assert.match(source, /'\/api\/google\/models'/);
  });

  it('has a stream-adapter dispatch case in orchestrator-provider-routing.ts', async () => {
    const fs = await import('node:fs');
    const url = new URL('../../app/src/lib/orchestrator-provider-routing.ts', import.meta.url);
    const source = fs.readFileSync(url, 'utf8');
    assert.match(
      source,
      /case 'google':\s*\n\s*stream = \(req\) => normalizeReasoning\(geminiStream/,
    );
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
