# Apache-Derived Code Draft

This is the working convention for using Apache-2.0 code or prompt material in
Push while keeping Push's original code MIT licensed.

## Current Position

Push remains MIT licensed. Apache-2.0 code or prompt material may be used in
isolated files or modules when the borrowed subsystem is low-differentiation,
safety-sensitive, or better proven upstream than a handrolled replacement.

Push already has one small Codex-adapted area: `lib/llm-compaction.ts` adapts
the compaction prompt/prefix idea from OpenAI Codex. The next likely candidate
for real code reuse is command safety: shell parsing, `bash -lc` handling, git
option classification, and command-safety tests.

## Candidate Register

### 1. Command Safety

Reuse posture: recommended for Apache-derived code and test use.

Codex has mature shell and git classification logic, including `bash -lc`
parsing, read-only git option handling, and safety tests for commands such as
`find`, `rg`, and `base64`. This maps directly to Push's current command guard
and is safety-sensitive enough to justify using upstream code or translated
tests instead of staying purely handrolled.

Candidate upstream paths:

- `codex-rs/shell-command/src/command_safety/`
- `codex-rs/shell-command/src/bash.rs`
- `codex-rs/shell-command/src/parse_command.rs`
- `codex-rs/execpolicy/`

### 2. Exec Policy Rules

Reuse posture: likely Push-native implementation, Apache-derived tests or rule
semantics if useful.

Codex's `execpolicy` shape is cleaner than a plain trusted-prefix list:
`allow`, `prompt`, and `forbidden` decisions; ordered prefix rules; host
executable binding; and strictest-decision wins. Push can keep its own command
approval UX while adopting this policy model for safer saved approvals.

Candidate upstream paths:

- `codex-rs/execpolicy/`

### 3. Context Compaction

Reuse posture: partly active already; prefer targeted alignment over wholesale
copying.

Push has its own context stack and already includes an LLM compaction path in
`lib/llm-compaction.ts`. Future work should compare Push behavior against Codex
for the pieces that affect stability over long sessions:

- Manual and automatic compaction triggers.
- A visible `contextCompaction` lifecycle item/event.
- Repeated-compaction behavior that carries previous handoff summaries forward.
- Configurable thresholds and prompt override shape.
- Tests for resume/fork after compaction.

Candidate upstream paths:

- `codex-rs/prompts/templates/compact/`
- `codex-rs/prompts/src/compact.rs`
- `codex-rs/core/src/compact.rs`
- `codex-rs/core/src/compact_remote.rs`
- `codex-rs/core/src/state/auto_compact_window.rs`
- `codex-rs/core/tests/suite/compact_resume_fork.rs`
- `codex-rs/core/tests/suite/compact_remote_parity.rs`

### 4. Headless JSONL and Output Schema

Reuse posture: implement Push-native protocol, borrow event taxonomy and tests.

Push headless mode currently has structured final output. Codex `exec` is useful
prior art for machine-readable streaming: progress and diagnostics stay off
stdout, `--json` emits JSONL events, and output schemas make automation results
stable. Push should own the event names and compatibility guarantees, but Codex
is a strong reference for the automation contract.

Candidate upstream paths:

- `codex-rs/exec/src/exec_events.rs`
- `codex-rs/exec/src/cli.rs`
- `codex-rs/exec/src/lib.rs`

### 5. Hooks

Reuse posture: reference first; copy schema/discovery pieces only if Push adds
user or team-managed hooks.

Push has a small internal hook registry. Codex has a fuller lifecycle hook
system with `hooks.json`, managed/project/plugin sources, trust state, matcher
validation, and pre/post compaction events. This is worth studying if Push wants
local policy hooks, team guardrails, or plugin-provided hooks.

Candidate upstream paths:

- `codex-rs/hooks/src/engine/discovery.rs`
- `codex-rs/hooks/src/engine/dispatcher.rs`
- `codex-rs/hooks/src/config_rules.rs`
- `codex-rs/hooks/schema/`

### 6. Local Review and Safe Diff UX

Reuse posture: Push-native UX, Apache-derived edge-case tests if useful.

Push already has strong git and auditor gates, but Codex's local `/review`
presets and hardened diff collection are good source material. The best reuse is
probably not the TUI widget code; it is the diff safety behavior: include
untracked files, avoid configured external diff/textconv helpers, handle
fsmonitor carefully, and preserve clear review targets.

Candidate upstream paths:

- `codex-rs/tui/src/get_git_diff.rs`
- `codex-rs/tui/src/chatwidget/review_popups.rs`

### 7. OS Sandbox and Network Proxy

Reuse posture: high-value but heavy; reference architecture unless Push commits
to native host containment.

Codex has native sandbox orchestration and a network policy layer for protecting
the host and local/private services. Push's Docker sandbox is simpler and easier
to reason about, so this only belongs on the implementation path if Push wants a
strong local trust boundary beyond command approval.

Candidate upstream paths:

- `codex-rs/sandboxing/src/manager.rs`
- `codex-rs/linux-sandbox/`
- `codex-rs/network-proxy/`

### 8. Remote Session Stability

Use as reference architecture first; copy only clearly open-source client/server
pieces if needed.

Codex remote control is partly public CLI/app-server machinery and partly hosted
Codex app/service behavior. The public manual says mobile setup starts from the
Codex App, not the CLI or IDE extension, and that remote access depends on a
secure relay layer plus an awake, online host. Treat the hosted relay/product
behavior as inspiration, not Apache-derived source.

Open-source pieces worth studying:

- `codex-rs/app-server/README.md`
- `codex-rs/app-server-transport/src/transport/remote_control/`
- `codex-rs/app-server-daemon/src/remote_control_client.rs`
- `codex-rs/app-server-client/src/remote.rs`

Push-native lessons to consider:

- Thread/session state should be resumable by durable id, not by one socket.
- Clients should subscribe, reconnect, and hydrate from persisted state.
- Active turns need explicit status transitions and cancellation semantics.
- Pairing, token refresh, stale enrollment, and reconnect behavior need tests.
- The relay should not be treated as the source of truth for the transcript.

### 9. Config Layers and Managed Policy

Reuse posture: later-stage reference; avoid early copy unless Push needs
enterprise-style governance.

Codex's layered config, requirements, project trust, managed defaults, and
policy composition are mature. Push's current config is intentionally simpler.
This belongs on the list because it is a likely future pressure point, but it is
not an immediate code-reuse target.

Candidate upstream paths:

- `codex-rs/config/src/loader/`
- `codex-rs/config/src/requirements_layers/`
- `codex-rs/config/src/thread_config/`

## Non-Candidates For Copying

These can still inspire product decisions, but they should not be imported as
source unless the architecture changes substantially:

- Full Codex TUI implementation.
- OpenAI-specific provider/client stack.
- Codex session/thread store wholesale.
- Codex prompts or role architecture beyond narrowly attributed prompt
  templates.
- Hosted Codex app or cloud behavior that is not present in the Apache-licensed
  source tree.

## Rules

1. Keep derived code isolated.
   Prefer a clearly named module, such as `cli/command-policy/codex-derived/`,
   wrapped by Push-native code.

2. Preserve attribution.
   Record the upstream project, source URL, exact commit SHA, original copyright
   notice, and license.

3. Include the Apache license text.
   Keep the license text in `third_party/licenses/Apache-2.0.txt`.

4. Maintain `NOTICE`.
   If the upstream work ships a `NOTICE`, preserve the relevant attribution in
   Push's root `NOTICE`.

5. Mark modified files.
   Any copied, translated, or substantially derived file should carry a clear
   modification notice.

6. Track prompt material too.
   Prompts and templates can be copyrightable. If a prompt is copied or closely
   adapted from Apache-licensed source, list it in `NOTICE` and mark the local
   file.

7. Keep `NOTICE` current, not speculative.
   `NOTICE` is for material actually included in Push. Future candidates belong
   in this draft's candidate register until code, tests, prompts, or component
   APIs are copied, translated, or substantially adapted.

8. Avoid trademark drift.
   Use OpenAI and Codex names only for factual attribution, not product naming
   or endorsement.

## Source Header Template

```ts
/*
 * Portions derived from OpenAI Codex:
 * https://github.com/openai/codex
 * Source revision: db887d03e1f907467e33271572dffb73bceecd6b
 *
 * Copyright 2025 OpenAI
 * Licensed under the Apache License, Version 2.0.
 *
 * Modifications Copyright (c) 2026 Shawn Montgomery
 * SPDX-License-Identifier: Apache-2.0
 */
```

Use `SPDX-License-Identifier: Apache-2.0` for derived files. Push-native wrapper
files can remain MIT.

## Prompt-Only Adaptations

If only a prompt, template, or small component API shape is adapted inside an
otherwise Push-native file, do not automatically label the whole file as
Apache-derived. Prefer a focused source comment near the adapted material plus a
path-level entry in `NOTICE`.

That is the deliberate treatment for `lib/llm-compaction.ts`: the compaction
prompt and handoff-prefix idea are attributed, while the surrounding runtime
implementation remains Push-native. A full Apache SPDX header is reserved for
files that are copied, translated, or substantially derived as source files.

## Suggested Layout

```text
cli/command-policy/
  index.ts
  codex-derived/
    README.md
    shell-safety.ts
    shell-safety.test.mjs
third_party/licenses/
  Apache-2.0.txt
NOTICE
```

For prompt-only adaptations, the source can stay near the owning runtime module
if moving it would make the code less clear. In that case, add a source comment
and list the file in `NOTICE`.

## README License Wording

The root README should say that Push's original code is MIT licensed, and that
third-party or derived portions may carry their own permissive license terms and
notices. It should not imply the whole project has been relicensed to Apache.

## Activation Checklist

- Copy or port only the files/tests actually needed.
- Record upstream file paths and the exact source revision in `NOTICE`.
- Add Apache headers to derived files.
- Keep Push-native adapters separate where practical.
- Run the relevant derived-module tests plus the normal CLI validation suite.
- Re-read the rendered README and NOTICE before publishing.
