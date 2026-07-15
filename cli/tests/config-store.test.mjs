import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyConfigToEnv,
  reapplyProviderConfigToEnv,
  resolveRuntimeConfig,
} from '../config-store.ts';
import { mergeConfigLayers } from '../../lib/config-layers.ts';

const savedEnv = {
  PUSH_PROVIDER: process.env.PUSH_PROVIDER,
  PUSH_LOCAL_SANDBOX: process.env.PUSH_LOCAL_SANDBOX,
  PUSH_EXPLAIN_MODE: process.env.PUSH_EXPLAIN_MODE,
  PUSH_TAVILY_API_KEY: process.env.PUSH_TAVILY_API_KEY,
  PUSH_WEB_SEARCH_BACKEND: process.env.PUSH_WEB_SEARCH_BACKEND,
  PUSH_THEME: process.env.PUSH_THEME,
  PUSH_SPINNER: process.env.PUSH_SPINNER,
  PUSH_TUI_MOUSE_MODE: process.env.PUSH_TUI_MOUSE_MODE,
  PUSH_ZEN_URL: process.env.PUSH_ZEN_URL,
  PUSH_ZEN_API_KEY: process.env.PUSH_ZEN_API_KEY,
  PUSH_ZEN_MODEL: process.env.PUSH_ZEN_MODEL,
  PUSH_ANTHROPIC_API_KEY: process.env.PUSH_ANTHROPIC_API_KEY,
};

function restoreEnv() {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

describe('applyConfigToEnv', () => {
  afterEach(() => {
    restoreEnv();
  });

  it('applies tavilyApiKey to PUSH_TAVILY_API_KEY when missing', () => {
    delete process.env.PUSH_TAVILY_API_KEY;

    applyConfigToEnv({
      tavilyApiKey: 'tvly-config-key',
    });

    assert.equal(process.env.PUSH_TAVILY_API_KEY, 'tvly-config-key');
  });

  it('does not override existing PUSH_TAVILY_API_KEY', () => {
    process.env.PUSH_TAVILY_API_KEY = 'existing-env-key';

    applyConfigToEnv({
      tavilyApiKey: 'tvly-config-key',
    });

    assert.equal(process.env.PUSH_TAVILY_API_KEY, 'existing-env-key');
  });

  it('does not export sentinel string values from config', () => {
    delete process.env.PUSH_PROVIDER;
    delete process.env.PUSH_TAVILY_API_KEY;

    applyConfigToEnv({
      provider: 'undefined',
      tavilyApiKey: 'null',
    });

    assert.equal(process.env.PUSH_PROVIDER, undefined);
    assert.equal(process.env.PUSH_TAVILY_API_KEY, undefined);
  });

  it('preserves a named local exec sandbox backend', () => {
    delete process.env.PUSH_LOCAL_SANDBOX;

    applyConfigToEnv({ localSandbox: 'native' });

    assert.equal(process.env.PUSH_LOCAL_SANDBOX, 'native');
  });

  it('applies webSearchBackend to PUSH_WEB_SEARCH_BACKEND when missing', () => {
    delete process.env.PUSH_WEB_SEARCH_BACKEND;

    applyConfigToEnv({
      webSearchBackend: 'duckduckgo',
    });

    assert.equal(process.env.PUSH_WEB_SEARCH_BACKEND, 'duckduckgo');
  });

  it('does not override existing PUSH_WEB_SEARCH_BACKEND', () => {
    process.env.PUSH_WEB_SEARCH_BACKEND = 'tavily';

    applyConfigToEnv({
      webSearchBackend: 'duckduckgo',
    });

    assert.equal(process.env.PUSH_WEB_SEARCH_BACKEND, 'tavily');
  });

  it('applies explainMode to PUSH_EXPLAIN_MODE when missing (including false)', () => {
    delete process.env.PUSH_EXPLAIN_MODE;

    applyConfigToEnv({
      explainMode: false,
    });

    assert.equal(process.env.PUSH_EXPLAIN_MODE, 'false');
  });

  it('does not override existing PUSH_EXPLAIN_MODE', () => {
    process.env.PUSH_EXPLAIN_MODE = 'true';

    applyConfigToEnv({
      explainMode: false,
    });

    assert.equal(process.env.PUSH_EXPLAIN_MODE, 'true');
  });

  it('applies theme to PUSH_THEME when missing', () => {
    delete process.env.PUSH_THEME;

    applyConfigToEnv({ theme: 'neon' });

    assert.equal(process.env.PUSH_THEME, 'neon');
  });

  it('does not override existing PUSH_THEME', () => {
    process.env.PUSH_THEME = 'forest';

    applyConfigToEnv({ theme: 'neon' });

    assert.equal(process.env.PUSH_THEME, 'forest');
  });

  it('applies spinner to PUSH_SPINNER when missing', () => {
    delete process.env.PUSH_SPINNER;

    applyConfigToEnv({ spinner: 'braille' });

    assert.equal(process.env.PUSH_SPINNER, 'braille');
  });

  it('does not override existing PUSH_SPINNER', () => {
    process.env.PUSH_SPINNER = 'orbit';

    applyConfigToEnv({ spinner: 'helix' });

    assert.equal(process.env.PUSH_SPINNER, 'orbit');
  });

  it('applies TUI mouse mode to PUSH_TUI_MOUSE_MODE when missing', () => {
    delete process.env.PUSH_TUI_MOUSE_MODE;

    applyConfigToEnv({ tuiMouseMode: 'app' });

    assert.equal(process.env.PUSH_TUI_MOUSE_MODE, 'app');
  });

  it('does not override existing PUSH_TUI_MOUSE_MODE', () => {
    process.env.PUSH_TUI_MOUSE_MODE = 'native';

    applyConfigToEnv({ tuiMouseMode: 'app' });

    assert.equal(process.env.PUSH_TUI_MOUSE_MODE, 'native');
  });

  // Regression guard for the table refactor: provider keys must still DEFER to
  // an already-set env var on startup (setEnvIfMissing semantics preserved).
  it('does not override an existing provider key on startup application', () => {
    process.env.PUSH_ZEN_API_KEY = 'sk-old-env';

    applyConfigToEnv({ zen: { apiKey: 'sk-new-config' } });

    assert.equal(process.env.PUSH_ZEN_API_KEY, 'sk-old-env');
  });
});

describe('reapplyProviderConfigToEnv', () => {
  afterEach(() => {
    restoreEnv();
  });

  // The core of the TUI-key-rotation fix: a daemon inherits a stale provider
  // key at spawn; an explicit reload must OVERWRITE it from the on-disk config.
  it('overwrites a stale provider key the startup path would have kept', () => {
    process.env.PUSH_ZEN_API_KEY = 'sk-stale';

    const changed = reapplyProviderConfigToEnv({ zen: { apiKey: 'sk-rotated' } });

    assert.equal(process.env.PUSH_ZEN_API_KEY, 'sk-rotated');
    assert.ok(changed.includes('PUSH_ZEN_API_KEY'));
  });

  it('reports only env vars whose value actually changed', () => {
    process.env.PUSH_ZEN_API_KEY = 'sk-same';
    delete process.env.PUSH_ANTHROPIC_API_KEY;

    const changed = reapplyProviderConfigToEnv({
      zen: { apiKey: 'sk-same' }, // unchanged → not reported
      anthropic: { apiKey: 'sk-anthropic' }, // newly set → reported
    });

    assert.deepEqual(changed, ['PUSH_ANTHROPIC_API_KEY']);
    assert.equal(process.env.PUSH_ANTHROPIC_API_KEY, 'sk-anthropic');
  });

  it('overwrites the Tavily key too', () => {
    process.env.PUSH_TAVILY_API_KEY = 'tvly-stale';

    const changed = reapplyProviderConfigToEnv({ tavilyApiKey: 'tvly-rotated' });

    assert.equal(process.env.PUSH_TAVILY_API_KEY, 'tvly-rotated');
    assert.ok(changed.includes('PUSH_TAVILY_API_KEY'));
  });

  it('ignores sentinel/empty values rather than blanking a live key', () => {
    process.env.PUSH_ZEN_API_KEY = 'sk-live';

    const changed = reapplyProviderConfigToEnv({ zen: { apiKey: 'undefined' } });

    assert.equal(process.env.PUSH_ZEN_API_KEY, 'sk-live');
    assert.deepEqual(changed, []);
  });
});

describe('mergeConfigLayers', () => {
  it('deep-merges objects, replaces arrays, and records the winning leaf source', () => {
    const resolution = mergeConfigLayers([
      {
        id: 'user',
        kind: 'user',
        value: {
          provider: 'ollama',
          disabledTools: ['exec'],
          anthropic: { model: 'claude-user', url: 'https://user.example' },
        },
      },
      {
        id: 'env:PUSH_ANTHROPIC_MODEL',
        kind: 'environment',
        value: {
          disabledTools: ['write_file'],
          anthropic: { model: 'claude-env' },
        },
      },
    ]);

    assert.deepEqual(resolution.config, {
      provider: 'ollama',
      disabledTools: ['write_file'],
      anthropic: { model: 'claude-env', url: 'https://user.example' },
    });
    assert.equal(resolution.provenance.provider.source, 'user');
    assert.equal(resolution.provenance.disabledTools.source, 'env:PUSH_ANTHROPIC_MODEL');
    assert.equal(resolution.provenance['anthropic.model'].source, 'env:PUSH_ANTHROPIC_MODEL');
    assert.equal(resolution.provenance['anthropic.url'].source, 'user');
  });

  it('clears stale child provenance when a higher layer replaces an object', () => {
    const resolution = mergeConfigLayers([
      { id: 'user', kind: 'user', value: { scrub: { allow: ['CI'] } } },
      { id: 'cli', kind: 'cli', value: { scrub: false } },
    ]);

    assert.deepEqual(resolution.config, { scrub: false });
    assert.equal(resolution.provenance.scrub.source, 'cli');
    assert.equal(resolution.provenance['scrub.allow'], undefined);
  });

  it('rejects prototype-polluting keys instead of merging them', () => {
    const hostile = JSON.parse('{"__proto__":{"polluted":true}}');

    assert.throws(
      () => mergeConfigLayers([{ id: 'project', kind: 'project', value: hostile }]),
      /Unsafe configuration key: __proto__/,
    );
    assert.equal({}.polluted, undefined);
  });
});

describe('resolveRuntimeConfig', () => {
  it('resolves user < environment < CLI overrides with exact provenance', () => {
    const resolution = resolveRuntimeConfig(
      {
        provider: 'ollama',
        localSandbox: false,
        anthropic: { model: 'claude-user', apiKey: 'user-secret' },
      },
      {
        env: {
          PUSH_PROVIDER: 'anthropic',
          PUSH_LOCAL_SANDBOX: 'native',
          PUSH_ANTHROPIC_MODEL: 'claude-env',
          ANTHROPIC_API_KEY: 'env-secret',
        },
        overrides: { provider: 'openai' },
      },
    );

    assert.equal(resolution.config.provider, 'openai');
    assert.equal(resolution.config.localSandbox, 'native');
    assert.deepEqual(resolution.config.anthropic, {
      model: 'claude-env',
      apiKey: 'env-secret',
    });
    assert.equal(resolution.provenance.provider.source, 'cli-overrides');
    assert.equal(resolution.provenance.localSandbox.source, 'env:PUSH_LOCAL_SANDBOX');
    assert.equal(resolution.provenance['anthropic.model'].source, 'env:PUSH_ANTHROPIC_MODEL');
    assert.equal(resolution.provenance['anthropic.apiKey'].source, 'env:ANTHROPIC_API_KEY');
  });

  it('normalizes environment lists and booleans into the typed config shape', () => {
    const resolution = resolveRuntimeConfig(
      { disabledTools: ['exec'], scrub: { disabled: false } },
      {
        env: {
          PUSH_DISABLED_TOOLS: 'read_file, write_file',
          PUSH_SCRUB_DISABLED: 'true',
        },
      },
    );

    assert.deepEqual(resolution.config.disabledTools, ['read_file', 'write_file']);
    assert.equal(resolution.config.scrub.disabled, true);
  });

  it('ignores invalid strict booleans instead of masking saved values', () => {
    const resolution = resolveRuntimeConfig(
      {
        auditorGate: false,
        postEditDiagnostics: false,
        scrub: { disabled: true },
      },
      {
        env: {
          PUSH_AUDITOR_GATE: 'maybe',
          PUSH_POST_EDIT_DIAGNOSTICS: 'perhaps',
          PUSH_SCRUB_DISABLED: 'sometimes',
        },
      },
    );

    assert.equal(resolution.config.auditorGate, false);
    assert.equal(resolution.config.postEditDiagnostics, false);
    assert.equal(resolution.config.scrub.disabled, true);
    assert.equal(resolution.provenance.auditorGate.source, 'user-config');
    assert.equal(resolution.provenance.postEditDiagnostics.source, 'user-config');
    assert.equal(resolution.provenance['scrub.disabled'].source, 'user-config');
    assert.deepEqual(
      resolution.layers.map((layer) => layer.id),
      ['user-config'],
    );
  });
});
