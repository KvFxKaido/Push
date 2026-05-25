# Design Token Migration Plan

Status: Draft plan, P0–P1 shipped. Added 2026-05-25.

Drives the legacy hardcoded-color backlog toward zero so the DESIGN.md token
system is the single source of truth for color. The `check:design-tokens`
ratchet (added with the canonical-docs work) holds the line; this plan scopes
the existing violations and orders the cleanup.

The baseline audit ran against `app/src` (excluding `src/components/ui/**`, the
shadcn carveout) and found **441** hardcoded colors. P0 (carve out the CodeMirror
editor theme) and P1 (34 mechanical swaps) have since landed, bringing the
ratchet baseline to **362**. Re-run the numbers any time with
`npm run check:design-tokens` (counts + top offenders).

## What counts

The detector (`app/scripts/design-token-detector.mjs`) flags two forms, hex only
(valid CSS lengths 3/4/6/8), rgb/rgba/hsl intentionally excluded as low-signal:

- **Tailwind arbitrary values** — `bg-[#000]`, `border-[#1f2531]`, `[background-color:#121926]` (365 of 441).
- **Quoted hex literals** — inline `style={{ color: '#fff' }}`, theme objects, color constants (76 of 441).

## Scope by migratability

Breakdown of the **initial 441-violation audit**. `codemirror-theme.ts` (45) has
since been carved out in P0, so the live ratchet baseline is **396**.

| Bucket | Count | Action |
|---|---:|---|
| Exact token match | 34 (8%) | Mechanical find/replace |
| Near-token drift (RGB dist ≤12) | 108 (24%) | Snap to existing token, eyeball each |
| Genuinely new (no nearby token) | 299 (68%) | Add a token or accept a justified one-off |
| ↳ near-black (`#000000`, `#1a1a1a`, …) | 42 | Map to `push-surface*` or add a black token |
| ↳ `src/lib/codemirror-theme.ts` | 45 | Editor syntax theme, not app tokens — **carved out (P0 ✓)** |

## Concentration

Top files in the **initial (pre-P0) audit** — ~67% of the backlog, a
handful-of-files problem:

| File | Count |
|---|---:|
| `src/components/chat/ChatInput.tsx` | 84 |
| `src/components/chat/LibraryPanel.tsx` | 73 |
| `src/components/filebrowser/FileEditor.tsx` | 54 |
| `src/lib/codemirror-theme.ts` | 45 (carved out in P0) |
| `src/components/launcher/RepoLauncherPanel.tsx` | 38 |
| `src/components/chat/MessageBubble.tsx` | 19 |
| `src/components/filebrowser/CommitPushSheet.tsx` | 12 |

## Reference data

**Exact-token swaps (P1):**

| Hex | Token | Count |
|---|---|---:|
| `#070a10` | `push-surface` | 27 |
| `#1f2531` | `push-edge` | 3 |
| `#f5f7ff` | `push-fg` | 2 |
| `#0c1018` | `push-surface-raised` | 1 |
| `#0070f3` | `push-accent` | 1 |

**Drift — token exists, code drifted (P3, eyeball each):**

| Hex | Nearest token | Dist | Count |
|---|---|---:|---:|
| `#fafafa` | `push-fg` | 8 | 21 |
| `#2a3447` | `push-edge-hover` | 7 | 21 |
| `#8891a1` | `push-fg-muted` | 11 | 11 |
| `#0d0d0d` | `push-surface` | 7 | 10 |
| `#151b26` | `push-surface-active` | 7 | 6 |
| `#8e99ad` | `push-fg-muted` | 5 | 5 |

**Frequent colors with no token (P2 — add tokens first):**

| Hex | Count | Notes |
|---|---:|---|
| `#7c879b` | 49 | Muted gray — the single most-used hardcoded color |
| `#d7deeb` | 32 | Light text |
| `#52525b` | 20 | Gray |
| `#3d5579` | 17 | Muted blue |
| `#d1d8e6` | 12 | Light text |

The purple/cyan family (`#a78bfa`, `#67e8f9`, `#c4b5fd`, …) is almost entirely
`codemirror-theme.ts` syntax highlighting — handle via the P0 carveout, not new
app tokens.

## Phased plan

Each phase ends with `npm run check:design-tokens -- --update` to ratchet the
baseline down and lock in progress. Verify the UI is visually unchanged before
re-baselining — these are color swaps, so a screenshot diff on the touched
screens is the acceptance bar.

- **P0 ✓ — Carveout** `src/lib/codemirror-theme.ts` (editor syntax theme, not
  DESIGN.md app tokens) added to the ratchet's exclude list. Baseline 441 → 396.
- **P1 ✓ — Mechanical** 34 exact-token swaps, all Tailwind-arbitrary values
  (`bg-[#070a10]` → `bg-push-surface`, etc.). Color-identical by construction
  (each token's value equals the literal hex), so no visual change. Baseline
  396 → 362.
- **P2 — New tokens** Add tokens for the frequent no-token colors (`#7c879b`,
  `#d7deeb`, `#52525b`, …) to DESIGN.md + `tailwind.config.js`, then swap their
  usages. Each new token needs a DESIGN.md table row (the reviewer + ratchet
  expect tokens to be documented).
- **P3 — Drift** Snap the 108 near-token values to their token, one judgment
  call per value (a slightly-off shade may be intentional; if it is, that is a
  DESIGN.md gap to document, not a swap). Concentrated in the top files.
- **Tail** Near-blacks (decide: `push-surface*` vs. a new black token) and the
  long tail of one-off singletons.

## Graduation

Once the baseline is near zero, graduate from the standalone ratchet to a
blocking ESLint rule for new/changed code (the original intent deferred because
the 441-violation backlog made a blocking rule break CI or flood warnings). See
the canonical-docs PR discussion for that rationale.
