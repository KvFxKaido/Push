import { describe, expect, it } from 'vitest';

import { __test__ } from './useDaemonRuntimeSettings';

describe('useDaemonRuntimeSettings payload parser', () => {
  it('maps daemon exec mode to the web approval mode', () => {
    expect(
      __test__.parseDaemonRuntimeSettingsPayload({
        execMode: 'yolo',
        webSearchBackend: 'duckduckgo',
        configPath: '/tmp/push-config.json',
      }),
    ).toEqual({
      execMode: 'yolo',
      approvalMode: 'full-auto',
      webSearchBackend: 'duckduckgo',
      configPath: '/tmp/push-config.json',
    });
  });

  it('rejects malformed daemon payloads', () => {
    expect(
      __test__.parseDaemonRuntimeSettingsPayload({
        execMode: 'turbo',
        webSearchBackend: 'duckduckgo',
      }),
    ).toBeNull();
    expect(
      __test__.parseDaemonRuntimeSettingsPayload({
        execMode: 'auto',
        webSearchBackend: 'google-grounding',
      }),
    ).toBeNull();
  });
});
