# Push — Agent Context

This file is a compatibility shim for agents. The canonical detailed source is [CLAUDE.md](CLAUDE.md).

## Quick pointers

- Push is a mobile-first AI coding notebook with a web app and local CLI.
- Core roles: Orchestrator, Explorer, Coder, Reviewer, Auditor.
- Repo chats are branch-scoped, and repo work follows a PR-based merge flow.
- Delegated Coder and Explorer runs inherit the current chat-locked provider/model.
- Scratch workspaces are available when GitHub auth is not needed.

Refer to [CLAUDE.md](CLAUDE.md) for the full architecture, workflow, and tool protocol details.
