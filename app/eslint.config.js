import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import tseslint from 'typescript-eslint';
import { defineConfig, globalIgnores } from 'eslint/config';

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
  },
  // Containment guard for useChat.ts. The hook regrew from 770 -> 1,733
  // lines between 2026-03-25 and 2026-04-19 because new features kept
  // landing sibling modules *and* hook-level coordinators. This ceiling
  // blocks silent regression; ratchet it down as phases 2-4 of the
  // re-extraction track land. See docs/decisions/useChat Regression Audit.md.
  //
  // History:
  //   Phase 1 (useQueuedFollowUps): 1,733 -> 1,672, ceiling set to 1,700.
  //   Phase 2 (useRunEventStream):  1,673 -> 1,577, ceiling lowered to 1,620.
  //   Phase 3 (useRunEngine):       1,577 -> 1,465, ceiling lowered to 1,500.
  {
    files: ['src/hooks/useChat.ts'],
    rules: {
      'max-lines': ['error', { max: 1500 }],
    },
  },
]);
