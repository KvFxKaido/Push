import { describe, expect, it } from 'vitest';
import {
  DEFAULT_VERBS,
  type RepoVibe,
  type RepoVibeSignals,
  VERB_POOLS,
  classifyRepoVibe,
  getVibeVerb,
} from './repo-vibe-verbs';

describe('classifyRepoVibe', () => {
  describe('domain themes come from GitHub topics (the strongest domain signal)', () => {
    const cases: Array<[string[], RepoVibe]> = [
      [['machine-learning'], 'ai'],
      [['deep-learning', 'pytorch'], 'ai'],
      [['llm'], 'ai'],
      [['computer-vision'], 'ai'],
      [['gamedev'], 'game'],
      [['game-engine'], 'game'],
      [['unity3d'], 'game'],
      [['flutter'], 'mobile'],
      [['jetpack-compose'], 'mobile'],
      [['kubernetes', 'helm'], 'devops'],
      [['terraform'], 'devops'],
      [['gitops'], 'devops'],
    ];

    it.each(cases)('classifies topics %j as %s', (topics, vibe) => {
      // Name is deliberately neutral so topics are what decide.
      expect(classifyRepoVibe({ fullName: 'acme/platform', topics })).toBe(vibe);
    });

    it('outranks a conflicting name', () => {
      // The name screams web (`vite`), the owner-curated topic says AI — trust
      // the topic, which is the more deliberate signal.
      expect(classifyRepoVibe({ fullName: 'acme/vite-app', topics: ['machine-learning'] })).toBe(
        'ai',
      );
    });

    it('outranks the implementation language', () => {
      expect(
        classifyRepoVibe({
          fullName: 'acme/platform',
          topics: ['game-engine'],
          projectMarkers: ['package.json'],
        }),
      ).toBe('game');
    });

    it('falls through to language when topics are present but unrecognized', () => {
      expect(
        classifyRepoVibe({
          fullName: 'acme/platform',
          topics: ['hacktoberfest', 'awesome'],
          projectMarkers: ['Cargo.toml'],
        }),
      ).toBe('rust');
    });
  });

  describe('domain themes come from the name (no filesystem footprint)', () => {
    const cases: Array<[string, RepoVibe]> = [
      ['huggingface/transformers', 'ai'],
      ['acme/llm-router', 'ai'],
      ['acme/gpt-wrapper', 'ai'],
      ['studio/voxel-roguelike', 'game'],
      ['acme/ios-app', 'mobile'],
      ['acme/android-client', 'mobile'],
      ['facebook/react-native', 'mobile'],
      ['acme/terraform-modules', 'devops'],
      ['acme/k8s-operator', 'devops'],
      ['acme/ci-pipeline', 'devops'],
      ['KvFxKaido/Push', 'push'],
    ];

    it.each(cases)('classifies %s as %s', (fullName, vibe) => {
      expect(classifyRepoVibe({ fullName })).toBe(vibe);
    });

    it('lets a domain theme win over the implementation language', () => {
      // A Python AI repo should read as AI, not Python — the domain is the more
      // delightful, more specific signal.
      expect(
        classifyRepoVibe({ fullName: 'acme/ml-platform', projectMarkers: ['requirements.txt'] }),
      ).toBe('ai');
    });
  });

  describe('language comes from real sandbox manifest files', () => {
    const cases: Array<[string[], RepoVibe]> = [
      [['Cargo.toml'], 'rust'],
      [['requirements.txt'], 'python'],
      [['pyproject.toml'], 'python'],
      [['setup.py'], 'python'],
      [['package.json'], 'web'],
      [['package.json', 'package-lock.json'], 'web'],
    ];

    it.each(cases)('classifies markers %j as %s', (projectMarkers, vibe) => {
      // No name signal, so the marker is what decides.
      expect(classifyRepoVibe({ fullName: 'acme/platform', projectMarkers })).toBe(vibe);
    });

    it('beats a misleading name (the repo name lies, the files do not)', () => {
      // Name has no recognized token; markers say Rust.
      expect(classifyRepoVibe({ fullName: 'acme/widget', projectMarkers: ['Cargo.toml'] })).toBe(
        'rust',
      );
    });

    it('ignores languages without a themed pool (go/java/ruby)', () => {
      expect(classifyRepoVibe({ fullName: 'acme/svc', projectMarkers: ['go.mod'] })).toBe(
        'default',
      );
      expect(classifyRepoVibe({ fullName: 'acme/svc', projectMarkers: ['pom.xml'] })).toBe(
        'default',
      );
    });
  });

  describe("GitHub's primary-language field is a secondary signal", () => {
    it('uses language when there are no markers', () => {
      expect(classifyRepoVibe({ fullName: 'acme/thing', language: 'Rust' })).toBe('rust');
      expect(classifyRepoVibe({ fullName: 'acme/thing', language: 'TypeScript' })).toBe('web');
      expect(classifyRepoVibe({ fullName: 'acme/thing', language: 'Swift' })).toBe('mobile');
    });

    it('is outranked by real markers', () => {
      // GitHub says Python but the tree has a Cargo.toml — trust the tree.
      expect(
        classifyRepoVibe({
          fullName: 'acme/thing',
          projectMarkers: ['Cargo.toml'],
          language: 'Python',
        }),
      ).toBe('rust');
    });
  });

  describe('name-as-language is only a last-resort fallback', () => {
    it('infers language from the name when the sandbox gave us nothing', () => {
      // Sandbox still booting: no markers, no language. Lean on the name.
      expect(classifyRepoVibe({ fullName: 'acme/ripgrep-rs' })).toBe('rust');
      expect(classifyRepoVibe({ fullName: 'acme/some-tool-py' })).toBe('python');
      expect(classifyRepoVibe({ fullName: 'acme/my-web-app' })).toBe('web');
    });

    it('is outranked by real markers', () => {
      // Name says python (`-py`) but the tree has package.json.
      expect(
        classifyRepoVibe({ fullName: 'acme/thing-py', projectMarkers: ['package.json'] }),
      ).toBe('web');
    });
  });

  describe('no false positives from substring collisions', () => {
    // These previously matched via raw `.includes()` substring checks and must
    // now fall through to the default vibe.
    const falsePositives = [
      'acme/main', // 'ai'
      'octocat/maintain', // 'ai'
      'acme/container-lib', // 'ai' inside 'container'
      'acme/email-client', // 'ai'
      'acme/html-parser', // 'ml'
      'acme/yaml-loader', // 'ml'
      'acme/data-model', // 'model' (dropped as too generic)
      'acme/dev-studios', // 'ios' inside 'studios'
      'acme/recipe-box', // 'ci' inside 'recipe'
      'acme/security-policies', // 'ci' inside 'policies'
      'acme/social-feed', // 'ci' inside 'social'
    ];

    it.each(falsePositives)('does not misclassify %s', (fullName) => {
      expect(classifyRepoVibe({ fullName })).toBe('default');
    });
  });

  describe('push token matching', () => {
    it('matches a bare repo name with no slash', () => {
      expect(classifyRepoVibe({ fullName: 'push' })).toBe('push');
    });

    it('matches when push is the owner', () => {
      expect(classifyRepoVibe({ fullName: 'push/some-repo' })).toBe('push');
    });

    it('does not match when push is only a substring of a token', () => {
      expect(classifyRepoVibe({ fullName: 'acme/pushpin' })).toBe('default');
    });
  });

  it('returns default when there are no signals at all', () => {
    expect(classifyRepoVibe({})).toBe('default');
    expect(classifyRepoVibe({ fullName: null, projectMarkers: null, language: null })).toBe(
      'default',
    );
  });
});

describe('getVibeVerb', () => {
  it('falls back to the default pool when signals are null', () => {
    expect(DEFAULT_VERBS).toContain(getVibeVerb(null));
  });

  it('returns a verb from the pool matching the classified vibe', () => {
    const signals: RepoVibeSignals = { fullName: 'acme/widget', projectMarkers: ['Cargo.toml'] };
    expect(VERB_POOLS.rust).toContain(getVibeVerb(signals));
  });

  it('every vibe maps to a non-empty pool', () => {
    for (const pool of Object.values(VERB_POOLS)) {
      expect(pool.length).toBeGreaterThan(0);
    }
  });

  it('always returns a non-empty string', () => {
    const inputs: Array<RepoVibeSignals | null> = [
      null,
      {},
      { fullName: 'a/b' },
      { fullName: 'KvFxKaido/Push' },
      { projectMarkers: ['Cargo.toml'] },
      { language: 'Python' },
    ];
    for (const input of inputs) {
      const verb = getVibeVerb(input);
      expect(typeof verb).toBe('string');
      expect(verb.length).toBeGreaterThan(0);
    }
  });
});
