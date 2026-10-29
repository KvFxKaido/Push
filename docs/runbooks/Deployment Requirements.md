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
| Workers + Workers Builds | — | The app itself; deploy-on-merge from `main` (~2 min). Don't `wrangler deploy` by hand. | Connect the repo in dash → Workers Builds; set the production trigger's deploy command to `node scripts/deploy-worker.mjs` (`wrangler deploy` at a **pinned** wrangler version, `WRANGLER_VERSION` in the script, that retries the occasional sandbox-image push timeout to `registry.cloudflare.com`; see the script header. Bump the pin deliberately and watch the first deploy) |
| Durable Objects | `Sandbox`, `CoderJob`, `RELAY_SESSIONS`, `PrReviewJob`, `RUN_HOST` | Sandbox control, background coder jobs, remote-session relay, autonomous PR review, durable runs | Migrations ship in `wrangler.jsonc`; nothing manual |
| Containers (Sandbox SDK) | via `Sandbox` DO | Cloud workspaces (`Dockerfile.sandbox`, base pinned to the SDK version) | Deploys with the Worker |
| KV | `SANDBOX_TOKENS`, `SNAPSHOT_INDEX`, `CHAT_LIBRARY` | Sandbox auth tokens (durable source of truth), snapshot index, chat library | `wrangler kv namespace create <name>` ×3, swap the ids into `wrangler.jsonc` |
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
| `BACKUP_BUCKET_NAME`, `CLOUDFLARE_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | **Sandbox SDK 0.12 only.** 0.12 backups (the workspace preservation floor) need them; SDK 1.0 backups use the `BACKUP_BUCKET` binding through the `DirectoryBackupGateway` export and need none of them. Delete them after the 1.0 cutover. The R2 keypair comes from dash → R2 → Manage R2 API Tokens → Object Read & Write, scoped to the snapshots bucket |

**Optional:**

| Secret | Purpose |
|---|---|
| `CF_AI_GATEWAY_ACCOUNT_ID`, `CF_AI_GATEWAY_SLUG`, `CF_AI_GATEWAY_TOKEN` | AI Gateway routing + optional authenticated-gateway header (`cf-aig-authorization`) |
| `CF_AI_GATEWAY_COMPAT_TOKEN` | Server-side `Authorization` credential for the unified `/compat` provider; separate from gateway authentication |
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
- **Tavily** (optional): web-search backend.

## After first deploy

Verify the preservation floor before trusting it with real work: create a
session on a scratch repo **feature branch** (the on-origin snapshot restore
deliberately skips default branches), write an uncommitted file, hibernate,
recreate, and confirm the file comes back. A fresh deployment with missing
backup secrets fails **visibly** (503 `INVALID_BACKUP_CONFIG`) rather than
silently claiming durability.

## Worker Previews

Non-`main` branches deploy as [Worker Previews](https://developers.cloudflare.com/workers/previews/) (`npx wrangler preview`), configured by the `previews` block in `wrangler.jsonc`. Each Preview gets its own Durable Object namespaces, so a branch can't reach production's sandboxes, chats or jobs. **Never point non-production builds back at `wrangler versions upload`.** That runs against the production Worker, and on 2026-10-25 it attached production's Sandbox namespace to a new container app and took production sandboxes down.

**How Previews differ from production**
- **Sandboxes run on Modal.** Previews reject `durable_object`-policy containers, so the block has no containers and sets `PUSH_SANDBOX_PROVIDER=modal`. Rehearse Cloudflare-container changes on push-staging (`wrangler.staging.jsonc`) by hand instead.
- **Data lives on push-staging's resources:** its KV namespaces, the `push-staging-snapshots` bucket, rate-limit namespace `9001` and the `push_provider_stats_staging` dataset. `wrangler-previews-config.test.ts` fails if any Preview binding points at a production resource.
- **No crons, logpush or routes.** These only target production.

**Preview secrets.** Set these once on the Previews Base config. Each new Preview copies them when it's created; existing Previews keep what they had. Set the values yourself. Use the absolute config path so the folder you run from doesn't matter:

```bash
npx wrangler preview base-config secret put <NAME> -c C:/dev/Push-v1/wrangler.jsonc
```

| Secret | Why a Preview needs it |
|---|---|
| `PUSH_SESSION_SECRET` | Signs sessions. **Use a new random value, not production's**, so a session minted on a Preview can't be replayed against production. |
| `GITHUB_ALLOWED_USER_IDS` | Who may sign in. Same value as production. |
| `PUSH_SESSION_GATE_ENFORCE` | Turns the session gate on (any non-empty value). **Required:** Preview URLs are public, and without it the gate only observes. |
| `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` | Sign-in (installation-ID flow, which works on any origin) and repo access. |
| `GITHUB_ALLOWED_INSTALLATION_IDS` | Which installations may sign in. Same value as production. |
| `MODAL_SANDBOX_BASE_URL` | Preview sandboxes. |
| `CF_AI_GATEWAY_ACCOUNT_ID`, `CF_AI_GATEWAY_SLUG`, `CF_AI_GATEWAY_TOKEN` | Models through the AI Gateway. |

**Deliberately not set on Previews**
- **Production-only operations:** `ADMIN_TOKEN`, `STATS_ADMIN_TOKEN`, `CF_ANALYTICS_TOKEN`, `PUSH_DEPLOYMENT_TOKEN`.
- **Webhooks:** `GITHUB_WEBHOOK_SECRET`. Webhooks go to production.
- **Relay:** `PUSH_RELAY_TOKEN`. Add it only to test the relay on a Preview.
- **Not needed:** `ALLOWED_ORIGINS`. A Worker always allows its own origin.
- **0.12 backups only:** `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `BACKUP_BUCKET_NAME`, `CLOUDFLARE_ACCOUNT_ID`.

**Turning Previews on (one time, can't be undone)**
1. Merge the PR that adds the `previews` block, with Workers Builds still disabled.
2. Set the Preview secrets above.
3. Dashboard: **Workers & Pages → push → Settings → Build → Set up Worker Previews → Switch to Worker Previews**. Cloudflare replaces the non-production command with `npx wrangler preview`. The switch can't be reversed.
4. Re-enable builds, with preview builds turned on.
5. Push a scratch branch. Then check three things:
   - `GET /accounts/<id>/containers/applications` shows no new or changed app;
   - the Preview URL asks you to sign in;
   - a sandbox create on the Preview succeeds.

Cloudflare Artifacts uses the separate `CF_ARTIFACTS` namespace binding. See [Cloudflare Artifacts](<Cloudflare Artifacts.md>) for namespace setup and staging validation. Removing the old `ARTIFACTS` KV binding does not delete its stored records.
