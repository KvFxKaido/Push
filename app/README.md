# Push — App

Frontend source for Push. See the [root README](../README.md) for architecture and project overview.

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
VITE_OLLAMA_API_KEY=...           # Optional — Ollama Cloud
VITE_MISTRAL_API_KEY=...          # Optional — Mistral Vibe
VITE_TAVILY_API_KEY=...           # Optional — Tavily web search
VITE_GITHUB_TOKEN=...             # Optional — higher GitHub rate limits
VITE_GITHUB_CLIENT_ID=...         # Optional — enables OAuth login
VITE_GITHUB_OAUTH_PROXY=...       # Optional — required for OAuth token exchange
VITE_GITHUB_REDIRECT_URI=...      # Optional — exact OAuth callback URL (OAuth App/PAT flow)
VITE_GITHUB_APP_REDIRECT_URI=...  # Optional — exact OAuth callback URL (GitHub App flow)
```

Without any AI key the app prompts for one on first use.

Worker secrets (set via `wrangler secret put`):

- `MODAL_SANDBOX_BASE_URL` — Modal app base URL (e.g. `https://youruser--push-sandbox`). Without this, sandbox returns 503.

Sandbox backend: `cd ../sandbox && modal deploy app.py` — deploys the 6 Modal web endpoints.
