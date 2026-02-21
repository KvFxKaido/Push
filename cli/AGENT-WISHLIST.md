# CLI Agent Experience Wishlist

Date: 2026-02-20
Author: Claude (agent-in-residence)
Status: **Shipped** (all 10 items implemented, 2026-02-20)

---

## What this is

Improvements to the Push CLI harness from the perspective of the AI agent running inside it. These are things that would reduce wasted rounds, prevent blind spots, and make the agent more effective at completing tasks. Companion to the web app's `documents/analysis/Agent Experience Wishlist.md` (shipped).

The CLI already has several things the web app needed to build from scratch — multi-tool dispatch, hashline edits, structured error taxonomy, working memory, and file awareness ledger. This list covers what was still missing or underperforming.

---

## P0 — Highest leverage (save rounds on every session)

### 1. Workspace Snapshot in System Prompt

**The problem:** The system prompt says `Workspace root: /path` and nothing else. On the first turn the agent is blind — it has to burn a round on `list_dir` + `read_file` on a README just to orient. Every session starts with the same wasted exploration.

**What I'd want:** A lightweight workspace snapshot injected into the system prompt at session init:
- Current git branch + dirty file list (`git status --short`)
- Top-level file tree (1-2 levels, like a `tree -L 2` summary)
- Language/framework hint from manifest files (`package.json`, `Cargo.toml`, `pyproject.toml`, etc.)

**Implementation sketch:**
```js
// In engine.mjs or a new workspace-context.mjs
async function buildWorkspaceSnapshot(cwd) {
  const tree = await execFileAsync('find', ['.', '-maxdepth', '2', '-not', '-path', '*/node_modules/*', '-not', '-path', '*/.git/*'], { cwd });
  const gitStatus = await execFileAsync('git', ['status', '--short', '--branch'], { cwd }).catch(() => null);
  const manifest = await detectManifest(cwd); // check package.json, Cargo.toml, etc.
  return formatSnapshot({ tree, gitStatus, manifest });
}
```

Inject the result into `buildSystemPrompt()` alongside the existing workspace root line.

**Impact:** Saves 1-2 rounds on every session. Highest-leverage single change.

---

### 2. Project Instructions

**The problem:** The web app reads `AGENTS.md` / `CLAUDE.md` from the repo root and injects it into the system prompt. The CLI ignores these entirely. If a project has architecture docs, coding conventions, or agent-specific instructions, the agent doesn't see them unless it happens to read the file manually.

**What I'd want:** On session init, check for project instruction files and inject into the system prompt:
- `AGENTS.md` (primary)
- `CLAUDE.md` (fallback)
- `.push/instructions.md` (CLI-specific override)

**Implementation sketch:**
```js
const INSTRUCTION_FILES = ['AGENTS.md', 'CLAUDE.md', '.push/instructions.md'];

async function loadProjectInstructions(cwd) {
  for (const file of INSTRUCTION_FILES) {
    try {
      const content = await fs.readFile(path.join(cwd, file), 'utf8');
      return { file, content: content.slice(0, 8000) }; // cap to avoid context blowout
    } catch { continue; }
  }
  return null;
}
```

Inject as a `[PROJECT_INSTRUCTIONS]` block in the system prompt with clear boundaries (to prevent prompt injection from repo content — escape or fence it).

**Impact:** Near-zero code, large context quality improvement. The user communicates project conventions once, not every message.

---

### 3. File Paths in Ledger Summary

**The problem:** The file ledger tracks which files have been read/written and injects a summary into the `[meta]` envelope — but `getLedgerSummary()` only returns aggregates (`partial_read: 2, fully_read: 1`). If context was trimmed and the agent is on round 5, it knows it touched 3 files but not *which* ones.

**What I'd want:** Include file paths in the summary, not just counts.

**Implementation sketch:**
```js
export function getLedgerSummary(ledger) {
  const entries = Object.entries(ledger.files);
  return {
    total: entries.length,
    files: entries.map(([path, v]) => ({
      path,
      status: v.status,
      reads: v.reads,
      writes: v.writes,
    })),
  };
}
```

**Impact:** One-line change, fixes a real blind spot after context trimming.

---

## P1 — High value (save rounds on common operations)

### 4. Edit Confirmation Context

**The problem:** When `edit_file` succeeds, the result is: `"Applied 3 hashline edits to src/parser.ts"`. The agent doesn't know if the replacement actually produced correct code without burning another round on `read_file`.

**What I'd want:** Include a small context window (3 lines before/after) around each applied edit in the tool result. The web app's `sandbox_edit_file` returns a diff; even a simpler "here's what each edited line looks like now" would work.

**Implementation sketch:**
```js
// After applying edits, render a preview around each edit site
const previews = applied.map(({ op, line }) => {
  const start = Math.max(0, line - 4);
  const end = Math.min(lines.length, line + 3);
  return lines.slice(start, end).map((l, i) => `${start + i + 1}| ${l}`).join('\n');
});
```

Return previews in the tool result text alongside the success message.

**Impact:** Prevents unnecessary re-read rounds after edits. Especially valuable when making multiple edits to the same file across rounds.

---

### 5. Working Memory Deduplication

**The problem:** The `[meta]` envelope (including working memory) is injected into *every* tool result. If the agent does 3 parallel reads in one round, it gets 3 identical copies of its own plan in the context. Pure waste.

**What I'd want:** Inject working memory once per round, not per tool result. Either:
- Only include it on the *last* tool result message for that round, or
- Inject it as a separate synthetic message after all tool results for the round.

**Implementation sketch:**
```js
// In engine.mjs, executeOneToolCall — accept a flag
async function executeOneToolCall(call, round, includeMemory = true) {
  // ...
  const metaEnvelope = {
    runId,
    round,
    ledger: getLedgerSummary(fileLedger),
    ...(includeMemory ? { workingMemory: state.workingMemory } : {}),
  };
  // ...
}

// In the dispatch section, only pass includeMemory=true on the last call
```

**Impact:** Reduces context waste proportional to number of parallel reads per round. Typical 3-read orientation goes from 3x working memory to 1x.

---

### 6. Multi-Line Content in Hashline Edits

**The problem:** Hashline edit ops (`insert_after`, `insert_before`, `replace_line`) each operate on a single line. Inserting a 15-line function requires either 15 sequential `insert_after` calls (fragile, order-dependent, each re-resolving refs against a shifting document) or falling back to `write_file` on the whole file (wasteful, loses staleness protection).

**What I'd want:** Allow `content` in insert/replace ops to contain newlines. Split on `\n` and splice all lines as a block.

**Implementation sketch:**
```js
// In hashline.mjs, applyHashlineEdits — replace_line case
if (op === 'replace_line') {
  if (typeof edit.content !== 'string') throw new Error('replace_line requires string content');
  const newLines = edit.content.split('\n');
  lines.splice(idx, 1, ...newLines);
  applied.push({ op, line: idx + 1, linesInserted: newLines.length });
  continue;
}
```

Same pattern for `insert_after` and `insert_before`.

**Impact:** Small change to hashline engine, big usability gain. Eliminates the most common reason agents fall back to full-file rewrites.

---

### 7. Read Symbols Tool

**The problem:** The agent can `read_file` (lines) and `search_files` (grep). But "show me all the functions in this file" requires reading the entire file and mentally parsing it. The web app has `sandbox_read_symbols` (AST/regex extraction). The CLI has nothing.

**What I'd want:** A `read_symbols` tool that extracts function/class/method/export declarations from a file. Even a regex-based approach works — it doesn't need a real parser.

**Implementation sketch:**
```js
// In tools.mjs
case 'read_symbols': {
  const filePath = ensureInsideWorkspace(workspaceRoot, asString(call.args.path, 'path'));
  const content = await fs.readFile(filePath, 'utf8');
  const lines = content.split('\n');
  const symbols = [];
  const patterns = [
    /^\s*(export\s+)?(async\s+)?function\s+(\w+)/,
    /^\s*(export\s+)?class\s+(\w+)/,
    /^\s*(export\s+)?const\s+(\w+)\s*=/,
    /^\s*def\s+(\w+)/,           // Python
    /^\s*fn\s+(\w+)/,            // Rust
    /^\s*func\s+(\w+)/,          // Go
  ];
  lines.forEach((line, i) => {
    for (const pat of patterns) {
      const m = line.match(pat);
      if (m) { symbols.push({ line: i + 1, text: line.trim() }); break; }
    }
  });
  return { ok: true, text: symbols.map(s => `${s.line}| ${s.text}`).join('\n') || 'No symbols found' };
}
```

**Impact:** Saves exploration rounds. Especially valuable on unfamiliar codebases where the agent needs a map before diving in.

---

## P2 — Important but higher effort

### 8. Context Budget Tracking

**The problem:** The agent has no idea how much context it has used or how much remains. The max-rounds cap (default 8) is a blunt proxy. The web app tracks token budget and does rolling-window trimming. The CLI just hopes it fits — and gets a cryptic 400 error when it doesn't.

**What I'd want:** At minimum, a rough character count of the current messages array injected into the meta envelope. At best, actual context trimming (summarize + drop oldest messages) before hitting the provider's limit.

**Implementation sketch (minimal):**
```js
// In engine.mjs, before each streamCompletion call
const contextChars = state.messages.reduce((sum, m) => sum + (m.content?.length || 0), 0);
// Include in meta envelope
const metaEnvelope = { runId, round, contextChars, contextBudget: 120000, ... };
```

For actual trimming, port the web app's rolling-window logic from `useChat.ts` — summarize old tool-heavy messages, then drop oldest pairs if still over budget.

**Impact:** Prevents late-session failures. Medium effort for minimal tracking, high effort for full trimming.

---

### 9. Structured Git Tools

**The problem:** The agent can `exec("git status")` — but it has to construct the right invocation, parse the output, and handle edge cases. The most common operations (status, diff, commit) are predictable and could return structured data.

**What I'd want:** First-class `git_status`, `git_diff`, and `git_commit` tools with structured output:

```json
{"tool": "git_status", "args": {}}
// Returns: { branch: "main", dirty: ["src/parser.ts"], staged: [], ahead: 2, behind: 0 }

{"tool": "git_diff", "args": {"path": "src/parser.ts"}}
// Returns: unified diff, already truncated and formatted

{"tool": "git_commit", "args": {"message": "Fix parser edge case", "paths": ["src/parser.ts"]}}
// Returns: { sha: "abc1234", message: "Fix parser edge case", filesChanged: 1 }
```

**Impact:** Structured output means fewer parsing mistakes and better decisions. But `exec` works as a workaround, so this is a convenience improvement more than a necessity.

---

### 10. File Backup / Undo

**The problem:** If the agent makes a bad `write_file` or `edit_file`, there's no undo. It has to remember the original content (which it might not after context trimming) or re-read and try to manually reverse the edit. The web app has sandbox snapshots for recovery.

**What I'd want:** Automatic backup before mutations — copy the original file to `.push/backups/<session-id>/<filename>.<timestamp>` before any `write_file` or `edit_file`. Optionally, an `undo_last_edit` tool that restores the backup.

**Implementation sketch:**
```js
// In tools.mjs, before write/edit
const backupDir = path.join(workspaceRoot, '.push', 'backups', state.sessionId);
await fs.mkdir(backupDir, { recursive: true });
await fs.copyFile(filePath, path.join(backupDir, `${path.basename(filePath)}.${Date.now()}`));
```

**Impact:** Important for safety, but higher implementation cost. Git-based undo (`git stash` / `git checkout -- file`) is a lighter alternative if the workspace is always a git repo.

---

## Relationship to web app wishlist

| CLI Wishlist Item | Web App Equivalent | Status |
|---|---|---|
| Workspace snapshot (#1) | `workspace-context.ts` | Shipped in web app, missing in CLI |
| Project instructions (#2) | `fetchProjectInstructions()` | Shipped in web app, missing in CLI |
| File paths in ledger (#3) | `file-awareness-ledger.ts` | Web app has full ledger; CLI has counts only |
| Edit confirmation (#4) | `sandbox_edit_file` diff output | Shipped in web app, missing in CLI |
| Working memory dedup (#5) | N/A (web app injects differently) | CLI-specific issue |
| Multi-line edits (#6) | `sandbox_apply_patchset` | Web app has patchset tool; CLI hashline is line-only |
| Read symbols (#7) | `sandbox_read_symbols` | Shipped in web app, missing in CLI |
| Context budget (#8) | Rolling-window trimming in `useChat.ts` | Shipped in web app, missing in CLI |
| Git tools (#9) | GitHub tools in `github-tools.ts` | Web app uses GitHub API; CLI needs local git |
| File backup (#10) | Sandbox snapshots | Web app has snapshots; CLI has nothing |
