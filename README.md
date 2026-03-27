# Push

[![Deploy Modal](https://github.com/KvFxKaido/Push/actions/workflows/deploy-modal.yml/badge.svg)](https://github.com/KvFxKaido/Push/actions/workflows/deploy-modal.yml)
[![CI](https://github.com/KvFxKaido/Push/actions/workflows/ci.yml/badge.svg)](https://github.com/KvFxKaido/Push/actions/workflows/ci.yml)

Mobile-native AI coding agent for developers who ship from anywhere.

Self-hosted. Provider-flexible. Built for repo-grounded execution.

## Why Push exists

Push is for the gap between "I need to check something quickly" and "I need a full desktop IDE session."

It gives you a chat-first workflow that stays tied to a real repo, real branch state, real diffs, and real execution. You can explore code, review changes, run tasks in a sandbox, and ship from your phone or terminal without locking yourself to a single model vendor or managed platform.

## What makes it different

- **Chat-first, repo-locked workflow** — context stays anchored to one repo and one active branch
- **Role-based agents** — **Orchestrator**, **Explorer**, **Coder**, **Reviewer**, **Auditor**
- **Self-hosted and provider-flexible** — use your own model stack instead of buying into one AI platform
- **Scratch workspaces** — start without GitHub auth, prototype in an ephemeral sandbox, export anytime
- **GitHub-native flow** — branch-aware chats, PR reviews, commit/push, and merge flow
- **Harness-first reliability** — safe reads, surgical edits, checkpoints, and execution quality over model hype

## Who it's for

- Solo builders shipping away from their desk
- Developers who want mobile-native leverage, not just mobile access
- Teams or individuals already paying for model providers and wanting execution control
- People who want AI coding help without platform lock-in

## Quick orientation

- **Web app** for mobile-first repo chat, reviews, sandbox runs, and branch workflows
- **CLI** for local terminal use with interactive and headless task execution
- **Modal sandbox** for ephemeral Linux workspaces and code execution
- **GitHub-backed repo mode** plus **scratch workspace mode** when you do not want auth

## Repo map

- `app/` — web app, Cloudflare Worker, UI, hooks, and app logic
- `cli/` — local terminal agent, sessions, daemon, and terminal UX work
- `sandbox/` — Modal sandbox backend
- `lib/` — shared logic used across app and CLI
- `documents/` — plans, design notes, and archived references

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

See [app/README.md](app/README.md) for environment variables, OAuth setup, Worker secrets, and Modal sandbox deployment.

### CLI

```bash
npm install
./push config init
./push
./push run --task "Implement X and run tests"
```

## Start here

- [ROADMAP.md](ROADMAP.md) — current product and engineering priorities
- [AGENTS.md](AGENTS.md) — project context for AI collaborators
- [CLAUDE.md](CLAUDE.md) — architecture, workflows, and operating notes
- [cli/README.md](cli/README.md) — terminal workflows, config, and provider details
- [app/README.md](app/README.md) — frontend environment and Worker setup

## Current direction

Push is currently focused on transcript-first CLI ergonomics, attach/resume behavior, and TUI-lite improvements rather than a ground-up full-screen TUI rewrite. See [ROADMAP.md](ROADMAP.md) for the canonical plan.

## License

MIT — see [LICENSE](LICENSE) for details.
