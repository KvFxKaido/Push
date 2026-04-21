import { describe, expect, it } from 'vitest';
import {
  compareProviderModelIds,
  formatModelDisplayName,
  getModelDisplayGroupKey,
  getModelDisplayLeafName,
  normalizeKilocodeModelName,
} from './providers';

describe('formatModelDisplayName', () => {
  it('normalizes routed Blackbox ids and uses provider shorthand labels', () => {
    expect(formatModelDisplayName('blackbox', 'blackboxai/anthropic/claude-sonnet-4.6')).toBe(
      'Anthropic / claude-sonnet-4.6',
    );
    expect(formatModelDisplayName('openrouter', 'openai/gpt-5.4')).toBe('OpenAI / gpt-5.4');
  });

  it('groups Blackbox native ids while keeping Ollama native ids readable', () => {
    expect(formatModelDisplayName('blackbox', 'blackbox-pro')).toBe('Blackbox / blackbox-pro');
    expect(formatModelDisplayName('ollama', 'gemini-3-flash-preview')).toBe(
      'gemini-3-flash-preview',
    );
  });

  it('formats Kilo auto routes with a readable provider label', () => {
    expect(formatModelDisplayName('kilocode', 'kilo-auto/balanced')).toBe('Kilo Auto / balanced');
  });

  it('formats Cloudflare model ids with readable provider grouping', () => {
    expect(formatModelDisplayName('cloudflare', '@cf/qwen/qwen3-30b-a3b-fp8')).toBe(
      'Qwen / qwen3-30b-a3b-fp8',
    );
  });
});

describe('normalizeKilocodeModelName', () => {
  it('migrates retired Kilo defaults and rejects label-shaped selections', () => {
    expect(normalizeKilocodeModelName('google/gemini-2.0-flash')).toBe(
      'google/gemini-3-flash-preview',
    );
    expect(normalizeKilocodeModelName('anthropic/claude-3.5-sonnet')).toBe(
      'anthropic/claude-sonnet-4.6',
    );
    expect(normalizeKilocodeModelName('openai/gpt-4o')).toBe('openai/gpt-5.2');
    expect(normalizeKilocodeModelName('Anthropic: Claude Sonnet 4.6')).toBe(
      'google/gemini-3-flash-preview',
    );
    expect(normalizeKilocodeModelName('kilo-auto/balanced')).toBe('kilo-auto/balanced');
  });
});

describe('Blackbox display grouping', () => {
  it('groups first-party Blackbox models under the Blackbox bucket', () => {
    expect(getModelDisplayGroupKey('blackbox', 'blackbox-pro')).toBe('blackbox');
    expect(getModelDisplayLeafName('blackbox', 'blackbox-pro')).toBe('blackbox-pro');
  });

  it('sorts by provider bucket, then model name', () => {
    const models = [
      'blackboxai/qwen/qwen3-coder-32b-instruct',
      'blackbox-pro',
      'blackboxai/anthropic/claude-sonnet-4.6',
    ];

    expect(
      [...models].sort((left, right) => compareProviderModelIds('blackbox', left, right)),
    ).toEqual([
      'blackboxai/anthropic/claude-sonnet-4.6',
      'blackbox-pro',
      'blackboxai/qwen/qwen3-coder-32b-instruct',
    ]);
  });
});

describe('Cloudflare display grouping', () => {
  it('drops the @cf prefix for grouping while keeping the model leaf readable', () => {
    expect(getModelDisplayGroupKey('cloudflare', '@cf/qwen/qwen3-30b-a3b-fp8')).toBe('qwen');
    expect(getModelDisplayLeafName('cloudflare', '@cf/qwen/qwen3-30b-a3b-fp8')).toBe(
      'qwen3-30b-a3b-fp8',
    );
  });
});
