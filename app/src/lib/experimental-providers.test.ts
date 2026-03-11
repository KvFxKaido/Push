import { describe, expect, it } from 'vitest';
import {
  MAX_EXPERIMENTAL_DEPLOYMENTS,
  normalizeExperimentalBaseUrl,
  normalizeExperimentalDeployment,
  parseStoredExperimentalDeployments,
} from './experimental-providers';

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
        'https://aiplatform.googleapis.com/v1beta1/projects/demo/locations/global/endpoints/openapi/models',
      ),
    ).toEqual({
      ok: true,
      normalized: 'https://aiplatform.googleapis.com/v1beta1/projects/demo/locations/global/endpoints/openapi',
    });
  });
});

describe('experimental deployments', () => {
  it('normalizes a deployment with a deterministic id', () => {
    expect(
      normalizeExperimentalDeployment('azure', {
        baseUrl: 'https://example.openai.azure.com/openai/v1/chat/completions',
        model: 'gpt-4.1',
      }),
    ).toEqual({
      id: expect.stringMatching(/^dep_/),
      baseUrl: 'https://example.openai.azure.com/openai/v1',
      model: 'gpt-4.1',
    });
  });

  it('dedupes and caps stored deployments', () => {
    const parsed = parseStoredExperimentalDeployments('azure', JSON.stringify([
      { baseUrl: 'https://one.openai.azure.com/openai/v1', model: 'gpt-4.1' },
      { baseUrl: 'https://one.openai.azure.com/openai/v1', model: 'gpt-4.1' },
      { baseUrl: 'https://two.openai.azure.com/openai/v1', model: 'gpt-4.1-mini' },
      { baseUrl: 'https://three.openai.azure.com/openai/v1', model: 'grok-4.1' },
      { baseUrl: 'https://four.openai.azure.com/openai/v1', model: 'ignored-over-limit' },
    ]));

    expect(parsed).toHaveLength(MAX_EXPERIMENTAL_DEPLOYMENTS);
    expect(parsed.map((deployment) => deployment.model)).toEqual([
      'gpt-4.1',
      'gpt-4.1-mini',
      'grok-4.1',
    ]);
  });
});
