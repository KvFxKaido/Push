# Codex CLI Structural Backend Gap Analysis

Status: Reference (research snapshot, 2026-07-14; reprioritized 2026-07-14)

## Question

Compared with Codex CLI, what is obviously missing from Push CLI at the
structural/backend layer?

The comparison deliberately excludes presentation parity and small command
ergonomics. It asks which missing substrates limit what Push can safely become.

Current Codex references used for the comparison:

- [Sandbox and approvals](https://learn.chatgpt.com/docs/sandboxing.md)
- [MCP](https://learn.chatgpt.com/docs/extend/mcp.md)
- [Layered configuration](https://learn.chatgpt.com/docs/config-file/config-advanced.md),
  [hooks](https://learn.chatgpt.com/docs/hooks.md), and
  [rules](https://learn.chatgpt.com/docs/agent-configuration/rules.md)
- [Non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode.md),
  [app-server](https://learn.chatgpt.com/docs/app-server.md), and
  [SDK](https://learn.chatgpt.com/docs/codex-sdk.md)
- [Authentication and credential storage](https://learn.chatgpt.com/docs/auth.md)

## Current read

Push is not missing a credible agent runtime. It already has durable daemon
sessions, attach/replay, worktree isolation, task graphs and role delegation,
workspace skills, long-running exec sessions, context compaction and retrieval,
GitHub tools, and stronger-than-usual delivery governance through the capability
ledger, Protect Main, Auditor, and Gate-at-Push.

The obvious gaps sit below that runtime.

| Priority | Missing substrate | Current Push shape | Consequence |
|---|---|---|---|
| 1 | Supported machine interface | Rich internal run events and experimental daemon protocol; final-result headless JSON | CI and product integrations cannot consume a stable streaming/schema contract |
| 2 | Layered config, policy, and trust | User JSON + env/flags + simple allow/deny lists; internal code hooks | MCP, hooks, team policy, and profiles have no shared precedence/trust model |
| 3 | General external-tool bus | Compiled-in tools plus first-party GitHub integration; Push exposes an MCP server but consumes none | New tools require product code instead of governed attachment |
| 4 | Host-enforced containment | Workspace path checks, command policy, env scrubbing, optional Docker exec | A generated host command can still reach everything the Push process can reach |
| 5 | Credential lifecycle | Provider keys in a mode-0600 config file and scrubbed environment | OAuth, refresh, revocation, MCP auth, and shared-machine use have no neutral broker |

### Reprioritization (2026-07-14)

The original snapshot was authored in Codex's recommended order — containment →
tool bus → config → machine interface → credential broker. Re-read against Push's
actual deployment (sole-user, local, multi-surface, governance-as-visible-safety),
that order inverts.

Codex's top three — containment, MCP, and trust layers — are the substrates most
shaped by the multi-tenant, run-untrusted-code-for-untrusted-operators model that
Push does not have. They are real, but their urgency is borrowed from Codex's
product shape, not Push's. The **machine interface**, which Codex buries at #4, is
the most *Push* item on the list: it directly serves the multi-surface thesis
(web, Android, CLI sharing runtime contracts in `lib/`), it builds on the existing
`push.runtime.v1` / `push.stream.v1` wire rather than net-new plumbing, and it is
purely additive and reversible. The revised order is **machine interface → config
loader → MCP → containment → credential broker**.

Note on status: Phase 1 of the containment work (the opt-in Linux/WSL subprocess
boundary, `cli/exec-sandbox.ts`) was started under the original ordering, before
this reprioritization. It continues — as opt-in defense-in-depth — even though the
substrate now ranks #4.

## 1. Supported machine interface

This is the item closest to done and the one that compounds for Push. The
multi-surface thesis already shares runtime contracts in `lib/`, and the
`push.runtime.v1` / `push.stream.v1` migration is partway there; a public
streaming/schema contract is additive rather than a new subsystem. The smallest
useful progression is:

1. `push run --jsonl` over the existing run-event taxonomy;
2. schema-constrained final output;
3. versioned daemon/app-server protocol plus generated TypeScript/JSON schemas;
4. a thin SDK facade over that protocol.

The distinction is not capability. It is whether external consumers can rely on
the capability without importing internal coordinator modules. Steps 1–2 are the
near-term win; step 4 (the SDK facade) is demand-driven and can wait until a
consumer exists, rather than being built speculatively.

## 2. Layered config, policy, and trust

One typed loader should own system/managed constraints, user defaults, named
profiles, trusted project/subdirectory layers, and CLI overrides. Rules, hooks,
MCP, sandbox permissions, and provider settings should compose through that
loader.

The near-term win is the **loader with defined precedence** — the pre-MCP hygiene
that stops each subsystem (MCP config, hooks, permissions, provider settings) from
inventing its own precedence and trust model. Building it before MCP lands is the
point.

The **trusted-project and managed/team layers** — the constraint that project code
must not redirect credentials or silently enable host-reach hooks merely by being
opened — are demand-driven by multi-tenant and untrusted-repo use. They remain a
valid design constraint, but for a sole-user deployment they are lower urgency than
the loader itself, and can follow it.

## 3. General external-tool bus

Push CLI needs to consume MCP servers over stdio and HTTP, including tools,
resources, server instructions, timeouts, and authentication. MCP calls must
enter through the existing capability ledger, approval categories, side-effect
budget, and untrusted-content boundary. Attaching an MCP server must not create a
second ungoverned dispatcher.

This is already the planned direction (CLI-scoped, governed attachment); it is
sequenced after the config loader so the attachment has one precedence/trust model
to hang from rather than inventing its own.

## 4. Host-enforced containment

This remains a real gap, but it is defense-in-depth for Push's deployment rather
than the top priority Codex ranks it. A worktree isolates Git state, not machine
authority. The workspace jail constrains built-in file tools, not arbitrary
commands. Command classification and approval govern intent — but a classifier has
false negatives: a non-cooperating model can find a command form the parser does
not catch. That argues for an opt-in containment *floor* beneath the governance,
not a replacement for it, and not a mandatory jail that would undercut the CLI's
reason to exist (local reach, real filesystem, real shell).

The target contract is:

- spawned commands cannot write outside the selected workspace, its validated
  linked-worktree Git metadata, and disposable temporary storage;
- spawned commands cannot reach host service sockets;
- network is denied unless the run receives an explicit network grant;
- the boundary applies symmetrically to foreground exec, detached exec, daemon
  exec, and automated acceptance checks;
- requesting a containment backend that is unavailable fails closed;
- built-in file mutation remains workspace-contained and eventually moves
  behind the same OS-enforced broker.

### Phase plan

1. **Linux/WSL subprocess boundary.** Add an opt-in Bubblewrap backend shared by
   CLI exec, detached exec, daemon exec, and acceptance checks. Host root is
   read-only; workspace and tmpfs are writable; process namespaces are isolated;
   conventional runtime sockets under `/run` are masked; registered linked-
   worktree metadata remains writable; network is off by default.
2. **Permission vocabulary.** Replace backend-shaped booleans with explicit
   `read-only`, `workspace-write`, and `full-access` modes, with an escalation
   path rather than a global network escape hatch.
3. **Full tool boundary.** Move built-in file mutation and git mutation behind a
   broker enforced by the selected mode, keeping hashline and typed-git semantics
   above it.
4. **Other hosts.** Add Seatbelt on macOS and a native Windows implementation;
   keep Docker as the portable fallback.
5. **Network broker.** Replace binary network on/off with destination policy and
   credential-stripping routes.

Phase 1 is in progress (`cli/exec-sandbox.ts`), started under the original ordering
before the reprioritization above. It is intentionally opt-in until the
toolchain/cache compatibility matrix is exercised on Linux and WSL.

## 5. Credential lifecycle

Introduce a provider-neutral credential store whose config values are references,
not necessarily secrets. Support OS keyring storage with an explicit file fallback,
status/logout, refresh/revocation, and future OAuth/device flows. The same broker
should serve model providers, GitHub, MCP, and relay credentials without exposing
them to model-invoked subprocesses.

This ranks last by its own dependency chain: OAuth/device flows and neutral broker
storage become necessary once MCP-with-auth (#3) and richer provider/trust
configuration (#2) land, so it is demand-driven by the substrates above it rather
than a standalone near-term need.

## Explicit non-gaps

Do not reopen these as generic Codex-parity work without new evidence:

- durable/resumable sessions and event replay;
- daemon-backed background work;
- worktrees;
- subagent/task-graph execution;
- workspace skills;
- context compaction and retrieval;
- PTY-backed long-running processes;
- GitHub operations;
- approval and delivery gates.

Push is competitive or intentionally different in those areas. The revised
implementation order is **machine interface → config loader → MCP → containment →
credential broker** (see Reprioritization above); the original snapshot's
containment-first order is retained in this document only as the record of Codex's
recommendation.
