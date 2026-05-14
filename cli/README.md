# Push CLI

Local coding agent for your terminal. Push currently ships three terminal surfaces: an interactive REPL, headless runs, and an experimental full-screen TUI. The current product direction is transcript-first CLI ergonomics and TUI-lite improvements, not a ground-up full-screen TUI rewrite. It uses the same role-based agent architecture as the Push mobile app, but operates directly on your filesystem.

## Pointers

- [`architecture.md`](architecture.md) — CLI-specific architecture, runtime layers, and terminal surfaces
- [`DESIGN.md`](DESIGN.md) — CLI/TUI presentation guidance and terminal design principles
- [`../docs/architecture.md`](../docs/architecture.md) — shared Push architecture and operating model
- [`../docs/DESIGN.md`](../docs/DESIGN.md) — graphical app visual system

## Quick start

```bash
# From repo root
npm install
./push config init
PUSH_TUI_ENABLED=0 ./push
./push tui
./push run --task "Implement X and run tests"

# Or with Node directly
node --import tsx cli/cli.ts
```

On Windows, use `.\push.cmd` from `cmd.exe`, PowerShell, or Windows Terminal:

```powershell
.\push.cmd config init
$env:PUSH_TUI_ENABLED = "0"
.\push.cmd
.\push.cmd tui
```

`./push config init` walks you through provider, model, API key, and sandbox settings using numbered menus (with free-text fallback). Config is saved to `~/.push/config.json` (mode 0600).

## Modes

### Interactive REPL (transcript-first CLI)

```bash
PUSH_TUI_ENABLED=0 ./push
PUSH_TUI_ENABLED=0 ./push --provider openrouter --model anthropic/claude-sonnet-4.6:nitro
PUSH_TUI_ENABLED=0 ./push --session sess_abc123     # resume a previous session by id
PUSH_TUI_ENABLED=0 ./push --no-resume-prompt        # skip the resume-or-new prompt
```

With TUI disabled, this starts the transcript-first REPL. When resumable sessions exist for the current workspace (matched by cwd), bare `./push` prints a numbered picker of those sessions with an `n=new` choice so you can pick up where you left off without typing a second command. `--session <id>` skips the picker (explicit resume), `--no-resume-prompt` skips the picker and starts a new session, and if no sessions exist for this cwd the picker is silent. Cross-cwd resume is still available via `./push resume`. The agent streams responses, executes tools, and loops until it's done or you type `/exit`. High-risk commands (`rm -rf`, `sudo`, force-push, etc.) prompt for approval before running, with one-shot, session-trust, and saved-prefix trust options.

Use `PUSH_TUI_ENABLED=0` to make the REPL the default in your shell, or run `./push tui` explicitly when you want the TUI.

### TUI (current launcher default, not the product north star)

```bash
./push
./push --session sess_abc123
./push tui
```

The launcher currently exports `PUSH_TUI_ENABLED=1`, so bare `./push` and `./push --session` still open the full-screen TUI by default. This is a transitional launcher default rather than the roadmap direction: treat the TUI as an experimental shell, while transcript-first REPL flows remain the primary CLI UX target.

Shared in-session commands:

- `/help` — show commands
- `/new` — start a fresh session in the same workspace/provider/model
- `/model` — show current model and curated list for the active provider
- `/model <name|#>` — switch model by name or list number
- `/provider` — show providers with key status
- `/provider <name|#>` — switch provider by name or list number
- `/session` — print current session id
- `/session rename <name>` — rename the current session (`--clear` to unset)
- `/skills reload` — reload skill files from `.push/skills` and `.claude/commands`
- `@path[:line[-end]]` — preload file references into context (example: `@src/app.ts:120-180`)
- `/exit` or `/quit` — exit interactive mode

Skill discovery:
- Built-ins are always available.
- Push auto-loads workspace skills from `.push/skills/*.md`.
- Push also auto-detects Claude command files from `.claude/commands/**/*.md` and exposes them as skills.
- Nested Claude command paths are flattened to hyphenated names (example: `.claude/commands/git/pr-review.md` -> `/git-pr-review`).
- If names collide, `.push/skills` overrides Claude commands, and Claude commands override built-ins.
- Skills are loaded at startup; run `/skills reload` in REPL/TUI to refresh without restarting.

### Headless

```bash
./push run --task "Add error handling to src/parser.ts"
./push run "Fix the failing test in utils.test.js"
./push run --task "Refactor auth module" --accept "npm test" --accept "npm run lint" --json
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
    "checks": [{ "command": "npm test", "ok": true, "exitCode": 0, "durationMs": 3200 }]
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
./push config set --no-sandbox  # disable it
```

Per-provider settings (model, endpoint URL, API key) are stored under the provider name. The config file is chmod 0600.

### Tool allow / deny lists

Two arrays in `~/.push/config.json` shape what tools the agent can run:

```json
{
  "disabledTools": ["exec", "exec_start"],
  "alwaysAllow": ["exec"],
  "safeExecPatterns": ["npm test", "git status"]
}
```

- `disabledTools` — CLI tool names blocked at dispatch. The agent receives a `TOOL_DISABLED` error and is instructed not to retry.
- `alwaysAllow` — CLI tool names that bypass approval prompts. Today only `exec` and `exec_start` actually prompt; other entries are forward-compatible no-ops. Does **not** bypass `--allow-exec` in headless mode.
- `safeExecPatterns` — command-prefix allowlist for `exec` (existing). Use this for command-level granularity instead of allowing the whole tool.

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
| `PUSH_PROVIDER` | Default provider (`ollama`, `openrouter`, `zen`, `nvidia`, `kilocode`, `blackbox`, `openadapter`) |
| `PUSH_OLLAMA_URL` | Ollama Cloud endpoint (default: `https://ollama.com/v1/chat/completions`) |
| `PUSH_OLLAMA_API_KEY` | Ollama API key |
| `PUSH_OLLAMA_MODEL` | Ollama model (default: `gemini-3-flash-preview`) |
| `PUSH_OPENROUTER_URL` | OpenRouter endpoint (default: `https://openrouter.ai/api/v1/chat/completions`) |
| `PUSH_OPENROUTER_API_KEY` | OpenRouter API key (BYOK-compatible; provider-native keys stay in OpenRouter) |
| `PUSH_OPENROUTER_MODEL` | OpenRouter model (default: `anthropic/claude-sonnet-4.6:nitro`) |
| `PUSH_ZEN_URL` | OpenCode Zen endpoint (default: `https://opencode.ai/zen/v1/chat/completions`) |
| `PUSH_ZEN_API_KEY` | OpenCode Zen API key |
| `PUSH_ZEN_MODEL` | OpenCode Zen model (default: `big-pickle`) |
| `PUSH_NVIDIA_URL` | Nvidia NIM endpoint (default: `https://integrate.api.nvidia.com/v1/chat/completions`) |
| `PUSH_NVIDIA_API_KEY` | Nvidia NIM API key |
| `PUSH_NVIDIA_MODEL` | Nvidia NIM model (default: `nvidia/llama-3.1-nemotron-70b-instruct`) |
| `PUSH_KILOCODE_URL` | Kilo Code endpoint (default: `https://api.kilo.ai/api/gateway/chat/completions`) |
| `PUSH_KILOCODE_API_KEY` | Kilo Code API key |
| `PUSH_KILOCODE_MODEL` | Kilo Code model (default: `google/gemini-3-flash-preview`) |
| `PUSH_BLACKBOX_URL` | Blackbox AI endpoint (default: `https://api.blackbox.ai/chat/completions`) |
| `PUSH_BLACKBOX_API_KEY` | Blackbox AI API key |
| `PUSH_BLACKBOX_MODEL` | Blackbox AI model (default: `blackbox-ai`) |
| `PUSH_OPENADAPTER_URL` | OpenAdapter endpoint (default: `https://api.openadapter.in/v1/chat/completions`) |
| `PUSH_OPENADAPTER_API_KEY` | OpenAdapter API key |
| `PUSH_OPENADAPTER_MODEL` | OpenAdapter model (default: `deepseek/deepseek-v3`) |
| `PUSH_TAVILY_API_KEY` | Optional Tavily key for premium web search (`web_search`) |
| `PUSH_WEB_SEARCH_BACKEND` | Web search backend: `auto` (default), `tavily`, `ollama`, `duckduckgo` |
| `PUSH_LOCAL_SANDBOX` | `true` to run exec commands in a Docker container |
| `PUSH_SHELL` | Override the shell used for `exec` / acceptance checks. Useful on Windows if you want to force Git Bash, WSL bash, PowerShell, etc. |
| `PUSH_SESSION_DIR` | Override session storage location (default: `~/.push/sessions`) |
| `PUSH_CONFIG_PATH` | Override config file path |

Fallback env vars from the web app (`VITE_OLLAMA_API_KEY`, `OLLAMA_API_KEY`, `VITE_TAVILY_API_KEY`, etc.) are also checked.

## Providers

All seven providers use OpenAI-compatible SSE streaming. The CLI retries on 429/5xx with exponential backoff (up to 3 attempts).

| Provider | Default model | Requires key |
|---|---|---|
| `ollama` | `gemini-3-flash-preview` | Yes |
| `openrouter` | `anthropic/claude-sonnet-4.6:nitro` | Yes |
| `zen` | `big-pickle` | Yes |
| `nvidia` | `nvidia/llama-3.1-nemotron-70b-instruct` | Yes |
| `kilocode` | `google/gemini-3-flash-preview` | Yes |
| `blackbox` | `blackbox-ai` | Yes |
| `openadapter` | `deepseek/deepseek-v3` | Yes |

Removed providers (`mistral`, `zai`, `google`, `minimax`) are gracefully redirected to `openrouter` with a warning.

You can switch provider/model mid-session with `/provider` and `/model`. Switching providers updates runtime endpoint/key/model without restarting the CLI.

### Provider policies

- Ollama: `docs/security/PROVIDER_USAGE_POLICY_OLLAMA.md`
- OpenRouter: `docs/security/PROVIDER_USAGE_POLICY_OPENROUTER.md`
- OpenCode Zen: `docs/security/PROVIDER_USAGE_POLICY_ZEN.md`

## Tools

All providers support prompt-engineered tool calls (fenced JSON blocks in the content stream). OpenAI-compatible native `delta.tool_calls` are also accepted: `cli/openai-stream.ts` uses the shared SSE pump to accumulate them and flush each assembled call back into the same text-based dispatcher.

Available tools:

| Tool | Type | Purpose |
|---|---|---|
| `read_file` | read | Read file with hashline-anchored line numbers |
| `list_dir` | read | List directory contents |
| `search_files` | read | Ripgrep text search (falls back to grep) |
| `web_search` | read | Search the public web (backend configurable: `auto`/`tavily`/`ollama`/`duckduckgo`) |
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
| `lsp_diagnostics` | read | Run workspace diagnostics/type-check output |
| `save_memory` | memory | Persist concise project learnings across sessions (`.push/memory.md`) |
| `coder_update_state` | memory | Update working memory (plan, tasks, etc.) |
| `ask_user` | control | Pause for operator clarification when a critical ambiguity would waste work |

**Read/mutate split:** The CLI groups each turn as read-only calls first, then a sequential file-mutation batch (`write_file`, `edit_file`, `undo_edit`), then at most one trailing side-effect (`exec`, `git_commit`, `save_memory`, etc.). Reads run in parallel; file mutations run sequentially with fail-fast; extra side effects or reads after mutation starts are rejected with `MULTI_MUTATION_NOT_ALLOWED`. Memory/control tools do not modify workspace files.

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

## Working memory

The agent maintains structured working memory across rounds — plan, open tasks, files touched, assumptions, and errors encountered. Working memory is reinjected through the `[meta]` envelope only when it first appears, when it changes, under elevated context pressure, or on a long-task cadence, and never more than once per round.

The `[meta]` envelope also includes `contextChars` — a rough character count of the full message history — so the agent can gauge context budget consumption.

## Workspace context

On session init, the system prompt is enriched with:

- **Workspace snapshot** — git branch, dirty files, top-level tree, and manifest summary (e.g. `package.json` name/version/dep count). Generated by `workspace-context.ts`.
- **Project instructions** — reads `PUSH.md`, `AGENTS.md`, `CLAUDE.md`, or `GEMINI.md` from the workspace root in that order (first found wins, capped at 8KB). Injected as a `[PROJECT_INSTRUCTIONS]` block.

## File backups

Before any `write_file` or `edit_file` mutation, the original file is copied to `.push/backups/<filename>.<timestamp>.bak`. This is best-effort — backup failures never block the write.

## Safety

- **Workspace jail:** All file paths are resolved and checked — no escaping the workspace root.
- **High-risk detection:** Commands matching patterns like `rm -rf`, `sudo`, `git push --force`, `drop table`, `curl | sh`, etc. are flagged. In interactive mode, you can approve once, trust for session, or save a reusable prefix. In headless mode, high-risk commands are blocked unless they match an explicit trusted prefix pattern.
- **Tool loop detection:** If the same tool call sequence repeats 3 times, the run is stopped.
- **Max rounds:** Default 8, configurable via `--max-rounds` (max 30). Prevents runaway loops.
- **Output truncation:** Tool output is capped at 24KB to avoid context blowout.

## Docker sandbox

With `--sandbox` (or `PUSH_LOCAL_SANDBOX=true`), `exec` and `exec_start` commands run inside a Docker container instead of directly on your machine:

```bash
docker run --rm -v $WORKSPACE:/workspace -w /workspace push-sandbox bash -lc "$COMMAND"
```

The `push-sandbox` image must exist locally. File reads/writes still go through the host filesystem.

## Daemon (experimental)

`pushd` is the daemon runtime for attachable CLI sessions, Local PC sessions, and Remote sessions:

```bash
./push daemon start
```

It listens on a Unix domain socket (`~/.push/run/pushd.sock`) for CLI attach/admin commands and, when enabled, a loopback WebSocket for paired web clients. Remote sessions use an outbound Worker/Durable Object relay connection configured by `push daemon relay enable`. All transports carry the same `push.runtime.v1` JSON envelopes. Current request families include session start/attach/send/cancel, approval submission, role delegation, task graphs, daemon-backed sandbox exec/read/write/list/diff, pairing/token admin, relay admin, and audit/device inspection.

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
  pushd-ws.ts           # Loopback WebSocket listener for paired Local PC clients
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
push daemon pair [--origin <url>]    Mint a Local PC pairing token
push daemon pair --remote            Mint a Remote pairing bundle via relay
push daemon relay enable|disable|status
                                    Manage the outbound Worker relay
push attach <session-id>            Attach to daemon-backed session
push config show                    Show saved config
push config init                    Interactive setup wizard
push config set ...                 Save provider config

Options:
  --provider <name>       ollama | openrouter | zen | nvidia | kilocode | blackbox | openadapter (default: ollama)
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
  --no-sandbox            Disable local Docker sandbox
  -h, --help              Show help
```

Interactive slash commands:

```
/new                      Start a new session (same provider/model/cwd)
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

- **`--verbose` / `--quiet`** — No verbosity control. Tool status lines always go to stdout in interactive mode.
- **Subcommand-level help** — `push config --help` doesn't show config-specific options.
- **`--yes` / `--force`** — No flag to auto-approve high-risk commands in headless mode.
- **Exit code taxonomy** — Only `0` (success) and `1` (error) currently. Could add `2` (usage error), `130` (SIGINT) for CI.
