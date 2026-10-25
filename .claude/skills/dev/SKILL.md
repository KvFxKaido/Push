---
name: dev
description: Run the Push web dev stack (Vite app + Cloudflare Worker) and read its agent-readable structured output — dev_server_ready, hmr_update/hmr_error, vite_warn/vite_error — instead of grepping human logs. Use when iterating on the web app/Worker locally, or driving the dev server before a browser check.
allowed-tools: Bash, Read, PowerShell
user-invocable: true
proactive: false
---

# /dev — run the Push web dev stack, agent-readably

The web sibling of `/device`: start the long-running dev servers and read
**structured JSON** about readiness and errors, instead of sleeping/tailing.

This leans on the `agent-dev-reporter` Vite plugin (PR #1109,
`app/dev/agent-dev-reporter.ts`, wired in `app/vite.config.ts`). It's `apply:
'serve'` (dev only; production/PWA/Capacitor builds untouched).

## It auto-activates for agents

The reporter turns on when an agent env var is present — source of truth is
`KNOWN_AGENT_ENV` in `app/dev/agent-dev-reporter.ts` (Claude Code, Codex, Cursor,
Aider, Replit) — so under Claude Code or Codex it's **already on**. Override: `PUSH_DEV_AGENT=1` forces on,
`PUSH_DEV_AGENT=0` forces off (human logs are always preserved underneath).

## Start the stack (two background servers)

```bash
# Vite app on :5173 (proxies /api/* to :8787)
cd "$(git rev-parse --show-toplevel)/app" && npm run dev
# Worker on :8787, in a second background run, from repo root
cd "$(git rev-parse --show-toplevel)" && npx wrangler dev --port 8787
```
Run **both** with `run_in_background: true`. Don't foreground-`sleep` waiting for
them — read the ready event instead (below).

## Read the structured events (one-line JSON on the dev server's stdout)

Grep the background run's output file for the event you care about:

- **`dev_server_ready`** — `{ port, urls }`. The reliable "it's up, here's where"
  signal; use it instead of guessing the port or polling blindly.
- **`hmr_update`** — `{ file, modules }` per hot pass (a save took effect).
- **`hmr_error`** — `{ message, file, loc, plugin, frame, stack }` (ANSI-stripped)
  for overlay errors. Intercepted off Vite's client hot channel and **passed
  through untouched**, so the browser overlay still renders.
- **`vite_warn` / `vite_error`** — wrapped logger output (compile/transform fails).
  Distinct channel from HMR — not duplicates.

So the loop is: start → wait for `dev_server_ready` → make a change → check for
`hmr_update` (good) or `hmr_error`/`vite_error` (read the message/file/loc).

## Then actually exercise it

The dev server being up ≠ the change working. Drive the running app with the
browser tools (`claude-in-chrome` / `playwright-cli`) against the `dev_server_ready`
URL to confirm behavior, capture console/network, or screenshot.

## Notes

- This is the **collapsed-lead web surface** (the `inline` lane), per CLAUDE.md §10
  — the same lead the CLI/daemon target with more reach.
- For the **device** surface (APK, logcat, native plugin), use `/device`. Frontend
  changes reach the device via the deployed Worker (`server.url`), not the dev
  server — see the rebuild-vs-deploy table there.
- To ship what you built: `/ship`.
