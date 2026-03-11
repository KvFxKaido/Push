import { describe, expect, it } from 'vitest';
import {
  VERTEX_DEFAULT_REGION,
  buildVertexAnthropicEndpoint,
  buildVertexOpenApiBaseUrl,
  encodeVertexServiceAccountHeader,
  decodeVertexServiceAccountHeader,
  getVertexModelTransport,
  normalizeVertexRegion,
  parseVertexServiceAccount,
} from './vertex-provider';

const SERVICE_ACCOUNT_FIXTURE = JSON.stringify({
  type: 'service_account',
  project_id: 'demo-project',
  client_email: 'push@demo-project.iam.gserviceaccount.com',
  private_key: '-----BEGIN PRIVATE KEY-----\nabc123\n-----END PRIVATE KEY-----\n',
});

describe('vertex-provider', () => {
  it('parses and normalizes a service account JSON blob', () => {
    const parsed = parseVertexServiceAccount(SERVICE_ACCOUNT_FIXTURE);
    expect(parsed).toMatchObject({
      ok: true,
      parsed: {
        projectId: 'demo-project',
        clientEmail: 'push@demo-project.iam.gserviceaccount.com',
      },
    });
  });

  it('rejects non-service-account JSON', () => {
    expect(parseVertexServiceAccount(JSON.stringify({ type: 'user' }))).toEqual({
      ok: false,
      error: 'JSON must be a Google service account credential.',
    });
  });

  it('round-trips service account headers', () => {
    const encoded = encodeVertexServiceAccountHeader(SERVICE_ACCOUNT_FIXTURE);
    const decoded = decodeVertexServiceAccountHeader(encoded);
    expect(decoded).toMatchObject({
      ok: true,
      parsed: {
        projectId: 'demo-project',
      },
    });
  });

  it('normalizes regions and accepts global', () => {
    expect(normalizeVertexRegion(' global ')).toEqual({ ok: true, normalized: VERTEX_DEFAULT_REGION });
    expect(normalizeVertexRegion('us-east5')).toEqual({ ok: true, normalized: 'us-east5' });
  });

  it('classifies Claude as anthropic and Gemini as openapi', () => {
    expect(getVertexModelTransport('claude-sonnet-4-5@20250929')).toBe('anthropic');
    expect(getVertexModelTransport('google/gemini-2.5-pro')).toBe('openapi');
  });

  it('builds the expected Vertex endpoints', () => {
    expect(buildVertexOpenApiBaseUrl('demo-project', 'global'))
      .toBe('https://aiplatform.googleapis.com/v1beta1/projects/demo-project/locations/global/endpoints/openapi');
    expect(buildVertexAnthropicEndpoint('demo-project', 'us-east5', 'claude-sonnet-4-5@20250929'))
      .toBe('https://aiplatform.googleapis.com/v1/projects/demo-project/locations/us-east5/publishers/anthropic/models/claude-sonnet-4-5@20250929:streamRawPredict');
  });
});
