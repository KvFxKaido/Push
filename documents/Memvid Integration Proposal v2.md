# Memvid Integration Proposal v2

> **Status:** Revised Draft
> **Previous:** v1 (Council Reviewed — Gemini, Codex)
> **This revision:** Claude Opus 4.6
> **Date:** 2025-02-05

## What Changed

The original proposal was triggered by a specific moment: Kimi referenced "Shawn Montgomery" without knowing that's who she was talking to. That's not a memory problem — it's a missing identity context problem. This revision separates **identity** (who am I talking to?) from **memory** (what have we discussed before?) and sequences them correctly.

Additionally, Push is built with shareability in mind. All memory features must be generic — scoped to authenticated users, not hardcoded to any individual. This constraint improves the architecture.

---

## Trigger Analysis

| Symptom | Root Cause | Fix |
|---------|-----------|-----|
| Kimi doesn't know user's name | No identity in system prompt | Phase 0: User context injection |
| Kimi forgets last session's work | No cross-session persistence | Phase 2: Memory writes |
| Kimi can't search past decisions | No semantic retrieval | Phase 3: Memory reads |

The original proposal jumped to Phase 2/3 solutions for a Phase 0 problem.

---

## Revised Phases

### Phase 0: User Context Injection (Ship Now)

**Problem:** Kimi starts every session as a stranger.

**Fix:** Pull identity from the GitHub PAT validation already happening at onboarding (`GET /user` returns `name`, `login`, `avatar_url`) and inject it into the Orchestrator's system prompt:

```
You are assisting {{user.name}} (GitHub: @{{user.login}}).
When you see commits, PRs, or comments by this user, that's who you're talking to.
```

**Scope:**
- Modify system prompt template in orchestrator
- Use existing `GET /user` response (no new API calls)
- Works for any authenticated user automatically

**Cost:** A few lines. No dependencies, no storage, no latency.

**Validation:** Use Push for a week. Keep a running list of moments where "she should have known that." That list becomes the real requirements doc for memory.

---

### Phase 1: Shadow Mode (Evaluate Before Committing)

Unchanged from v1. Before injecting memories into prompts, log what *would* be retrieved.

- At session end, generate a 3-5 sentence summary via Kimi
- Store as JSON in Cloudflare KV (keyed `userId/repoId`)
- On next session start, log the summary but don't inject it
- Evaluate: is the summary actually useful? Would it have improved the session?

**Why KV first:** Validates the concept with zero new dependencies. If summaries don't help, you've saved yourself from building a memory layer nobody needed. If they do, Memvid becomes the upgrade path for richer retrieval.

---

### Phase 2: Memory Writes via Modal

**Architecture decision:** Memvid runs server-side on Modal, not on the edge.

Push already has a working pattern: Cloudflare Worker proxies to Modal for sandbox operations. Memory follows the same pattern.

| Component | Runs On | Why |
|-----------|---------|-----|
| Kimi proxy | Cloudflare Worker | Hottest path, needs edge latency |
| GitHub API | Cloudflare Worker | Simple proxy, fast |
| Sandbox | Modal | Needs full container runtime |
| **Memory writes** | **Modal** | Needs `memvid-sdk` (Python), embedding models |
| **Memory reads** | **Modal (with KV cache)** | See Phase 3 |

**Why not Kimi on Modal?** The Kimi proxy is the hottest path — every message, streaming, token by token. Workers are edge-deployed with zero cold start. Modal cold starts would kill the feel on mobile. Keep the current split: Worker for fast stuff, Modal for heavy compute.

**Implementation:**
- New Modal endpoint: `POST /api/memory/write`
- Worker route: `/api/memory/*` → Modal proxy
- At session end, fire-and-forget summary to Modal
- Modal runs `memvid-sdk`, generates embeddings, appends to `.mv2` file
- `.mv2` files stored on Cloudflare R2 (source of truth)
- No latency pressure — user is already leaving the session

**Prior art:** SENTINEL's `memvid_adapter.py` provides a working pattern:
- Turn states saved as Smart Frames
- Hinge moments tagged for priority retrieval
- Per-entity queryable history
- `.mv2` files stored alongside campaign data

Push adapts this pattern with `userId/repoId` namespacing instead of campaign scoping.

**What gets stored (strict write filters):**
- Conversation summaries about this codebase
- Architecture decisions discussed with the user
- Bugs fixed and rationale
- User preferences (coding style, patterns they like)
- Never raw user input — only LLM-generated summaries

---

### Phase 3: Memory Reads at Session Start

This is the latency-critical path. User opens Push, selects a repo, and expects context before the first message.

**Two-tier read strategy:**

1. **Fast path (KV cache):** On every memory write, also write the latest summary to Cloudflare KV. On session start, read from KV (sub-millisecond). Inject into system prompt immediately.

2. **Rich path (Memvid on Modal):** After the session starts, trigger a background fetch to Modal for semantic search across full memory. Inject additional context into subsequent messages if relevant.

This means the first message always has *some* context (the KV summary), and deeper memories arrive asynchronously. No cold start blocking the experience.

**User experience:**
- Return to a repo after days → Kimi has basic context immediately
- Deeper context surfaces naturally as the conversation develops
- No loading spinners, no "retrieving memories..." delays

---

### Phase 4: Searchable Scratchpad + User Control

Upgrade the current localStorage scratchpad to Memvid-backed searchable memory.

- Replace text blob with structured, searchable entries
- Kimi can query scratchpad contextually during conversation
- **Pin/forget UX** — user controls what persists
- Memory inspector — view what's stored per repo

Deferred until Phases 2-3 prove memory is valuable.

---

### Phase 5: Shadow Auditing + Task Resumption

- Auditor queries past bugs during code review
- Store task state for instant context restore
- "Continue where you left off" on session start

Deferred until core memory loop is validated.

---

### Phase 6: Codebase Semantic Indexing (Optional/Separate)

> **Recommendation unchanged:** Defer or implement as separate pipeline.

Highest risk due to stale index problems. If implemented:
- Commit-scoped (tied to specific SHA)
- Separate from chat memory
- Server-side only (Modal)
- Incremental updates on file changes

---

## Memory Architecture

### Memory Types (unchanged from v1)

```ts
type MemoryType =
  | 'preference'   // User coding style, patterns
  | 'decision'     // Architecture choices made
  | 'repo_fact'    // Facts about the codebase
  | 'task_state'   // Current work in progress
  | 'bug_fix';     // Bugs fixed and rationale

interface Memory {
  id: string;
  type: MemoryType;
  content: string;
  embedding: number[];

  provenance: {
    messageId?: string;
    toolCall?: string;
    commitSha?: string;
    timestamp: Date;
  };

  ttl?: number;
  confidence: number;  // 0-1
  pinned: boolean;
}
```

### Retrieval Strategy (unchanged from v1)

Hybrid: vector similarity + BM25 keyword match + recency weighting.

### Namespacing (unchanged from v1)

```
{userId}/{repoId}/memory.mv2
```

Strict isolation. No cross-repo, no cross-user. User ID from GitHub OAuth, repo ID from active selection.

---

## Storage Architecture (Revised)

| Layer | Technology | Purpose | Phase |
|-------|------------|---------|-------|
| Identity | System prompt injection | User name/login from GitHub | 0 |
| Summary cache | Cloudflare KV | Fast reads, last session context | 1-2 |
| Memory store | Cloudflare R2 | `.mv2` files, source of truth | 2 |
| Memory compute | Modal | Embeddings, semantic search | 2-3 |
| Scratchpad | Memvid (IndexedDB + R2) | Searchable user notes | 4 |

**Removed from v1:** IndexedDB as a general cache layer. Premature for the MVP. KV handles the fast-read case; IndexedDB comes in Phase 4 with the scratchpad if needed.

---

## Security Considerations

Unchanged from v1. Key risks:

1. **HIGH: Prompt injection persistence** — Never store raw user input. Only LLM-generated summaries. Content review before writes. User can inspect and delete.
2. **HIGH: Cross-repo leakage** — Strict `userId/repoId` namespacing. Memory queries scoped to active repo only.
3. **MEDIUM: Stale memory degradation** — Recency weighting, confidence decay, compaction, user forget controls.

---

## Open Questions (Revised)

1. **~~Embedding model?~~** → Resolved: Server-side on Modal. Use whatever SENTINEL's adapter uses as the starting point (bge-base-en-v1.5 via ONNX). Evaluate Kimi embeddings if/when available.

2. **Compaction strategy?** → Still open. Defer to Phase 3 when we have real data on growth rates.

3. **~~Conflict resolution?~~** → Simplified: KV for fast reads (last-write-wins is fine for summaries), R2 for source of truth, no bidirectional sync needed until Phase 4.

4. **Memory size limits?** → Still open. Start uncapped, measure, then set limits based on actual usage.

5. **NEW: Modal cold start latency for reads?** → Mitigated by two-tier read strategy (KV fast path + Modal background). Measure actual P50/P99 in Phase 3.

---

## Decision Log

| Decision | Rationale |
|----------|-----------|
| Kimi stays on Cloudflare Worker | Hottest path, needs edge latency. Modal cold starts unacceptable for streaming. |
| Memory compute on Modal | Needs Python SDK, embedding models. Same pattern as sandbox. |
| Phase 0 before memory | Solve identity first. Validate memory need through lived experience. |
| KV before Memvid for reads | Fast path that works without Modal spin-up. Memvid is the upgrade, not the baseline. |
| Separate from SENTINEL | Different domains, schemas, retrieval patterns. Share the *pattern*, not the data. |
| No IndexedDB in MVP | Premature complexity. KV handles fast reads. IndexedDB comes with scratchpad in Phase 4. |
| Shareability over personalization | Build for any authenticated user. No hardcoded identity. |

---

## Next Actions

- [ ] **Phase 0:** Add `{{user.name}}` / `{{user.login}}` to Orchestrator system prompt
- [ ] Use Push for 1 week, document "she should have known that" moments
- [ ] Evaluate whether those moments justify Phase 1
- [ ] If yes, implement KV-based session summaries (Phase 1)
