import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import {
  getDefaultEmbeddingProvider,
  setDefaultEmbeddingProvider,
} from '../../lib/embedding-provider.ts';
import { installCliEmbeddingProvider } from '../embedding-provider-cli.ts';
import { LOCAL_EMBEDDING_MODEL } from '../embedding-provider-local.ts';

// Pins the provider-selection precedence:
//   PUSH_EMBED_URL set      -> remote (Worker) provider
//   PUSH_EMBED_LOCAL === '0' -> no provider (lexical)
//   otherwise               -> local on-device provider

const SAVED = {
  url: process.env.PUSH_EMBED_URL,
  local: process.env.PUSH_EMBED_LOCAL,
  token: process.env.PUSH_EMBED_TOKEN,
};

afterEach(() => {
  for (const key of ['PUSH_EMBED_URL', 'PUSH_EMBED_LOCAL', 'PUSH_EMBED_TOKEN']) {
    const saved =
      SAVED[key === 'PUSH_EMBED_URL' ? 'url' : key === 'PUSH_EMBED_LOCAL' ? 'local' : 'token'];
    if (saved === undefined) delete process.env[key];
    else process.env[key] = saved;
  }
  setDefaultEmbeddingProvider(null);
});

describe('installCliEmbeddingProvider — selection precedence', () => {
  it('selects the remote provider when PUSH_EMBED_URL is set', () => {
    process.env.PUSH_EMBED_URL = 'https://push.example.workers.dev';
    delete process.env.PUSH_EMBED_LOCAL;
    installCliEmbeddingProvider();
    const provider = getDefaultEmbeddingProvider();
    assert.ok(provider);
    assert.equal(provider.model, '@cf/baai/bge-base-en-v1.5');
  });

  it('selects no provider (lexical) when PUSH_EMBED_LOCAL=0 and no URL', () => {
    delete process.env.PUSH_EMBED_URL;
    process.env.PUSH_EMBED_LOCAL = '0';
    installCliEmbeddingProvider();
    assert.equal(getDefaultEmbeddingProvider(), null);
  });

  it('selects the local provider by default (no URL, local not disabled)', () => {
    delete process.env.PUSH_EMBED_URL;
    delete process.env.PUSH_EMBED_LOCAL;
    installCliEmbeddingProvider();
    const provider = getDefaultEmbeddingProvider();
    assert.ok(provider);
    assert.equal(provider.model, LOCAL_EMBEDDING_MODEL);
  });
});
