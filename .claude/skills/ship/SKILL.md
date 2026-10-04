---
name: ship
description: Land a change through Push's standard flow — branch off main, validate, commit (CRLF/Biome-safe), PR, watch CI (re-running the flaky Android job), address bot reviews (fugu + Codex) before merging, squash-merge, and confirm the Workers Builds deploy. Use when shipping a PR end to end.
allowed-tools: Bash, Read, Edit, PowerShell
user-invocable: true
proactive: false
---

# /ship — branch → commit → PR → CI → reviews → merge → deploy

The repeatable Push delivery loop, with the gotchas baked in.

## 1. Branch off fresh main

```bash
git checkout main && git pull --ff-only origin main && git checkout -b <type>/<slug>
```
`<type>`: `feat` / `fix` / `docs` / `chore` / `refactor`.

## 2. Validate before committing

- `pnpm run typecheck:all` for cross-surface (app-only: `cd app && pnpm run typecheck`, tsgo).
- Relevant tests: `cd app && npx vitest run <files>` (app);
  `TMPDIR=/tmp TEMP=/tmp TMP=/tmp pnpm run test:cli` (root — the TMPDIR prefix is
  the canonical isolation guard from AGENTS.md; don't drop it).
- Native Kotlin: `./gradlew :capacitor-native-git:testDebugUnitTest` under JDK 21
  (see `/device`).

## 3. Commit — the CRLF/Biome dance (do it in ONE Bash call)

Biome wants LF; the Windows checkout (`C:\dev\Push`) is CRLF. Chain so autocrlf
can't re-CRLF between steps:

```bash
npx biome format --write <files> && git add <files> && git commit -F - <<'EOF'
<type>(<scope>): lowercase subject line

Body wrapped ~80 cols.

Co-Authored-By: <current model's attribution footer from the harness>
Claude-Session: <session url>
EOF
```

- **commitlint scope enum** (use one, or omit the scope) — source of truth is
  `app/commitlint.config.cjs`; grep it when in doubt rather than trusting this
  list. As of 2026-07-26: subsystems `orchestrator`, `coder`, `auditor`,
  `sandbox`, `browser`, `github`, `chat`, `ui`, `design`, `worker`, `auth`,
  `settings`, `context`, `contract`, `tools`, `scratchpad`, `providers`,
  `research`; surfaces `cli`, `tui`, `daemon`, `web`, `android`, `lib`;
  platforms `windows`, `wsl`, `macos`, `linux`; meta `deps`, `deps-dev`,
  `lint`, `ci`. (`checkpoint` and `decisions` are **not** in the enum — they
  bounce.)
- Subject must start lowercase. Footer needs a **leading blank line** (else a
  `footer-leading-blank` warning — non-blocking, but clean it up).
- The pre-commit hook runs ESLint; fix real lints (e.g. `no-useless-assignment`)
  rather than `--no-verify`.
- To verify content formatting under CRLF noise: `biome format --write` then
  `git diff --stat` — line-ending normalization shows no git diff, so anything
  that remains is a real change.

## 4. Push + PR

```bash
git push -u origin <branch>
gh pr create --base main --head <branch> --title "…" --body "$(cat <<'EOF'
…
🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

## 5. Watch CI (and the known flake)

```bash
# poll until terminal:
while gh pr checks <n> 2>/dev/null | awk -F'\t' '{print $2}' | grep -q pending; do sleep 25; done
gh pr checks <n>
```
Run the poll with `run_in_background: true`.

- **`Build (android)` flakes** on a Maven Central **403 fetching JUnit** (purely
  infra). Re-run just the failed job and re-poll:
  `gh run rerun <run-id> --failed`. A CSS/TS-only change can't break the native
  build — if it "fails", check for the 403 before assuming it's you.
- Docs-only PRs path-filter some checks (fewer than 9 is normal there).

## 6. Address reviews BEFORE merging

Green checks are not "no findings." Two bot reviewers land on every PR, and the
**"Push review" check passes even when the review body carries warnings** — the
findings live in the review text and inline comments, not the check status.
Never `gh pr merge` without having read both.

```bash
# Review bodies + top-level comments:
gh pr view <n> --json reviews --jq '.reviews[] | {author: .author.login, state, body}'
# Inline comments (where fugu WARNINGs and Codex P-badges actually live):
gh api repos/KvFxKaido/Push/pulls/<n>/comments --jq '.[] | {author: .user.login, path, line, body}'
# Codex verdict = the top-level PR reaction, not its boilerplate review:
gh api repos/KvFxKaido/Push/issues/<n>/reactions --jq '.[] | {user: .user.login, content}'
```

- **Codex**: 👀 = still reviewing, 👍 = clean. **No reaction + a P-badge inline
  comment = it has suggestions** — treat as unresolved. If neither reaction nor
  comments have appeared yet, wait; Codex can lag the CI checks.
- **Verify findings by executing the claim**, per the repo's self-review rule —
  reproduce the scenario before accepting OR dismissing it. Fugu's tally is
  ~12 real / 3 confabulated with control-flow claims needing the hardest
  verification; **fugu + Codex converging on the same finding is the cheap
  high-confidence signal** (take it seriously).
- Real finding → fix on the same branch, re-run the touched validation, push.
  **Neither bot re-reviews a pushed commit on its own** — a fix commit gets no
  automatic verdict, so don't poll for one. If re-verification is wanted,
  request it — comment `@codex review` for Codex, `@push-agent review` (or
  `@push-agent re-review`) for fugu; otherwise merge on local
  validation + green CI once every finding is fixed or dismissed on the record.
  Dismissed finding → say why in a PR comment before merging, so the dismissal
  is on the record, not silent.

## 7. Merge + confirm deploy

```bash
gh pr merge <n> --squash --delete-branch
```
Workers Builds auto-deploys `main` (~2 min) — **don't** `wrangler deploy` (no
interactive token). If a device/web test depends on it, poll the deploy:

```bash
gh api repos/KvFxKaido/Push/commits/<merge-sha>/check-runs \
  --jq '.check_runs[] | select(.name|test("Workers Builds";"i")) | {status,conclusion}'
```
Note: the **edge can serve the new Worker before** the GitHub check flips to
`completed` — the check lags edge propagation.

## Confirm before outward actions

Pushing, opening PRs, and merging are publishing actions — proceed when the user
has clearly asked to ship, not on inference. One "merge" doesn't authorize the next.
