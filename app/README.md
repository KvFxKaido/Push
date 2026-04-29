# Push — App

Frontend source for Push. See the [root README](../README.md) for architecture and project overview.

## Scripts

```bash
npm install       # Install dependencies
npm run dev       # Start dev server (port 5173)
npm run build     # Type-check + production build → dist/
npm run preview   # Preview production build locally
npm run lint      # Run ESLint
npm run android:setup  # Regenerate the gitignored Capacitor Android project
npm run android:sync   # Build the SPA and sync it into Android
```

## Environment Variables

Create `.env` in this directory, or paste keys in the Settings UI at runtime:

```env
VITE_OLLAMA_API_KEY=...           # Optional — Ollama Cloud
VITE_OPENROUTER_API_KEY=...       # Optional — OpenRouter (BYOK-compatible)
VITE_ZEN_API_KEY=...              # Optional — OpenCode Zen
VITE_BLACKBOX_API_KEY=...         # Optional — Blackbox AI
VITE_NVIDIA_API_KEY=...           # Optional — Nvidia NIM
VITE_KILOCODE_API_KEY=...         # Optional — Kilo Code
VITE_TAVILY_API_KEY=...           # Optional — Tavily web search
VITE_GITHUB_TOKEN=...             # Optional — higher GitHub rate limits
VITE_GITHUB_CLIENT_ID=...         # Optional — enables OAuth login
VITE_GITHUB_OAUTH_PROXY=...       # Optional — required for OAuth token exchange
VITE_GITHUB_REDIRECT_URI=...      # Optional — exact OAuth callback URL (OAuth App/PAT flow)
VITE_GITHUB_APP_REDIRECT_URI=...  # Optional — exact OAuth callback URL (GitHub App flow)
```

Without any AI key the app prompts for one on first use.

Worker secrets (set via `wrangler secret put`):

- `MODAL_SANDBOX_BASE_URL` — only needed when `PUSH_SANDBOX_PROVIDER=modal`. Modal app base URL (e.g. `https://youruser--push-sandbox`).

## Sandbox backend

Push runs tasks inside ephemeral Linux workspaces. Two backends are supported, selected per-deploy via the `PUSH_SANDBOX_PROVIDER` var in `wrangler.jsonc`:

- **Cloudflare Sandbox (default, `"cloudflare"`)** — runs inside a Worker-bound container defined by `Dockerfile.sandbox`. The `containers` block, `Sandbox` Durable Object binding, and `SANDBOX_TOKENS` KV namespace in `wrangler.jsonc` are already provisioned; no extra deploy step beyond `wrangler deploy`.
- **Modal (`"modal"`)** — runs in Modal's managed cloud. Deploy with `cd ../sandbox && modal deploy app.py` (6 web endpoints) and set the `MODAL_SANDBOX_BASE_URL` secret. Remains available as an explicit fallback.

## Android app (experimental)

The Android app is a Capacitor wrapper around the built web app. It is currently for emulator/device smoke testing, OAuth/WebView validation, CI build verification, and sideloaded debug APKs. Treat it as experimental until release signing and distribution are wired.

`app/android/` is generated and gitignored. Recreate it with:

```bash
npm run android:setup
```

Build and sync the web bundle into Android with:

```bash
npm run android:sync
```

Install a debug build on a connected emulator or device:

```bash
cd android
./gradlew installDebug
```

On Windows, use `.\gradlew installDebug` from `app\android`.
