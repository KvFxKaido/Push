# Memvid Integration Proposal

> **Status:** Draft (Council Reviewed)
> **Source:** [github.com/memvid/memvid](https://github.com/memvid/memvid)
> **Reviewed by:** Gemini, Codex

## What is Memvid?

Memvid is a single-file memory layer for AI agents. Instead of complex RAG pipelines or server-based vector databases, it packages data, embeddings, search structure, and metadata into one portable file.

**Key properties:**
- Append-only, crash-safe storage (inspired by video codecs)
- Ultra-fast retrieval (~0.025ms P50)
- Works offline, no infrastructure dependencies
- Supports text, PDF, images (CLIP), audio (Whisper)
- SDKs for Node.js, Python, Rust

## Why Consider This for Push?

Push currently has:
- **Rolling window** (30 messages) — forgets older context
- **Scratchpad** (localStorage) — simple text blob, no search
- **No cross-session memory** — each session starts fresh

Memvid could address the "why doesn't it remember?" problem without adding backend infrastructure.

---

## Integration Options

### 1. Per-Repo Memory (Primary Proposal)

Each repo gets a `.memvid` file that accumulates knowledge over time:

```
storage/
  {userId}/{repoId}/
    memory.memvid    ← persistent memory for this repo
```

**What gets stored:**
- Conversation summaries about this codebase
- Architecture decisions discussed with the user
- Bugs fixed and rationale
- User preferences (coding style, patterns they like)
- Task state for resumption (current file, immediate goal)

**User experience:**
- Return to a repo after days → Kimi remembers context
- "Last time we discussed refactoring the auth flow. Want to continue?"
- No manual context-setting needed

**Implementation:**
- Store in Cloudflare R2 (source of truth) with IndexedDB cache (local speed)
- On session start, load relevant memories into system prompt
- On session end, summarize and append new learnings

---

### 2. Searchable Scratchpad

Upgrade the current scratchpad from text blob to searchable memory:

**Current:**
```
localStorage: "scratchpad" → "Remember: use kebab-case for routes..."
```

**With Memvid:**
```ts
// User writes notes over multiple sessions
scratchpad.append("Use kebab-case for routes");
scratchpad.append("Error handling: always return structured JSON");
scratchpad.append("Auth: JWT tokens, 1hr expiry");

// Kimi can query contextually
const relevant = await scratchpad.search("how should errors be formatted?");
// → Returns the error handling note
```

**Benefits:**
- Notes accumulate without getting unwieldy
- Kimi finds relevant notes automatically
- Nothing gets buried or forgotten
- User can pin/forget specific memories

---

### 3. Shadow Auditing (Auditor Enhancement)

The Auditor queries past bugs during code review:

```ts
// During sandbox_commit review
const pastBugs = await memory.search("bugs fixed in auth module");
// Auditor checks if current diff might reintroduce similar issues
```

**Benefits:**
- Prevents regression of previously fixed logic errors
- Auditor has historical context without bloating prompts
- Learns from the repo's bug history

---

### 4. Audit Trail

Log every commit decision with full context:

```ts
interface AuditEntry {
  timestamp: Date;
  diff: string;
  verdict: 'SAFE' | 'UNSAFE';
  reasoning: string;
  userOverride?: boolean;
  provenance: {
    messageId: string;
    commitSha?: string;
  };
}

// Append-only, tamper-evident
await auditLog.append(entry);
```

**Benefits:**
- "Why did we ship this?" is always answerable
- Compliance-friendly (immutable log)
- Debug production issues by reviewing decision history

---

### 5. Codebase Semantic Search (Deferred)

> **Council recommendation:** Defer to Phase 4 or implement as separate pipeline.

Index repo files into memvid for semantic retrieval. High complexity due to:
- Code changes frequently — stale index causes hallucinations
- Requires file-watcher/indexer running in background
- Invalidation on every commit/branch switch

If implemented, should be:
- Commit-scoped (tied to specific SHA)
- Separate from chat memory
- Server-side only (Modal)

---

## Memory Architecture

### Memory Types (Policy Layer)

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

  // Provenance (for debugging and citations)
  provenance: {
    messageId?: string;
    toolCall?: string;
    commitSha?: string;
    timestamp: Date;
  };

  // Lifecycle
  ttl?: number;        // Optional expiry
  confidence: number;  // 0-1, for relevance ranking
  pinned: boolean;     // User-protected from compaction
}
```

### Retrieval Strategy (Hybrid)

Not just vector similarity — combine multiple signals:

```ts
interface RetrievalQuery {
  text: string;
  weights: {
    vector: number;    // Semantic similarity
    keyword: number;   // BM25 text match
    recency: number;   // Prefer recent memories
  };
  filters?: {
    types?: MemoryType[];
    minConfidence?: number;
    maxAge?: number;
  };
}
```

### Namespacing (Security)

Strict isolation to prevent cross-repo/user leakage:

```
{userId}/{repoId}/memory.memvid
```

- User ID from GitHub OAuth
- Repo ID from active repo selection
- Branch-specific memories optional (Phase 2+)

---

## Security Considerations

### HIGH: Prompt Injection Persistence

**Risk:** Malicious content gets stored in memory, then re-injected into future sessions forever.

**Mitigations:**
- Sanitize content before storing (escape injection patterns)
- Never store raw user input — only LLM-generated summaries
- Content review before memory write (similar to Auditor pattern)
- User can inspect and delete any memory

### HIGH: Cross-Repo Leakage

**Risk:** Memories from repo A surface when working on repo B.

**Mitigations:**
- Strict `userId/repoId` namespacing
- Memory queries scoped to active repo only
- No "global" memory pool

### MEDIUM: Stale Memory Degradation

**Risk:** Old/wrong memories outrank fresh context, confusing the LLM.

**Mitigations:**
- Recency weighting in retrieval
- Confidence decay over time
- Periodic compaction/summarization
- User can "forget" outdated memories

---

## Recommended Approach

### Phase 0: Shadow Mode (New)
- Log what memories *would* be retrieved
- Don't inject into prompts yet
- Evaluate retrieval quality before going live
- Build confidence in the system

### Phase 1: Per-Repo Memory (MVP)
- Single memory file per repo
- Store decisions/preferences only (strict write filters)
- Provenance on every memory
- Load top-k relevant memories on session start
- Minimal UI change — memory works invisibly

### Phase 2: Searchable Scratchpad + User Control
- Replace localStorage scratchpad with memvid-backed store
- Add search capability to scratchpad UI
- **Pin/forget UX** — user controls persistence
- Memory inspector (view what's stored)

### Phase 3: Shadow Auditing + Task Resumption
- Auditor queries past bugs during review
- Store task state for instant context restore
- "Continue where you left off" on session start

### Phase 4: Codebase Indexing (Optional/Separate)
- Separate code index pipeline (not mixed with chat memory)
- Commit-scoped indexing
- Server-side only (Modal)
- Incremental updates on file changes

---

## Open Questions

1. **Embedding model?**
   - Server-side recommended (avoid mobile bundle bloat)
   - Options: OpenAI embeddings, Kimi endpoint (if available), or quantized model on Modal
   - Council consensus: avoid client-side embedding on mobile

2. **Compaction strategy?**
   - Append-only grows forever
   - Need periodic summarization jobs
   - When to compact? (Size threshold? Time-based?)

3. **Conflict resolution?**
   - IndexedDB cache + R2 source of truth
   - What happens on reconnect with local changes?
   - "Last write wins" or merge strategy?

4. **Memory size limits?**
   - How much history is useful vs. noise?
   - Per-repo limits? Per-type limits?

---

## Storage Architecture

**Recommended (Hybrid):**

| Layer | Technology | Purpose |
|-------|------------|---------|
| Cache | IndexedDB | Fast local reads, offline support |
| Source of Truth | Cloudflare R2 | Durable storage, cross-device sync |
| Metadata | Cloudflare KV | Pointers, last-sync timestamps |

**Avoid:**
- Modal as canonical store (cold starts, session-scoped)
- Git repo (binary conflicts, size bloat)
- localStorage (size limits, no structure)

---

## Dependencies

```bash
npm install @memvid/sdk    # ~200KB, no native deps
```

Embedding generation should happen server-side (Cloudflare Worker or Modal).

---

## Decision Requested

- [ ] Proceed with Phase 0 (shadow mode) prototype?
- [ ] Need more research on embedding costs?
- [ ] Design pin/forget UX before implementation?
- [ ] Defer — current scratchpad + rolling window is sufficient?

---

## Council Review Summary

**Reviewed:** 2025-02-04
**Consultants:** Gemini (architecture), Codex (implementation)

**Key agreements:**
- Phase 3 (codebase indexing) is highest risk — defer or separate
- Hybrid storage (local cache + cloud sync) is correct approach
- Avoid heavy local embedding models on mobile
- User control (pin/forget) is essential
- Prompt injection persistence is a serious risk

**Additions from review:**
- Phase 0 shadow mode for evaluation
- Memory provenance for debugging
- Hybrid retrieval (vector + keyword + recency)
- Strict namespacing for security
- Memory type classification with TTL/confidence
