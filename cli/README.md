# Push CLI

Local coding agent for your terminal. The terminal surface is moving toward a full-screen TUI, with the classic REPL and headless runs still supported. It uses the same role-based agent architecture as the Push mobile app, but operates directly on your filesystem.

## Quick start

```bash
# From repo root
PUSH_TUI_ENABLED=1 ./push
./push run --task "Implement X and run tests"

# Or with Node directly
node cli/cli.mjs
```

On first run you'll want to configure a provider:

```bash
./push config init
```

This walks you through provider, model, API key, and sandbox settings using numbered menus (with free-text fallback). Config is saved to `~/.push/config.json` (mode 0600).

## Modes

### TUI (current terminal focus)

```bash
PUSH_TUI_ENABLED=1 ./push
PUSH_TUI_ENABLED=1 ./push --session sess_abc123
PUSH_TUI_ENABLED=1 ./push tui
```

Starts the full-screen TUI. This is where most current terminal UX work is landing. When `PUSH_TUI_ENABLED=1`, bare `./push` and `./push --session` open the TUI by default.

### Interactive REPL (default fallback)

```bash
./push
./push --provider openrouter --model anthropic/claude-sonnet-4.6:nitro
./push --session sess_abc123   # resume a previous session
```

With TUI disabled, this starts the classic REPL. The agent streams responses, executes tools, and loops until it's done or you type `/exit`. High-risk commands (rm -rf, sudo, force-push, etc.) prompt for approval before running, with one-shot, session-trust, and saved-prefix trust options.

If `PUSH_TUI_ENABLED=1`, bare `./push` launches the full-screen TUI by default. Use `./push tui` explicitly to force TUI mode, or unset the flag to use the classic REPL as default.

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

### Environment variables

Config resolves in order: CLI flags > env vars > config file > defaults.

| Variable | Purpose |
|---|---|
| `PUSH_PROVIDER` | Default provider (`ollama`, `openrouter`, `zen`, `nvidia`) |
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
| `PUSH_TAVILY_API_KEY` | Optional Tavily key for premium web search (`web_search`) |
| `PUSH_WEB_SEARCH_BACKEND` | Web search backend: `auto` (default), `tavily`, `ollama`, `duckduckgo` |
| `PUSH_LOCAL_SANDBOX` | `true` to run exec commands in a Docker container |
| `PUSH_SESSION_DIR` | Override session storage location (default: `~/.push/sessions`) |
| `PUSH_CONFIG_PATH` | Override config file path |

Fallback env vars from the web app (`VITE_OLLAMA_API_KEY`, `OLLAMA_API_KEY`, `VITE_TAVILY_API_KEY`, etc.) are also checked.

## Providers

All four providers use OpenAI-compatible SSE streaming. The CLI retries on 429/5xx with exponential backoff (up to 3 attempts).

| Provider | Default model | Requires key |
|---|---|---|
| `ollama` | `gemini-3-flash-preview` | Yes |
| `openrouter` | `anthropic/claude-sonnet-4.6:nitro` | Yes |
| `zen` | `big-pickle` | Yes |
| `nvidia` | `nvidia/llama-3.1-nemotron-70b-instruct` | Yes |

Removed providers (`mistral`, `zai`, `google`, `minimax`) are gracefully redirected to `openrouter` with a warning.

You can switch provider/model mid-session with `/provider` and `/model`. Switching providers updates runtime endpoint/key/model without restarting the CLI.

### Provider policies

- Ollama: `documents/security/PROVIDER_USAGE_POLICY_OLLAMA.md`
- OpenRouter: `documents/security/PROVIDER_USAGE_POLICY_OPENROUTER.md`
- OpenCode Zen: `documents/security/PROVIDER_USAGE_POLICY_ZEN.md`

## Tools

All providers use prompt-engineered tool calls (fenced JSON blocks in the content stream).

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

**Read/mutate split:** Multiple read-only tools can run in parallel per turn. Only one mutating tool is allowed per turn — extras are rejected with a structured error. Memory/control tools do not modify workspace files.

### Hashline edits

`edit_file` uses content-hash anchored references instead of raw line numbers. When the agent reads a file, each line is displayed as:

```
12|a3b8c1f| const x = 42;
```

The `a3b8c1f` is a 7-char SHA-1 hash of the line content. Edits reference lines by `lineNo:hash` (e.g. `"12:a3b8c1f"`), so stale edits are caught immediately if the file changed. Operations: `replace_line`, `insert_after`, `insert_before`, `delete_line`. All content-bearing ops support multi-line content (split on `\n`). After edits, the result includes a context window around each edit site so the agent can verify correctness without a re-read.

## Sessions

Sessions persist to `~/.push/sessions/<session-id>/` by default. Each session has:

- `state.json` — full conversation state (messages, working memory, provider info)
- `events.jsonl` — append-only event log (tool calls, results, errors, run outcomes)

If no `PUSH_SESSION_DIR` is set, the CLI also reads legacy workspace-local sessions from `.push/sessions/` in the current directory when listing or resuming by id.

```bash
./push resume                                    # list resumable sessions (shows name when set)
./push resume --json                             # list as JSON
./push resume rename sess_abc123 "PR review"     # rename a session
./push resume rename sess_abc123 --clear         # clear a session name
./push --session sess_abc123 # resume
```

## Working memory

The agent maintains structured working memory across rounds — plan, open tasks, files touched, assumptions, and errors encountered. Working memory is injected once per round (on the last tool result) via a `[meta]` envelope, so it survives context trimming without being duplicated across parallel reads.

The `[meta]` envelope also includes `contextChars` — a rough character count of the full message history — so the agent can gauge context budget consumption.

## Workspace context

On session init, the system prompt is enriched with:

- **Workspace snapshot** — git branch, dirty files, top-level tree, and manifest summary (e.g. `package.json` name/version/dep count). Generated by `workspace-context.mjs`.
- **Project instructions** — reads `.push/instructions.md`, `AGENTS.md`, `CLAUDE.md`, or `GEMINI.md` from the workspace root in that order (first found wins, capped at 8KB). Injected as a `[PROJECT_INSTRUCTIONS]` block.

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

`pushd` is a daemon skeleton for IPC-based access to the same engine:

```bash
node cli/pushd.mjs
```

Listens on a Unix domain socket (`~/.push/run/pushd.sock`), speaks NDJSON. Request types: `hello`, `start_session`, `send_user_message`, `attach_session`. This is the foundation for editor integrations and background task runners.

## File layout

```
cli/
  cli.mjs               # Entrypoint — arg parsing, interactive/headless dispatch
  engine.mjs            # Assistant loop, working memory, multi-tool dispatch, context tracking
  tools.mjs             # Tool executor, workspace guard, hashline edits, risk detection, git tools
  provider.mjs          # SSE streaming client, retry policy, provider configs
  workspace-context.mjs # Workspace snapshot + project instruction loading
  session-store.mjs     # Session state + event persistence
  config-store.mjs      # ~/.push/config.json read/write/env overlay
  hashline.mjs          # Hashline protocol (content-hash line refs, multi-line edits)
  file-ledger.mjs       # File awareness tracking (per-file read/write status)
  tool-call-metrics.mjs # Malformed tool-call counters
  pushd.mjs             # Daemon skeleton (Unix socket, NDJSON IPC)
  tests/                # node:test suite
```

## CLI reference

```
push                                Start TUI when enabled, otherwise interactive session
push --session <id>                 Resume session (TUI when enabled, otherwise interactive)
push run --task "..."               Headless mode (single task)
push run "..."                      Headless mode (positional)
push resume                         List resumable sessions
push stats                          Show provider compliance stats
push daemon status|start|stop       Manage pushd daemon
push attach <session-id>            Attach to daemon-backed session
push config show                    Show saved config
push config init                    Interactive setup wizard
push config set ...                 Save provider config

Options:
  --provider <name>       ollama | openrouter | zen | nvidia (default: ollama)
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
