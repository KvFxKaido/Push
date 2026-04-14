import path from 'path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@push/lib': path.resolve(__dirname, '../lib'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    // `src/**` covers the web tests; `../lib/**` covers the shared
    // root-level `lib/` kernel tests (e.g. `correlation-context.test.ts`,
    // `memory-persistence.test.ts`) so they run in CI through the
    // `app` job instead of sitting unexercised. Both the web tests and
    // the lib tests run in the `node` environment with no DOM
    // dependencies, so they share one runner.
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', '../lib/**/*.test.ts'],
  },
});
