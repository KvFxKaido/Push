# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Push collapses the mobile dev stack — GitHub, terminal, CI, code, and AI — into a single conversation: a repo you run by chatting, not by juggling a dozen apps and browser tabs. It's a git tool with the feel of the everyday AI app you already live in. It spans three surfaces — a web app, an experimental Capacitor Android shell, and a local CLI — all sharing runtime contracts in root `lib/`. Roles remain an internal execution/capability model; user-facing surfaces render workflow phases through `lib/role-display.ts`. **Every surface targets the same single conversational lead** (the agent you talk to); the CLI/daemon is that same lead with *more reach* because it's local — real filesystem, real shell, persistent daemon, no sandbox limits — not a different interaction model. The web `inline` lane and CLI/TUI `lead-turn` lane are the collapsed lead paths today; detached/background runs and Explorer fan-out remain explicit tools for work that benefits from isolation. See [`docs/decisions/Agent Runtime Decisions.md`](docs/decisions/Agent%20Runtime%20Decisions.md) §10.

> Loader order is `PUSH.md` → `AGENTS.md` → `CLAUDE.md` → `GEMINI.md` (first found wins). `PUSH.md` is the Push-specific override when present; otherwise `AGENTS.md` carries the startup contract and overrides this file when they conflict. `ARCHITECTURE.md` is the canonical source of truth for architecture details.

## Quick start

### Web app + Worker

The repo is a **pnpm workspace** — one `pnpm install` at the root installs root + `app/` + `mcp/github-server` from a single `pnpm-lock.yaml`. There is no separate per-package install.

```bash
pnpm install                              # once, from the repo root — covers all three packages
pnpm --filter my-app run dev              # Vite on :5173, /api/* proxies to :8787
pnpm dlx wrangler dev --port 8787         # in a second terminal, from repo root
```

### CLI

```bash
pnpm install
./push config init        # interactive provider/model/key setup → ~/.push/config.json (chmod 0600)
./push                    # full-screen TUI today; PUSH_TUI_ENABLED=0 ./push for transcript REPL
./push run --task "..."   # headless single-task mode
```

### Android (experimental, debug-only)

```bash
cd app && pnpm run android:sync && cd android && ./gradlew installDebug
```

`app/android/` is **committed source** (it carries native customization — the `capacitor-native-git` JGit plugin wiring, core-library desugaring, the proguard fix). Build outputs and the regenerated web bundle are ignored by `app/android/.gitignore`. `cap sync` updates web assets + plugin registration; don't regenerate via `cap add android`.

## Validation commands

`AGENTS.md` declares the canonical commands; mirror them when wiring scripts:

```bash
# test:
TMPDIR=/tmp TEMP=/tmp TMP=/tmp pnpm run test:cli && pnpm run test:mcp:github
# typecheck:
pnpm run typecheck:all
# check:
pnpm run typecheck:all
```

Per-surface:

| Surface | Lint | Typecheck | Test | Build |
|---|---|---|---|---|
| Root (CLI + MCP wiring) | `pnpm run lint` (delegates to app ESLint) / `pnpm run format:check` (Biome format) | `pnpm run typecheck:all` | `pnpm run test:cli` | `pnpm run build:cli` |
| `app/` | `pnpm run lint` (ESLint) | `pnpm run typecheck` | `pnpm test` (vitest) / `pnpm run test:watch` | `pnpm run build` |
| `mcp/github-server/` | — | `pnpm run typecheck` | `pnpm test` | `pnpm run build` |

Run a single CLI test with `node --import tsx --import ./cli/tests/setup-test-home-isolation.mjs --test cli/tests/<name>.test.mjs`. The isolation import is not optional: `pnpm run test:cli` supplies it globally via `--import`, but a standalone invocation without it writes real session/memory state into `~/.push` (some test files, e.g. `daemon-integration.test.mjs`, also self-import it as a backstop — but don't rely on that for files that don't). Run a single app test with `cd app && npx vitest run path/to/file.test.ts`.

The TypeScript toolchain **typechecks with TS 7.0 GA (`7.0.2`) everywhere**, but the `app/` is still split by package because of ESLint. **`cli/` and `mcp/github-server` run `typescript@~7.0.2`** — both typecheck *and* emit (`build:cli`, MCP `build`) go through the native `tsc`. (`cli/` has no `package.json`; it compiles with the **root's** `typescript`.) **`app/` typechecks with the same GA `typescript@7.0.2`, installed under an alias** (`typescript-go: npm:typescript@~7.0.2`) and invoked as `node node_modules/typescript-go/lib/tsc.js`, while keeping **TS 6 (`typescript@^6.0.3`) for ESLint**. It can't collapse to a single `typescript@7` yet because TS 7.0 GA ships **no** programmatic API and `typescript-eslint` still hard-caps its `typescript` peer at `<6.1.0` (tracked upstream at [typescript-eslint#10940](https://github.com/typescript-eslint/typescript-eslint/issues/10940); blocked on the stable API in TS 7.1 **and** ESLint async-parser support — months out). The alias exists to dodge a `.bin/tsc` collision: GA `typescript@7` and the TS 6 copy both expose a `tsc` bin, so the app invokes GA's compiler by explicit path (`node …/lib/tsc.js`) instead of via `.bin`. Under pnpm the dual-major split needs **no override at all**: pnpm resolves per importer rather than hoisting into one flat tree, so `app/` sees its own `typescript@^6.0.3` while root and `mcp/` see `typescript@~7.0.2`, and the `typescript-go` alias still resolves to `7.0.2` (verified). npm needed an `overrides: { "typescript": "$typescript" }` in `app/package.json` purely to fight its own hoisting; that hack is gone. **Do not add a global `typescript` override to `pnpm-workspace.yaml`** — workspace overrides are root-global and would drag root/cli/mcp down to TS 6, breaking `build:cli` and the MCP build. When typescript-eslint supports TS 7, the app collapses the alias into a single `typescript@7` and the split goes away. App emit is `vite build` (esbuild/rollup); `tsc` only typechecks. `pnpm run typecheck:all` runs everything (cli/mcp via `tsc`, app via the aliased `tsc`). Fallback if the alias's native binary is missing (`--no-optional`, unsupported platform): from the repo root, typecheck the app with the root's GA compiler — `node node_modules/typescript/lib/tsc.js --noEmit -p app/tsconfig.app.json` (and `app/tsconfig.node.json`).

Biome formats the entire monorepo from the root config (`biome.json`); the linter is intentionally disabled there — ESLint runs only inside `app/`. Biome ignores `app/src/components/ui/**`, `sandbox/**`, and the standard build artifacts.

## Architecture

### Runtime roles and display vocabulary

The five internal roles — **Orchestrator**, **Explorer**, **Coder**, **Reviewer**, **Auditor** — and their responsibilities live once in [`ARCHITECTURE.md`](ARCHITECTURE.md#agent-roles-and-display-vocabulary) (the canonical source per this file's own deference to it). Don't restate the responsibility table here — the hand-copied duplicate had already drifted from ARCHITECTURE.md before this pointer replaced it.

Roles are locked internally and models are replaceable. Presentation is phase-first: Explorer/Coder normally render as "Exploring" / "Editing", Orchestrator source attribution renders as "Assistant", and Reviewer/Auditor keep names where independent attribution is useful. Do not hand-spell user-facing role labels; use `lib/role-display.ts`.

**Provider routing.** Settings holds defaults + the active backend pick. The current chat **locks** the Orchestrator provider/model on first send; delegated Coder and Explorer runs **inherit** that lock. Reviewer keeps its own sticky selection. Auditor follows the chat lock when present, else the active backend.

### Repo / session / branch model

- One **active branch** per repo session — the commit target, push target, and diff base. It is **mutable session state** that follows sandbox HEAD, not a fixed property of the chat.
- Chats are **repo-scoped**, not branch-scoped: a chat lists under its repo regardless of branch and **carries across branch switches** — the branch is `conv.branch`, mutable session state, so there's no per-branch chat to migrate to. Typed branch tools (`create_branch` / `switch_branch`) and the chat-resume path **preserve the sandbox** via `skipBranchTeardownRef` (`app/src/sections/WorkspaceSessionScreen.tsx`, `app/src/hooks/useWorkspaceSandboxController.ts`) — warm switch; a bare UI branch swap that bypasses them still restarts the sandbox (the desync guard — `stopSandbox()` on `current_branch` change). Resuming a chat warm-restores its saved branch. See [`docs/decisions/Repo-Scoped Chats — Branch as Session State.md`](docs/decisions/Repo-Scoped%20Chats%20—%20Branch%20as%20Session%20State.md).
- A `BranchSwitchPayload` (`kind: 'forked' | 'switched' | 'merged'`) **updates the active conversation's `conv.branch` in place** — it no longer migrates the chat or routes to a per-branch chat. `forked` / `merged` also append a passive `branch_forked` / `branch_merged` timeline moment; per-message `message.branch` stamps record write-time branch provenance. (The `'carried'` kind and the old migration machinery were removed in #1257 / #1258.)
- Branch ops are **tool-callable**: `create_branch` (forked) and `switch_branch` (switched). Long-form aliases `sandbox_create_branch` / `sandbox_switch_branch` still resolve.
- Raw `git checkout <branch>` / `git switch <branch>` (and `-b`/`-c`) are **blocked** in `sandbox_exec` regardless of approval mode — the issue is state sync, not consent. Both subcommands block any single bare positional operand except previous-branch shorthand (`git checkout -` / `git switch -`): for `git checkout` the syntax doesn't disambiguate branch from path (so `git checkout feat/foo` and `git checkout src/utils.ts` both block); for `git switch` (which is branch-only) the block forces branch ops through the typed tools so Push's tracked branch stays in sync with sandbox HEAD. File restores must use the explicit form — `git checkout -- <path>` or two-positional `git checkout HEAD <path>`. Ref expressions (`HEAD`, `HEAD~1`, `main^`, `branch@{upstream}`) pass through. `git branch -m`/`-M`/`--move` is blocked outright (`branch-rename`, no `allowDirectGit` escape) — renaming the checked-out branch would desync the tracked branch, and there's no typed rename; recipe: `create_branch` at the same commit, then delete the old name. Other `git branch` forms (list/create/delete/upstream) are unaffected. Use the typed tools when you know the operand is a branch.
- Foreground/background result split: foreground tools emit `branchSwitch` for the in-place branch-state update; background coder jobs emit `meta.branchCreated` / `meta.branchSwitched` for observability only.

### Delivery rules

- Web/cloud delivery uses **Gate-at-Push**: `sandbox_commit` is a silent local commit (pre-commit hook + auto-branch off main, no Auditor card), then `prepare_push` audits the cumulative push diff and returns the review card; direct `sandbox_push` also runs the push-time Auditor gate. CLI/daemon `git_commit` still uses the pre-commit Auditor gate. Required Auditor gates fail closed when unrunnable.
- Reviewer is advisory; **only PR-backed branch-diff reviews** can be posted back to GitHub.
- Standard merges go through the **GitHub PR flow** only — Push **never** runs local `git merge`.
- `Protect Main` may block direct commits to `main`.
- Remote **identity mutations** are **blocked** in `sandbox_exec` regardless of approval mode or `allowDirectGit` (`lib/git/policy.ts`, `remote-mutation`). This includes `git remote` mutation forms (`set-url` / `add` / `rename` / `remove` / `set-head` / `set-branches`) and equivalent `git config remote.*` / `git config url.*InsteadOf` repoints. The session's remote is fixed; repointing `origin` or its push URL would redirect an audited `prepare_push` to another repo while the destination pins (HEAD/branch/upstream ref) still match. Read-only forms (`git remote -v` / `show` / `get-url`, `git config --get remote.origin.url`) pass through.

### Shared runtime in root `lib/`

Cross-surface semantics live here and are consumed by both web and CLI. Don't re-implement them per surface — promote a per-surface helper into `lib/` the moment a second surface needs it. Examples already in `lib/`:

- `task-graph.ts`, `tool-dispatch.ts`, `tool-execution-runtime.ts`, `tool-protocol.ts`, `tool-registry.ts`
- `context-memory*` (store / retrieval / packing / invalidation), `working-memory.ts`, `role-memory-budgets.ts`
- `delegation-brief.ts`, `role-context.ts`, `runtime-contract.ts`, `run-events.ts`
- Internal role kernels: `coder-agent.ts`, `explorer-agent.ts`, `auditor-agent.ts`, `reviewer-agent.ts`, `deep-reviewer-agent.ts`
- `role-display.ts` (single source of truth for user-facing role / phase labels)
- `sandbox-provider.ts` (the abstraction Cloudflare and Modal both implement)
- `capabilities.ts` (shared capability tables — extend here, not per-surface)

The web app and CLI keep **shell-specific coordinators local** (e.g. `app/src/hooks/chat-*` for the web round loop, `cli/engine.ts` for the terminal loop). The target is a shared agent/runtime contract, not identical UX.

### Sandbox backend (pluggable)

Both backends implement `SandboxProvider` and route through the same `/api/sandbox/*` Worker endpoint. The selector is `PUSH_SANDBOX_PROVIDER` in `wrangler.jsonc`:

- **`cloudflare`** (default) — `Dockerfile.sandbox` + `app/src/worker/worker-cf-sandbox.ts` + `app/src/lib/cloudflare-sandbox-provider.ts`. Container, Durable Object binding, and `SANDBOX_TOKENS` KV are already provisioned in `wrangler.jsonc`; no extra deploy step beyond `wrangler deploy`.
- **`modal`** — `sandbox/app.py` (Python + FastAPI on Modal). Deploy with `cd sandbox && modal deploy app.py` and set `MODAL_SANDBOX_BASE_URL` via `wrangler secret put`.

### Tool protocol

Tool calls reach the dispatcher two ways: fenced/bare JSON in the model's `content` stream (the text-dispatch path), or — for native-function-calling providers — OpenAI-native `tool_calls` that `lib/openai-sse-pump.ts` flushes as structured `native_tool_call` events (`formatNativeToolCallFenced` still exists but is **legacy** compat for text-only callback surfaces, not the live flush). Native calls never enter `content`, so the text parser is short-circuited for them (`detectNativeToolCalls` in `chat-send.ts`). `lib/tool-call-parsing.ts` only scans `content`, **not** reasoning tokens — relevant when teaching models that emit thinking blocks. That boundary holds, but a model that buries its call in the reasoning channel (a documented Kimi K2.x habit) would otherwise dead-end silently; `lib/tool-call-recovery.ts` covers this with a bounded re-prompt nudge (`reasoningToolCallNudges`, cap `MAX_REASONING_TOOL_CALL_NUDGES`) that fires only when re-parsing the reasoning channel actually finds a buried call (not on every dead-end) and asks the model to re-emit it in `content` — recovery on top of the boundary, not a change to what the parser scans. **Per-turn budget:** read-only calls run in parallel (cap 6), pure file mutations run sequentially as one batch (cap 8), and at most one trailing side-effecting call (`sandbox_exec`, commit/push, delegation, workflow dispatch, etc.) is allowed. Ordering violations and extra side effects are rejected with structured errors. Web grouping lives in `app/src/lib/tool-dispatch.ts`; the shared CLI detection kernel lives in `lib/tool-dispatch.ts`.

### Surface-specific landmarks

- **Web app** (`app/src/` plus `app/worker.ts`): `hooks/chat-*` is the round loop and queue (`useChat.ts` is guarded by an ESLint `max-lines` rule — new feature hooks ship as sibling modules under `hooks/` or `lib/`, not appended here). `app/worker.ts` is the Cloudflare Worker entry; `app/src/worker/worker-cf-sandbox.ts` is the CF Sandbox handler. `components/ui/` is shadcn — Biome and contributors generally leave it alone.
- **CLI** (`cli/`): entry `cli.ts`, loop `engine.ts`, executor `tools.ts`, hashline edits `hashline.ts`, sessions `session-store.ts`, daemon `pushd.ts`. CLI auto-loads workspace skills from `.push/skills/*.md` and `.claude/commands/**/*.md` (nested paths flatten with hyphens).
- **MCP** (`mcp/github-server/`): the GitHub MCP server consumed in the chat layer. It has its own `package.json`, `tsconfig`, and test runner.

## Conventions

### Behavior lives in code, not prompts

If a prompt change is compensating for something the runtime *should* handle (validation, routing, safety, correctness), **fix the runtime instead**. Prompts are guidance for cooperating models — not a control plane. Legitimate prompt/doc updates: surfacing hard runtime boundaries (e.g. that the parser ignores reasoning tokens), clarifying role contracts, or documenting quirks models can't infer. Test: if a non-cooperating model could break it, the fix belongs in code.

### Capability sourcing: fold in, don't outsource

Build capabilities into shared `lib/` as first-party tools; don't pull in a third-party MCP server for functionality Push could own. The boundary that decides which is which:

- **Runtime-contract capabilities** — git, shell, fs, code, CI, AI, GitHub-as-repo-backend → **fold in, always.** These *are* the stack Push collapses into one conversation; owning them is the thesis. `lib/github-tool-core.ts` is the template: the capability lives in shared `lib/` (reused by the web Worker, the CLI, and our own `mcp/github-server`), built to close the gap against the official GitHub MCP rather than consume it. Own the core, optionally publish the adapter, never depend on someone else's.
- **External-product integrations** — Notion, Linear, Slack, Stripe → **don't fold in.** Re-implementing an API surface that isn't Push's domain means owning its maintenance on someone else's release schedule — the one job MCP legitimately does. GitHub straddles the line but leans *core* (the repo **is** the runtime), so folding it in was right.

Test: is this capability part of the stack Push *is* (fold in), or an integration to a product it merely talks to (leave it for MCP)?

**MCP, when it lands, is CLI-scoped.** A folded-in tool is *governed* — capability gating, the role-filter, the Auditor gate, the per-turn side-effect budget, structured logs. An MCP tool on the web/cloud surface is ungoverned reach outside the runtime contract: acceptable on the CLI (user owns the machine, sole-user trust), a governance hole on a deployed multi-user surface. MCP attach is therefore CLI-only and scoped to the attached tools — also the only place tool **deferral** would earn its keep. The first-party catalog is small enough to eager-load (~3k tokens across ~68 tools) and never needs progressive disclosure; a long tail of user-attached MCP tools (mostly irrelevant per turn) would. See **Tool protocol** above for the eager-load surface.

### Symmetric structured logs

When a runtime function has multiple early-exit paths that change observable behavior, emit a structured log line on each branch — not just the loud-failure one. Anything callers can't distinguish from "still in progress" is invisible to ops until you add the log.

Canonical shape is `console.log(JSON.stringify({ level, event, ...ctx }))` with one line per branch; pick event names that pair semantically (success ↔ failure ↔ cap-hit). The resume path in `app/src/worker/coder-job-do.ts` is the established example:

- `coder_checkpoint_captured` ↔ `coder_checkpoint_failed`
- `coder_job_resumed` ↔ `coder_resume_restore_failed` ↔ `coder_resume_cap_exhausted` ↔ `coder_resume_no_checkpoint` ↔ `coder_resume_state_parse_failed`

**Stream choice is surface-dependent.** `console.log` is the canonical sink for worker/web code, where stdout is the logging pipeline. But a shared `lib/` module that also runs on the **CLI must emit to `console.error`** — CLI stdout is reserved for user output and `--json` payloads, so a structured log on stdout corrupts them. Shape and event-pairing are identical; only the stream changes. Precedent: `lib/git/repo-lock.ts`, `lib/context-memory.ts`, `lib/verbatim-retain.ts`.

In-band with the change that introduces the silent path — not as a follow-up. Silent returns shipped at PR-merge time become an "untriaged runtime degradation" the next person paying attention has to root-cause.

### Decision-doc discipline

When you ship something specified in `docs/decisions/`, **flip that doc's `Status:` field in the same PR**. Don't leave specs at "Draft" while the code has landed. See `docs/decisions/README.md` for the label vocabulary (Current / Historical / Draft / Reference / Superseded by `<doc>` / Merged into `<doc>`).

### New feature checklist (cross-surface work)

Three guardrails from the 2026-04 Big Four extraction; apply before adding cross-surface features:

1. **Storage: scope keys CLI-first.** Durable identifiers (`repoFullName + branch`) beat per-session ones. Web `chatId` is durable but CLI `sessionId` is per-run, so chatId-shaped keys break cross-run retrieval on CLI. If both surfaces touch the store, put the scope resolver in `lib/` from day one (see `lib/role-memory-budgets.ts` as the shape to follow).
2. **Background tasks: name the coordinator's home first.** State + callback clusters need an owning module **before the first line of code**. If the owner isn't obvious in one sentence, the coordinator silently lands in `useChat.ts`. Ship feature hooks as siblings under `app/src/hooks/` or `app/src/lib/`; the `max-lines` ESLint guard on `useChat.ts` enforces this in CI.
3. **Web/CLI communication: one source of truth per vocabulary.** Any new tool, event, or envelope type needs a single canonical definition **and a drift-detector test in the same PR**. Tool-protocol drift uses `cli/tests/daemon-integration.test.mjs` (prompt-vs-capability sync); event/envelope drift uses `cli/tests/protocol-drift.test.mjs` (strict-mode schema pins). Extend `lib/capabilities.ts` for shared capability tables and `lib/protocol-schema.ts` strict mode for envelopes.

### PR self-review pass

Before opening a PR (or pushing a review-response commit), walk the diff through these checks. Each one corresponds to a class of bug bot reviewers (Copilot, Codex, Kilo) have caught more than once on this repo, so shifting them left saves a ~30-min review cycle. These same classes are mirrored (reviewer-framed) in `REVIEW.md`'s "Recurring defect classes" — which the in-app and autonomous reviewers load at runtime — so **edits here should be reflected there, and vice versa.**

**Execute the claim; do not inspect it.** This rule governs the list, because a self-review is the same mind that wrote the diff — the confirmation bias is *inside* the loop, and re-reading your own code is the one method guaranteed not to escape it. So turn every assertion the diff makes into a command you actually run:

- If the change claims a **tool or format accepts its output** — run that tool. `git apply` the diff you generated. Parse the JSON you emit. Curl the endpoint. (#1474 shipped a "unified diff" with no `@@` headers that `git apply` rejects outright; the claim went in a PR body without ever being run.)
- If the change claims **a path is wired** — call it from the *real* caller, not the helper. Then break the wiring and watch the test go red. **A test you have never seen fail is a test of nothing**, and a test that exercises a helper the production entry point cannot reach is worse: it is a green light on dead code.
- If the change claims **a mechanism** ("EBUSY means a leaked handle") — reproduce the mechanism in ten lines before scoping the fix. An inferred mechanism scales the blast radius of being wrong: #1471's real cause was a live child's *cwd*, and the inferred one produced a proposed 197-site sweep for a 3-site bug.

Naming a failure mode in a comment is not the same as having checked for it. Several defects below shipped in PRs whose own commit message described that exact defect class.

- **HTTP status classification.** Every `if (status >= 400)` arm should enumerate the cases (auth, rate-limit, not-found, validation) and assign each a sensible `structuredError.type` / surface code. Default fallbacks to "everything is sandbox loss" or "everything is unknown" are bugs (see PR #656's rate-limit misclassification).
- **`await` in a loop.** Every `await` inside a `for`/`while` should prove it can exit on terminal conditions (deadlines, abort signals, event-completion races) — not just on the happy path. A naked `await promiseThatOnlyResolvesOnSuccess` is a hang waiting to happen (see PR #657's `prompt_snapshot` race fix).
- **Fire-and-forget IIFEs / promises.** `(async () => { ... })()` and `someFn().catch(() => {})` swallow errors silently. Prove the returned promise is awaited somewhere or the failure mode is acceptable. If not acceptable, surface the error via `warn()` / structured log (see PR #657's `startTailToFile.ready` fix).
- **Silent return paths.** Any `return null` / `return` / `return false` from a runtime function that callers can't distinguish from "still in progress" gets a structured log line in the same change (see Symmetric structured logs above).
- **Config-file changes.** Grep new diffs in `wrangler.jsonc`, `*.yml`, `.env*`, anything in `secrets/` for account IDs, slugs, tokens, or hardcoded URLs that should be secrets or dashboard vars. The public repo has bitten this — committed account-bound identifiers in `wrangler.jsonc` belong in the secret store, dashboard vars, or `.dev.vars`.
- **Error-formatting paths.** Confirm upstream content (HTTP bodies, stderr, exec output) isn't passed through to the UI verbatim — wrap or escape. Past HTML-leak regressions shipped because raw upstream JSON ended up rendered.
- **Auth / allowlist seams.** New endpoints or auth gates: trace at least one denied path AND one allowed path end-to-end. When a PR gates a security-sensitive resource on one path, grep every other path that touches the same resource — bots have caught the asymmetry on every PR where the author only traced one side.
- **Text-edit primitive boundary cases.** When a change touches a text-editing primitive (hashline, the line model, content (de)serialization), treat normalization as lossy-by-default: only canonicalize when the file *proves* a single convention — mixed state is data, not a mandate, and a one-line edit must produce a one-line diff. Walk these inputs explicitly — empty file; single line with no trailing newline; exactly one vs. multiple trailing newlines; all content deleted → empty; a blank line surviving a sibling's deletion; an edit on the last line (EOF); and uniform-LF / uniform-CRLF / mixed-ending files. Each is a distinct serialization path that first-pass tests routinely miss (the #1089–#1093 hashline arc cost four review rounds, one boundary case each).
- **Hidden-but-interactive UI.** A visually-hidden control still receives input unless hit-testing is disabled too. `opacity-0` (and `transform`) leave the element in layout and *clickable* — so a hidden action row fires its buttons on a blind tap, and a long-press starting over it can reveal-and-click in one gesture. Anything hidden-until-hover/reveal must gate `pointer-events` (`-none` at rest, `-auto` only when shown) or use `visibility`/unmount, which do stop hit-testing. The hover→long-press touch idiom in `DESIGN.md` carries this requirement (the #1132 Codex P2).
- **Unreachable from the real caller.** A helper can be correct, fully tested, and *impossible to reach from production*. Its unit tests stay green because they call it directly, so nothing anywhere goes red. Two shapes, both shipped: a function with **zero production callers** (`osc52Copy` — written, unit-tested, never wired, and it looked done from the inside *because its own tests passed*), and a function whose **only caller filters it out** (#1474's `copyLastResponse` selected `kind === 'message'` rows, making every diff/card branch of the module dead code). For any new behavior, name the production entry point and write the test against **that**, not the helper. If you cannot name the caller, you have not finished.
- **Unit-of-measure at an encoding boundary.** Bytes, characters (UTF-16 code units), and code points are three different numbers, and a check that uses the wrong one fails *silently* — the value passes, the wire payload doesn't. `String#length` is not a byte count: 48k CJK characters are ~144KB of UTF-8 (#1474 capped an OSC 52 payload by string length, so oversized non-ASCII sailed past the guard with `truncated: false`, got dropped by the terminal, and reported success). Cap at the boundary the *consumer* measures — bytes for a wire protocol, code points for a cut (slicing at a byte-derived index severs surrogate pairs). Same family as the text-edit boundary cases above.

Not exhaustive; encode new patterns here when a review catches the same class twice.

### Project instructions loading

Loader order is `PUSH.md` → `AGENTS.md` → `CLAUDE.md` → `GEMINI.md` (first found wins). `PUSH.md` is the Push-specific override and applies on both surfaces. Acquisition returns raw content through the shared resolver (`lib/project-instructions-source.ts`); injection-time sanitization in `lib/project-instructions.ts` applies the default **8,000 char** cap and delimiter escaping. The web fetches via GitHub REST before the sandbox exists, then re-reads from the sandbox once ready; the CLI injects the same `[PROJECT_INSTRUCTIONS]` block alongside a workspace snapshot (git branch, dirty files, top-level tree, manifest summary).

## Pointers

- [`AGENTS.md`](AGENTS.md) — startup contract; **read this first**, it overrides this file
- [`ARCHITECTURE.md`](ARCHITECTURE.md) — canonical architecture, tool protocol, repo/session model
- [`DESIGN.md`](DESIGN.md) — visual tokens, colors, typography, components
- [`cli/README.md`](cli/README.md) — CLI surfaces, providers, env vars, tools, sessions
- [`cli/architecture.md`](cli/architecture.md) — CLI runtime layers
- [`app/README.md`](app/README.md) — frontend, Worker secrets, sandbox backend selection, Android
- [`docs/decisions/`](docs/decisions/) — design decisions with `Status:` lifecycle
- [`docs/runbooks/`](docs/runbooks/), [`docs/security/`](docs/security/) — ops + provider usage policies
- [`ROADMAP.md`](ROADMAP.md) — current product priorities
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — philosophy, what fits, what may be declined
