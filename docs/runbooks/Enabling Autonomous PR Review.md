# Enabling Autonomous PR Review

Date: 2026-05-29
Status: **Current runbook** — feature shipped across #690–#696
Owner: Push

Operational steps to turn on the GitHub-webhook-driven PR reviewer in a Push
deployment. The code is fully merged; nothing here is a code change — it's
deploy + GitHub App configuration that only an operator with Cloudflare/GitHub
access can do. Architecture and rationale live in
[`../decisions/Webhook-Triggered PR Review.md`](../decisions/Webhook-Triggered%20PR%20Review.md).

## What it does

When a PR is opened or pushed, GitHub posts a webhook → the Worker verifies it
→ a `PrReviewJob` Durable Object runs an agentic review (reads beyond the diff
via read-only GitHub tools, honoring repo-root `REVIEW.md`) → posts an advisory
review comment back to the PR. The PWA review tab shows per-PR history with a
**Re-run** button. Opt-in **gating** posts a GitHub Checks API run (fail on a
critical finding) for allowlisted repos.

Surfaces: `POST /api/github/webhook` (receiver), `GET /api/pr-reviews` (history),
`POST /api/pr-reviews/run` (manual re-run), `PrReviewJob` DO.

## Prerequisites

- The `push-agent` GitHub App is already installed (the same one the app uses
  for OAuth/app-token auth) and its installation id is in
  `GITHUB_ALLOWED_INSTALLATION_IDS`.
- `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY` are set (already required for app
  auth).
- A provider key for whatever the reviewer runs on is set as a **Worker secret**
  (the DO runs the model through the Worker's own provider path). Default
  provider/model is `anthropic` / `claude-sonnet-4-6`, so `ANTHROPIC_API_KEY`
  unless you override `PR_REVIEW_PROVIDER` / `PR_REVIEW_MODEL`.

## 1. Apply the Durable Object migration (one-time)

The `PrReviewJob` DO ships with a `v4` migration in `wrangler.jsonc`. Cloudflare
**cannot apply a new DO migration through `wrangler versions upload`** (the
versioned/gradual path the Workers Build pipeline uses — it fails with
`code: 10211`). Apply it once with a non-versioned deploy:

```bash
npx wrangler deploy
```

After this one deploy, the migration is applied and subsequent
`versions upload` deploys work normally. Until you do this, `/api/github/webhook`
returns 503 (`NOT_CONFIGURED`, no DO binding) and the PWA history surface stays
hidden.

## 2. Set the webhook secret

```bash
TOKEN=$(openssl rand -hex 32)
printf '%s' "$TOKEN" | npx wrangler secret put GITHUB_WEBHOOK_SECRET
```

The receiver **fails closed** (503) when this is unset and rejects any delivery
whose `X-Hub-Signature-256` doesn't match (401). `/api/github/webhook` is exempt
from the `PUSH_DEPLOYMENT_TOKEN` gate (GitHub can't send that header) — the HMAC
signature is its auth.

## 3. Point the GitHub App at the webhook

In the GitHub App settings (Settings → Developer settings → GitHub Apps → your
app):

- **Webhook URL:** `https://<your-worker-host>/api/github/webhook`
- **Webhook secret:** the same `$TOKEN` from step 2.
- **Subscribe to events:** `Pull requests`.
- **Permissions:** `Pull requests: Read & write` (to post the review) and
  `Contents: Read` (to read files + `REVIEW.md`). Add `Checks: Read & write`
  only if you'll use gating (step 6).

Reviewable deliveries are `pull_request` with action `opened` / `synchronize` /
`reopened` / `ready_for_review`; drafts and other events are skipped.

## 4. (Optional) Tune the reviewer model

Defaults to `anthropic` / `claude-sonnet-4-6`. Provider/model are **non-secret
config**, so they live as `vars` in `wrangler.jsonc` (visible + version
controlled), not as secrets:

```jsonc
"vars": {
  "PR_REVIEW_PROVIDER": "zen",
  "PR_REVIEW_MODEL": "kimi-k2.6",
  "PR_REVIEW_ZEN_GO": "1"   // route `zen` through the OpenCode Zen "Go" endpoint
}
```

Make sure the matching provider **key** is set as a secret (e.g.
`ZEN_API_KEY` for OpenCode Zen, `OPENROUTER_API_KEY` for OpenRouter).

`PR_REVIEW_ZEN_GO` (truthy `1`/`true`/`yes`) only applies when
`PR_REVIEW_PROVIDER=zen`; it switches the upstream from `/zen/v1` to
`/zen/go/v1`. Only **OpenAI-transport** Go models work on the webhook path
(the DO's SSE pump is OpenAI-shaped) — `kimi-k2.6` and `glm-5.1` are fine;
the Anthropic-transport `minimax-*` models fail loud with a clear error.

## 5. (Optional) Add repo review guidance

Drop a repo-root `REVIEW.md` on the **base** branch. The reviewer reads it (from
the base ref — never a fork head) and weights findings by it. This is the same
file the in-app Reviewer and CLI use. No deploy needed; it's read per review.

## 6. (Optional) Enable gating

Gating is **off by default** — every repo gets advisory comments only. To make
a critical finding fail a GitHub check on specific repos:

1. Grant the GitHub App **`Checks: Read & write`** permission (step 3).
2. List the repos (comma/space-separated `owner/name`):

   ```bash
   printf '%s' "octo/repo, octo/other" | npx wrangler secret put PR_REVIEW_GATING_REPOS
   ```

For a listed repo the DO posts a `Push review` check run on the reviewed commit:
`failure` if any 🔴 critical finding, else `success`. It only **blocks merge** if
you add that check to the branch's required status checks; otherwise it's
informational. A missing `checks: write` permission is logged
(`pr_review_check_run_failed`) and never blocks the advisory comment.

## Verify

Open or push a PR in an installed+allowlisted repo and watch the Worker logs
(`npx wrangler tail`). Healthy path emits, in order:

- `webhook_enqueued` → `pr_review_completed` (with `commentsPosted`)
- `pr_review_check_run_posted` (only for gated repos)

Rejections are explicit: `webhook_rejected_signature` (401),
`webhook_rejected_installation` (403), `webhook_skipped_event` (204, e.g. draft).
The advisory review should appear on the PR; the PWA review tab should list it.

## Disable / roll back

- **Pause reviews:** remove `GITHUB_WEBHOOK_SECRET`
  (`wrangler secret delete GITHUB_WEBHOOK_SECRET`) or unsubscribe the App from
  `Pull requests` — deliveries then fail closed / stop.
- **Drop gating only:** delete `PR_REVIEW_GATING_REPOS`
  (`wrangler secret delete PR_REVIEW_GATING_REPOS`) — back to advisory-only.
- The DO + routes are inert without an authenticated delivery; no teardown
  needed beyond the secret.

## Reference

| Knob | Where | Effect |
|---|---|---|
| `GITHUB_WEBHOOK_SECRET` | Worker secret | HMAC key; unset → receiver 503 |
| `GITHUB_ALLOWED_INSTALLATION_IDS` | Worker secret/var | Installation allowlist (fail-closed on empty) |
| `PR_REVIEW_PROVIDER` / `PR_REVIEW_MODEL` | `wrangler.jsonc` vars | Reviewer model (default anthropic / claude-sonnet-4-6) |
| `PR_REVIEW_ZEN_GO` | `wrangler.jsonc` var | Route `zen` through the Go endpoint (`/zen/go/v1`); OpenAI-transport models only |
| `ZEN_API_KEY` | Worker secret | OpenCode Zen API key (required when `PR_REVIEW_PROVIDER=zen`) |
| `PR_REVIEW_GATING_REPOS` | Worker secret | Gating opt-in allowlist (default off) |
| `PrReviewJob` | `wrangler.jsonc` DO binding + `v4` migration | The review runner |

Open follow-ups (not blockers): surfacing gating status in the PWA, and a
multi-tenant read-authz hardening — both noted in the decision doc.
