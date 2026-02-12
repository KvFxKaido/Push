# Hashline Edit Tool Spike (Push)

## Status
- Last updated: 2026-02-12
- State: Exploratory — not yet implemented
- Source of truth: This document

## Context

Can Bölük's article "The Harness Problem" ([blog.can.ac](https://blog.can.ac/2026/02/12/the-harness-problem/)) demonstrates that edit tool choice has a larger impact on coding agent success rates than most model upgrades. His benchmark of 16 models with 3 edit formats found:

- Gemini improved **8%** just from changing edit format (bigger than typical model upgrades)
- Grok Code Fast went from **6.7% to 68.3%** (10x improvement)
- Weaker models gained the most from better edit tools
- Output tokens dropped **~20%** across models (fewer retry loops)

**Core insight:** Current edit tools (`apply_patch`, `str_replace`, Cursor's 70B merge model) all force the model to reproduce content it already saw to prove it knows what it's editing. When reproduction fails (whitespace, exact match, partial recall), the edit fails, and users blame the model instead of the harness.

**Hashline approach:** Tag every line with a 2-3 character content hash when the model reads files. The model references tags (`replace line 2:f1`, `insert after 3:0e`) instead of reproducing exact text. If the file changed since last read, the hash won't match and the edit is rejected before corruption.

## Why This Matters for Push

Push has unique advantages for testing hashline:

1. **Complete harness control** — Repo-locked context, three-agent architecture, full sandbox ownership
2. **Multi-provider support** — Kimi/Mistral/Ollama mean we'd see differential gains like Bölük's benchmarks
3. **Mobile-first constraint** — Edit reliability matters even more on glass than desktop
4. **Current pain point** — `str_replace` has "String to replace not found in file" as Claude Code's [most common failure mode](https://github.com/anthropics/claude-code/issues/3471)
5. **Clean separation** — Infrastructure layer (Modal, sandbox-client) is already decoupled from core logic

## Current Edit Mechanism

**Tool:** `sandbox_write_file(path, content)`
- Complete file replacement only
- Model must reproduce entire file perfectly
- No anchoring mechanism
- No staleness detection
- Whitespace/indentation mismatches common

**Problems:**
- Large files risk truncation (MAX_TOOL_RESULT_SIZE = 24k chars)
- No way to express partial edits
- Agent retry loops burn tokens
- Coder timeout (180s) includes retry overhead

## Hashline Design

### Reading Files

When the model reads a file via `sandbox_read_file`, each line gets tagged:

```
11:a3|function hello() {
22:f1|  return "world";
33:0e|}
```

Format: `{line_number}:{hash}|{content}`

**Hash properties:**
- 2-3 chars (base62: `[0-9a-zA-Z]`)
- Derived from line content (stable)
- Collision-resistant within typical file sizes
- NOT cryptographic (speed matters, security doesn't)

### Edit Operations

New tool: `sandbox_edit_file(path, edits)`

```json
{
  "tool": "sandbox_edit_file",
  "args": {
    "path": "/workspace/src/utils.ts",
    "edits": [
      {
        "type": "replace_line",
        "ref": "22:f1",
        "new_content": "  return 'hello';"
      },
      {
        "type": "insert_after",
        "ref": "33:0e",
        "new_content": "\nfunction goodbye() {\n  return 'bye';\n}"
      },
      {
        "type": "replace_range",
        "start_ref": "11:a3",
        "end_ref": "33:0e",
        "new_content": "export default {\n  hello: () => 'world'\n};"
      }
    ]
  }
}
```

**Edit types:**
- `replace_line` — swap single line
- `replace_range` — swap contiguous block
- `insert_after` — add content after a line
- `insert_before` — add content before a line
- `delete_line` — remove single line
- `delete_range` — remove contiguous block

**Validation rules:**
1. Read current file
2. Hash each line
3. For each edit, verify ref hash matches current content
4. If any mismatch → abort entire edit batch with staleness error
5. If all match → resolve all refs to line numbers, then apply edits **bottom-to-top** (highest line numbers first, so insertions/deletions don't shift earlier refs)
6. Return new file with updated hashline annotations (agent needs fresh refs for subsequent edits; UI card can show a diff)

### Staleness Detection (Free)

If Coder references `2:f1` but Auditor sees a different hash for line 2, that's an automatic signal that:
- Working tree is dirty
- File was modified between read and edit
- Context is stale

No additional staleness mechanism needed — the hash mismatch is the signal.

### Backward Compatibility

Keep `sandbox_write_file` for full-file replacement (e.g., new files, binary data, template generation).

Deprecation path:
1. Ship `sandbox_edit_file` alongside `sandbox_write_file`
2. Update prompts to prefer edit tool
3. Monitor usage split
4. Eventually deprecate write tool for edits (keep for new files)

## Implementation Plan

### Phase 1: Backend (Modal)

**File:** `sandbox/app.py`

Add hashline utilities:
```python
def hash_line(content: str) -> str:
    """2-3 char base62 hash of line content (CRC16 or FNV-1a)"""
    pass

def annotate_file(content: str) -> str:
    """Return content with hashline tags"""
    lines = content.splitlines(keepends=False)
    tagged = []
    for idx, line in enumerate(lines, start=1):
        h = hash_line(line)
        tagged.append(f"{idx}:{h}|{line}")
    return "\n".join(tagged)

def apply_hashline_edits(path: str, edits: list[dict]) -> dict:
    """Validate refs, apply edits, return result or error"""
    pass
```

Add endpoint:
```python
@app.function(image=endpoint_image)
@modal.fastapi_endpoint(method="POST")
def edit_file(data: dict):
    """Apply hashline edits to a file"""
    pass
```

**Estimated effort:** 4-6 hours
- Hash function (CRC16 via zlib.crc32, mod to base62)
- Edit validation logic
- Edit application (line replacement, insertion, deletion)
- Error handling (staleness, invalid refs)

### Phase 2: Frontend (TypeScript)

**File:** `app/src/lib/sandbox-client.ts`

Add client function:
```typescript
export async function editInSandbox(
  sandboxId: string,
  path: string,
  edits: Array<{
    type: 'replace_line' | 'replace_range' | 'insert_after' | 'insert_before' | 'delete_line' | 'delete_range';
    ref?: string;
    start_ref?: string;
    end_ref?: string;
    new_content?: string;
  }>,
): Promise<{ ok: boolean; diff?: string; error?: string }> {
  // POST to /api/sandbox/edit-file via Worker
}
```

**File:** `app/src/lib/sandbox-tools.ts`

Add tool definition:
```typescript
type SandboxEditFileCall = {
  tool: 'sandbox_edit_file';
  args: {
    path: string;
    edits: Array<EditOperation>;
  };
};
```

Update `validateSandboxToolCall` and `executeSandboxToolCall`.

Update `SANDBOX_TOOL_PROTOCOL` prompt:
```markdown
- sandbox_edit_file(path, edits) — Apply precise line-based edits using hashline references.
  When you read a file, each line has a tag like `22:f1|content`. Reference these tags
  in your edits instead of reproducing content. If the file changed since you read it,
  the edit will be rejected (staleness protection).
```

**Estimated effort:** 3-4 hours
- Type definitions
- Tool validation
- Execution logic
- Prompt updates

### Phase 3: Worker Proxy

**File:** `app/worker.ts`

Add route:
```typescript
if (url.pathname === '/api/sandbox/edit-file') {
  const body = await request.json();
  const modalResp = await fetch(`${MODAL_BASE}/edit-file`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  // ...
}
```

**Estimated effort:** 30 minutes

### Phase 4: Annotate File Reads

**File:** `sandbox/app.py` (modify `file_ops` endpoint)

When `operation === 'read'`, accept optional params:
- `annotate` (bool, default false) — add hashline tags
- `start_line` / `end_line` (int, optional) — read a range instead of the full file

```python
content = ...  # existing read logic
if start_line or end_line:
    lines = content.splitlines(keepends=False)
    content = "\n".join(lines[start_line-1:end_line])
if annotate:
    content = annotate_file(content, start_line=start_line or 1)
return {"ok": True, "content": content, "truncated": truncated}
```

The Coder agent passes `annotate: true`; the Orchestrator does not.
Line-range reads pair naturally with hashline — read lines 200-300 with annotations, edit just those lines. This also mitigates annotation-induced truncation on large files.

**File:** `app/src/lib/sandbox-tools.ts` (modify `sandbox_read_file` execution)

Strip hashline tags before showing user:
```typescript
const result = await readFromSandbox(sandboxId, call.args.path);
// result.content has hashline tags
const strippedContent = result.content
  .split('\n')
  .map(line => line.replace(/^\d+:[a-zA-Z0-9]+\|/, ''))
  .join('\n');

// Show stripped version in card, but keep original in tool result for agent
```

**Estimated effort:** 2-3 hours
- Backend annotation (opt-in flag + range reads)
- Frontend stripping for UI
- Preserve hashlines in tool result for agent context

### Phase 5: Prompt Engineering

Update `CODER_SYSTEM_PROMPT` in `app/src/lib/coder-agent.ts`:

```markdown
When editing files:
1. Use sandbox_read_file to see current content (lines will be tagged like `22:f1|content`)
2. Use sandbox_edit_file to make changes by referencing line tags
3. Do NOT reproduce entire files with sandbox_write_file unless creating new files
4. Multiple edits in one call are applied atomically
5. If any ref is stale, the entire edit batch fails — read the file again

Example workflow:
- sandbox_read_file("/workspace/src/app.ts")
- Review tagged content: `11:a3|function foo() {`
- sandbox_edit_file with edits: `[{type: "replace_line", ref: "11:a3", new_content: "function bar() {"}]`
```

**Estimated effort:** 1 hour

### Phase 6: Testing

Add test suite in `app/src/lib/sandbox-tools.test.ts`:

```typescript
describe('sandbox_edit_file', () => {
  it('validates hashline refs', () => { });
  it('detects stale refs', () => { });
  it('applies replace_line edits', () => { });
  it('applies replace_range edits', () => { });
  it('applies insert_after/before edits', () => { });
  it('applies delete_line/range edits', () => { });
  it('rejects edits with invalid refs', () => { });
  it('applies multiple edits atomically', () => { });
});
```

Add integration test with real sandbox (opt-in):
```typescript
describe('hashline integration', () => {
  it('round-trip: read annotated → edit → verify', async () => {
    // requires MODAL_SANDBOX_ID env var
  });
});
```

**Estimated effort:** 3-4 hours

## Total Implementation Effort

**Estimated:** 14-20 hours (2-3 focused work sessions)

Breakdown:
- Backend hashline utils + endpoint: 4-6h
- Frontend tool definition + client: 3-4h
- Worker routing: 0.5h
- File read annotation + range reads: 2-3h
- Prompt engineering: 1h
- Testing: 3-4h

**Prerequisite:** Run micro-test (1-2h) to validate that each provider can emit valid hashline edits from prompt examples before committing to the full build.

## Risks and Mitigations

### Risk: Hash collisions in large files

**Likelihood:** Low (CRC16 over 65k values, typical files <1000 lines)

**Mitigation:**
- Use 3-char base62 (238k namespace) instead of 2-char (3.8k)
- Hash is **content-only** (no line number baked in) — the ref format `line_number:hash` is already unique even for identical lines. Including line number in the hash would make every ref brittle to insertions (adding a blank line above would invalidate all subsequent hashes even though content didn't change)
- Log collision rate in metrics

### Risk: Model doesn't learn hashline syntax

**Likelihood:** Medium-High — this is the make-or-break risk

The models haven't been trained on this format. Bölük designed his format to be LLM-friendly, but Kimi K2.5, Devstral, and GLM may or may not pick it up from prompt examples alone.

**Mitigation:**
- **Micro-test before building the full pipeline:** Give each provider a hashline-annotated file in a system prompt with edit instructions. If 2/3 providers can't emit valid `sandbox_edit_file` JSON on the first try, reassess the investment
- Prompt examples with hashline edits
- Fallback to `sandbox_write_file` if edit tool fails
- Gradual rollout (feature flag + A/B test)
- Monitor tool usage split in analytics

### Risk: Worse performance than full-file replacement

**Likelihood:** Low (benchmarks show opposite)

**Mitigation:**
- Measure success rate before/after
- Track token usage (should decrease)
- Keep `sandbox_write_file` as escape hatch

### Risk: Increased latency from dual-pass validation

**Likelihood:** Low (file reads are fast)

**Mitigation:**
- Cache file content + hashes during validation pass
- Apply edits in memory (no extra disk I/O)
- Measure p50/p99 latency vs current write tool

### Risk: Token overhead on file reads

**Likelihood:** Certain — every line gets ~6-8 chars of prefix (`22:f1|`)

For a 500-line file, that's 3-4KB of annotation against `MAX_TOOL_RESULT_SIZE` of 24K chars (12-16% of budget consumed by metadata). The ~20% token savings from fewer retries come from a different axis (avoided retry loops, not the read path). On the read path, hashline *adds* tokens.

**Mitigation:**
- Only annotate when the Coder reads a file (not Orchestrator context reads)
- Add opt-in `annotate` flag to `sandbox_read_file` (default: true for Coder, false otherwise)
- Support line-range reads (`start_line`, `end_line`) so the model can read chunks of large files — pairs naturally with hashline (read lines 200-300, edit just those lines)
- Monitor files near truncation boundary for annotation-induced truncation

## Success Metrics

**Primary:**
- Edit success rate (% of edit attempts that apply cleanly)
- Agent retry loops per task (should decrease)
- Coder rounds per task (should decrease if fewer retries)

**Secondary:**
- Token usage per task (should decrease ~20% based on benchmarks)
- Time-to-completion (should improve if retry loops decrease)
- Staleness detection rate (how often hash mismatch catches dirty state)

**Comparison baseline:**
- Current `sandbox_write_file` success rate
- Current retry loop frequency
- Current token usage per task type

## Rollout Strategy

### Week 1: Prototype

- Implement backend hashline utils + endpoint
- Implement frontend tool + client
- Add Worker route
- Manual testing with real sandbox

### Week 2: Integration

- Annotate file reads
- Update Coder prompt
- Add automated tests
- Dogfood on personal sandbox tasks

### Week 3: Evaluation

- Measure success rate vs baseline
- Collect agent retry metrics
- Monitor token usage
- Fix edge cases

### Week 4: Gradual Rollout

- Feature flag: `hashlineEditEnabled` (default: false)
- Enable for 10% of sandbox tasks
- Compare metrics (hashline vs write tool)
- Expand to 50% if metrics improve
- Full rollout if 50% cohort shows clear gains

## Benchmarking Plan (Deprioritized)

Real-world dogfooding will tell you more than synthetic benchmarks for Push's specific use case. Pursue this only after hashline has been live for 2+ weeks and you want rigorous comparison data.

To replicate Can Bölük's methodology:

1. **Fixture generation:**
   - Take random files from Push codebase
   - Introduce mechanical mutations (operator swaps, renames, etc.)
   - Generate task descriptions ("Fix the bug in utils.ts")

2. **Test harness:**
   - Run Coder agent with `sandbox_write_file` (baseline)
   - Run Coder agent with `sandbox_edit_file` (hashline)
   - Compare success rates across Kimi/Mistral/Ollama

3. **Metrics:**
   - Edit success rate
   - Rounds to completion
   - Token usage
   - Output correctness (file diff vs expected)

**Effort:** 6-8 hours (if we want rigorous data)

## Resolved Questions

1. **Hash algorithm** → **CRC16 via zlib.** Stdlib, fast, good distribution. See Appendix.
2. **Base encoding** → **Base62.** Alphanumeric-only is safer for LLM tokenization — no `+`/`/`/`=` chars that might confuse models or get mangled in JSON.
3. **Collision handling** → **No line number in hash.** The ref format `line_number:hash` is already unique. Baking line number into the hash makes refs brittle to insertions. See Risks section.
4. **Multi-edit atomicity** → **All-or-none.** Partial application leaves files in states the model can't reason about.
5. **Diff output** → **Annotated full file.** The agent needs updated refs for subsequent edits. Diff is only useful for the UI card.

## Related Work

- [oh-my-pi hashline implementation](https://github.com/can1357/oh-my-pi/tree/main/packages/react-edit-benchmark)
- [Aider benchmarks](https://aider.chat/docs/benchmarks.html) (format choice swings GPT-4 from 26% to 59%)
- [Diff-XYZ benchmark paper](https://arxiv.org/abs/2510.12487) (JetBrains)
- [EDIT-Bench paper](https://arxiv.org/abs/2511.04486) (only one model >60% pass@1)
- [Claude Code str_replace issues](https://github.com/anthropics/claude-code/issues/3471)

## Appendix: Hash Function Candidates

### Option A: CRC16 (via zlib)

```python
import zlib

def hash_line(content: str) -> str:
    crc = zlib.crc32(content.encode('utf-8')) & 0xFFFF  # 16-bit
    return base62_encode(crc)  # 2-3 chars
```

**Pros:** Fast, widely available, good distribution
**Cons:** Not cryptographic (doesn't matter here)

### Option B: FNV-1a

```python
def hash_line(content: str) -> str:
    hash_val = 0x811c9dc5  # FNV offset basis
    for byte in content.encode('utf-8'):
        hash_val ^= byte
        hash_val = (hash_val * 0x01000193) & 0xFFFFFFFF
    return base62_encode(hash_val & 0xFFFF)  # 16-bit
```

**Pros:** Simple, no dependencies
**Cons:** Slightly more code than CRC

### Recommendation: CRC16 via zlib

Python's `zlib` is stdlib, CRC is fast, and 16-bit gives 65k namespace (overkill for typical files).

### Base62 Encoding

```python
BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"

def base62_encode(n: int) -> str:
    if n == 0:
        return BASE62[0]
    result = []
    while n > 0:
        result.append(BASE62[n % 62])
        n //= 62
    return ''.join(reversed(result))
```

**Namespace:**
- 2 chars: 62^2 = 3,844 values
- 3 chars: 62^3 = 238,328 values

Use 3 chars for safety (most files <1000 lines, so collision risk ~0.4%).

## Next Steps

1. **Micro-test:** Give each provider (Kimi, Devstral, GLM) a hashline-annotated file + edit prompt. Can they emit valid `sandbox_edit_file` JSON? If 2/3 fail, reassess before building.
2. **Prototype:** Implement backend + frontend in a feature branch
3. **Dogfood:** Test on personal sandbox tasks for a week
4. **Measure:** Compare success rate vs baseline
5. **Commit or abandon:** If metrics improve, promote to ROADMAP.md as v2 scope

## Notes

- Hashline doesn't replace `sandbox_write_file` — it's a complementary tool for partial edits
- The edit tool can coexist with write tool during transition (gradual prompt migration)
- If hashline fails to improve metrics after 2 weeks of dogfooding, we learned something and can abandon cleanly
- The benchmarking effort is optional — we can ship without it and rely on production metrics
- Staleness detection is a bonus side effect, not the primary goal (edit reliability is)
