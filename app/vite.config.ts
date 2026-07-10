import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'path';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';
import { agentDevReporter } from './dev/agent-dev-reporter';
// https://vite.dev/config/

// Stamp the PWA service-worker cache name with a per-build id so installed
// PWAs auto-purge stale caches on every deploy — no manual CACHE_NAME bump.
// sw.js lives in public/ (copied verbatim), so we rewrite it in the built
// output. The source value in public/sw.js is only the dev fallback. Runs in
// closeBundle (after Vite's public-dir copy has settled) and throws if the
// declaration isn't found, so a future sw.js format change can't silently
// reintroduce stale-cache bugs.
function stampServiceWorkerCache(): Plugin {
  let outDir = path.resolve(__dirname, 'dist');
  let sourceSwPath = path.resolve(__dirname, 'public/sw.js');
  const cacheNameDeclaration = /const\s+CACHE_NAME\s*=\s*['"][^'"]*['"];/;
  return {
    name: 'stamp-sw-cache',
    apply: 'build',
    configResolved(config) {
      outDir = path.resolve(config.root, config.build.outDir);
      sourceSwPath =
        typeof config.publicDir === 'string'
          ? path.resolve(config.publicDir, 'sw.js')
          : path.resolve(config.root, 'public/sw.js');
    },
    closeBundle() {
      const swPath = path.resolve(outDir, 'sw.js');
      const inputPath = fs.existsSync(sourceSwPath) ? sourceSwPath : swPath;
      if (!fs.existsSync(inputPath)) return;

      const fromGit = () => {
        try {
          return execSync('git rev-parse --short HEAD', {
            stdio: ['ignore', 'pipe', 'ignore'],
          })
            .toString()
            .trim();
        } catch {
          return '';
        }
      };
      const buildId =
        process.env.WORKERS_CI_COMMIT_SHA?.slice(0, 8) ||
        process.env.CF_PAGES_COMMIT_SHA?.slice(0, 8) ||
        process.env.GITHUB_SHA?.slice(0, 8) ||
        fromGit() ||
        Date.now().toString(36);

      const source = fs.readFileSync(inputPath, 'utf8');
      if (!cacheNameDeclaration.test(source)) {
        throw new Error(
          `stampServiceWorkerCache: CACHE_NAME declaration not found in ${inputPath} — ` +
            'the PWA cache would not bust on deploy. Check the format in public/sw.js.',
        );
      }
      const stamped = source.replace(cacheNameDeclaration, `const CACHE_NAME = 'push-${buildId}';`);
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(swPath, stamped);
    },
  };
}
const API_PROXY_TARGET = process.env.VITE_API_PROXY_TARGET || 'http://127.0.0.1:8787';
const API_PROXY_ORIGIN = (() => {
  try {
    return new URL(API_PROXY_TARGET).origin;
  } catch {
    return API_PROXY_TARGET;
  }
})();
const SRC_ROOT = path.resolve(__dirname, './src');

function packageChunkName(moduleId: string): string | null {
  const normalized = moduleId.replace(/\\/g, '/');
  const marker = '/node_modules/';
  const markerIndex = normalized.lastIndexOf(marker);
  if (markerIndex === -1) return null;

  const afterNodeModules = normalized.slice(markerIndex + marker.length);
  const parts = afterNodeModules.split('/').filter(Boolean);
  if (parts.length === 0) return null;

  let packageName = parts[0];
  let pathIndex = 1;
  if (packageName.startsWith('@') && parts.length > 1) {
    packageName = `${packageName}/${parts[1]}`;
    pathIndex = 2;
  }

  const packageSlug = packageName
    .replace(/^@/, '')
    .replace(/\//g, '-')
    .replace(/[^a-zA-Z0-9_-]/g, '');

  let filePart = '';
  if (parts[pathIndex] === 'dist') {
    pathIndex += 1;
  }
  if (parts[pathIndex]) {
    filePart = parts[pathIndex].replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_-]/g, '');
  }

  if (!filePart || filePart === 'index') return packageSlug || null;
  return packageSlug ? `${packageSlug}-${filePart}` : filePart;
}

function chunkBaseName(chunkName: string, facadeModuleId?: string | null): string {
  if (!facadeModuleId) return chunkName || 'chunk';

  const packageName = packageChunkName(facadeModuleId);
  if (packageName) return packageName;

  const relativeFromSrc = path.relative(SRC_ROOT, facadeModuleId).replace(/\\/g, '/');
  const withoutExt = relativeFromSrc.replace(/\.[^.]+$/, '');
  const normalized = withoutExt
    .replace(/^[./]+/, '')
    .replace(/[^a-zA-Z0-9/_-]/g, '')
    .replace(/\//g, '-');

  return normalized || chunkName || 'chunk';
}

export default defineConfig({
  base: './',
  plugins: [react(), stampServiceWorkerCache(), agentDevReporter()],
  build: {
    // Mermaid's parser core is an intentional, artifact-only lazy chunk at
    // ~594 kB minified. Keep the warning ceiling just above it so startup
    // regressions and larger accidental chunks still trip the build output.
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        entryFileNames: 'assets/entry/[name]-[hash].js',
        chunkFileNames: (chunkInfo) => {
          if (chunkInfo.name.startsWith('vendor-')) {
            return 'assets/vendor/[name]-[hash].js';
          }
          const baseName = chunkBaseName(chunkInfo.name, chunkInfo.facadeModuleId);
          return `assets/chunks/${baseName}-[hash].js`;
        },
        assetFileNames: ({ name }) => {
          const ext = name ? path.extname(name).toLowerCase() : '';
          if (ext === '.css') return 'assets/styles/[name]-[hash][extname]';
          if (/\.(png|jpe?g|svg|gif|webp|ico|bmp|avif)$/i.test(ext)) {
            return 'assets/media/[name]-[hash][extname]';
          }
          return 'assets/static/[name]-[hash][extname]';
        },
        manualChunks(id) {
          if (!id.includes('node_modules')) return;

          if (
            id.includes('node_modules/react') ||
            id.includes('node_modules/react-dom') ||
            id.includes('node_modules/scheduler')
          ) {
            return 'vendor-react';
          }
          if (
            id.includes('node_modules/@codemirror/view') ||
            id.includes('node_modules/@codemirror/state') ||
            id.includes('node_modules/@codemirror/language') ||
            id.includes('node_modules/@codemirror/commands') ||
            id.includes('node_modules/@lezer/common') ||
            id.includes('node_modules/@lezer/highlight') ||
            id.includes('node_modules/style-mod') ||
            id.includes('node_modules/w3c-keyname') ||
            id.includes('node_modules/@marijn/find-cluster-break')
          ) {
            return 'vendor-codemirror-core';
          }
          if (id.includes('@radix-ui') || id.includes('node_modules/vaul')) {
            return 'vendor-radix';
          }
          if (id.includes('node_modules/lucide-react')) {
            return 'vendor-icons';
          }
          if (id.includes('node_modules/date-fns')) {
            return 'vendor-date';
          }
          if (
            id.includes('node_modules/zod') ||
            id.includes('node_modules/react-hook-form') ||
            id.includes('@hookform')
          ) {
            return 'vendor-forms';
          }
          if (id.includes('@opentelemetry')) {
            return 'vendor-otel';
          }
        },
      },
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@push/lib': path.resolve(__dirname, '../lib'),
    },
    // Shared lib/ lives at the repo root, so a bare `zod` import from a
    // lib/ module would otherwise resolve up to the (uninstalled) root
    // node_modules during the app build. dedupe forces it to the app's
    // own copy of zod, which the bundle already vendors (manualChunks →
    // vendor-forms).
    dedupe: ['zod'],
  },
  server: {
    fs: {
      allow: [
        path.resolve(__dirname, '.'),
        path.resolve(__dirname, './src'),
        path.resolve(__dirname, '../lib'),
        path.resolve(__dirname, './node_modules'),
      ],
    },
    allowedHosts: ['.trycloudflare.com'],
    proxy: {
      '/ollama': {
        target: 'https://ollama.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/ollama/, ''),
      },
      '/openrouter': {
        target: 'https://openrouter.ai',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/openrouter/, ''),
      },
      '/zai': {
        target: 'https://api.z.ai',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/zai/, ''),
      },
      '/kimi': {
        target: 'https://api.moonshot.ai',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/kimi/, ''),
      },
      '/huggingface': {
        target: 'https://router.huggingface.co',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/huggingface/, ''),
      },
      '/opencode': {
        target: 'https://opencode.ai',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/opencode/, ''),
      },
      '/nvidia': {
        target: 'https://integrate.api.nvidia.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/nvidia/, ''),
      },
      '/blackbox': {
        target: 'https://api.blackbox.ai',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/blackbox/, ''),
      },
      '/api': {
        target: API_PROXY_TARGET,
        changeOrigin: true,
        configure(proxy) {
          proxy.on('proxyReq', (proxyReq) => {
            // Ensure Worker origin validation passes in local dev/tunnel contexts.
            proxyReq.setHeader('Origin', API_PROXY_ORIGIN);
            proxyReq.setHeader('Referer', `${API_PROXY_ORIGIN}/`);
          });
        },
      },
    },
  },
});
