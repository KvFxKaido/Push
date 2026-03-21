# Push

[![Deploy Modal](https://github.com/KvFxKaido/Push/actions/workflows/deploy-modal.yml/badge.svg)](https://github.com/KvFxKaido/Push/actions/workflows/deploy-modal.yml)
[![CI](https://github.com/KvFxKaido/Push/actions/workflows/ci.yml/badge.svg)](https://github.com/KvFxKaido/Push/actions/workflows/ci.yml)

Push is a mobile-first AI coding notebook with role-based agents for chatting with a repo, reviewing changes, and shipping code from your phone or terminal.

## Quick orientation

- Chat-first workflow with repo-locked context
- Role-based agents: Orchestrator, Explorer, Coder, Reviewer, Auditor
- Web app plus local CLI/TUI
- Scratch workspaces when you do not want GitHub auth
- PR-based merge flow for repo work

## Start here

For the detailed architecture, workflow, and operating notes, read [CLAUDE.md](CLAUDE.md).

For the CLI, see [cli/README.md](cli/README.md).

## Getting started

```bash
cd app
npm install
npm run dev
```

For local auth/sandbox routes, run the Worker in a second terminal:

```bash
npx wrangler dev --port 8787
```

## License

MIT — see [LICENSE](LICENSE) for details.
