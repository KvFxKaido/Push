# Push — Mobile AI Coding Agent

## Quick Start

### Web app

```bash
cd app
npm install
npm run dev
```

Run the Worker from the repo root in a second terminal:

```bash
npx wrangler dev --port 8787
```

### CLI

```bash
npm install
./push config init
./push
```

## Pointers

- [`docs/architecture.md`](docs/architecture.md) — tech stack, agent roles, key systems, repo/session model, delivery rules, and repo map
- [`docs/DESIGN.md`](docs/DESIGN.md) — visual tokens, colors, typography, and components
- [`AGENTS.md`](AGENTS.md) — startup contract for AI agents (provider routing, workflow rules)
- [`ROADMAP.md`](ROADMAP.md) — current product priorities
- [`docs/`](docs/) — decisions, runbooks, security policies, and archived references

## Notes

Keep `docs/architecture.md` as the detailed source of truth for architecture and operating model details. This file is a quick-start entry point. `AGENTS.md` carries the agent startup contract. `ROADMAP.md` carries priorities. If a new operational detail is needed, add it to `docs/` and point to it from here.
