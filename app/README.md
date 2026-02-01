# Diff — App

Frontend source for Diff. See the [root README](../README.md) for architecture and project overview.

## Scripts

```bash
npm install       # Install dependencies
npm run dev       # Start dev server (port 5173)
npm run build     # Type-check + production build → dist/
npm run preview   # Preview production build locally
npm run lint      # Run ESLint
```

## Environment Variables

Create `.env` in this directory, or paste keys in the Settings UI at runtime:

```env
VITE_MOONSHOT_API_KEY=...         # Optional — or paste in Settings UI (sk-kimi-...)
VITE_GITHUB_TOKEN=...             # Optional — higher GitHub rate limits
VITE_GITHUB_CLIENT_ID=...         # Optional — enables OAuth login
VITE_GITHUB_OAUTH_PROXY=...       # Optional — required for OAuth token exchange
```

Without a Kimi key the app runs in demo mode.

Worker secrets (set via `wrangler secret put`):

- `MOONSHOT_API_KEY` — Kimi For Coding API key for production proxy (starts with `sk-kimi-`)
- `MODAL_SANDBOX_BASE_URL` — Modal app base URL (e.g. `https://youruser--diff-sandbox`). Without this, sandbox returns 503.

Sandbox backend: `cd ../sandbox && modal deploy app.py` — deploys the 6 Modal web endpoints.
