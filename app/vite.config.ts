import path from "path"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"
import { inspectAttr } from 'kimi-plugin-inspect-react'

// https://vite.dev/config/
const API_PROXY_TARGET = process.env.VITE_API_PROXY_TARGET || 'http://127.0.0.1:8787';
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
    filePart = parts[pathIndex]
      .replace(/\.[^.]+$/, '')
      .replace(/[^a-zA-Z0-9_-]/g, '');
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
  plugins: [inspectAttr(), react()],
  build: {
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

          if (id.includes('node_modules/react') || id.includes('node_modules/react-dom') || id.includes('node_modules/scheduler')) {
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
          if (id.includes('node_modules/recharts')) {
            return 'vendor-charts';
          }
          if (id.includes('node_modules/date-fns')) {
            return 'vendor-date';
          }
          if (id.includes('node_modules/zod') || id.includes('node_modules/react-hook-form') || id.includes('@hookform')) {
            return 'vendor-forms';
          }
        },
      },
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    allowedHosts: ['.trycloudflare.com'],
    proxy: {
      '/kimi': {
        target: 'https://api.kimi.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/kimi/, ''),
        headers: {
          'User-Agent': 'claude-code/1.0.0',
        },
      },
      '/ollama': {
        target: 'https://ollama.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/ollama/, ''),
      },
      '/mistral': {
        target: 'https://api.mistral.ai',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/mistral/, ''),
      },
      '/zai': {
        target: 'https://api.z.ai',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/zai/, ''),
      },
      '/api': {
        target: API_PROXY_TARGET,
        changeOrigin: true,
      },
    },
  },
});
