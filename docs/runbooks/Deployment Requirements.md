# Deployment Requirements

Everything a full Push deployment needs, in one place — the vibesdk-style
upfront list. Canonical source for "what do I have to provision"; the README
carries only a summary pointing here. Binding names below must match
`wrangler.jsonc` (which is authoritative for shapes; this doc is authoritative
for the *why* and the provisioning steps).

## Plan tier

**Cloudflare Workers Paid** is required — Durable Objects and Containers (the
cloud sandbox) don't run on the free tier. Everything else fits free-tier
allowances at single-user scale. **Workers for Platforms is NOT required**
(Push delivers to your GitHub repo, not to hosted per-user Workers).

## Cloudflare services

| Service | Binding(s) | Why | Provisioning |
|---|---|---|---|
| Workers + Workers Builds | — | The app itself; deploy-on-merge from `main` (~2 min). Don't `wrangler deploy` by hand. | Connect the repo in dash → Workers Builds |
| Durable Objects | `Sandbox`, `CoderJob`, `RELAY_SESSIONS`, `PrReviewJob`, `RUN_HOST` | Sandbox control, background coder jobs, remote-session relay, autonomous PR review, durable runs | Migrations ship in `wrangler.jsonc`; nothing manual |
| Containers (Sandbox SDK) | via `Sandbox` DO | Cloud workspaces (`Dockerfile.sandbox`, base pinned to the SDK version) | Deploys with the Worker |
| KV | `SANDBOX_TOKENS`, `SNAPSHOT_INDEX`, `ARTIFACTS`, `CHAT_LIBRARY` | Sandbox auth tokens (durable source of truth), snapshot index, artifact store, chat library | `wrangler kv namespace create <name>` ×4, swap the ids into `wrangler.jsonc` |
| R2 | `SNAPSHOTS`, `BACKUP_BUCKET` (same bucket) | Workspace snapshots/backup descriptors + SDK backup archives | `wrangler r2 bucket create push-cf-snapshots`, then the 7-day lifecycle rule (`npm run r2:snapshots:lifecycle`) |
| Workers AI | `AI` | Optional provider (`cloudflare` in the picker) — no key needed | Binding only |
| AI Gateway | — | Optional: BYOK key consolidation per provider (`push-gate`). Disable guardrails on a fresh gateway (they can bill more than the calls they guard) and mind response caching if you run evals | Create gateway in dash, set the `CF_AI_GATEWAY_*` secrets |
| Secrets Store | `ZEN_KEY_STORE` | Optional: OpenCode Zen Go anthropic-transport key (gateway BYOK can't inject `x-api-key`) | Only if you use Zen Go |
| Analytics Engine | `PROVIDER_STATS` | Provider usage stats | Binding only |
| Cron trigger | — | Daily orphaned-snapshot reaper | Ships in `wrangler.jsonc` |

## Worker secrets

Set with `npx wrangler versions secret put <NAME>` — on a Workers Builds
deployment, plain `wrangler secret put` fails with error 10215 (versioned
deploys); use the `versions` variant and promote, or set via dashboard.

**Required:**

| Secret | Purpose |
|---|---|
| `GITHUB_APP_ID`, `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`, `GITHUB_APP_PRIVATE_KEY` | The GitHub App — repo access, auth, PR flow |
| `PUSH_SESSION_SECRET`, `GITHUB_ALLOWED_USER_IDS`, `PUSH_SESSION_GATE_ENFORCE` | GitHub-identity session gate (see [Private Cloudflare Deployment](Private%20Cloudflare%20Deployment.md)) |
| `ALLOWED_ORIGINS` | CORS allowlist |
| At least one provider key (e.g. `MOONSHOT_API_KEY`, `ANTHROPIC_API_KEY`, …) | A model to talk to — or route BYOK through the AI Gateway instead |
| `BACKUP_BUCKET_NAME`, `CLOUDFLARE_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | Sandbox SDK backups (the workspace preservation floor). The R2 keypair comes from dash → R2 → Manage R2 API Tokens → Object Read & Write, scoped to the snapshots bucket |

**Optional:**

| Secret | Purpose |
|---|---|
| `CF_AI_GATEWAY_ACCOUNT_ID`, `CF_AI_GATEWAY_SLUG`, `CF_AI_GATEWAY_TOKEN` | AI Gateway routing + BYOK |
| `ADMIN_TOKEN` | Admin routes |
| `PUSH_RELAY_ENABLED`, `PUSH_RELAY_TOKEN` | Remote session relay (CLI daemon ↔ web) |
| `MODAL_SANDBOX_BASE_URL` | Alternate Modal sandbox backend (`PUSH_SANDBOX_PROVIDER=modal`; deploy `sandbox/app.py` with `modal deploy`) |
| `TAVILY_API_KEY` | Web-search backend |

## External accounts

- **GitHub App** (required): create one on your account, install it on the
  repos Push should reach. The web app authenticates users against it and the
  Worker uses it for repo access.
- **Model provider** (at least one): any entry in the provider picker works;
  keys go in Worker secrets or the AI Gateway.
- **Modal** (optional): only for the alternate sandbox backend.
- **Browserbase / Tavily** (optional): browser tool and web search.

## After first deploy

Verify the preservation floor before trusting it with real work: create a
session on a scratch repo **feature branch** (the on-origin snapshot restore
deliberately skips default branches), write an uncommitted file, hibernate,
recreate, and confirm the file comes back. A fresh deployment with missing
backup secrets fails **visibly** (503 `INVALID_BACKUP_CONFIG`) rather than
silently claiming durability.
