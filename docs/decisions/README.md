# Decisions Folder

Status reviewed: 2026-06-07

This folder is the small, live doorway into Push's architecture decisions.
Older per-topic decision docs have moved to [`../archive/decisions/`](../archive/decisions/README.md)
as source notes and shipping provenance.

## Current Operating Decisions

| Document | Owns |
|---|---|
| [`Agent Runtime Decisions.md`](<Agent Runtime Decisions.md>) | Agent loop shape, runtime protocol, role/display vocabulary, memory, prompt packing, task graph, tool dispatch, loop detection, and TUI decomposition. |
| [`Platform, Sessions, and Sandbox Decisions.md`](<Platform, Sessions, and Sandbox Decisions.md>) | Auth, session/bearer model, remote relay, sandbox providers, background execution, provider observability, PR review automation, repo mirror, and git/RPC seams. |

## Status Vocabulary

The canonical `Status:` labels. A decision doc's field uses one, optionally with
a parenthetical qualifier (e.g. `(partially implemented)`, `(Reference)`):

- **Current** — the operating contract for new work; describes shipped/live behavior.
- **Draft** — design-in-motion; implementation still needs an owner commitment.
- **Reference** — useful context, not an active task list.
- **Historical** — provenance only; prefer the live docs above unless you need history.
- **Superseded by `<doc>`** / **Merged into `<doc>`** — pointer statuses: this doc's content moved to `<doc>`; follow the pointer.

This list is the single source of truth for the vocabulary — CLAUDE.md and other
docs point here rather than restating it.

## Editing Rules

- Update one of the two live decision docs when a decision changes.
- When shipping work that changes an active decision, flip the relevant status
  in the live doc in the same PR.
- Do not keep new research snapshots in this folder by default. Put raw
  research under `docs/research/`, implementation plans under `docs/runbooks/`,
  and completed provenance under `docs/archive/decisions/`.
- If a live decision conflicts with code, prefer the code and refresh the doc.

## Archive

The old decision set is preserved in [`../archive/decisions/README.md`](../archive/decisions/README.md).
Those files are intentionally not the first stop for future agents.
