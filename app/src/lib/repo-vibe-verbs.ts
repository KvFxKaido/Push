const AI_ML_VERBS = [
  'Backpropagating...',
  'Training on your input...',
  'Inferring...',
  'Tokenizing thoughts...',
  'Running inference...',
];

const GAME_VERBS = [
  'Rendering ideas...',
  'Spawning thoughts...',
  'Loading assets...',
  'Calculating physics...',
  'Rolling initiative...',
];

const MOBILE_VERBS = [
  'Building for device...',
  'Packaging thoughts...',
  'Checking permissions...',
  'Compiling for arm64...',
];

const RUST_VERBS = [
  'Fighting the borrow checker...',
  'Compiling...',
  'Satisfying the compiler...',
  'Checking lifetimes...',
];

const PYTHON_VERBS = [
  'Pip installing wisdom...',
  'Indenting thoughts...',
  'Parsing the AST...',
  'Running in the REPL...',
];

const WEB_JS_VERBS = [
  'Bundling thoughts...',
  'Hydrating...',
  'Tree-shaking ideas...',
  'Hot reloading...',
];

const PUSH_VERBS = [
  'Orchestrating...',
  'Delegating to inner agent...',
  'Dispatching tool calls...',
  'Querying the sandbox...',
];

const DEVOPS_VERBS = [
  'Provisioning thoughts...',
  'Containerizing...',
  'Scaling to zero...',
  'Applying manifests...',
];

const DEFAULT_VERBS = [
  'Thinking...',
  'Reasoning...',
  'Processing...',
  'Analyzing...',
  'Working through this...',
];

function pickRandom(pool: string[]): string {
  return pool[Math.floor(Math.random() * pool.length)];
}

export function getVibeVerb(repoFullName: string | null): string {
  if (!repoFullName) return pickRandom(DEFAULT_VERBS);

  const lower = repoFullName.toLowerCase();

  const aiKeywords = ['ai', 'ml', 'llm', 'gpt', 'neural', 'model', 'diffusion', 'embedding'];
  if (aiKeywords.some((k) => lower.includes(k))) return pickRandom(AI_ML_VERBS);

  const gameKeywords = ['game', 'unity', 'godot', 'engine', 'render', 'shader', 'voxel'];
  if (gameKeywords.some((k) => lower.includes(k))) return pickRandom(GAME_VERBS);

  const mobileKeywords = [
    'android',
    'ios',
    'mobile',
    'flutter',
    'react-native',
    'capacitor',
    'swift',
    'kotlin',
  ];
  if (mobileKeywords.some((k) => lower.includes(k))) return pickRandom(MOBILE_VERBS);

  const rustKeywords = ['rust', '-rs', '_rs'];
  if (rustKeywords.some((k) => lower.includes(k))) return pickRandom(RUST_VERBS);

  const pythonKeywords = [
    'python',
    '-py',
    '_py',
    'django',
    'flask',
    'fastapi',
    'jupyter',
    'notebook',
  ];
  if (pythonKeywords.some((k) => lower.includes(k))) return pickRandom(PYTHON_VERBS);

  const webJsKeywords = [
    'web',
    'nextjs',
    'next-js',
    'vite',
    'webpack',
    'nuxt',
    'svelte',
    'angular',
    'vue',
    'react',
  ];
  if (webJsKeywords.some((k) => lower.includes(k))) return pickRandom(WEB_JS_VERBS);

  const [owner, repo] = lower.split('/');
  if (owner === 'push' || (repo && repo.includes('push'))) return pickRandom(PUSH_VERBS);

  const devopsKeywords = [
    'infra',
    'terraform',
    'k8s',
    'kubernetes',
    'docker',
    'deploy',
    'ci',
    'pipeline',
    'helm',
  ];
  if (devopsKeywords.some((k) => lower.includes(k))) return pickRandom(DEVOPS_VERBS);

  return pickRandom(DEFAULT_VERBS);
}
