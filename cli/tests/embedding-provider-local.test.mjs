import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  createLocalEmbeddingProvider,
  LOCAL_EMBEDDING_MODEL,
} from '../embedding-provider-local.ts';

// Load-free contract tests. We deliberately do NOT exercise a real embed here:
// @huggingface/transformers is an optional dependency that, when installed,
// would load a ~110MB model — far too heavy for a unit test, and network-
// dependent on a cold cache. The real embedding path (768-dim vectors, related
// vs unrelated cosine behavior) is verified by a manual smoke test recorded in
// the PR. These tests pin the cheap, deterministic guarantees.

describe('local embedding provider — load-free contract', () => {
  it('exposes the local model id, distinct from the Worker BGE id', () => {
    const provider = createLocalEmbeddingProvider();
    assert.equal(provider.model, LOCAL_EMBEDDING_MODEL);
    assert.equal(LOCAL_EMBEDDING_MODEL, 'local:bge-base-en-v1.5');
    // Distinct id is what keeps the scorer's same-model gate from comparing
    // locally-embedded vectors against CF-embedded ones.
    assert.notEqual(LOCAL_EMBEDDING_MODEL, '@cf/baai/bge-base-en-v1.5');
  });

  it('returns [] for an empty batch without loading the model', async () => {
    const provider = createLocalEmbeddingProvider();
    const results = await provider.embed([]);
    assert.deepEqual(results, []);
  });
});
