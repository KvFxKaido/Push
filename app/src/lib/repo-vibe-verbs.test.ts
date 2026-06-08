import { describe, expect, it } from 'vitest';
import {
  AI_ML_VERBS,
  DEFAULT_VERBS,
  DEVOPS_VERBS,
  GAME_VERBS,
  MOBILE_VERBS,
  PUSH_VERBS,
  PYTHON_VERBS,
  RUST_VERBS,
  WEB_JS_VERBS,
  getVibeVerb,
} from './repo-vibe-verbs';

describe('getVibeVerb', () => {
  it('falls back to the default pool when no repo is provided', () => {
    expect(DEFAULT_VERBS).toContain(getVibeVerb(null));
    expect(DEFAULT_VERBS).toContain(getVibeVerb(''));
  });

  describe('positive matches', () => {
    const cases: Array<[string, readonly string[]]> = [
      ['acme/ai-platform', AI_ML_VERBS],
      ['user/cool-ml-toolkit', AI_ML_VERBS],
      ['org/llm-router', AI_ML_VERBS],
      ['org/gpt-wrapper', AI_ML_VERBS],
      ['studio/cool-game', GAME_VERBS],
      ['gamedev/voxel-engine', GAME_VERBS],
      ['acme/ios-app', MOBILE_VERBS],
      ['acme/android-client', MOBILE_VERBS],
      ['facebook/react-native', MOBILE_VERBS],
      ['acme/ripgrep-rs', RUST_VERBS],
      ['rust-lang/rust', RUST_VERBS],
      ['acme/some-tool-py', PYTHON_VERBS],
      ['django/django', PYTHON_VERBS],
      ['acme/my-web-app', WEB_JS_VERBS],
      ['vercel/nextjs-starter', WEB_JS_VERBS],
      ['facebook/react', WEB_JS_VERBS],
      ['KvFxKaido/Push', PUSH_VERBS],
      ['acme/infra-tools', DEVOPS_VERBS],
      ['acme/ci-runner', DEVOPS_VERBS],
      ['acme/k8s-operator', DEVOPS_VERBS],
    ];

    it.each(cases)('routes %s to the expected pool', (repo, pool) => {
      expect(pool).toContain(getVibeVerb(repo));
    });
  });

  describe('no false positives from substring collisions', () => {
    // These previously matched via raw `.includes()` substring checks and
    // must now fall through to the default pool.
    const falsePositives = [
      'acme/main', // contained 'ai'
      'octocat/maintain', // contained 'ai'
      'acme/container-lib', // contained 'ai' inside 'container'
      'acme/email-client', // contained 'ai'
      'acme/html-parser', // contained 'ml'
      'acme/yaml-loader', // contained 'ml'
      'acme/data-model', // 'model' is too generic, dropped from AI keywords
      'acme/dev-studios', // 'ios' substring of 'studios'
      'acme/recipe-box', // 'ci' substring of 'recipe'
      'acme/security-policies', // 'ci' substring of 'policies'
      'acme/social-feed', // 'ci' substring of 'social'
    ];

    it.each(falsePositives)('does not misclassify %s', (repo) => {
      expect(DEFAULT_VERBS).toContain(getVibeVerb(repo));
    });
  });

  describe('push token matching', () => {
    it('matches a bare repo name with no slash', () => {
      expect(PUSH_VERBS).toContain(getVibeVerb('push'));
    });

    it('matches when push is the owner', () => {
      expect(PUSH_VERBS).toContain(getVibeVerb('push/some-repo'));
    });

    it('does not match when push is only a substring of a token', () => {
      // 'pushpin' is a single token, so exact-token matching skips it.
      expect(DEFAULT_VERBS).toContain(getVibeVerb('acme/pushpin'));
    });
  });

  it('always returns a non-empty string', () => {
    for (const repo of [null, '', 'a/b', 'main', 'KvFxKaido/Push', 'acme/ai']) {
      const verb = getVibeVerb(repo);
      expect(typeof verb).toBe('string');
      expect(verb.length).toBeGreaterThan(0);
    }
  });
});
