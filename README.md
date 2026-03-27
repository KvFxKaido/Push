# Push

[![Deploy Modal](https://github.com/KvFxKaido/Push/actions/workflows/deploy-modal.yml/badge.svg)](https://github.com/KvFxKaido/Push/actions/workflows/deploy-modal.yml)
[![CI](https://github.com/KvFxKaido/Push/actions/workflows/ci.yml/badge.svg)](https://github.com/KvFxKaido/Push/actions/workflows/ci.yml)

Push is a mobile-first AI coding notebook with role-based agents for chatting with a repo, reviewing changes, and shipping code from your phone or terminal.

## Quick orientation

- **Chat-first repo workflow** with repo-locked context and branch-scoped chats
- **Role-based agents**: **Orchestrator**, **Explorer**, **Coder**, **Reviewer**, **Auditor**
- **Web app** plus **local CLI** with interactive, headless, and experimental TUI flows
- **Modal sandbox** for ephemeral Linux workspaces and code execution
- **Scratch workspaces** when you do not want GitHub auth
- **PR-based GitHub flow** for repo work
- **Current terminal focus**: transcript-first CLI ergonomics and TUI-lite improvements, not a ground-up full-screen TUI rewrite

## Repo map

- `app/` — web app, Worker, UI, hooks, and app logic
- `cli/` — local terminal agent, sessions, daemon, and TUI
- `sandbox/` — Modal sandbox backend
- `lib/` — shared logic used by app and CLI
- `documents/` — plans, design notes, and archived references

## Getting started

### Web app

```bash
cd app
npm install
npm run dev
```

In a second terminal from the repo root, run the Worker for local auth and sandbox routes:

```bash
npx wrangler dev --port 8787
```

See [app/README.md](app/README.md) for environment variables, OAuth setup, Worker secrets, and Modal sandbox deployment.

### CLI

The CLI launcher depends on root-level dev dependencies, so install them once from the repo root:

```bash
npm install
./push config init
./push
./push run --task "Implement X and run tests"
```

If you want the transcript-first REPL instead of the current TUI launcher default, run `PUSH_TUI_ENABLED=0 ./push`.

## Start here

- [CLAUDE.md](CLAUDE.md) — canonical architecture, workflow, and operating notes
- [cli/README.md](cli/README.md) — terminal workflows, sessions, daemon, config, and provider details
- [app/README.md](app/README.md) — frontend environment and Worker setup
- [ROADMAP.md](ROADMAP.md) — current product and engineering priorities

## License

MIT — see [LICENSE](LICENSE) for details.
