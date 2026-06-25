module.exports = {
  extends: ['@commitlint/config-conventional'],
  rules: {
    // Scopes matching Push's architecture
    'scope-enum': [
      2,
      'always',
      [
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
        'deps',
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
