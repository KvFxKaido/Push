import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { detectArtifactToolCall, executeArtifactToolCall } from './artifact-tools';
import type { ArtifactAuthor, ArtifactRecord, ArtifactScope } from '@push/lib/artifacts/types';

const SCOPE: ArtifactScope = {
  repoFullName: 'KvFxKaido/Push',
  branch: 'feat/x',
  chatId: 'chat-1',
};

const AUTHOR: ArtifactAuthor = {
  surface: 'web',
  role: 'orchestrator',
  messageId: 'm-1',
  createdAt: 1_700_000_000_000,
};

const RECORD: ArtifactRecord = {
  id: 'a-1',
  scope: SCOPE,
  author: AUTHOR,
  title: 'Counter',
  status: 'ready',
  updatedAt: 1_700_000_000_000,
  kind: 'static-react',
  files: [{ path: '/App.js', content: 'export default () => null' }],
};

describe('detectArtifactToolCall', () => {
  it('detects a fenced JSON create_artifact call', () => {
    const text = [
      'Sure, here you go:',
      '```json',
      JSON.stringify({
        tool: 'create_artifact',
        args: {
          kind: 'mermaid',
          title: 'Flow',
          source: 'graph TD; A-->B',
        },
      }),
      '```',
    ].join('\n');
    const detected = detectArtifactToolCall(text);
    expect(detected).not.toBeNull();
    expect(detected?.tool).toBe('create_artifact');
    if (detected?.args.kind === 'mermaid') {
      expect(detected.args.source).toContain('graph TD');
    }
  });

  it('accepts the public alias `artifact`', () => {
    const text = [
      '```json',
      JSON.stringify({
        tool: 'artifact',
        args: {
          kind: 'static-html',
          title: 'Hello',
          files: [{ path: 'index.html', content: 'hi' }],
        },
      }),
      '```',
    ].join('\n');
    const detected = detectArtifactToolCall(text);
    expect(detected?.args.kind).toBe('static-html');
  });

  it('returns null for unrelated tool calls', () => {
    const text = '```json\n{"tool":"web","args":{"query":"x"}}\n```';
    expect(detectArtifactToolCall(text)).toBeNull();
  });

  it('rejects calls with an invalid kind', () => {
    const text = [
      '```json',
      JSON.stringify({
        tool: 'create_artifact',
        args: { kind: 'video', title: 'Bad' },
      }),
      '```',
    ].join('\n');
    expect(detectArtifactToolCall(text)).toBeNull();
  });

  it('rejects calls without a title', () => {
    const text = [
      '```json',
      JSON.stringify({
        tool: 'create_artifact',
        args: { kind: 'mermaid', source: 'graph TD; A-->B' },
      }),
      '```',
    ].join('\n');
    expect(detectArtifactToolCall(text)).toBeNull();
  });
});

describe('executeArtifactToolCall', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              ok: true,
              record: RECORD,
              summary: 'Artifact created: a-1 — static-react "Counter" (1 file).',
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
      ),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('POSTs to /api/artifacts/create and returns a card on success', async () => {
    const result = await executeArtifactToolCall(
      {
        kind: 'static-react',
        title: 'Counter',
        files: [{ path: '/App.js', content: 'export default () => null' }],
      },
      SCOPE,
      AUTHOR,
    );

    expect(result.text).toContain('Artifact created');
    expect(result.card?.type).toBe('artifact');
    if (result.card?.type === 'artifact') {
      expect(result.card.data.record.id).toBe('a-1');
      expect(result.card.data.record.kind).toBe('static-react');
    }

    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.scope).toEqual(SCOPE);
    expect(body.author).toEqual(AUTHOR);
    expect(body.args.kind).toBe('static-react');
  });

  it('forwards a 400 validation error as a non-retryable structured error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              ok: false,
              code: 'TOO_LARGE',
              field: 'files[0].content',
              message: 'File too large',
            }),
            { status: 400, headers: { 'content-type': 'application/json' } },
          ),
      ),
    );

    const result = await executeArtifactToolCall(
      {
        kind: 'static-html',
        title: 'Big',
        files: [{ path: 'index.html', content: 'huge' }],
      },
      SCOPE,
      AUTHOR,
    );

    expect(result.text).toContain('TOO_LARGE');
    expect(result.text).toContain('File too large');
    expect(result.structuredError).toBeDefined();
    expect(result.structuredError?.type).toBe('INVALID_ARG');
    expect(result.structuredError?.detail).toBe('TOO_LARGE');
    expect(result.structuredError?.retryable).toBe(false);
    expect(result.card).toBeUndefined();
  });

  it('marks 5xx errors as retryable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ ok: false, code: 'NOT_CONFIGURED', message: 'KV missing' }),
            { status: 503, headers: { 'content-type': 'application/json' } },
          ),
      ),
    );

    const result = await executeArtifactToolCall(
      { kind: 'mermaid', title: 'X', source: 'graph TD; A-->B' },
      SCOPE,
      AUTHOR,
    );
    expect(result.structuredError?.retryable).toBe(true);
    expect(result.structuredError?.type).toBe('UNKNOWN');
    expect(result.structuredError?.detail).toBe('NOT_CONFIGURED');
  });

  it('treats network failures as retryable transport errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('connection refused');
      }),
    );

    const result = await executeArtifactToolCall(
      { kind: 'mermaid', title: 'X', source: 'graph TD; A-->B' },
      SCOPE,
      AUTHOR,
    );
    expect(result.structuredError?.type).toBe('UNKNOWN');
    expect(result.structuredError?.detail).toBe('NETWORK');
    expect(result.structuredError?.retryable).toBe(true);
  });
});
