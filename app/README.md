# Push — App

Frontend source for Push. See the [root README](../README.md) for architecture and project overview.

## Scripts

Dependencies come from the **root** pnpm workspace — run `pnpm install` once at the repo root, not here. These scripts then run from `app/` (or from the root via `pnpm --filter my-app run <script>`):

```bash
pnpm run dev       # Start dev server (port 5173)
pnpm run build     # Production build → dist/
pnpm run preview   # Preview production build locally
pnpm run lint      # Run ESLint
pnpm run android:sync   # Build the SPA and sync it into Android
pnpm run electron:sync  # Build the SPA and sync it into the Electron desktop shell
```

## Environment Variables

Create `.env` in this directory, or paste keys in the Settings UI at runtime:

```env
VITE_OLLAMA_API_KEY=...           # Optional — Ollama Cloud
VITE_OPENROUTER_API_KEY=...       # Optional — OpenRouter (BYOK-compatible)
VITE_ZEN_API_KEY=...              # Optional — OpenCode Zen
VITE_FIREWORKS_API_KEY=...        # Optional — Fireworks AI
VITE_SAKANA_API_KEY=...           # Optional — Sakana AI
VITE_ANTHROPIC_API_KEY=...        # Optional — Anthropic (native /v1/messages API with prompt caching)
VITE_OPENAI_API_KEY=...           # Optional — OpenAI (GPT models with automatic prefix-based prompt caching)
VITE_GOOGLE_API_KEY=...           # Optional — Google Gemini (native generativelanguage.googleapis.com API)
VITE_AZURE_OPENAI_API_KEY=...     # Optional — Azure OpenAI (experimental)
VITE_AZURE_OPENAI_BASE_URL=...    # Optional — Azure/OpenAI-compatible base URL
VITE_AZURE_OPENAI_MODEL=...       # Optional — Azure deployment/model name
VITE_BEDROCK_API_KEY=...          # Optional — AWS Bedrock OpenAI-compatible endpoint
VITE_BEDROCK_BASE_URL=...         # Optional — Bedrock OpenAI-compatible base URL
VITE_BEDROCK_MODEL=...            # Optional — Bedrock model/deployment name
VITE_VERTEX_SERVICE_ACCOUNT_JSON=... # Optional — Google Vertex service account JSON
VITE_VERTEX_REGION=...            # Optional — Google Vertex region
VITE_VERTEX_MODEL=...             # Optional — Google Vertex model
VITE_TAVILY_API_KEY=...           # Optional — Tavily web search
VITE_GITHUB_TOKEN=...             # Optional — higher GitHub rate limits
VITE_GITHUB_CLIENT_ID=...         # Optional — enables OAuth login
VITE_GITHUB_OAUTH_PROXY=...       # Optional — required for OAuth token exchange
VITE_GITHUB_REDIRECT_URI=...      # Optional — exact OAuth callback URL (OAuth App/PAT flow)
VITE_GITHUB_APP_REDIRECT_URI=...  # Optional — exact OAuth callback URL (GitHub App flow)
VITE_GITHUB_TOOL_BACKEND=...      # Optional — GitHub tool transport override
VITE_API_BASE_URL=...             # Optional — API base when the app is served separately
```

Without any AI key the app prompts for one on first use.

### Experimental mode flags

Experimental paths are gated by build-time flags. They default OFF so unfinished surfaces don't ship into mainline builds.

```env
VITE_RELAY_MODE=1       # Surfaces the Remote (pushd relay) tile on the same surfaces
VITE_NATIVE_CHECKPOINTS=1 # APK/native only: use the on-device JGit checkpoint store + history UI
```

Truthy values: `1`, `true`, `yes`, `on` (case-insensitive). Anything else — including unset — hides the gated surface.

**These are inlined by Vite at `vite build` time** (`import.meta.env.VITE_*` becomes a literal string in the bundle). They are **not** runtime vars — setting them in the browser, in `wrangler.jsonc` `vars`, or via `wrangler secret put` has no effect, because the JS the PWA loads was already compiled with whatever value the flag had at build time.

| Surface | Where to set | Trigger |
|---|---|---|
| Local dev | `.env.local` (gitignored) | `pnpm run dev` picks it up automatically |
| Cloudflare Workers Builds | Dashboard → Workers & Pages → `push` → Settings → **Build → Variables and Secrets** (separate from runtime vars further down the page) | Push any commit, or **Retry deployment** on the latest build |

To verify a deployed build picked them up, open DevTools → Sources, find the hashed `App-*.js`, and search for the flag name — you won't find it, because Vite has already replaced it with the literal string value.

Worker runtime vars/secrets:

- `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` — optional server-side keys for the direct Anthropic and OpenAI Worker proxies. When set, the Worker prefers these secrets over client-supplied Settings keys for those providers.
- `PUSH_SESSION_SECRET` / `GITHUB_ALLOWED_USER_IDS` / `PUSH_SESSION_GATE_ENFORCE` — the GitHub-identity session gate (auth rework). The session is the universal `/api/*` gate: a request needs a valid session for an allowlisted GitHub user id. `PUSH_SESSION_SECRET` signs the session JWT; `GITHUB_ALLOWED_USER_IDS` is the comma/space list of allowed numeric GitHub ids; `PUSH_SESSION_GATE_ENFORCE=1` flips it from observe (log-only) to enforcing. See [the platform decisions doc](<../docs/decisions/Platform, Sessions, and Sandbox Decisions.md>).
- `PUSH_RELAY_ENABLED` / `PUSH_RELAY_TOKEN` — enable the Remote session relay route and set the deployment-scoped `pushd_relay_*` bearer used by `push daemon relay enable`. Keep the token in a Worker secret.
- `PUSH_RELAY_BUFFER_COUNT` / `PUSH_RELAY_BUFFER_AGE_MS` — optional replay-buffer tuning for the relay Durable Object.
- `MODAL_SANDBOX_BASE_URL` — only needed when `PUSH_SANDBOX_PROVIDER=modal`. Modal app base URL (e.g. `https://youruser--push-sandbox`).

For production phone testing, the GitHub-identity session gate is the app-level access control; Cloudflare Access in front of the hostname is an optional additional edge gate. See [Private Cloudflare Deployment](../docs/runbooks/Private%20Cloudflare%20Deployment.md).

## Sandbox backend

Push runs tasks inside ephemeral Linux workspaces. Two backends are supported, selected per-deploy via the `PUSH_SANDBOX_PROVIDER` var in `wrangler.jsonc`:

- **Cloudflare Sandbox (default, `"cloudflare"`)** — runs inside a Worker-bound container defined by `Dockerfile.sandbox`. The `containers` block, `Sandbox` Durable Object binding, and `SANDBOX_TOKENS` KV namespace in `wrangler.jsonc` are already provisioned; no extra deploy step beyond `wrangler deploy`.
- **Modal (`"modal"`)** — runs in Modal's managed cloud. Deploy with `cd ../sandbox && modal deploy app.py` (6 web endpoints) and set the `MODAL_SANDBOX_BASE_URL` secret. Remains available as an explicit fallback.

## Android app (experimental)

The Android app is a Capacitor wrapper around the built web app. It is currently for emulator/device smoke testing, OAuth/WebView validation, CI build verification, and sideloaded debug APKs. Treat it as experimental until release signing and distribution are wired.

`app/android/` is **committed source** (the Capacitor project, with the native-git plugin + build config). Build outputs and the regenerated web bundle are ignored via `app/android/.gitignore`; don't regenerate it with `cap add android`. Build and sync the web bundle into Android with:

```bash
pnpm run android:sync
```

Install a debug build on a connected emulator or device:

```bash
cd android
./gradlew installDebug
```

On Windows, use `.\gradlew installDebug` from `app\android`.

## Desktop app (Electron, experimental)

The desktop shell wraps the same PWA for Windows/macOS/Linux via
[`@capawesome/capacitor-electron`](https://github.com/capawesome-team/capacitor-electron)
— a Capacitor platform, so it shares the Android wiring model. It is the
scaffolding path for the "native Windows Electron shell" in
[`Windows Desktop — WSL-Hosted Daemon.md`](../docs/decisions/Windows%20Desktop%20—%20WSL-Hosted%20Daemon.md);
treat it as experimental until a packaged build is walked end-to-end.

**Load mode is bundled, unlike Android.** The Electron runtime does not read
`server.url` from `capacitor.config.ts` — verified against the plugin source
(no config option consumes it) and a live launch (2026-07-18): the window
serves the synced `dist/` copy at `capacitor-electron://localhost/`. Each web
deploy therefore needs a `pnpm run electron:sync` to refresh the shell. The
Worker `/api` backend is remote regardless.

Remote load exists only through the `CAPACITOR_ELECTRON_DEV_SERVER_URL` env
var (verified: with it set, the window loads the hosted Worker and the PWA
service worker registers). The runtime treats that as **dev-server mode and
relaxes CSP**, so use it as a development escape hatch, not the shipping
loader. If a first-class remote mode matters later, that's an upstream
feature request, not a config tweak.

`app/electron/` is **committed source** (mirroring `app/android/`): the platform
config (`capacitor.electron.config.ts`, `electron-builder.config.js`, `main.ts`,
`package.json` + its own `pnpm-lock.yaml`, `tsconfig.json`) is tracked, while
`app/electron/.gitignore` excludes everything regenerated — the synced web
bundle (`app/`), Capacitor plugin registration (`generated/`), tsc output
(`build/`), packaged builds (`dist/`), the vendored runtime (`vendor/`), and
`node_modules`. Don't regenerate via `cap add`; a fresh clone only needs deps
and a sync:

```bash
# one-time, from app/electron/ — install the shell's own deps
# --ignore-workspace is load-bearing: app/electron is not a pnpm workspace
# member, so a bare `pnpm install` here resolves the REPO workspace instead,
# reports success, and installs none of the scaffold's deps (verified).
cd electron && pnpm install --ignore-workspace && cd ..

# thereafter: build the SPA + sync + launch
pnpm run electron:run
```

`pnpm run electron:sync` builds the SPA and copies it into the shell;
`electron:open` / `electron:run` open or launch it. `scripts/ensure-capacitor-electron.mjs`
guards that the platform exists and prints the bootstrap command when it doesn't.
