import { describe, expect, it } from 'vitest';

import { __test__ } from './useDaemonSessionModel';

describe('useDaemonSessionModel payload parsers', () => {
  describe('parseProviderList', () => {
    it('parses a well-formed list_providers payload', () => {
      expect(
        __test__.parseProviderList({
          providers: [
            {
              id: 'ollama',
              url: 'https://ollama.com/v1/chat/completions',
              defaultModel: 'minimax-m3',
              requiresKey: true,
              hasKey: true,
              models: ['minimax-m3', 'qwen3-30b-a3b-fp8'],
            },
          ],
        }),
      ).toEqual([
        {
          id: 'ollama',
          url: 'https://ollama.com/v1/chat/completions',
          defaultModel: 'minimax-m3',
          requiresKey: true,
          hasKey: true,
          models: ['minimax-m3', 'qwen3-30b-a3b-fp8'],
        },
      ]);
    });

    it('drops malformed entries but keeps well-formed siblings', () => {
      expect(
        __test__.parseProviderList({
          providers: [
            { id: 'ollama' }, // missing defaultModel
            { id: 'openai', defaultModel: 'gpt-5' },
          ],
        }),
      ).toEqual([
        {
          id: 'openai',
          url: '',
          defaultModel: 'gpt-5',
          requiresKey: false,
          hasKey: false,
          models: [],
        },
      ]);
    });

    it('rejects a payload with no providers array', () => {
      expect(__test__.parseProviderList({})).toBeNull();
      expect(__test__.parseProviderList(null)).toBeNull();
    });
  });

  describe('parseUpdateSessionModel', () => {
    it('parses provider + model from an update_session response', () => {
      expect(
        __test__.parseUpdateSessionModel({
          provider: 'ollama',
          model: 'minimax-m3',
          roleRouting: {},
        }),
      ).toEqual({ provider: 'ollama', model: 'minimax-m3' });
    });

    it('rejects a payload with neither field', () => {
      expect(__test__.parseUpdateSessionModel({ roleRouting: {} })).toBeNull();
      expect(__test__.parseUpdateSessionModel(null)).toBeNull();
    });
  });
});
