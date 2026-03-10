import { describe, expect, it } from 'vitest';
import { normalizeExperimentalBaseUrl } from './experimental-providers';

describe('normalizeExperimentalBaseUrl', () => {
  it('normalizes Azure OpenAI chat-completions URLs back to the /openai/v1 base', () => {
    expect(
      normalizeExperimentalBaseUrl('azure', 'https://example.openai.azure.com/openai/v1/chat/completions'),
    ).toEqual({
      ok: true,
      normalized: 'https://example.openai.azure.com/openai/v1',
    });
  });

  it('accepts Azure Foundry project URLs and appends /openai/v1', () => {
    expect(
      normalizeExperimentalBaseUrl('azure', 'https://example.services.ai.azure.com/api/projects/demo-project'),
    ).toEqual({
      ok: true,
      normalized: 'https://example.services.ai.azure.com/api/projects/demo-project/openai/v1',
    });
  });

  it('accepts Azure Foundry project URLs that already include /openai/v1', () => {
    expect(
      normalizeExperimentalBaseUrl('azure', 'https://example.services.ai.azure.com/api/projects/demo-project/openai/v1/models'),
    ).toEqual({
      ok: true,
      normalized: 'https://example.services.ai.azure.com/api/projects/demo-project/openai/v1',
    });
  });

  it('rejects non-Azure hosts for Azure OpenAI', () => {
    expect(
      normalizeExperimentalBaseUrl('azure', 'https://api.openai.com/v1'),
    ).toMatchObject({
      ok: false,
    });
  });

  it('rejects classic Azure resource URLs that do not end at /openai/v1', () => {
    expect(
      normalizeExperimentalBaseUrl('azure', 'https://example.openai.azure.com/api/projects/demo-project'),
    ).toEqual({
      ok: false,
      error: 'Classic Azure OpenAI resource URLs must end at /openai/v1.',
    });
  });

  it('accepts Bedrock OpenAI-compatible base URLs', () => {
    expect(
      normalizeExperimentalBaseUrl('bedrock', 'https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1'),
    ).toEqual({
      ok: true,
      normalized: 'https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1',
    });
  });

  it('accepts Vertex OpenAPI endpoint bases and strips /models', () => {
    expect(
      normalizeExperimentalBaseUrl(
        'vertex',
        'https://us-central1-aiplatform.googleapis.com/v1/projects/demo/locations/us-central1/endpoints/openapi/models',
      ),
    ).toEqual({
      ok: true,
      normalized: 'https://us-central1-aiplatform.googleapis.com/v1/projects/demo/locations/us-central1/endpoints/openapi',
    });
  });
});
