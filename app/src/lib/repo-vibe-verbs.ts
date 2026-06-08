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

export function getVibeVerb(repoFullName: string | null): string {
  if (!repoFullName) return pickRandom(DEFAULT_VERBS);

  const tokens = tokenize(repoFullName);
  const has = (...keywords: string[]) => keywords.some((k) => tokens.has(k));

  if (
    has('ai', 'ml', 'llm', 'gpt', 'neural', 'diffusion', 'embedding', 'embeddings', 'transformer')
  )
    return pickRandom(AI_ML_VERBS);

  if (has('game', 'unity', 'godot', 'engine', 'render', 'shader', 'voxel'))
    return pickRandom(GAME_VERBS);

  // `react-native` only counts as mobile when both tokens are present, so a
  // plain `react` repo falls through to the web/JS pool below.
  if (
    has('android', 'ios', 'mobile', 'flutter', 'capacitor', 'swift', 'kotlin') ||
    (tokens.has('react') && tokens.has('native'))
  )
    return pickRandom(MOBILE_VERBS);

  // `-rs` / `_rs` suffixes tokenize to a bare `rs`; same for `-py` / `_py`.
  if (has('rust', 'rs')) return pickRandom(RUST_VERBS);

  if (has('python', 'py', 'django', 'flask', 'fastapi', 'jupyter', 'notebook'))
    return pickRandom(PYTHON_VERBS);

  if (has('web', 'nextjs', 'next', 'vite', 'webpack', 'nuxt', 'svelte', 'angular', 'vue', 'react'))
    return pickRandom(WEB_JS_VERBS);

  // `push` is matched as a token from anywhere in the identifier (owner or
  // repo), so it works whether or not the input contains a slash.
  if (tokens.has('push')) return pickRandom(PUSH_VERBS);

  if (has('infra', 'terraform', 'k8s', 'kubernetes', 'docker', 'deploy', 'ci', 'pipeline', 'helm'))
    return pickRandom(DEVOPS_VERBS);

  return pickRandom(DEFAULT_VERBS);
}
