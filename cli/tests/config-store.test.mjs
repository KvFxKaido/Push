import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { applyConfigToEnv } from '../config-store.ts';

const savedEnv = {
  PUSH_PROVIDER: process.env.PUSH_PROVIDER,
  PUSH_LOCAL_SANDBOX: process.env.PUSH_LOCAL_SANDBOX,
  PUSH_EXPLAIN_MODE: process.env.PUSH_EXPLAIN_MODE,
  PUSH_TAVILY_API_KEY: process.env.PUSH_TAVILY_API_KEY,
  PUSH_WEB_SEARCH_BACKEND: process.env.PUSH_WEB_SEARCH_BACKEND,
  PUSH_THEME: process.env.PUSH_THEME,
  PUSH_ANIMATION: process.env.PUSH_ANIMATION,
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

  it('applies animation to PUSH_ANIMATION when missing', () => {
    delete process.env.PUSH_ANIMATION;

    applyConfigToEnv({ animation: 'pulse' });

    assert.equal(process.env.PUSH_ANIMATION, 'pulse');
  });

  it('does not override existing PUSH_ANIMATION', () => {
    process.env.PUSH_ANIMATION = 'shimmer';

    applyConfigToEnv({ animation: 'rainbow' });

    assert.equal(process.env.PUSH_ANIMATION, 'shimmer');
  });
});
