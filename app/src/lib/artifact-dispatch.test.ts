/**
 * Drift guard for the `artifacts` source dispatch.
 *
 * Pins three contracts in one place so any future churn surfaces here:
 *   1. `detectAnyToolCall` routes a `create_artifact` JSON block to
 *      `source: 'artifacts'`.
 *   2. `executeAnyToolCall` carries the call through the runtime,
 *      hits `/api/artifacts/create`, and surfaces the worker's
 *      `summary` + record as a `text` + `card`.
 *   3. The `chatId` parameter on `executeAnyToolCall` is forwarded into
 *      the scope sent to the worker.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./sandbox-client', () => ({
  execInSandbox: vi.fn(async () => ({
    stdout: 'feat/x\n',
    stderr: '',
    exitCode: 0,
    truncated: false,
  })),
}));

import { detectAnyToolCall, executeAnyToolCall } from './tool-dispatch';

const ARTIFACT_RECORD = {
  id: 'a-9',
  title: 'Counter',
  kind: 'static-react' as const,
  status: 'ready' as const,
  updatedAt: 0,
  scope: { repoFullName: 'KvFxKaido/Push', branch: 'feat/x', chatId: 'chat-7' },
  author: { surface: 'web' as const, role: 'orchestrator' as const, createdAt: 0 },
  files: [{ path: '/App.js', content: 'export default () => null' }],
};

const CALL_TEXT = [
  '```json',
  JSON.stringify({
    tool: 'create_artifact',
    args: {
      kind: 'static-react',
      title: 'Counter',
      files: [{ path: '/App.js', content: 'export default () => null' }],
    },
  }),
  '```',
].join('\n');

describe('artifact dispatch drift', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              ok: true,
              record: ARTIFACT_RECORD,
              summary: 'Artifact created: a-9 — static-react "Counter" (1 file).',
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

  it('detectAnyToolCall tags create_artifact as source=artifacts', () => {
    const detected = detectAnyToolCall(CALL_TEXT);
    expect(detected).not.toBeNull();
    expect(detected?.source).toBe('artifacts');
    expect(detected?.call.tool).toBe('create_artifact');
  });

  it('executeAnyToolCall POSTs to /api/artifacts/create and returns an artifact card', async () => {
    const detected = detectAnyToolCall(CALL_TEXT);
    if (!detected) throw new Error('Expected a detected tool call');

    const result = await executeAnyToolCall(
      detected,
      'KvFxKaido/Push',
      'sb-123',
      'orchestrator',
      false,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'chat-7',
    );

    expect(result.text).toContain('Artifact created');
    expect(result.card?.type).toBe('artifact');

    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(/\/api\/artifacts\/create$/);
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.scope.repoFullName).toBe('KvFxKaido/Push');
    expect(body.scope.branch).toBe('feat/x');
    expect(body.scope.chatId).toBe('chat-7');
    expect(body.author.surface).toBe('web');
    expect(body.author.role).toBe('orchestrator');
  });

  it('blocks artifact creation when no repo is selected', async () => {
    const detected = detectAnyToolCall(CALL_TEXT);
    if (!detected) throw new Error('Expected a detected tool call');

    const result = await executeAnyToolCall(detected, '', null, 'orchestrator');
    expect(result.text).toContain('Artifact creation requires an active repo');
    expect(result.structuredError?.type).toBe('INVALID_ARG');
    expect(result.structuredError?.detail).toContain('NO_ACTIVE_REPO');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('refuses to persist a web artifact without a chat id', async () => {
    const detected = detectAnyToolCall(CALL_TEXT);
    if (!detected) throw new Error('Expected a detected tool call');

    // Repo set, sandbox set, but chatId omitted — the runtime must fail
    // closed rather than silently file the artifact under repo+branch
    // and pollute the chat-scoped list.
    const result = await executeAnyToolCall(detected, 'KvFxKaido/Push', 'sb-123', 'orchestrator');
    expect(result.structuredError?.type).toBe('INVALID_ARG');
    expect(result.structuredError?.detail).toContain('MISSING_CHAT_ID');
    expect(result.text).toContain('requires a chat id');
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
