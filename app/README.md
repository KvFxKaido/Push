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

### Experimental mode flags

Two tiles on the launcher (`Local PC` and `Remote`) are gated by build-time flags. They default OFF so experimental paths don't ship into mainline builds.

```env
VITE_LOCAL_PC_MODE=1    # Surfaces the Local PC tile on onboarding, home, and the in-workspace launcher sheet
VITE_RELAY_MODE=1       # Surfaces the Remote (pushd relay) tile on the same surfaces
```

Truthy values: `1`, `true`, `yes`, `on` (case-insensitive). Anything else — including unset — hides the tile.

**These are inlined by Vite at `vite build` time** (`import.meta.env.VITE_*` becomes a literal string in the bundle). They are **not** runtime vars — setting them in the browser, in `wrangler.jsonc` `vars`, or via `wrangler secret put` has no effect, because the JS the PWA loads was already compiled with whatever value the flag had at build time.

| Surface | Where to set | Trigger |
|---|---|---|
| Local dev | `.env.local` (gitignored) | `npm run dev` picks it up automatically |
| Cloudflare Workers Builds | Dashboard → Workers & Pages → `push` → Settings → **Build → Variables and Secrets** (separate from runtime vars further down the page) | Push any commit, or **Retry deployment** on the latest build |

To verify a deployed build picked them up, open DevTools → Sources, find the hashed `App-*.js`, and search for the flag name — you won't find it, because Vite has already replaced it with the literal string value.

Worker secrets (set via `wrangler secret put`):

- `PUSH_DEPLOYMENT_TOKEN` — optional private-deployment API gate. When set, every `/api/*` route except `/api/health` requires `X-Push-Deployment-Token`. Open the app once with `#push_token=<token>` to store it in the browser.
- `MODAL_SANDBOX_BASE_URL` — only needed when `PUSH_SANDBOX_PROVIDER=modal`. Modal app base URL (e.g. `https://youruser--push-sandbox`).

For production phone testing, prefer putting the whole hostname behind Cloudflare Access. `PUSH_DEPLOYMENT_TOKEN` is a repo-side backstop/fallback, not a substitute for a real edge access policy. See [Private Cloudflare Deployment](../docs/runbooks/Private%20Cloudflare%20Deployment.md).

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
