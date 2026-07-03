# charmbracelet crush — Lessons for Push

Status: Reference (research snapshot, 2026-07-03)
Source: `charmbracelet/crush` v0.81.0 (~26k stars, Go 1.26) — `internal/agent`
(loop, coordinator, tools), `internal/lsp`, `internal/permission`,
`internal/config` (incl. `catwalk.go`), `internal/db` migrations, `schema.json`,
`docs/hooks/`, and the extracted Charm libraries `fantasy` (provider SDK),
`catwalk` (model DB), and `powernap` (LSP client) — cross-read against Push's
`lib/` + `cli/` runtime.

## Why this doc exists

crush is Charm's terminal AI coding agent and the closest *product* analog to
Push's CLI surface: a governed tool loop, multi-provider model layer, session
persistence, permission prompts, sub-agents, skills, MCP — all driven from a
terminal UI, with an experimental client/server split that rhymes with
`pushd`. Where deepagents ([`LangChain deepagents — Lessons for
Push.md`](LangChain%20deepagents%20—%20Lessons%20for%20Push.md)) was the
harness-library comparison, crush is the CLI-product comparison — directly
relevant to the roadmap's **Push CLI Muscle-Memory UX** and **CLI/TUI-lite
Ergonomics** tracks.

Same disclaimer as the prior reviews: this is a *concept* map, not a
dependency proposal. crush's load-bearing layers (Bubble Tea v2, fantasy,
SQLite/sqlc) sit exactly where Push's bespoke TUI renderer, provider
contract, and jsonl session store sit. The value is in a handful of runtime
mechanisms that are independently reimplementable.

## The map

| crush feature | Push equivalent | State |
|---|---|---|
| **Post-edit LSP diagnostics in tool results** — `edit`/`write`/`multiedit` call `notifyLSPs()` after a successful mutation and append diagnostics inside the tool result, so the model sees breakage immediately without asking | `lsp_diagnostics` tool (`cli/diagnostics.ts` — compiler subprocesses: `tsc --noEmit`, pyright/ruff, `cargo check`, `go vet`), **model-invoked only**; no post-mutation hook runs it (`cli/tool-hooks-default.ts` has no diagnostics wiring) | ⚠️ Gap, highest-value borrow. Push built the checker and the hook seam but never connected them. See takeaway 1. |
| **True LSP layer** (`internal/lsp` on `powernap`) — lazy server start gated on `filetypes` + `root_markers`, versioned open-file tracking, per-server state, 30s unavailable-retry, agent-callable `lsp_restart`, `references` tool | Deliberately deferred — `docs/archive/cli/runbooks/LSP Diagnostics Plan.md` chose compiler subprocesses ("option C, overkill for a first pass") | ◐ The deferral was right for a first pass; crush's manager is the reference design if/when subprocess latency (a full `tsc --noEmit` per check) forces the upgrade. See takeaway 1's second half. |
| **Cost tracking as first-class state** — Catwalk carries `CostPer1MIn/Out` + cached-rate fields per model; `sessions` table has `prompt_tokens`, `completion_tokens`, `cost` columns updated atomically per step; sub-agent session costs roll up into parents; `crush stats` | Token/context budgeting (`lib/context-budget.ts`, `cli/stats.ts`) — but `lib/model-metadata.ts` has **zero price fields** and no dollar figure exists anywhere in `lib/`/`cli/` | ⚠️ Gap. Push already tracks tokens and already derives model metadata from models.dev, which carries pricing. See takeaway 2. |
| **Catwalk provider/model DB** — central service (`catwalk.charm.land/v2/providers`), ETag-conditional fetch → on-disk cache → **embedded snapshot** fallback; model/pricing updates ship without product releases (232 catwalk releases) | Hardcoded `PROVIDER_MODEL_METADATA` (`lib/model-metadata.ts`, "cold-cache source derived from models.dev") + live per-provider `/models` fetch (`cli/model-catalog.ts`) | ◐ Push has two of the three tiers (live fetch, embedded table) but no shared remote catalog between them — the hardcoded table only updates by shipping a release. See takeaway 3. |
| **Large/small model split** — cheap model generates session titles (with large-model fallback); summarization stays on the large model | No cheap-model split; titles/summaries/compaction run on the lead model. Per-role routing exists (`roleRouting` per session, `docs/decisions/Per-Provider Role Routing Presets.md`, Draft) | ◐ The Draft presets doc is the natural home; crush's data point: only *titles* go small — summarization quality is worth the large model. |
| **Bash auto-backgrounding** — a foreground `bash` call auto-converts to a background job after 60s (`DefaultAutoBackgroundAfter`), returning a job ID; `job_output`/`job_kill` manage it | `exec` (foreground, timeout) and `exec_start`/`exec_poll`/`exec_stop` (detached sessions) are **separate tools the model must choose between up front** | ⚠️ Gap, cheap win — the machinery exists, only the automatic promotion is missing. See takeaway 4. |
| **Permission denial ends the turn** — denial returns a `StopTurn` tool response, handing control back to the user instead of letting the model argue with the refusal | Denial returns a plain error result (`Denied by user: …`, `cli/tools.ts:678`) that the model can immediately retry against | ⚠️ Gap, small hardening. See takeaway 5. |
| **Read-before-edit freshness** — `edit` rejects if `filetracker.LastReadTime()` predates file mtime; read timestamps persist across restarts (`read_files` table) | Hashline anchors (`lib/hashline.ts`): every edit op carries a per-line content hash `ref` + optional `expected_version`; stale state fails structurally (`STALE_WRITE`) | ✅ Have it, deeper — per-line content proof beats a timestamp heuristic. Nothing to borrow. |
| **Loop detection** — fantasy `StopCondition` on exact repeated tool calls within a window | `lib/loop-detection.ts`: graded verdict ladder (warn → block → compact → abort), exact-match breaker **plus** near-duplicate Jaccard similarity on writes | ✅ Have it, deeper. |
| **Auto-compaction** — threshold trigger (20k tokens remaining, or 20% for small windows), summary streamed from the large model, history sliced at the summary marker | Sync heuristic + async LLM compaction (`lib/message-context-manager.ts`, `lib/llm-compaction.ts`), lossless durable transcript, `memory_grep`/`memory_expand` recall | ✅ Have it, deeper (crush's compaction is lossy summary-slice; no recall path). |
| **Sub-agent tool** — `agent` tool spawns an isolated child session (`parent_session_id`), non-interactive, cost rolls up to parent | `delegate_coder`/`delegate_explorer`, curated `buildDelegationBrief`, typed `DelegationOutcome` distilled forward | ✅ Have it, deeper contract. (Cost rollup becomes relevant once takeaway 2 lands.) |
| **MCP client** — stdio/http/sse servers, per-server `enabled_tools`/`disabled_tools`, 15s timeout, MCP resources tools; **every MCP tool wrapped through the same permission service as built-ins** | Decided (CLI-scoped, [`CLAUDE.md`](../../CLAUDE.md) "Capability sourcing") but **zero implementation** — no MCP client code exists | ◐ Known gap, no schedule change. crush's one transferable design point: MCP tools route through the *same* approval/permission layer as first-party tools — the governed-attach shape Push already committed to on paper. |
| **PreToolUse hooks** — regex tool matcher → shell command, JSON in/out; exit 0 = allow/rewrite, 2 = block call, 49 = halt turn | Internal tool hooks (`lib/tool-hooks.ts`, pre-hook gates) — code-level, not user-scriptable | ✅ Deliberate divergence for now. User shell hooks are ungoverned reach — same posture as MCP: CLI-scoped at most, and only with the exit-code contract's block/halt semantics mapped onto `approval-gates` categories. |
| **Ignore files** — `.gitignore` + `.crushignore` (gitignore syntax) respected by ls/glob/grep and completions (`internal/fsext`) | `.gitignore` honored transitively (search shells to `rg`); **no `.pushignore`**; `lib/sensitive-paths.ts` blocks credential-shaped files | ⚠️ Small gap. See takeaway 6. |
| **Config JSON Schema** — published `schema.json`, `crush schema` subcommand, `"$schema"` key for editor completion | Runtime *event* schema published (`schema/push.runtime.v1.event.schema.json`); `PushConfig` has no published schema | ⚠️ Small gap. See takeaway 6. |
| **Commit attribution option** — `options.attribution`: `trailer_style: assisted-by \| co-authored-by \| none`, `generated_with` toggle | No attribution convention in the `git_commit` builder | ⚠️ Small gap / product decision. See takeaway 6. |
| **Bang mode** — `!` prefix runs a shell command directly, streamed, output lands in history/context | Not present in the TUI (no `!` passthrough); shell access is model-mediated via `exec` | ⚠️ Gap, roadmap-aligned (Claude Code parity — it has the same idiom). See takeaway 7. |
| **Client/server split** — experimental (`CRUSH_CLIENT_SERVER=1`), TUI as HTTP client over unix socket, 60+ endpoints, shared workspaces | `pushd` daemon is the **default** path (TUI auto-starts it, sessions persist), plus relay, device tokens, phone pairing (`/rc`) | ✅ Have it, shipped and deeper. Validates the architecture crush is still hardening. |
| **Banned-command list** — 43 hardcoded banned commands in `bash` (curl, wget, ssh, sudo, npm, pip…), `download` tool as the sanctioned alternative | Layered policy: `lib/command-policy.ts` on a Codex-derived shell parser, git policy oracle (`lib/git/policy.ts`), secret-scan + Protect-Main + Auditor gates, per-turn side-effect budget | ✅ Deliberate divergence — a static ban list is blunter than classification (banning `npm` outright would break Push's validation loops). Their safe read-only prefix shortlist ≈ `safeExecPatterns`, already present. |
| **Telemetry** — pseudonymous usage metadata, `DO_NOT_TRACK`/config opt-out, never prompts | No CLI telemetry | ✅ No action; noted for completeness. |

## What's worth borrowing (ranked)

1. **Inject diagnostics into mutation results.** crush's `edit`/`write` append
   fresh LSP diagnostics inside the tool result, so the model sees the type
   error it just introduced *in the same round*, without deciding to ask.
   Push has both halves built — `cli/diagnostics.ts` (tsc/pyright/cargo/go
   vet) and the tool-hook seam (`cli/tool-hooks-default.ts`) — but they're
   not connected: `lsp_diagnostics` only runs when the model thinks to call
   it, which is exactly the failure mode (the model that just wrote a bug is
   the least likely to check for it). The borrow is a post-mutation hook on
   `edit_file`/`write_file` that runs diagnostics scoped to the touched file
   and appends findings to the result. The known cost is latency — a
   subprocess `tsc --noEmit` is not an incremental LSP push — so it needs a
   scope guard (skip when the project check exceeds a time budget; cache the
   project detection) and a config opt-out. If that latency proves the
   blocker, crush's `internal/lsp` manager (lazy start on filetype +
   root-marker match, versioned open files, 30s unavailable-retry,
   agent-callable restart) is the reference design for the real-LSP upgrade
   the original plan doc deferred.
   *Shipped alongside this doc:* `cli/post-edit-diagnostics.ts` wires the
   loop into `write_file`/`edit_file` with exactly these guards (extension
   gate, 10s budget via `PUSH_POST_EDIT_DIAGNOSTICS_BUDGET_MS`, adaptive
   per-workspace disable, `postEditDiagnostics` config opt-out).

2. **Price the tokens Push already counts.** Push tracks tokens everywhere
   (context budget, stats) but has no dollar field anywhere in the runtime.
   crush treats cost as session state: per-model `CostPer1MIn/Out` (+ cached
   rates) from the catalog, a `cost` column on the session updated each step,
   sub-agent costs rolled up into the parent. The Push shape: add price
   fields to `lib/model-metadata.ts` (its declared source, models.dev,
   already carries them), accumulate per-session cost in `SessionState`
   alongside `rounds`, roll delegated-run costs into the parent session, and
   surface it in `cli/stats.ts` and the TUI status line. Matters more for
   Push than for most tools: multi-provider role routing makes "which role on
   which model costs what" a real question the user currently can't answer.

3. **Catalog delivery: remote → disk cache → embedded snapshot.** Catwalk's
   fetch chain (ETag-conditional GET, on-disk cache, embedded fallback, hard
   kill-switch env) lets model/pricing metadata update continuously without
   shipping releases — 232 catalog releases against ~80 product releases.
   Push's equivalent metadata is a hardcoded table that only moves when the
   CLI ships, plus a live `/models` fetch that doesn't carry
   pricing/capability depth. Push already runs a Worker; serving a versioned
   catalog JSON from it and teaching `lib/model-metadata.ts` the three-tier
   fallback gives the same decoupling without a new service. This is also
   the prerequisite plumbing for takeaway 2's price fields staying current.

4. **Auto-background long-running exec.** crush's `bash` converts itself to a
   background job after 60s and returns a job ID; the model polls with
   `job_output`. Push makes the model choose `exec` vs `exec_start` up
   front — guess wrong and a long build either times out (foreground) or
   costs an extra round-trip (background for a 2s command). The borrow:
   on foreground `exec` hitting a promotion threshold, transparently convert
   to an `exec_start` session and return the session ID with output-so-far,
   instead of killing at timeout. All the machinery (`exec_poll`,
   `exec_stop`, session listing) already exists; this is a behavior change
   inside one tool arm plus a structured `exec_promoted` result marker.

5. **Denial ends the turn.** In crush, a denied permission returns a
   `StopTurn` response — the run stops and control returns to the user. In
   Push a denial is a normal error result (`Denied by user: …`), which the
   model can immediately re-attempt or argue with; the user who just said
   "no" watches the loop continue. Denial is an authority signal, not an
   environment error: the CLI loop should end the turn (or at minimum
   suppress further side-effecting calls this turn) when the approval pane
   returns deny. Small change in `cli/tools.ts` / the engine loop; pairs
   with the existing per-turn side-effect budget vocabulary.

6. **Three cheap paper cuts.** (a) **`.pushignore`** — gitignore-syntax
   overlay honored by `search_files`/`list_dir`/`@`-completion (`rg` accepts
   `--ignore-file`, so the search path is nearly free); today there is no way
   to keep a committed-but-irrelevant directory out of the agent's view.
   (b) **Publish a config schema** — `PushConfig` is a TS interface with no
   JSON Schema; crush ships `schema.json` + a `schema` subcommand and honors
   `"$schema"` for editor completion. Push already publishes the runtime
   event schema, so the pattern and tooling exist. (c) **Attribution
   option** — a `PushConfig.attribution` (`assisted-by | co-authored-by |
   none`) applied by the `git_commit` builder. Push currently ships no
   attribution, silently; making it explicit-and-configurable is both more
   honest and more polite to downstream repos than either extreme.

7. **Bang mode.** `!command` in the composer runs the shell directly,
   streams output, and folds it into history/context — no model round-trip,
   no approval ceremony for something the user typed themselves. Claude Code
   has the same idiom, which puts this squarely in the roadmap's
   muscle-memory-parity track. Push's TUI has the input pipeline and exec
   plumbing; the design question is only how the output enters the
   transcript (crush: as ordinary context the model can see — the right
   call, since users bang-run `git status` precisely so the agent knows).

## What not to borrow

- **The library extraction** (fantasy, catwalk-as-a-lib, powernap). Charm is
  building a Go agent *ecosystem*; splitting the provider SDK and LSP client
  into public libraries is their business model, not an architecture lesson.
  Push is a product — same conclusion as the deepagents middleware verdict.
  (Borrowing catwalk's *delivery mechanism* — takeaway 3 — doesn't require
  borrowing the library shape.)
- **SQLite session store.** Push's `messages.jsonl` + `state.json` hybrid was
  a deliberate decision (#482) with append-only semantics matched to the
  daemon's event-cursor reattach. crush's relational store earns its keep
  through cost columns and file versioning — both replicable in the existing
  store without a database dependency.
- **The 43-command ban list.** Banning `curl`/`npm`/`pip` outright and
  shipping a `download` tool as the sanctioned alternative is a blunt
  instrument; Push's layered classification (command policy parser, git
  policy oracle, secret scan, Auditor gates) is strictly more capable, and
  Push's validation loops *require* package managers to run.
- **`old_string`/`new_string` editing.** crush's edit contract (unique-match
  search-replace + read-freshness timestamp) is the industry default; hashline
  (per-line content-hash anchors + `expected_version`) is stronger on both
  disambiguation and staleness. Keep hashline.
- **User-facing shell hooks on the web surface.** PreToolUse-style hooks are
  ungoverned reach outside the runtime contract — the same governance
  argument as MCP attach. If hooks land, they land CLI-scoped, with crush's
  exit-code semantics (allow/rewrite, block-call, halt-turn) expressed as
  `approval-gates` categories, not as a parallel mechanism.

## Where Push is already ahead

- **Delivery governance.** crush's permission layer is consent (ask, allow
  for session, yolo). Push has consent *plus* governance: fail-closed
  Auditor gates, Gate-at-Push cumulative diff review, Protect Main,
  deterministic secret scan, per-turn side-effect budget, git/remote-mutation
  policy oracles. crush has no equivalent of "the runtime reviews the diff
  before it leaves the machine."
- **Lossless context.** crush compacts by summary-slice — pre-summary history
  is gone from the model's reach. Push's LCM keeps the durable transcript,
  reduces losslessly, and gives the model `memory_grep`/`memory_expand`
  recall.
- **Loop detection.** Exact-repeat breaking vs Push's graded
  warn→block→compact→abort ladder with near-duplicate similarity scoring.
- **Daemon reach.** crush's client/server split is experimental and
  local-socket-scoped; `pushd` is the default path with relay, device
  tokens, and phone pairing shipped.
- **Non-native models.** crush requires native tool calling (fantasy);
  Push's text-dispatch protocol keeps fenced-JSON models first-class, with
  native calls additive.
- **Edit integrity.** Hashline's per-line content proofs vs mtime-based
  read-freshness checks.

## Alignment notes

- Takeaways 1, 4, 5, 7 all land in the roadmap's **Push CLI Muscle-Memory
  UX / CLI-TUI ergonomics** tracks; none conflict with the Single-Agent
  Loop direction (they harden the loop rather than add delegation).
- Takeaway 2 + 3 touch `lib/model-metadata.ts` and session state on both
  surfaces — per the cross-surface checklist, the price-lookup resolver
  belongs in `lib/` from day one, keyed to survive CLI per-run sessions.
- The Draft `Per-Provider Role Routing Presets` doc should absorb the
  large/small observation (titles small, summaries large) rather than a new
  doc.
