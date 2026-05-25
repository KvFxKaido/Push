# Design Token Migration Plan

Status: Draft plan, P0–P6 shipped — backlog cleared (baseline 0). Added 2026-05-25.

Drives the legacy hardcoded-color backlog toward zero so the DESIGN.md token
system is the single source of truth for color. The `check:design-tokens`
ratchet (added with the canonical-docs work) holds the line; this plan scopes
the existing violations and orders the cleanup.

The baseline audit ran against `app/src` (excluding `src/components/ui/**`, the
shadcn carveout) and found **441** hardcoded colors. P0–P6 have since landed
(carveouts, 34 mechanical swaps, new chat/library tokens, 29 drift snaps,
data-color carveouts, the status/accent token round, and the neutrals round),
bringing the ratchet baseline to **0** — the backlog is cleared. The remaining
next step is graduation (wire the ratchet into CI; see below).
Re-run the numbers any time with `npm run check:design-tokens` (counts + top
offenders).

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

All counts below are from the **initial audit** (historical), kept to show what
each phase targeted; they don't reflect the current baseline.

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
| `#7c879b` | 49 | Muted text — tokenized as `push-fg-faint` (P2 ✓) |
| `#d7deeb` | 32 | Panel text — tokenized as `push-fg-soft` (P2 ✓) |
| `#52525b` | 20 | Neutral zinc gray — no token yet (tail) |
| `#3d5579` | 17 | Focus border — tokenized as `push-edge-focus` (P2 ✓) |
| `#d1d8e6` | 12 | Light text ≈ `push-fg-soft` — drift snap (P3) |

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
- **P2 ✓ — New tokens** Added `push-fg-faint` (`#7c879b`), `push-fg-soft`
  (`#d7deeb`), and `push-edge-focus` (`#3d5579`) to DESIGN.md +
  `tailwind.config.js` and swapped their 98 exact uses (color-identical).
  Baseline 362 → 264. The neutral zinc `#52525b` and light `#e2e8f0` have no
  clean home in the cool-blue palette — deferred to the tail.
- **P3 ✓ — Drift** Snapped 29 off-shades (123 occurrences, all ≤12 RGB from
  their nearest token) to tokens, utility-preserving (e.g. `border-[#2a3447]` →
  `border-push-edge-hover`, `text-[#fafafa]` → `text-push-fg`). Small but real
  color shifts — **pending visual review** on the PR. Baseline 264 → 142. One
  `[background-color:#121926]` arbitrary-property form is left for the tail (a
  token name can't go in raw CSS — needs a utility rewrite or a CSS var).
- **P4 ✓ — Data-color carveouts** Investigated CSS vars to tokenize the
  inline-style hexes — **zero payoff**: none of the 31 inline hexes matched a
  token, and a var conversion would mean RGB-channel rewrites across 216 opacity
  usages for no tail reduction. The inline hexes were all legitimately
  non-tokens: GitHub language data-colors (extracted to `src/lib/language-colors.ts`)
  + the repo-accent palette (`src/lib/repo-appearance.ts`) + the crash-fallback
  screen (`src/components/RootErrorBoundary.tsx`, which renders before styles
  load). Carved all three out of the ratchet. Baseline 142 → 112; inline-style
  hexes now zero.
- **P5 ✓ — Status + accent tokens** Hybrid pass (112 → 83). Added
  `push-status-success-soft` (`#4ade80`), `push-status-error-soft` (`#f87171`),
  `push-status-success-bg` (`#173523`), `push-violet` (`#c4b5fd`, the chat
  accent), and `push-link-hover` (`#86ccff`). Snapped the bright-blue link/action
  text spread onto `push-link`. New tokens only where the shade carried meaning
  the mid-tones didn't; everything else snapped — no one-token-per-shade.
- **P6 ✓ — Neutrals** Cleared the rest (83 → 0). `#000` editor/input
  backgrounds → `push-surface-inset`; greys snapped to the nearest
  `push-fg`/`push-surface`/`push-edge` token; the `[background-color:#121926]`
  arbitrary-property form → `bg-push-surface-active`. Added one
  `push-fg-dimmest` (`#505971`) for the disabled/placeholder level below
  `push-fg-dim` (line numbers, placeholders, empty-state hints). 19 of these
  were exact matches to existing tokens that simply hadn't been migrated.
- **Tail** Cleared — baseline is **0**. Next is graduation (below).

## Graduation

Once the baseline is near zero, graduate from the standalone ratchet to a
blocking ESLint rule for new/changed code (the original intent deferred because
the 441-violation backlog made a blocking rule break CI or flood warnings). See
the canonical-docs PR discussion for that rationale.
