---
name: catch-up
description: Sync up on parallel work — fetch, diff local vs origin/main, and summarize what merged and what's open since the last sync. Use after working across multiple agents/sessions (Codex on the device, Claude cloud sessions, the user solo) to orient before continuing.
allowed-tools: Bash, Read
user-invocable: true
proactive: false
---

# /catch-up — orient on parallel work

Shawn runs work across several agents at once — this Claude Code session, Codex
driving device screen-taps, and Claude **cloud** sessions (branches prefixed
`claude/…`). Things land while you weren't looking. This re-establishes ground
truth before continuing.

## Steps

```bash
git fetch origin --quiet

# 1. How far is local from origin/main?
git log --oneline -1
git rev-list --left-right --count HEAD...origin/main   # left=local-ahead right=remote-ahead

# 2. What's recently on main?
git log --oneline origin/main -12

# 3. What merged recently (with times + authors)?
gh pr list --state merged --limit 12 \
  --json number,title,mergedAt,author \
  --jq '.[] | "\(.number)  \(.mergedAt[5:16])  @\(.author.login)  \(.title)"'

# 4. What's OPEN (parallel work not yet landed)?
gh pr list --state open --limit 15 \
  --json number,title,headRefName,author,updatedAt \
  --jq '.[] | "\(.number)  \(.updatedAt[5:16])  @\(.author.login)  \(.title)  [\(.headRefName)]"'

# 5. Recent remote branches (Codex/cloud experiments, device test lanes)
git for-each-ref --sort=-committerdate --count=10 \
  --format='%(committerdate:short)  %(refname:short)' refs/remotes/origin
```

## Interpreting

- **`claude/*` branches** = Claude cloud sessions. **Throwaway short names**
  (`testing`, `g`, `new`, `tese`…) are often device test lanes (checkpoint
  branches created on-device), not real work — don't mistake them for PRs.
- A merge you "ran" may show a **different PR number** at HEAD if someone merged a
  superseding PR concurrently — check `gh pr view <n> --json state,mergedAt` for
  the PRs you care about rather than trusting the latest commit alone.
- For anything new that touches current work, **read the PR body/diff** (`gh pr
  view <n>`, `gh pr diff <n>` or `git show <sha> --stat`) and say plainly: what
  changed, whether it overlaps/conflicts with the in-flight task, and whether it
  supersedes something you were about to do.

## Output

A tight summary: what landed since last sync, what's still open (and who's on it),
and the one or two items that actually affect the current task. Don't dump the raw
lists — relay the conclusion.
