# Private Cloudflare Deployment

This runbook is for the "I test the production web app from my phone, but I do not want strangers spending my Cloudflare/model/sandbox quota" setup.

## Recommended Shape

Use Cloudflare Access / Zero Trust in front of the whole production hostname. That protects the static app and every Worker route before requests reach Push.

Keep the repo-side deployment token below as a second layer or a fallback when Access setup is not available yet.

## Repo-Side API Gate

Push supports an optional Worker secret:

```bash
TOKEN=$(openssl rand -hex 32)
printf '%s\n' "$TOKEN"
printf '%s' "$TOKEN" | npx wrangler secret put PUSH_DEPLOYMENT_TOKEN
```

When `PUSH_DEPLOYMENT_TOKEN` is set:

- every `/api/*` route except `/api/health` requires `X-Push-Deployment-Token`
- static assets still load, so you get a visible app instead of a blank page
- the browser can store the token by opening the app once with a URL fragment:

```text
https://your-push-host.example/#push_token=<token>
```

The fragment is not sent to the server. The app stores it in `localStorage` as `push_deployment_token`, strips it from the URL with `history.replaceState`, and automatically adds `X-Push-Deployment-Token` to same-origin `/api/*` requests. For the Capacitor shell, the same helper also works with `VITE_API_BASE_URL`.

To rotate the token:

```bash
TOKEN=$(openssl rand -hex 32)
printf '%s\n' "$TOKEN"
printf '%s' "$TOKEN" | npx wrangler secret put PUSH_DEPLOYMENT_TOKEN
```

Then open the app once with the new `#push_token=<token>` URL on each browser/device.

To clear the browser token:

```js
localStorage.removeItem('push_deployment_token')
```

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

The deployment token is a personal-deployment guard, not multi-user auth. It does not add per-user quota, billing isolation, or audit identity. If Push becomes a public hosted service, add real auth, per-user limits, and separate billing controls before opening sandbox creation or background jobs.

Also keep self-hosting config hygiene separate: public examples should use placeholder KV namespace IDs and explain how operators create their own Cloudflare resources.
