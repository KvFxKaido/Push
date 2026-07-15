# Push CLI

Local coding agent for your terminal. Push ships three terminal surfaces: an interactive REPL, headless runs, and a retained-mode Silvery full-screen TUI. It uses the same role-based agent architecture as the Push mobile app, but operates directly on your filesystem.

## Pointers

- [`architecture.md`](architecture.md) — CLI-specific architecture, runtime layers, and terminal surfaces
- [`DESIGN.md`](DESIGN.md) — CLI/TUI presentation guidance and terminal design principles
- [`../ARCHITECTURE.md`](../ARCHITECTURE.md) — shared Push architecture and operating model
- [`../DESIGN.md`](../DESIGN.md) — graphical app visual system

## Quick start

```bash
# From repo root
pnpm install
./push config init
PUSH_TUI_ENABLED=0 ./push
./push tui
./push run --task "Implement X and run tests"

# Or with Node directly
node --import tsx cli/cli.ts
```

> **Requires Node ≥24.** The Push CLI targets Node 24 — the declared root `engines` floor,
> and the only version CI covers. Silvery 0.21 ships `using` syntax older Node cannot parse, so
> the full-screen TUI fails fast with a clear message below 24 (`nvm use 24`). Bun single-binary
> builds bundle the same Silvery surface; only Silvery's unused optional terminal adapters remain
> external to the binary.

On Windows, use `.\push.cmd` from `cmd.exe`, PowerShell, or Windows Terminal:

```powershell
.\push.cmd config init
$env:PUSH_TUI_ENABLED = "0"
.\push.cmd
.\push.cmd tui
```

`./push config init` walks you through provider, model, API key, and sandbox settings using numbered menus (with free-text fallback). Config is saved to `~/.push/config.json` (mode 0600).

### Single binary

The CLI (daemon included) compiles to a self-contained executable with [Bun](https://bun.sh) — no Node, tsx, or `node_modules` on the target machine:

```bash
bun build --compile --no-compile-autoload-dotenv --no-compile-autoload-bunfig cli/cli.ts --outfile push-bin
./push-bin                     # same surface: tui, run, daemon, …

# Cross-compile from any host:
bun build --compile --no-compile-autoload-dotenv --no-compile-autoload-bunfig --target=bun-windows-x64 cli/cli.ts --outfile push.exe
bun build --compile --no-compile-autoload-dotenv --no-compile-autoload-bunfig --target=bun-darwin-arm64 cli/cli.ts --outfile push-macos
```

Both flags are load-bearing, not cosmetic. A compiled binary otherwise
autoloads, from whatever directory it runs in, ahead of `~/.push/config.json`
hydration and the subprocess env scrub:

- `--no-compile-autoload-dotenv` — `.env` / `.env.local`, injecting
  repo-controlled values into the CLI's own `process.env` (provider keys,
  `PUSH_*` flags).
- `--no-compile-autoload-bunfig` — `bunfig.toml`, whose `preload` runs
  **arbitrary code before the CLI starts**. This is remote code execution
  from a repo-local file, not just env injection — the more severe of the
  two.

Caveats: binaries are ~100 MB (embedded Bun runtime), and local embeddings (`@huggingface/transformers`, a native optional dependency) can't be embedded — they resolve from `node_modules` at runtime when present, else the standard optional-dep fallback applies. CI smoke-tests the compiled binary on Linux and Windows (`cli-binary` job). Background and rejected alternative (a Go rewrite): [`docs/decisions/Go Migration Assessment.md`](../docs/decisions/Go%20Migration%20Assessment.md).

### Running the dev tree under Bun

Bun executes TypeScript natively, so the interpreter path works without the
tsx loader:

```bash
pnpm run dev:cli:bun            # bun --no-env-file cli/cli.ts — same surface as dev:cli
```

`--no-env-file` keeps this path symmetric with the Node dev script and the
compiled binary: without it, Bun's interpreter auto-loads `.env` / `.env.local`
from cwd into `process.env` ahead of `applyConfigToEnv()` and the env scrub.
(Bun has no runtime flag to disable `bunfig.toml` autoload, but the dev path
runs in the trusted Push checkout, not an arbitrary user repo — the
distributed-binary threat model the compile flags address does not apply here.)

Node (`pnpm run dev:cli`) remains the canonical dev path, and **tests stay on
`node --test`**: Bun's `node:test` shim can't run this suite yet
(`describe()` support, [oven-sh/bun#5090](https://github.com/oven-sh/bun/issues/5090)
— 137 of 824 tests fail under `bun test` as of Bun 1.3.11). Because tests run
on Node, code under `cli/` must not call `Bun.*` APIs directly; adoption
status and sequencing live in
[`docs/decisions/Bun Runtime Adoption.md`](../docs/decisions/Bun%20Runtime%20Adoption.md).

## Modes

### Interactive REPL (transcript-first CLI)

```bash
PUSH_TUI_ENABLED=0 ./push
PUSH_TUI_ENABLED=0 ./push --provider openrouter --model anthropic/claude-sonnet-4.6:nitro
PUSH_TUI_ENABLED=0 ./push --session sess_abc123     # resume a previous session by id
PUSH_TUI_ENABLED=0 ./push --no-resume-prompt        # skip the resume-or-new prompt
```

With TUI disabled, this starts the transcript-first REPL. When resumable sessions exist for the current workspace (matched by cwd), bare `./push` prints a numbered picker of those sessions with an `n=new` choice so you can pick up where you left off without typing a second command. `--session <id>` skips the picker (explicit resume), `--no-resume-prompt` skips the picker and starts a new session, and if no sessions exist for this cwd the picker is silent. Cross-cwd resume is still available via `./push resume`. The agent streams responses, executes tools, and loops until it's done or you type `/exit`. High-risk commands (`rm -rf`, `sudo`, force-push, etc.) prompt for approval before running, with one-shot, session-trust, and saved-prefix trust options.

Set `PUSH_TUI_ENABLED=0` in your shell to make the REPL the default for every invocation. The variable is honored by every code path, including the `tui` subcommand — so if you've exported `PUSH_TUI_ENABLED=0` persistently and want to launch the TUI for a single session, temporarily override it: `PUSH_TUI_ENABLED=1 ./push tui` (or unset the variable for that one shell).

### TUI (default)

```bash
./push
./push --session sess_abc123
./push tui
```

Bare `./push` and `./push --session` open the full-screen TUI by default. The default lives in `cli/cli.ts` now, so direct `node cli/cli.ts` and `pnpm run`-style invocations get the same UX as `./push`. Set `PUSH_TUI_ENABLED=0` (or `false`) to opt back to the transcript REPL. Transcript-first REPL flows remain a fully supported alternative for users who prefer them.

Shared in-session commands:

- `/help` — show commands
- `/new` or `/clear` — start a fresh session in the same workspace/provider/model
- `/model` — show current model and curated list for the active provider
- `/model <name|#>` — switch model by name or list number
- `/provider` — show providers with key status
- `/provider <name|#>` — switch provider by name or list number
- `/session` — print current session id
- `/session rename <name>` — rename the current session (`--clear` to unset)
- `/skills reload` — reload skill files from `.push/skills` and `.claude/commands`
- `/skills lint` — report skill files that were dropped (errors) or had a constraint ignored (warnings)
- `@path[:line[-end]]` — preload file references into context (example: `@src/app.ts:120-180`)
- `/exit` or `/quit` — exit interactive mode

Skill discovery:
- Built-ins are always available.
- Push auto-loads workspace skills from `.push/skills/*.md`.
- Push also auto-detects Claude command files from `.claude/commands/**/*.md` and exposes them as skills.
- Nested Claude command paths are flattened to hyphenated names (example: `.claude/commands/git/pr-review.md` -> `/git-pr-review`).
- If names collide, `.push/skills` overrides Claude commands, and Claude commands override built-ins.
- Skills are loaded at startup; run `/skills reload` in REPL/TUI to refresh without restarting.
- Argument substitution in skill templates follows the Claude Code contract plus Push-native `{{args}}`: `{{args}}` and `$ARGUMENTS` expand to the full text typed after the command; `$0`–`$9` and `$ARGUMENTS[N]` expand to individual arguments (0-based — `$0` is the first; missing positions become empty; multi-digit `$NN` is left untouched, use `$ARGUMENTS[N]`). Indexed arguments use shell-style quoting, so `/my-skill "hello world" second` makes `$0` = `hello world`. Escape a token to keep it literal — `\$1` renders as `$1` (a doubled backslash `\\$1` keeps both backslashes and still expands; a backslash before any other `$` is unchanged). If a template references no argument token, non-empty input is appended as `ARGUMENTS: <value>` instead of being dropped. Substitution is a single pass, so token-shaped text inside your arguments is never re-expanded.
- Optional frontmatter: `description` (overrides the `# Heading`), `argument-hint` (short usage hint shown in `/skills`, e.g. `"[issue-number] [priority]"`), `requires_capabilities`, and `platforms`.
- Skills cannot shadow built-in commands — a file whose name matches a reserved command is dropped with a `reserved-name` error visible via `/skills lint`. Newly reserved as of the interactive-mode alignment: `clear`, `resume`, `remote`, `daemon`, `debug` (previously these loaded but were uninvokable in the TUI and shadowed the built-in in the REPL). Rename e.g. `.claude/commands/debug.md` to `diagnose.md` to keep it available.
- Invalid skill files are skipped silently at load time. To see *why* a skill didn't appear, run `/skills lint` in REPL/TUI or `./push skills --lint` (add `--json` for machine output). It reports dropped files (bad name, reserved name, missing heading/body, unreadable) as errors and ignored frontmatter (typo'd capability/platform, malformed fence) as warnings. The headless command exits non-zero when any file is dropped, so it can gate CI.

### Headless

```bash
./push run --task "Add error handling to src/parser.ts"
./push run "Fix the failing test in utils.test.js"
./push run --task "Refactor auth module" --accept "pnpm test" --accept "pnpm run lint" --json
```

Runs a single task and exits. No interaction. High-risk commands are blocked (no approval prompt).

`--accept <cmd>` runs shell commands after the agent finishes as acceptance checks. Exit code 0 = pass. The process exits 0 only if the agent succeeds *and* all checks pass.

When `--accept` is present, Push also frames the task using the shared delegation-brief format so acceptance checks are visible to the model during the run, not only after it finishes.

`--json` outputs structured results:

```json
{
  "sessionId": "sess_...",
  "runId": "run_...",
  "outcome": "success",
  "rounds": 4,
  "assistant": "Done. Added try/catch blocks...",
  "acceptance": {
    "passed": true,
    "checks": [{ "command": "pnpm test", "ok": true, "exitCode": 0, "durationMs": 3200 }]
  }
}
```

## Configuration

### Config file (`~/.push/config.json`)

```bash
./push config init              # interactive wizard
./push config show              # print current config (keys masked)
./push config set --provider openrouter --model mistralai/mistral-large-2512
./push config set --api-key sk-abc123
./push config set --tavily-key tvly-abc123
./push config set --search-backend ollama
./push config set --sandbox     # enable local Docker sandbox
./push config set --sandbox-backend native  # Linux/WSL Bubblewrap containment
./push config set --no-sandbox  # disable it
```

Per-provider settings (model, endpoint URL, API key) are stored under the provider name. The config file is chmod 0600.

### Auditor commit gate

`git_commit` is routed through the **Auditor** — a binary SAFE/UNSAFE review of the staged diff (secrets, injection vectors, disabled security controls) — before the commit lands. It is **on by default**. On UNSAFE the commit is blocked and the changes stay staged; in an interactive session you can approve the override at the prompt, while headless / daemon runs stay blocked. The gate fails closed: if it's enabled but no provider/model/key is available, the commit is refused rather than waved through.

Turn it off per-config or via env:

```json
{ "auditorGate": false }
```

```bash
PUSH_AUDITOR_GATE=0 ./push run --task "..."   # env overrides the config setting
```

The toggle resolves identically across CLI, daemon, and the web app (shared resolver in `lib/auditor-policy.ts`): `PUSH_AUDITOR_GATE` wins, then the per-surface setting, then the default (on). The setting is forwarded to the `pushd` daemon as `PUSH_AUDITOR_GATE` so delegated Coder commits gate the same way.

### Post-edit diagnostics

After a successful `write_file` / `edit_file`, the CLI runs the project type-checker (`tsc --noEmit`, pyright/ruff, `cargo check`, or `go vet` — same detection as `lsp_diagnostics`) scoped to the edited file and appends findings to the tool result, so the model sees breakage it just introduced without having to ask. **On by default.** Pattern borrowed from charmbracelet/crush (see `docs/research/charmbracelet crush — Lessons for Push.md`).

Because the checkers are full project compiles rather than an incremental language server, the loop guards its own cost: non-code files skip, unsupported projects and missing checkers disable it silently per workspace, and a run that exceeds the time budget (`PUSH_POST_EDIT_DIAGNOSTICS_BUDGET_MS`, default 10s) disables it for that workspace for the rest of the process with a one-time note to the model. Turn it off per-config or via env:

```json
{ "postEditDiagnostics": false }
```

```bash
PUSH_POST_EDIT_DIAGNOSTICS=0 ./push run --task "..."
```

Like `auditorGate`, an explicit setting is forwarded to the `pushd` daemon as `PUSH_POST_EDIT_DIAGNOSTICS` so delegated Coder edits behave the same way.

### Tool allow / deny lists

Two arrays in `~/.push/config.json` shape what tools the agent can run:

```json
{
  "disabledTools": ["exec", "exec_start"],
  "alwaysAllow": ["exec"],
  "safeExecPatterns": ["pnpm test", "git status"]
}
```

- `disabledTools` — CLI tool names blocked at dispatch. The agent receives a `TOOL_DISABLED` error and is instructed not to retry.
- `alwaysAllow` — CLI tool names that bypass approval prompts. Today only `exec` and `exec_start` actually prompt; other entries are forward-compatible no-ops. Does **not** bypass `--allow-exec` in headless mode.
- `safeExecPatterns` — command-prefix allowlist for single plain `exec` commands. Use this for command-level granularity instead of allowing the whole tool; chained shell commands still prompt/block when they contain a high-risk segment.

The CLI exports both lists to `PUSH_DISABLED_TOOLS` and `PUSH_ALWAYS_ALLOW` (comma-separated) so the `pushd` daemon's delegated tool executors inherit the same policy without re-reading config.

### Checkpoints

Snapshot+rollback for the working tree. Inspired by Nano Coder's `/checkpoint`.

```
/checkpoint create [name]          # snapshot changed + untracked files
/checkpoint list                   # newest first
/checkpoint load <name>            # preview only — shows what would change
/checkpoint load <name> --force    # actually restore files (overwrites!)
/checkpoint delete <name>
```

Snapshots live in `<workspace>/.push/checkpoints/<name>/`, kept out of git via an auto-appended `.gitignore` entry. Each snapshot captures:

- `meta.json` — provider, model, sessionId, branch, HEAD sha, file list
- `messages.jsonl` — copy of the session transcript at create time
- `files/<rel-path>` — only paths that differ from HEAD (modified/added/untracked), capped at 1 MB each

Restore semantics: `--force` writes files back immediately; conversation rollback is **not** applied in-process. To restore the conversation, `/exit` then `push resume <sessionId>` (printed in the load output).

### Environment variables

Config resolves in order: CLI flags > env vars > config file > defaults.

| Variable | Purpose |
|---|---|
| `PUSH_PROVIDER` | Default provider (`ollama`, `openrouter`, `kimi`, `zai`, `huggingface`, `zen`, `nvidia`, `fireworks`, `deepseek`, `sakana`, `openai`, `xai`, `anthropic`, `google`) |
| `PUSH_OLLAMA_URL` | Ollama Cloud endpoint (default: `https://ollama.com/v1/chat/completions`) |
| `PUSH_OLLAMA_API_KEY` | Ollama API key |
| `PUSH_OLLAMA_MODEL` | Ollama model (default: `minimax-m3`) |
| `PUSH_OPENROUTER_URL` | OpenRouter endpoint (default: `https://openrouter.ai/api/v1/responses`) |
| `PUSH_OPENROUTER_API_KEY` | OpenRouter API key (BYOK-compatible; provider-native keys stay in OpenRouter) |
| `PUSH_OPENROUTER_MODEL` | OpenRouter model (default: `anthropic/claude-sonnet-4.6:nitro`) |
| `PUSH_OPENROUTER_WEB_SEARCH` | OpenRouter native web search on Responses transport (default: on; set `0`, `false`, `no`, or `off` to disable) |
| `PUSH_ZAI_URL` | Z.ai endpoint (default: `https://api.z.ai/api/paas/v4/chat/completions`) |
| `PUSH_ZAI_API_KEY` | Z.ai API key |
| `PUSH_ZAI_MODEL` | Z.ai model (default: `glm-5.2`) |
| `PUSH_KIMI_URL` | Kimi endpoint (default: `https://api.moonshot.ai/v1/chat/completions`) |
| `PUSH_KIMI_API_KEY` | Kimi API key |
| `PUSH_KIMI_MODEL` | Kimi model (default: `kimi-k2.7-code-highspeed`) |
| `PUSH_HUGGINGFACE_URL` | Hugging Face router endpoint (default: `https://router.huggingface.co/v1/chat/completions`) |
| `PUSH_HUGGINGFACE_API_KEY` | Hugging Face access token |
| `PUSH_HUGGINGFACE_MODEL` | Hugging Face model (default: `deepseek-ai/DeepSeek-V4-Pro`) |
| `PUSH_ZEN_URL` | OpenCode Zen endpoint (default: `https://opencode.ai/zen/v1/chat/completions`) |
| `PUSH_ZEN_API_KEY` | OpenCode Zen API key |
| `PUSH_ZEN_MODEL` | OpenCode Zen model (default: `big-pickle`) |
| `PUSH_NVIDIA_URL` | Nvidia NIM endpoint (default: `https://integrate.api.nvidia.com/v1/chat/completions`) |
| `PUSH_NVIDIA_API_KEY` | Nvidia NIM API key |
| `PUSH_NVIDIA_MODEL` | Nvidia NIM model (default: `nvidia/llama-3.1-nemotron-70b-instruct`) |
| `PUSH_FIREWORKS_URL` | Fireworks AI endpoint (default: `https://api.fireworks.ai/inference/v1/responses`) |
| `PUSH_FIREWORKS_API_KEY` | Fireworks AI API key |
| `PUSH_FIREWORKS_MODEL` | Fireworks AI model (default: `accounts/fireworks/models/deepseek-v4-pro`) |
| `PUSH_DEEPSEEK_URL` | DeepSeek endpoint (default: `https://api.deepseek.com/anthropic/v1/messages`) |
| `PUSH_DEEPSEEK_API_KEY` | DeepSeek API key |
| `PUSH_DEEPSEEK_MODEL` | DeepSeek model (default: `deepseek-v4-pro`) |
| `PUSH_SAKANA_URL` | Sakana AI endpoint (default: `https://api.sakana.ai/v1/responses`) |
| `PUSH_SAKANA_API_KEY` | Sakana AI API key |
| `PUSH_SAKANA_MODEL` | Sakana AI model (default: `fugu`) |
| `PUSH_OPENAI_URL` | OpenAI Responses endpoint (default: `https://api.openai.com/v1/responses`) |
| `PUSH_OPENAI_API_KEY` | OpenAI API key |
| `PUSH_OPENAI_MODEL` | OpenAI model (default: `gpt-5.4`) |
| `PUSH_XAI_URL` | xAI Responses endpoint (default: `https://api.x.ai/v1/responses`) |
| `PUSH_XAI_API_KEY` | xAI API key |
| `PUSH_XAI_MODEL` | xAI model (default: `grok-4.5`) |
| `PUSH_ANTHROPIC_URL` | Anthropic Messages endpoint (default: `https://api.anthropic.com/v1/messages`) |
| `PUSH_ANTHROPIC_API_KEY` | Anthropic API key |
| `PUSH_ANTHROPIC_MODEL` | Anthropic model (default: `claude-sonnet-4-6`) |
| `PUSH_GOOGLE_URL` | Google Gemini base URL (default: `https://generativelanguage.googleapis.com/v1beta`) |
| `PUSH_GOOGLE_API_KEY` | Google Gemini API key (also accepted as `GEMINI_API_KEY`) |
| `PUSH_GOOGLE_MODEL` | Google Gemini model (default: `gemini-3.5-flash`) |
| `PUSH_PROVIDER_FAILOVER` | `1`/`true` to opt into round-scoped provider failover. The CLI retries the locked provider first, then may rescue the current round on another configured provider with the same wire shape. Default: off. |
| `PUSH_TAVILY_API_KEY` | Optional Tavily key for premium web search (`web_search`) |
| `PUSH_WEB_SEARCH_BACKEND` | Web search backend: `auto` (default), `tavily`, `ollama`, `duckduckgo` |
| `PUSH_RELAY_TOKEN` | Fallback `pushd_relay_...` bearer for `push daemon relay enable` / `/remote enable` / `/remote setup` when `--token`/the token arg is omitted |
| `PUSH_AUDITOR_GATE` | `0`/`false` to disable the Auditor commit gate, `1`/`true` to force it on (default: on). Overrides the `auditorGate` config setting. |
| `PUSH_POST_EDIT_DIAGNOSTICS` | `0`/`false` to disable the post-edit diagnostics loop (default: on). Overrides the `postEditDiagnostics` config setting. |
| `PUSH_POST_EDIT_DIAGNOSTICS_BUDGET_MS` | Time budget for a post-edit checker run in ms (default: 10000). A run that exceeds it disables the loop for that workspace for the rest of the process. |
| `PUSH_DELEGATION_MODE` | `delegated` opts interactive turns (TUI/daemon) back into the planner → task-graph wrapper. Default: `inline` — the single conversational lead runs the turn in-loop with no planner pre-pass (Agent Runtime Decisions §10). Headless `push run` keeps its explicit `--delegate` flag. |
| `PUSH_GITHUB_TOKEN` | GitHub token enabling the GitHub tools (PRs, checks, repo browse, create/merge PR, workflows). Falls back to `GITHUB_TOKEN`, then `GH_TOKEN`, then `gh auth token`. |
| `PUSH_LOCAL_SANDBOX` | Exec isolation backend: `native` (Linux/WSL Bubblewrap), `docker`/`true`, or `host`/`false` |
| `PUSH_NATIVE_SANDBOX_NETWORK` | `1`/`true` to permit network inside the native sandbox; default is denied |
| `PUSH_BWRAP_PATH` | Override the Bubblewrap executable used by the native sandbox |
| `PUSH_SHELL` | Override the shell used for `exec` / acceptance checks. Useful on Windows if you want to force Git Bash, WSL bash, PowerShell, etc. |
| `PUSH_SESSION_DIR` | Override session storage location (default: `~/.push/sessions`) |
| `PUSH_CONFIG_PATH` | Override config file path |

Fallback env vars from the web app (`VITE_OLLAMA_API_KEY`, `OLLAMA_API_KEY`, `VITE_TAVILY_API_KEY`, etc.) are also checked.

> **Retired:** `PUSH_LEAD_RUNTIME` no longer exists — interactive turns always run on the shared coder kernel (`cli/lead-turn.ts`, Agent Runtime Decisions §10). The former `=engine` opt-out is a no-op; setting it has no effect.

## Providers

The CLI ships fourteen providers. Six (`ollama`, `kimi`, `zai`, `huggingface`, `zen`, `nvidia`) speak OpenAI Chat Completions-compatible wire shape. `openrouter`, direct `openai`, `xai`, `sakana` (Fugu), and `fireworks` use the Responses API (`/v1/responses`); `PUSH_OPENROUTER_TRANSPORT=chat` keeps OpenRouter's legacy Chat Completions path available. `anthropic` and `deepseek` (via `api.deepseek.com/anthropic`) use the Anthropic Messages API; `google` carries its native wire shape. The CLI normalizes each provider stream into Push events so downstream consumers see one event surface. The CLI retries on 429/5xx with exponential backoff (up to 3 attempts).

| Provider | Default model | Requires key |
|---|---|---|
| `ollama` | `minimax-m3` | Yes |
| `openrouter` | `anthropic/claude-sonnet-4.6:nitro` | Yes |
| `kimi` | `kimi-k2.7-code-highspeed` | Yes |
| `zai` | `glm-5.2` | Yes |
| `huggingface` | `deepseek-ai/DeepSeek-V4-Pro` | Yes |
| `zen` | `big-pickle` | Yes |
| `nvidia` | `nvidia/llama-3.1-nemotron-70b-instruct` | Yes |
| `fireworks` | `accounts/fireworks/models/deepseek-v4-pro` | Yes |
| `deepseek` | `deepseek-v4-pro` | Yes |
| `sakana` | `fugu` | Yes |
| `openai` | `gpt-5.4` | Yes |
| `xai` | `grok-4.5` | Yes |
| `anthropic` | `claude-sonnet-4-6` | Yes |
| `google` | `gemini-3.5-flash` | Yes |

Removed providers (`mistral`, `minimax`, `azure`, `bedrock`, `vertex`, `kilocode`) are gracefully redirected to `openrouter` with a warning.

You can switch provider/model mid-session with `/provider` and `/model`. Switching providers updates runtime endpoint/key/model without restarting the CLI.

## Tools

All providers support prompt-engineered tool calls (fenced JSON blocks in the content stream). OpenAI-compatible native `delta.tool_calls` and direct OpenAI Responses `response.function_call_arguments.*` events are also accepted; the provider pumps accumulate them and flush each assembled call back into the same dispatcher.

Available tools:

| Tool | Type | Purpose |
|---|---|---|
| `read_file` | read | Read file with hashline-anchored line numbers |
| `list_dir` | read | List directory contents |
| `search_files` | read | Ripgrep text search (falls back to grep) |
| `web_search` | read | Search the public web (backend configurable: `auto`/`tavily`/`ollama`/`duckduckgo`) |
| `fetch_url` | read | Fetch a public http(s) URL and return readable text (HTML converted to plain text) |
| `read_symbols` | read | Extract function/class/type declarations from a file |
| `git_status` | read | Workspace git status (branch, dirty files) |
| `git_diff` | read | Show git diff (optionally for a specific file, staged) |
| `exec` | mutate | Run a shell command |
| `exec_start` | mutate | Start a long-running command session |
| `exec_poll` | read | Read incremental output from a command session |
| `exec_write` | mutate | Send stdin to a running command session |
| `exec_stop` | mutate | Stop a command session and release it |
| `exec_list_sessions` | read | List active/finished command sessions |
| `write_file` | mutate | Write entire file (auto-backed up) |
| `edit_file` | mutate | Surgical hashline edits with context preview (auto-backed up) |
| `undo_edit` | mutate | Restore a file from the most recent tool-created backup |
| `git_commit` | mutate | Stage and commit files |
| `git_create_branch` | mutate | Create a new branch and switch to it (optionally from a ref); aliases: `create_branch`, `sandbox_create_branch` |
| `git_switch_branch` | mutate | Switch to an existing branch (fetches it for shallow clones); aliases: `switch_branch`, `sandbox_switch_branch` |
| `lsp_diagnostics` | read | Run workspace diagnostics/type-check output |
| `save_memory` | memory | Persist concise project learnings across sessions (`.push/memory.md`) |
| `coder_update_state` | memory | Update working memory (plan, tasks, etc.) |
| `ask_user` | control | Pause for operator clarification when a critical ambiguity would waste work |

**Read/mutate split:** The CLI groups each turn as read-only calls first, then a sequential file-mutation batch (`write_file`, `edit_file`, `undo_edit`), then at most one trailing side-effect (`exec`, `git_commit`, `save_memory`, etc.). Reads run in parallel; file mutations run sequentially with fail-fast; extra side effects or reads after mutation starts are rejected with `MULTI_MUTATION_NOT_ALLOWED`. Memory/control tools do not modify workspace files.

### GitHub tools

When a GitHub token is configured (`PUSH_GITHUB_TOKEN` / `GITHUB_TOKEN` / `GH_TOKEN`, or a logged-in `gh` CLI), the CLI also exposes GitHub tools that operate over the GitHub API — the same surface the web app uses, sharing the runtime-agnostic core in `lib/github-tool-core.ts`. They're advertised under their public names (`pr`, `prs`, `repo_read`, `pr_create`, …) and only appear in the prompt when a token is present; without one they return `GITHUB_NO_TOKEN`.

| Tool | Type | Purpose |
|---|---|---|
| `pr` / `prs` / `commits` | read | Fetch a PR (with diff + comments) / list PRs / list recent commits |
| `repo_read` / `repo_grep` / `repo_ls` / `repo_search` | read | Read a file / grep a file / list a directory / code-search, over the GitHub API |
| `branches` / `checks` / `commit_files` | read | List branches / CI status for a ref / files changed in a commit |
| `pr_check` / `pr_find` | read | Check PR mergeability + CI / find an open PR for a branch |
| `workflow_runs` / `workflow_logs` | read | List workflow runs / fetch run job+step details |
| `pr_create` | mutate | Open a pull request |
| `pr_merge` | mutate | Merge a PR (`merge`/`squash`/`rebase`) |
| `branch_delete` | mutate | Delete a branch |
| `workflow_run` | mutate | Trigger a `workflow_dispatch` |

Read-only GitHub tools parallelize alongside the CLI's other reads; the write tools (`pr_create`, `pr_merge`, `branch_delete`, `workflow_run`) are side-effecting and follow the one-trailing-side-effect-per-turn budget. **Merges go through the PR flow** — open a PR and merge it; the CLI never merges locally. Write tools require both a configured token and a role that grants `pr:write` (orchestrator/coder); the read-only Explorer is denied them at the capability gate.

### Hashline edits

`edit_file` uses content-hash anchored references instead of raw line numbers. When the agent reads a file, each line is displayed as:

```
12:a3b8c1f	const x = 42;
```

The `a3b8c1f` is a 7-char prefix of a SHA-256 hash of the line content. Edits reference lines by `lineNo:hash` (e.g. `"12:a3b8c1f"`), so every displayed line now includes a copy-pasteable ref and stale edits are caught immediately if the file changed. Operations: `replace_line`, `insert_after`, `insert_before`, `delete_line`. All content-bearing ops support multi-line content (split on `\n`). After edits, the result includes a context window around each edit site so the agent can verify correctness without a re-read.

## Sessions

Sessions persist to `~/.push/sessions/<session-id>/` by default. Each session has:

- `state.json` — full conversation state (messages, working memory, provider info)
- `events.jsonl` — append-only event log (including shared `tool.execution_*`, `tool.call_malformed`, and `assistant.turn_*` entries alongside CLI-specific status/error/run markers)

If no `PUSH_SESSION_DIR` is set, the CLI also reads legacy workspace-local sessions from `.push/sessions/` in the current directory when listing or resuming by id.

```bash
./push resume                                    # interactive picker (TTY) → auto-attach; prints list when piped
./push resume --no-attach                        # list only, never prompt (script-friendly)
./push resume --json                             # list as JSON
./push sessions                                  # alias of `resume --no-attach`, never prompts
./push resume rename sess_abc123 "PR review"     # rename a session
./push resume rename sess_abc123 --clear         # clear a session name
./push --session sess_abc123                     # resume by id (TUI or REPL)
./push attach sess_abc123                        # attach to a live daemon session by id
```

In a TTY, `./push resume` now prints a numbered list of resumable sessions and prompts for a selection; picking a number (or typing a full session id) attaches via `push attach` without requiring a second command. Empty input or `q`/`quit` cancels cleanly. When stdout is not a TTY, when `--json` is passed, or when `--no-attach` is passed, the picker is skipped and behavior matches the pre-existing list-only output so scripts that parse `resume` output keep working.

Each picker entry shows relative freshness (`2h ago`, `yesterday`, `3d ago`) alongside provider/model/cwd, and — when the session has a human turn on record — a one-line preview of the most recent user prompt in quotes. Tool-result and session-marker envelopes are filtered out so previews always reflect the operator's own words. Long prompts are truncated with an ellipsis. Machine-readable `--json` output still carries precise `updatedAt` milliseconds and the full `lastUserMessage` for scripts that need them.

When exactly one session is resumable, the picker is skipped — `./push resume` prints a one-line banner naming the session (`Resuming only session: sess_… (name) …`) and attaches directly. Use `./push resume --no-attach` if you want to see the list without the auto-attach.

### Pruning

Sessions are never garbage-collected automatically — `push sessions prune` is the explicit retention tool:

```bash
./push sessions prune --older-than 30            # dry-run: list sessions idle > 30 days
./push sessions prune --older-than 30 --force    # actually delete them
./push sessions prune --empty --force            # delete sessions with no human turn on record
./push sessions prune --keep 100 --force         # keep the 100 most recent, delete the rest
./push sessions prune --match-model 'ollama-base|replay-target' --force   # regex over provider/model
```

Selectors combine with **AND** (a multi-flag prune deletes the intersection), at least one selector is required, and every invocation is a dry-run unless `--force` is passed — the kill list prints either way. Sessions with a run marker fresher than 6 hours are skipped as live; older markers are treated as stale crash leftovers and don't shield a session from age-based pruning. `--json` emits the full report for scripts.

## Working memory

The agent maintains structured working memory across rounds — plan, open tasks, files touched, assumptions, and errors encountered. Working memory is reinjected through the `[meta]` envelope only when it first appears, when it changes, under elevated context pressure, or on a long-task cadence, and never more than once per round.

The `[meta]` envelope also includes `contextChars` — a rough character count of the full message history — so the agent can gauge context budget consumption.

## Workspace context

On session init, the system prompt is enriched with:

- **Workspace snapshot** — git branch, dirty files, top-level tree, and manifest summary (e.g. `package.json` name/version/dep count). Generated by `workspace-context.ts`.
- **Project instructions** — reads `PUSH.md`, `AGENTS.md`, `CLAUDE.md`, or `GEMINI.md` from the workspace root in that order (first found wins, capped at 8,000 characters by the shared sanitizer). Injected as a `[PROJECT_INSTRUCTIONS]` block.

## File backups

Before any `write_file` or `edit_file` mutation, the original file is copied to `.push/backups/<filename>.<timestamp>.bak`. This is best-effort — backup failures never block the write.

## Safety

- **Workspace jail:** All file paths are resolved and checked — no escaping the workspace root.
- **High-risk detection:** Commands matching patterns like `rm -rf`, `sudo`, `git push --force`, `drop table`, `curl | sh`, etc. are flagged. In interactive mode, you can approve once, trust for session, or save a reusable prefix. In headless mode, high-risk commands are blocked unless they match an explicit trusted prefix pattern.
- **Tool loop detection:** If the same tool call sequence repeats 3 times, the run is stopped.
- **Max rounds:** Default 8, configurable via `--max-rounds` (max 30). Prevents runaway loops.
- **Output truncation:** Tool output is capped at 24KB to avoid context blowout.
- **Subprocess env scrub:** Model-invoked commands (`sandbox_exec`, `exec`, `exec_start`, acceptance checks) run with a default-deny env allowlist defined in `cli/env-scrub.ts`. Provider API keys hydrated into the daemon's `process.env` by `applyConfigToEnv` (e.g. `PUSH_ANTHROPIC_API_KEY`, `ANTHROPIC_API_KEY`, `GITHUB_TOKEN`) are stripped before the spawn, so `env`-style introspection from a sandboxed command can't exfiltrate them. The allowlist covers `PATH`/`HOME`/`SHELL`/locale, the common Node/Python/Go/Rust/Docker-client vars, `CI`, and `npm_config_*` / `NPM_CONFIG_*` / `BUN_*`. Widen via `config.scrub.allow` (exact names or `PREFIX*` patterns), or set `config.scrub.disabled: true` (or `PUSH_SCRUB_DISABLED=1`) to opt out entirely — only for local debugging.

## Local exec sandbox

Model-invoked subprocesses support three backends:

- `host` — direct execution with workspace path policy, approvals, and env scrubbing;
- `docker` — the legacy `--sandbox` / `PUSH_LOCAL_SANDBOX=true` container;
- `native` — Linux/WSL Bubblewrap containment selected with
  `--sandbox-backend native` or `PUSH_LOCAL_SANDBOX=native`.

Native mode covers `exec`, `exec_start`, daemon `sandbox_exec`, and headless
acceptance checks. It mounts the host read-only, keeps the workspace and
disposable temp filesystems writable, masks conventional runtime sockets under
`/run`, isolates process namespaces, and denies network by default. It fails closed when
Bubblewrap is unavailable. Set `PUSH_NATIVE_SANDBOX_NETWORK=1` only when the run
genuinely needs network access.

Native mode is currently opt-in while Linux/WSL toolchain compatibility is
exercised. Built-in file tools remain protected by the symlink-aware workspace
jail; moving them behind the same OS broker and adding macOS/Windows backends are
later containment phases.

With the Docker backend, commands run as:

```bash
docker run --rm -v $WORKSPACE:/workspace -w /workspace push-sandbox bash -lc "$COMMAND"
```

The `push-sandbox` image must exist locally. Built-in file reads/writes still go
through the host filesystem and workspace jail.

## Daemon (experimental)

`pushd` is the daemon runtime for attachable CLI sessions and Remote sessions:

```bash
./push daemon start
```

It listens on a Unix domain socket (`~/.push/run/pushd.sock`) for CLI attach/admin commands and, when enabled, a loopback WebSocket for paired web clients. Remote sessions use an outbound Worker/Durable Object relay connection configured by `push daemon relay enable`. All transports carry the same `push.runtime.v1` JSON envelopes. Current request families include session start/attach/send/cancel, approval submission, role delegation, task graphs, daemon-backed sandbox exec/read/write/list/diff, pairing/token admin, relay admin, and audit/device inspection.

**Lifecycle.** The daemon's lifetime tracks the local client's: when the last loopback client disconnects, `pushd` self-exits after a short grace window — but only once it's idle (in-flight runs / delegations / task graphs finish first) and no relay (paired phone) is attached. The grace window is cancelled if a client reconnects, so the self-heal drain→respawn and transient disconnects don't kill a daemon still in use. Tune the window with `PUSH_DAEMON_IDLE_GRACE_MS` (default `8000`). A paired phone (active relay) keeps the daemon alive with no local client.

## File layout

```
cli/
  cli.ts                # Entrypoint — arg parsing, interactive/headless dispatch
  engine.ts             # Assistant loop, working memory, multi-tool dispatch, context tracking
  tools.ts              # Tool executor, workspace guard, hashline edits, risk detection, git tools
  provider.ts           # SSE streaming client, retry policy, provider configs
  workspace-context.ts  # Workspace snapshot + project instruction loading
  session-store.ts      # Session state + event persistence
  config-store.ts       # ~/.push/config.json read/write/env overlay
  hashline.ts           # Hashline protocol (content-hash line refs, multi-line edits)
  file-ledger.ts        # File awareness tracking (per-file read/write status)
  tool-call-metrics.ts  # Malformed tool-call counters
  pushd.ts              # Daemon runtime (Unix socket dispatcher, sessions, role delegation)
  pushd-ws.ts           # Loopback WebSocket listener for low-level daemon clients
  pushd-relay-*.ts      # Remote relay config, dialer, pairing bundle, allowlist
  tui.ts                # Experimental full-screen terminal UI
  tests/                # node:test suite
```

## CLI reference

```
push                                Start TUI when enabled, otherwise interactive session
push --session <id>                 Resume session (TUI when enabled, otherwise interactive)
push run --task "..."               Headless mode (single task)
push run "..."                      Headless mode (positional)
push resume                         Pick a session and attach (TTY); list only when piped
push resume --no-attach             List resumable sessions without prompting
push sessions                       List resumable sessions (never prompts; script alias)
push stats                          Show provider compliance stats
push daemon status|start|stop       Manage pushd daemon
push daemon pair [--origin <url>]    Mint a loopback device token (low-level/back-compat)
push daemon pair --remote            Mint a Remote pairing bundle via relay
push daemon relay enable|disable|status
                                    Manage the outbound Worker relay. `enable [--url <url>] [--token <token>]`
                                    — both are optional after the first machine-wide setup: --url falls back
                                    to the already-persisted deployment, --token falls back to PUSH_RELAY_TOKEN.
push attach <session-id>            Attach to daemon-backed session
push config show                    Show saved config
push config init                    Interactive setup wizard
push config set ...                 Save provider config

TUI Remote flow:
  /remote setup [<deployment-url>] [<pushd_relay_...>]
                                    Enable relay + mint a phone bundle for this TUI session
                                    (args optional the same way as `push daemon relay enable`)
  /remote pair                      Mint a fresh phone bundle for this TUI session
  /rc [pair]                        Remote control, one-shot: make this session reachable
                                    on your phone — re-enables the relay from saved config,
                                    mints a pairing bundle if no phone is paired, otherwise
                                    confirms the session is listed under Connected on the
                                    phone (tap a Connected row there to resume the session)

Options:
  --provider <name>       ollama | openrouter | kimi | zai | huggingface | zen | nvidia | fireworks | deepseek | sakana | openai | xai | anthropic | google (default: ollama)
  --model <name>          Override model
  --url <endpoint>        Override provider endpoint URL
  --api-key <secret>      Set provider API key
  --tavily-key <secret>   Set Tavily API key for web_search
  --search-backend <mode> auto | tavily | ollama | duckduckgo
  --cwd <path>            Workspace root (default: cwd)
  --session <id>          Resume session
  --task <text>           Task for headless mode
  --accept <cmd>          Acceptance check (repeatable)
  --max-rounds <n>        Tool-loop cap (default: 8, max: 30)
  --json                  JSON output (headless/resume)
  --no-attach             Resume: list sessions without prompting
  --no-resume-prompt      Bare push: skip the "resume or new" prompt and start a new session
  --sandbox               Enable local Docker sandbox
  --sandbox-backend <mode> host | docker | native (native requires Linux/WSL Bubblewrap)
  --no-sandbox            Disable local Docker sandbox
  -h, --help              Show help
```

Interactive slash commands:

```
/new | /clear             Start a new session (same provider/model/cwd)
/model                    Show model list for current provider
/model <name|#>           Switch model
/provider                 Show providers and current status
/provider <name|#>        Switch provider
/session                  Print session id
/session rename <name>    Rename current session (--clear to unset)
/exit | /quit             Exit interactive mode
```

## Future

Items not yet implemented:

Interactive-mode pattern gaps (flagged against the slash-command conventions of peer agent CLIs — Command Code, Claude Code — for possible addition later):

- **`/status`** — One-shot overview of auth, model, git branch/dirty state, workspace, and skills. Pieces exist across `/config`, `/debug runtime`, and `/worktree` (TUI-only); no unified read.
- **`/rewind` for the local engine** — `/revert` / `/unrevert` only work against the daemon; the non-daemon engine has no turn-rewind.
- **`!` bash-mode and `#` memory-note input sigils** — Only `/` (commands) and `@` (file refs) are special in the composer.
- **`model:` frontmatter on skills** — Per-command model override. Needs a decision on how it interacts with the chat-lock provider-routing model before implementing.
- **Named skill arguments (`$name` + `arguments:` frontmatter)** — Claude Code also supports declaring `arguments: [issue, branch]` and referencing `$issue` / `$branch`; Push currently supports only positional and full-string tokens.
- **`allowed-tools` frontmatter** — Execution-time tool scoping per skill. `requires_capabilities` gates *visibility* only; nothing narrows what a skill run may do.
- **Shared command table for TUI + REPL** — The two dispatch switches and `/help` texts are maintained independently; the REPL supports a subset (`/config`, `/theme`, `/copy`, `/resume`, `/remote`, `/rc`, `/daemon`, `/debug` are TUI-only). One table would end the drift.
- **Command descriptions in the completion palette** — The TUI palette lists names only; peer CLIs show each command's description inline in the `/` menu.
- **`/share` conversation links** — No conversation export/share surface.
- **User-scoped (`~/.push/skills`) commands** — Skills load from the workspace and built-ins only; no personal cross-repo command directory.

CLI flags and plumbing:

- **`--verbose` / `--quiet`** — No verbosity control. Tool status lines always go to stdout in interactive mode.
- **Subcommand-level help** — `push config --help` doesn't show config-specific options.
- **`--yes` / `--force`** — No flag to auto-approve high-risk commands in headless mode.
- **Exit code taxonomy** — Only `0` (success) and `1` (error) currently. Could add `2` (usage error), `130` (SIGINT) for CI.
