# Push

[![Deploy Modal](https://github.com/KvFxKaido/Push/actions/workflows/deploy-modal.yml/badge.svg)](https://github.com/KvFxKaido/Push/actions/workflows/deploy-modal.yml)
[![CI](https://github.com/KvFxKaido/Push/actions/workflows/ci.yml/badge.svg)](https://github.com/KvFxKaido/Push/actions/workflows/ci.yml)

Mobile-native AI coding agent for developers who ship from anywhere.

Self-hosted, provider-flexible, and built to stay tied to real code — not a managed cloud.

## Why Push exists

Push is for the gap between "I need to check something quickly" and "I need a full desktop IDE session."

It gives you a chat-first workflow anchored to a real repo, real branch state, real diffs, and real execution. Explore code, review changes, run tasks in a sandbox, and ship from your phone or terminal — without locking yourself to a single model vendor or platform.

## What makes it different

- **Chat-first, repo-locked workflow** — context stays anchored to one repo and one active branch
- **Role-based agents** — Orchestrator, Explorer, Coder, Reviewer, Auditor
- **Self-hosted and provider-flexible** — use your own model stack instead of buying into one AI platform
- **Scratch workspaces** — prototype in an ephemeral sandbox without GitHub auth, export anytime
- **GitHub-native flow** — branch-aware chats, PR reviews, commit/push, and merge flow
- **Execution-first reliability** — safe reads, surgical edits, and checkpoints over model hype

## Who it's for

- Solo builders who ship away from their desk
- Developers who want real execution leverage, not just chat
- Anyone already paying for model providers who wants execution control
- Anyone who wants AI coding help without platform lock-in

## Quick orientation

- **Web app** — mobile-first repo chat, reviews, sandbox runs, and branch workflows
- **Android app (experimental)** — Capacitor wrapper around the web app for native Android testing and sideloaded debug builds
- **CLI** — local terminal use with interactive and headless task execution
- **Sandbox execution** — ephemeral Linux workspaces backed by Cloudflare Sandbox (default) or Modal, selected per-deploy via `PUSH_SANDBOX_PROVIDER`
- **Daemon-backed sessions (experimental)** — flag-gated Local PC and Remote modes drive a paired `pushd` through loopback or the Worker relay
- **GitHub-backed repo mode** plus **scratch workspace mode** when you don't need auth

## Repo map

- `app/` — web app, experimental Capacitor Android app, Cloudflare Worker, UI, hooks, and app logic (Cloudflare Sandbox handler lives in `app/src/worker/worker-cf-sandbox.ts`)
- `cli/` — local terminal agent, sessions, daemon, and terminal interface
- `sandbox/` — Modal sandbox backend (Python)
- `lib/` — shared logic used across app and CLI
- `docs/` — plans, design notes, and archived references

## Getting started

### Web app

```bash
cd app
npm install
npm run dev
```

In a second terminal from the repo root:

```bash
npx wrangler dev --port 8787
```

See [app/README.md](app/README.md) for environment variables, OAuth setup, Worker secrets, and sandbox deployment.

If you run the hosted web app on a personal Cloudflare account, see [Private Cloudflare Deployment](docs/runbooks/Private%20Cloudflare%20Deployment.md) before sharing the URL.

### Android app (experimental)

The Android app is currently a Capacitor shell for the production web bundle. It is useful for native WebView testing, OAuth checks, and sideloaded debug builds, but it is not yet treated as a release channel.

```bash
cd app
npm install
npm run android:sync
cd android
./gradlew installDebug
```

On Windows, run the Gradle wrapper as `.\gradlew installDebug` from `app\android`.

### CLI

```bash
npm install
./push config init
./push # full-screen TUI today; use PUSH_TUI_ENABLED=0 ./push for the transcript REPL
./push run --task "Implement X and run tests"
```

## Start here

- [ROADMAP.md](ROADMAP.md) — current product and engineering priorities
- [CONTRIBUTING.md](CONTRIBUTING.md) — project philosophy and contribution guidelines
- [AGENTS.md](AGENTS.md) — project context for AI collaborators
- [CLAUDE.md](CLAUDE.md) — quick start and entry points
- [docs/architecture.md](docs/architecture.md) — tech stack, agent roles, and key systems
- [cli/README.md](cli/README.md) — terminal workflows, config, and provider details
- [app/README.md](app/README.md) — frontend, Worker, and experimental Android setup

## Current direction

Push is actively improving CLI ergonomics, daemon-backed Local PC/Remote sessions, and the experimental Android app path. See [ROADMAP.md](ROADMAP.md) for what's next.

## License

MIT — see [LICENSE](LICENSE) for details.
