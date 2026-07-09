module.exports = {
  extends: ['@commitlint/config-conventional'],
  rules: {
    // Scopes matching Push's architecture. Grouped: subsystems/modules, the
    // three surfaces + shared runtime, platform-specific work, and tooling.
    // NB: PR squash-merges use the PR title and skip this local hook, so the
    // merged history can drift ahead of this list — keep them reconciled.
    'scope-enum': [
      2,
      'always',
      [
        // ── Subsystems / modules ──
        'orchestrator',
        'coder',
        'auditor',
        'sandbox',
        'browser',
        'github',
        'chat',
        'ui',
        'design',
        'worker',
        'auth',
        'settings',
        'context',
        'contract',
        'tools',
        'scratchpad',
        'providers',
        'research',
        // ── Surfaces + shared runtime ──
        'cli',
        'tui',
        'daemon',
        'web',
        'android',
        'lib',
        // ── Platforms ──
        'windows',
        'wsl',
        'macos',
        'linux',
        // ── Tooling / meta ──
        'deps',
        'deps-dev',
        'lint',
        'ci',
      ],
    ],
    // Allow empty scopes — not every commit fits a module
    'scope-empty': [0],
    // Keep subject under 72 chars for readability
    'subject-max-length': [2, 'always', 72],
  },
};
