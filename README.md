# Push

[![Deploy Modal](https://github.com/KvFxKaido/Push/actions/workflows/deploy-modal.yml/badge.svg)](https://github.com/KvFxKaido/Push/actions/workflows/deploy-modal.yml)
[![CI](https://github.com/KvFxKaido/Push/actions/workflows/ci.yml/badge.svg)](https://github.com/KvFxKaido/Push/actions/workflows/ci.yml)

**Push is one agent attached to your repo.** Talk to it from your phone or your terminal — same conversation, same branch. The pushed branch is the source of truth; the sandbox, the tab, and the daemon are all disposable views of it.

Self-hosted, provider-flexible, and built to stay tied to real code — not someone else's managed AI cloud.

## Why Push exists

Push is for the gap between "I need to check something quickly" and "I need a full desktop IDE session."

It gives you a chat-first workflow anchored to a real repo, real branch state, real diffs, and real execution. Explore code, review changes, run tasks in a sandbox, and ship from your phone or terminal — without locking yourself to a single model vendor or platform.

On a phone especially, running a repo normally means bouncing between the GitHub app, a terminal, a CI dashboard, a code viewer, and a separate AI chat. Push is all of that in one place you can talk to — the git tool that feels like the AI app you already use.

## What makes it different

- **One surface, not a tab graveyard** — git, GitHub, CI, code, and AI in a single conversation
- **Chat-first, repo-locked workflow** — context stays anchored to one repo and one active branch
- **One capable agent, not a relay** — a single lead reads, edits, runs, and ships in one loop; pulls in read-only investigation or independent review only when it earns its keep
- **Self-hosted and provider-flexible** — use your own model stack instead of buying into one AI platform
- **Scratch workspaces** — prototype in an ephemeral sandbox without GitHub auth, export anytime
- **GitHub-native flow** — repo-scoped chats, active-branch state, PR reviews, commit/push, and merge flow
- **Execution-first reliability** — safe reads, surgical edits, and checkpoints over model hype

## Who it's for

- Solo builders who ship away from their desk
- Developers who want real execution leverage, not just chat
- Anyone already paying for model providers who wants execution control
- Anyone who wants AI coding help without platform lock-in

## Privacy & control

Push runs on **your** infrastructure against **your** provider keys — your own Cloudflare (or Modal) account, your own model accounts. Nothing phones home to us; there is no managed Push cloud in the loop. The only usage analytics is an optional provider-stats endpoint that stays inside your own Cloudflare Analytics Engine, gated behind an admin token you set.

## How it fits together

```
  Web app  ─┐                          ┌─▶  Sandbox  (Cloudflare Sandbox · Modal)
  Android  ─┴─▶  Cloudflare Worker  ───┤
 (Capacitor)      API · auth · relay   └─▶  GitHub  (repo-scoped chats · PRs · commits)

  CLI · pushd  ─▶  your machine: real shell + filesystem
                   (optionally pairs via the Worker relay for Remote sessions)
```

The web and Android surfaces broker through the Cloudflare Worker to a sandbox and to GitHub; the CLI is the same lead running locally with more reach — real shell and filesystem — and pairs through the Worker relay only for Remote sessions.

## Quick orientation

- **Web app** — mobile-first repo chat, reviews, sandbox runs, and branch workflows
- **Android app (experimental)** — Capacitor wrapper around the web app for native Android testing and sideloaded debug builds
- **CLI** — local terminal use with interactive and headless task execution
- **Sandbox execution** — ephemeral Linux workspaces backed by Cloudflare Sandbox (default) or Modal, selected per-deploy via `PUSH_SANDBOX_PROVIDER`
- **Daemon-backed sessions (experimental)** — a flag-gated Remote mode drives a paired `pushd` through the Worker relay
- **GitHub-backed repo mode** plus **scratch workspace mode** when you don't need auth

## Repo map

- `app/` — web app, experimental Capacitor Android app, Cloudflare Worker, UI, hooks, and app logic (Cloudflare Sandbox handler lives in `app/src/worker/worker-cf-sandbox.ts`)
- `cli/` — local terminal agent, sessions, daemon, and terminal interface
- `sandbox/` — Modal sandbox backend (Python)
- `lib/` — shared logic used across app and CLI
- `docs/` — plans, design notes, and archived references

## Getting started

### Web app

The repo is a pnpm workspace — one install at the root covers the CLI, the web app, and the MCP server.

```bash
pnpm install                    # from the repo root
pnpm --filter my-app run dev    # Vite on :5173
```

In a second terminal from the repo root:

```bash
pnpm dlx wrangler dev --port 8787
```

See [app/README.md](app/README.md) for environment variables, OAuth setup, Worker secrets, and sandbox deployment.

A full web deployment needs your own Cloudflare account (Workers Paid), a GitHub App, and at least one model provider. [Deployment Requirements](docs/runbooks/Deployment%20Requirements.md) is the canonical provisioning checklist.

If you run the hosted web app on a personal Cloudflare account, see [Private Cloudflare Deployment](docs/runbooks/Private%20Cloudflare%20Deployment.md) before sharing the URL.

### Android app (experimental)

The Android app is currently a Capacitor shell for the production web bundle. It is useful for native WebView testing, OAuth checks, and sideloaded debug builds, but it is not yet treated as a release channel.

```bash
pnpm install                            # from the repo root
pnpm --filter my-app run android:sync
cd app/android
./gradlew installDebug
```

On Windows, run the Gradle wrapper as `.\gradlew installDebug` from `app\android`.

### CLI

```bash
pnpm install
./push config init
./push # full-screen TUI today; use PUSH_TUI_ENABLED=0 ./push for the transcript REPL
./push run --task "Implement X and run tests"
```

## Start here

- [`docs/decisions/`](docs/decisions/) — the live decision + priority surface (each doc carries a `Status:`)
- [CONTRIBUTING.md](CONTRIBUTING.md) — project philosophy and contribution guidelines
- [AGENTS.md](AGENTS.md) — project context for AI collaborators
- [CLAUDE.md](CLAUDE.md) — quick start and entry points
- [ARCHITECTURE.md](ARCHITECTURE.md) — tech stack, agent roles, and key systems
- [cli/README.md](cli/README.md) — terminal workflows, config, and provider details
- [app/README.md](app/README.md) — frontend, Worker, and experimental Android setup

## Current direction

Push's active direction is collapsing its internal multi-agent scaffolding onto a **single conversational lead** that behaves the same on every surface (web, terminal, daemon) and differs only in reach; making the **pushed branch the durable source of truth** so nothing lands on `main` unaudited and the sandbox stays disposable compute; and hardening **session continuity** between the terminal and the phone. See [`docs/decisions/`](docs/decisions/) for the live decision surface and near-term priorities.

## Contributors

Push is a solo project, built with heavy use of AI coding tools. Some accounts in the contributor list are AI/bots — co-author trailers on commits and automation (CI, review bots) — not separate human maintainers.

## Acknowledgements

Push stands on the shoulders of a few open projects:

- [**transitions.dev**](https://transitions.dev) — Jakub Antalík's motion recipes and five-axis token system, which Push's design-system motion tokens and primitives (`app/src/index.css`, see [DESIGN.md](DESIGN.md)) are translated from.
- [**models.dev**](https://models.dev) — the open model/provider catalog whose logos back the provider icons across Push's settings and model pickers.
- [**Streamdown**](https://streamdown.ai) — Vercel's streaming-markdown renderer, adapted in `PushMarkdownRenderer` to drive Push's chat prose with its own reveal cadence and Shiki-themed code chrome.
- [**silvery**](https://github.com/beorn/silvery) — Bjørn Stabell's retained-mode terminal compositor and React renderer, the view layer of Push's entire full-screen TUI. The only candidate of an eleven-project survey to clear every contract Push's own build plan had specified — so Push adopted it instead of building.
- [**giggles**](https://github.com/zion-off/giggles) — zion-off's batteries-included terminal React framework, two of whose designs Push borrowed as patterns (not code): the focus-scope key-ownership model (`cli/tui-focus.ts`) and the terminal handoff/reclaim flow (`cli/tui-handoff.ts`).

## License

Push's original code is MIT licensed; see [LICENSE](LICENSE).

Third-party or derived portions may carry their own permissive license terms and
attribution requirements. See [NOTICE](NOTICE) and `third_party/licenses/` for
any included third-party notices and license texts.
