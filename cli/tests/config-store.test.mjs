import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { applyConfigToEnv } from '../config-store.mjs';

const savedEnv = {
  PUSH_PROVIDER: process.env.PUSH_PROVIDER,
  PUSH_LOCAL_SANDBOX: process.env.PUSH_LOCAL_SANDBOX,
  PUSH_TAVILY_API_KEY: process.env.PUSH_TAVILY_API_KEY,
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
});

