import path from "path"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"
import { inspectAttr } from 'kimi-plugin-inspect-react'

// https://vite.dev/config/
export default defineConfig({
  base: './',
  plugins: [inspectAttr(), react()],
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
    },
  },
});
