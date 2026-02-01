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
VITE_OLLAMA_CLOUD_API_KEY=...     # Optional — or paste in Settings UI
VITE_OPENROUTER_API_KEY=...       # Optional — or paste in Settings UI (takes priority over Ollama)
VITE_GITHUB_TOKEN=...             # Optional — higher GitHub rate limits
VITE_GITHUB_CLIENT_ID=...         # Optional — enables OAuth login
VITE_GITHUB_OAUTH_PROXY=...       # Optional — required for OAuth token exchange
```

Without any AI keys the app runs in demo mode. OpenRouter takes priority when both keys are set.
