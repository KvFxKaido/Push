export const AI_ML_VERBS = [
  'Backpropagating...',
  'Training on your input...',
  'Inferring...',
  'Tokenizing thoughts...',
  'Running inference...',
];

export const GAME_VERBS = [
  'Rendering ideas...',
  'Spawning thoughts...',
  'Loading assets...',
  'Calculating physics...',
  'Rolling initiative...',
];

export const MOBILE_VERBS = [
  'Building for device...',
  'Packaging thoughts...',
  'Checking permissions...',
  'Compiling for arm64...',
];

export const RUST_VERBS = [
  'Fighting the borrow checker...',
  'Compiling...',
  'Satisfying the compiler...',
  'Checking lifetimes...',
];

export const PYTHON_VERBS = [
  'Pip installing wisdom...',
  'Indenting thoughts...',
  'Parsing the AST...',
  'Running in the REPL...',
];

export const WEB_JS_VERBS = [
  'Bundling thoughts...',
  'Hydrating...',
  'Tree-shaking ideas...',
  'Hot reloading...',
];

export const PUSH_VERBS = [
  'Orchestrating...',
  'Delegating to inner agent...',
  'Dispatching tool calls...',
  'Querying the sandbox...',
];

export const DEVOPS_VERBS = [
  'Provisioning thoughts...',
  'Containerizing...',
  'Scaling to zero...',
  'Applying manifests...',
];

export const DEFAULT_VERBS = [
  'Thinking...',
  'Reasoning...',
  'Processing...',
  'Analyzing...',
  'Working through this...',
];

export type RepoVibe =
  | 'ai'
  | 'game'
  | 'mobile'
  | 'rust'
  | 'python'
  | 'web'
  | 'push'
  | 'devops'
  | 'default';

export const VERB_POOLS: Record<RepoVibe, string[]> = {
  ai: AI_ML_VERBS,
  game: GAME_VERBS,
  mobile: MOBILE_VERBS,
  rust: RUST_VERBS,
  python: PYTHON_VERBS,
  web: WEB_JS_VERBS,
  push: PUSH_VERBS,
  devops: DEVOPS_VERBS,
  default: DEFAULT_VERBS,
};

/**
 * Real runtime signals used to classify a repo's vibe, in descending order of
 * trust. The whole point of this module is that a repo's *language* should come
 * from what's actually in the tree — not from guessing at its name — while its
 * *domain* (AI, game, ...) has no filesystem footprint and can only be hinted
 * at by the name. `classifyRepoVibe` layers them accordingly.
 */
export interface RepoVibeSignals {
  /**
   * Manifest files detected in the sandbox at boot, e.g.
   * `['package.json', 'Cargo.toml']`. The strongest *language* signal because
   * these files actually live in the repo. (Installed tool versions are
   * deliberately not used — they reflect the sandbox image, not the repo.)
   */
  projectMarkers?: string[] | null;
  /** GitHub's primary-language field, e.g. `'TypeScript'`. Secondary signal. */
  language?: string | null;
  /** GitHub `full_name` (`owner/repo`). Domain hint + last-resort fallback. */
  fullName?: string | null;
}

function pickRandom(pool: string[]): string {
  return pool[Math.floor(Math.random() * pool.length)];
}

// Split a repo identifier into lowercase alphanumeric tokens. We match on
// exact tokens rather than raw substrings so that short keywords like `ai`,
// `ml`, `ios`, and `ci` don't collide with longer words (`main`, `html`,
// `studios`, `recipe`). `nextjs` stays one token; `react-native` splits into
// `react` + `native`; the `owner/repo` slash is just another separator.
function tokenize(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean),
  );
}

// --- Layer 1: domain themes (name-only) ---
// AI/game/devops are about *what a project does*, which leaves no trace in the
// file tree, so the name is the only signal we have. Mobile appears here (for
// `ios`/`android`-style names) and again in the language layer (swift/kotlin).
function domainVibeFromName(tokens: Set<string>): RepoVibe | null {
  const has = (...keywords: string[]) => keywords.some((k) => tokens.has(k));

  // `push` is our own repo; check it first so it wins over generic matches.
  if (tokens.has('push')) return 'push';

  if (
    has(
      'ai',
      'ml',
      'llm',
      'gpt',
      'neural',
      'diffusion',
      'embedding',
      'embeddings',
      'transformer',
      'transformers',
    )
  )
    return 'ai';

  if (has('game', 'unity', 'godot', 'godux', 'shader', 'voxel', 'roguelike')) return 'game';

  // `react-native` only counts as mobile when both tokens are present, so a
  // plain `react` repo falls through to the web layer.
  if (
    has('android', 'ios', 'mobile', 'flutter', 'capacitor') ||
    (tokens.has('react') && tokens.has('native'))
  )
    return 'mobile';

  if (has('infra', 'terraform', 'k8s', 'kubernetes', 'helm', 'pipeline', 'devops', 'ci'))
    return 'devops';

  return null;
}

// --- Layer 2: implementation language from real repo files ---
// `project_markers` are manifest files that actually exist in the tree, so they
// beat any name-based guess. Languages without a themed pool (go, java, ruby)
// intentionally return null and fall through.
function vibeFromMarkers(markers: string[]): RepoVibe | null {
  const set = new Set(markers.map((m) => m.toLowerCase()));
  if (set.has('cargo.toml')) return 'rust';
  if (
    set.has('requirements.txt') ||
    set.has('pyproject.toml') ||
    set.has('setup.py') ||
    set.has('pipfile') ||
    set.has('environment.yml')
  )
    return 'python';
  if (set.has('package.json')) return 'web';
  return null;
}

// --- Layer 2b: implementation language from GitHub's primary-language field ---
function vibeFromLanguage(language: string): RepoVibe | null {
  const l = language.toLowerCase();
  if (l === 'rust') return 'rust';
  if (l === 'python') return 'python';
  if (['javascript', 'typescript', 'vue', 'svelte', 'astro'].includes(l)) return 'web';
  if (['swift', 'kotlin', 'objective-c', 'objective-c++', 'dart'].includes(l)) return 'mobile';
  return null;
}

// --- Layer 3: language inferred from the name (sandbox-still-booting fallback) ---
function languageVibeFromName(tokens: Set<string>): RepoVibe | null {
  const has = (...keywords: string[]) => keywords.some((k) => tokens.has(k));
  // `-rs`/`_rs` and `-py`/`_py` suffixes tokenize to bare `rs`/`py`.
  if (has('rust', 'rs')) return 'rust';
  if (has('python', 'py', 'django', 'flask', 'fastapi', 'jupyter', 'notebook')) return 'python';
  if (has('web', 'nextjs', 'next', 'vite', 'webpack', 'nuxt', 'svelte', 'angular', 'vue', 'react'))
    return 'web';
  return null;
}

/**
 * Classify a repo's vibe from real signals, layered by trust: domain themes
 * (name-only) → language from the sandbox's manifest files → language from
 * GitHub's primary-language field → language guessed from the name → default.
 */
export function classifyRepoVibe(signals: RepoVibeSignals): RepoVibe {
  const tokens = signals.fullName ? tokenize(signals.fullName) : new Set<string>();

  const domain = domainVibeFromName(tokens);
  if (domain) return domain;

  if (signals.projectMarkers && signals.projectMarkers.length > 0) {
    const fromMarkers = vibeFromMarkers(signals.projectMarkers);
    if (fromMarkers) return fromMarkers;
  }

  if (signals.language) {
    const fromLanguage = vibeFromLanguage(signals.language);
    if (fromLanguage) return fromLanguage;
  }

  const fromName = languageVibeFromName(tokens);
  if (fromName) return fromName;

  return 'default';
}

/** Pick a themed thinking-phase verb for the given repo signals. */
export function getVibeVerb(signals: RepoVibeSignals | null): string {
  return pickRandom(VERB_POOLS[signals ? classifyRepoVibe(signals) : 'default']);
}
