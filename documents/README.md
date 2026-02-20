# Documents Index

Use this file to quickly identify which planning docs are authoritative vs historical.

## Active

- `Harness Reliability Plan.md`
  - Status: Active harness strategy and experiment roadmap (hashline included as one track).
- `Background Coder Tasks Plan.md`
  - Status: Draft plan for server-side background coding runs and reconnectable job timelines.
- `Push CLI Plan.md`
  - Status: Active draft for interactive-first CLI and runtime architecture.
- `Push Runtime Protocol.md`
  - Status: Active draft protocol spec for `pushd` client/runtime messaging.
- `schemas/` (see `schemas/README.md`)
  - Status: Active draft JSON Schemas for runtime protocol envelopes and payloads.
- `SECURITY_AUDIT.md`
  - Status: Security findings and mitigation history.

## Pointer

- `Roadmap.md`
  - Status: Deprecated pointer.
  - Canonical roadmap lives at `../ROADMAP.md`.

## Archive

- `archive/Workspace Hub Sprint Plan.md`
  - Status: Historical/superseded by implementation and `../ROADMAP.md`.
- `archive/PR and Branch Awareness.md`
  - Status: Historical planning reference; branch model now codified in root docs and code.
- `archive/Memvid Integration Proposal.md`
  - Status: Historical proposal; relevant shipped pieces are reflected elsewhere.
- `Browserbase Integration Spike.md`
  - Status: Historical implementation spike; browser tools are now part of baseline docs.
- `Push CLI Bootstrap Execution Plan.md`
  - Status: Completed execution record for the bootstrap hardening/modularization/`pushd` skeleton sprint on 2026-02-20.

## Promotion Rule

If a draft in `documents/` becomes an implementation commitment, promote a concise version into `../ROADMAP.md` first.
