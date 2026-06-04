# Private Cloudflare Deployment

This runbook is for the "I test the production web app from my phone, but I do not want strangers spending my Cloudflare/model/sandbox quota" setup.

## Recommended Shape

Use Cloudflare Access / Zero Trust in front of the whole production hostname. That protects the static app and every Worker route before requests reach Push.

The repo-side API gate is the **GitHub-identity session gate** below — Access is an optional additional outer edge layer.

> The legacy `X-Push-Deployment-Token` / `#push_token` gate was retired in the auth rework (see `docs/decisions/Auth Rework — GitHub as the Single Identity Anchor.md`). The GitHub-identity session is now the universal `/api/*` gate.

## GitHub-Identity Session Gate (repo-side API gate)

The session is the universal `/api/*` gate: a request needs a valid session minted for an **allowlisted GitHub user id**. Configure three Worker secrets:

```bash
# 1) HMAC signing secret for the session JWT (independent of all other secrets)
printf '%s' "$(openssl rand -hex 32)" | npx wrangler secret put PUSH_SESSION_SECRET

# 2) Allowed GitHub numeric user id(s), comma/space separated (find yours at
#    https://api.github.com/users/<login> → .id)
printf '%s' "107059169" | npx wrangler secret put GITHUB_ALLOWED_USER_IDS

# 3) Flip from observe (log-only) to enforcing, once you've watched the logs
printf '%s' "1" | npx wrangler secret put PUSH_SESSION_GATE_ENFORCE
```

When enforcing:

- every gated `/api/*` route requires a valid session (the exempt set is health, the GitHub-App auth-bootstrap endpoints, the webhook (HMAC), relay (device bearer), and the admin-token routes)
- static assets still load; a request with no session is met by the in-app **"Connect GitHub to continue"** screen (`GitHubSignInGate`)
- the session is minted when you connect via the GitHub App (OAuth or installation-id) and travels as a `SameSite=None` cookie plus an `X-Push-Session` header fallback for the Capacitor shell
- the repo must be covered by your GitHub App installation (`GITHUB_ALLOWED_INSTALLATION_IDS`); a non-covered repo gets an actionable install/update prompt before the sandbox clone

Roll out observe-first: leave `PUSH_SESSION_GATE_ENFORCE` unset, sign in on every surface you use, watch `wrangler tail` for `session_gate_observe_allow` with your `sub`, then set the flag to enforce. To deauthorize, remove your id from `GITHUB_ALLOWED_USER_IDS` (or disconnect, which expires the cookie).

## Cloudflare Access Setup Notes

Use one Access application for the production hostname, for example:

- Application type: self-hosted
- Application domain: `push.example.com`
- Policy action: allow
- Include: your email, your team email domain, or a specific identity group

After enabling Access, test from your phone:

1. Open the production URL.
2. Complete the Cloudflare Access login.
3. Confirm the app shell loads.
4. Connect GitHub.
5. Start a sandbox and run a harmless command, such as `pwd`.
6. Start and cancel a background Coder job if that path is enabled.

## What This Does Not Solve

The session gate's allowlist is a single-user / small-allowlist guard, not multi-user auth. It anchors identity on GitHub and gates the metered surface, but does not add per-user quota, billing isolation, or audit identity beyond the structured `session_gate_*` logs. If Push becomes a public hosted service, widen the allowlist into a real accounts/session system with per-user limits and separate billing before opening sandbox creation or background jobs.

Also keep self-hosting config hygiene separate: public examples should use placeholder KV namespace IDs and explain how operators create their own Cloudflare resources.
