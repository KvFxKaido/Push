# Provider Compliance Test Specification

## Test Environment

All tests run against Push's actual Orchestrator system prompt and tool definitions. The model being tested receives identical context to what Push would send in production.

Each test is independent and stateless unless otherwise noted. Tests timeout individually:
- Simple tests: 30 seconds
- Coder delegation tests: 90 seconds

---

## Test 1: Streaming Integrity

**Purpose:** Verify long responses complete without dropped chunks or truncation.

**Prompt:**
```
Write a 500-word essay about the history of version control systems. Do not use any tools.
```

**Pass Criteria:**
- Response completes with natural termination (not mid-sentence)
- Response length ≥ 400 tokens
- No stream errors or timeout
- No tool calls emitted

**Fail Conditions:**
- Response cuts off mid-stream
- Timeout before completion
- Tool call emitted despite instruction

---

## Test 2: Tool Call Schema

**Purpose:** Verify model emits valid, schema-compliant tool calls.

**Prompt:**
```
Read the file /workspace/test.txt using the sandbox_read_file tool.
```

**Precondition:** `/workspace/test.txt` exists with known content.

**Pass Criteria:**
- Exactly one tool call emitted
- No assistant text before or after tool call
- Tool name matches exactly: `sandbox_read_file`
- Arguments validate against expected schema: `{ path: string }`
- Valid JSON (no trailing commas, single quotes, unquoted keys)

**Fail Conditions:**
- Multiple tool calls
- Chatter/explanation before tool call
- Invalid JSON
- Missing required field
- Wrong tool name

---

## Test 3: Truncated Tool Recovery

**Purpose:** Verify model recovers from truncated tool calls in one retry.

**Setup:** Pre-seed conversation with a truncated tool call and error feedback.

**Synthetic Error Message:**
```
Your last tool call was truncated and incomplete:
{"tool": "sandbox_read_file", "args": {"path": "/workspace/te

Error: UNBALANCED_BRACES — tool call cut off mid-JSON.
Retry the tool call in full.
```

**Pass Criteria:**
- Model emits corrected, complete tool call immediately
- No text chunks before the tool call
- Corrected call is schema-valid
- Exactly one correction attempt (no multi-retry spiral)

**Fail Conditions:**
- No tool call in response
- Multiple retries across turns
- Extended apology/explanation before correction
- Still malformed after correction

---

## Test 4: Multi-Round Coherence

**Purpose:** Verify model completes multi-step tasks without looping.

**Prompt:**
```
Read /workspace/numbers.txt, sum all the numbers, then append the result to /workspace/result.txt.
```

**Precondition:**
- `/workspace/numbers.txt` contains: `10 20 30`
- `/workspace/result.txt` exists (empty)

**Expected Flow:**
1. Round 1: Model calls `sandbox_read_file` on numbers.txt
2. Inject result: "10 20 30"
3. Round 2: Model calls `sandbox_write_file` or `sandbox_edit_file` on result.txt with "60"
4. Inject success
5. Round 3: Model confirms completion (no further tool calls)

**Pass Criteria:**
- Task completes in ≤ 4 rounds
- Correct numeric result (60)
- No repeated identical tool calls (loop detection)
- Final response confirms completion

**Fail Conditions:**
- Exceeds 4 rounds
- Wrong sum
- Repeats same tool call verbatim
- Gives up without completion
- Infinite loop detection triggered

---

## Test 5a: Delegation Signal

**Purpose:** Verify Orchestrator correctly delegates to Coder.

**Prompt:**
```
Create a Python script at /workspace/hello.py that prints "Hello from Push".
```

**Pass Criteria:**
- Orchestrator emits `delegate_coder` tool call
- Task description includes correct file path and content
- No direct file write from Orchestrator (it delegated)

**Fail Conditions:**
- Orchestrator attempts file write directly
- No delegation occurs
- Delegation task missing required details

---

## Test 5b: Sandbox Execution

**Purpose:** Verify Coder completes delegated task and returns result.

**Precondition:** Test 5a passed (delegation occurred).

**Pass Criteria:**
- Coder writes file to `/workspace/hello.py`
- File content includes `print("Hello from Push")`
- Coder returns success result to Orchestrator
- Orchestrator surfaces confirmation to user

**Fail Conditions:**
- File not created
- Wrong content
- Coder timeout (>90s)
- Result not surfaced to Orchestrator

---

## Test 6: Event Stream Clean

**Purpose:** Verify tool calls don't bleed into text chunks.

**Prompt:**
```
Briefly explain what a config file is (2 sentences), then read /workspace/config.json.
```

**Precondition:** `/workspace/config.json` exists with valid JSON.

**Pass Criteria:**
- Assistant text chunks stream first (clean markdown)
- Tool call event emitted after text completion
- No raw tool JSON in text chunks
- No partial tool fragments in stream

**Fail Conditions:**
- Tool JSON appears in text content
- Tool call interleaved with text mid-chunk
- Markdown formatting broken by tool emission

---

## Scoring

A provider is **ELIGIBLE** if:
- All tests pass
- No individual timeout
- No manual intervention required

A provider is **NOT ELIGIBLE** if:
- Any test fails
- Any test times out
- Manual retry required

---

## Output Format

### Human-Readable (Local Dev)

```
Provider: anthropic-direct
Model: claude-sonnet-4.5

Test 1 — Streaming Integrity: PASS (2.1s)
Test 2 — Tool Call Schema: PASS
Test 3 — Truncated Recovery: PASS (1 retry)
Test 4 — Multi-Round Coherence: PASS (3 rounds)
Test 5a — Delegation Signal: PASS
Test 5b — Sandbox Execution: PASS (4.2s)
Test 6 — Event Stream Clean: PASS

→ ELIGIBLE
```

### JSON (CI)

```json
{
  "provider": "anthropic-direct",
  "model": "claude-sonnet-4.5",
  "timestamp": "2026-02-17T14:32:00Z",
  "eligible": true,
  "tests": [
    { "name": "streaming-integrity", "passed": true, "duration_ms": 2100 },
    { "name": "tool-call-schema", "passed": true, "duration_ms": 850 },
    { "name": "truncated-recovery", "passed": true, "duration_ms": 1200, "retries": 1 },
    { "name": "multi-round-coherence", "passed": true, "duration_ms": 3400, "rounds": 3 },
    { "name": "delegation-signal", "passed": true, "duration_ms": 600 },
    { "name": "sandbox-execution", "passed": true, "duration_ms": 4200 },
    { "name": "event-stream-clean", "passed": true, "duration_ms": 1100 }
  ],
  "failures": []
}
```

---

## Versioning

This spec is versioned. If test criteria change, increment the version number.

Current version: `1.0.0`

Providers must be re-tested when:
- Spec version increments
- Push tool definitions change significantly
- Provider claims API changes
