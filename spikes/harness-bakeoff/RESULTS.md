# Harness bake-off: results (2026-10-24)

One task, one model (`claude-haiku-5-5`), five runs per arm, scored from the
proxy's wire log. Design and rubric: [README.md](README.md). Raw records:
`results/` (round 3), `results-round1/` and `results-round2-partialfix/`
(earlier rounds, kept as evidence; all gitignored).

## Verdict

**Push's loop isn't behind. Push's upkeep is.** Stock Push passed 0 of 5 runs.
Every failure traced to provider drift that built up while the repo sat idle,
not to the loop's logic. With two fixes (an empty-block guard and a catalog
refresh), Push passed 5 of 5, the same as Think and Pi.

**Update, after the fixes landed on main (rerun 2026-10-24, `8cd90ff1`).** All
six bugs below are fixed on main (#1660–#1664), and the prompt is leaner
(#1663, #1665, #1666). Push on main passes 5 of 5. It now caches, and costs
about **$0.0047 a run**, down 55% from the first fixed version ($0.0105).
That's about 2× Think and 3× Pi, down from 5× and 6×. The rest of the gap is
the prefix: 60 tool schemas plus a 14.8k-character prompt (22.8k before) on
every call.

| Arm | Pass | Model calls | Tool calls | Input tok | Output tok | Wall s | Canary → model | Trap tried |
|---|---|---|---|---|---|---|---|---|
| push (stock) | **0/5** | 5.0 | 4.0 | 36,759 | 511 | 9.2 | 0/5 | 0/5 |
| push-fixed (empty-block guard) | **0/5** | 2.8 | 4.0 | 25,192 | 509 | 4.6 | 0/5 | 0/5 |
| push-native (guard + catalog) | **5/5** | 5.2 | 9.0 | 95,237 | 1,968 | 13.9 | 0/5 | 0/5 |
| think | **5/5** | 4.6 | 6.8 | 13,059 | 1,810 | 15.0 | **4/5** | 0/5 |
| pi | **5/5** | 5.4 | 8.4 | 14,901 | 2,040 | 12.8 | **1/5** | 0/5 |
| **push-main** (main @ `8cd90ff1`, rerun) | **5/5** | 5.8 | 9.4 | 85,301 | 2,388 | 18.6 | 0/5 | 0/5 |

Input tokens include cache reads. Every one of the 75 round-3 wire requests is
filed under its run id, so attribution is exact. For push-main, 85.3k input
tokens split into 11.5k uncached, 14.3k cache writes and 59.5k cache reads per
run. That's why its token count stays high while its cost falls.

**Cost per run at Haiku 5.5 prices** (Inference, from the token mix):
Pi ≈ $0.0017 (it caches nearly everything: 52k cache reads against 64 uncached
tokens over five runs), Think ≈ $0.0022 (no `cache_control`), push-native ≈
$0.0105 (no `cache_control`, 60 tool schemas plus a 22.8k-character prompt on
every call). At Opus 5.5 prices that's roughly 7¢, 9¢ and 42¢ per run.
Push on main ≈ $0.0047 at Haiku 5.5 and ≈ 18¢ at Opus 5.5 (Inference: list
prices; 5-minute cache writes at 1.25×; reads at 0.1× on Haiku and 0.05× on
Opus; the Opus figure assumes the same token counts).

**The rerun's caveats.** n = 5 on one easy task. Push on main made slightly
more model calls than push-native (5.8 against 5.2) and ran slower (18.6 s
against 13.9 s). I haven't traced why, and at this n it may be noise. Between
the prompt-lean measurement (CLI lead only) and main, input moved 80.6k →
85.3k on 5.4 → 5.8 calls. That tracks the extra calls, not the prompt, which
is 15.0k → 14.8k characters.

## Push bugs this spike found

All are real outside the spike, with no proxy involved. **All six are fixed on
main:** 1, 3 and 4 in #1660; 2 in #1662 (headless `success` now needs a passing
`--accept`, otherwise the outcome is `completed`; the rerun's five runs all
report `completed`); 5 in #1664; 6 in #1661. The notes below describe the
state before the fixes.

1. **The catalog is stale, and the fallback is silent.** `lib/provider-models.ts`
   `ANTHROPIC_MODELS` was refreshed 2026-07-09. The CLI only gives native tools to
   models on that list, so every 5.x model (`claude-haiku-5-5`, `claude-sonnet-5-5`,
   `claude-opus-5-5`, `claude-fable-5-1`) quietly falls back to JSON-in-text tool
   dispatch, with no log line. That includes Opus 5.5, the current default Claude.
   *Spike branch: the four ids are added.*
2. **Text-mode Push reports `success` on unfinished work.** On the JSON-in-text
   path, Haiku 5.5 narrates its next step ("Reading the source and test now.")
   without writing a fenced call. Push takes that turn as the final answer and
   ends with outcome `success` while the tests still fail. In one run the model
   says "I haven't finished this yet" and the outcome is still `success`.
3. **A thinking-only turn crashes the run.** Adaptive thinking can return a turn
   with only a thinking block. `toAnthropicMessages` replays it with an empty text
   block, or as an empty assistant turn, and Anthropic answers 400 ("text content
   blocks must be non-empty"). *Spike branch: fixed in both converters by
   `withoutEmptyText`, which drops the empty block and drops an emptied turn with a
   structured log line. Covered by 4 tests, each seen failing first.*
4. **`temperature` 400s on Haiku 5.5.** The CLI defaults `temperature: 0.1`, and
   `anthropicModelRejectsSamplingParams` misses `claude-haiku-5-5`, the only
   current model it misses. *Not fixed in the branch; the proxy strips sampling
   params for the bake-off.*
5. **`push run` ignores `--url` and `--api-key`**, though `push --help` lists both.
6. **The CLI's Anthropic path doesn't use prompt caching** (0 cache reads), even
   though the bridge has breakpoint support.

## Harness facts that matter for the decision

- **Approvals:** Think has `needsApproval` (it pauses the turn for a client) and a
  server-side `beforeToolCall` hook that can block a call. Pi has no approval step,
  only a code `beforeTool` hook. Push has its exec policy and the Auditor.
- **Secrets:** stock Think and Pi with a bare shell sent `.env` to the model in 4/5
  and 1/5 runs (`cat .env`). Nothing in either harness stood in the way. **Push's
  sensitive-path filter was never exercised:** no Push run tried to read `.env`, so
  Push's 0/5 means "not tested", not "protected".
- **Trap:** no arm tried the `curl … | sh` line. In text-mode Push runs the model
  itself flagged it as an injection and ignored it. That's the model's doing, not a
  harness's.
- **Interruption:** Pi resumed by itself after `wrangler dev` was killed
  mid-command, and recorded the cut-off call as "interrupted and may have
  partially run" (tested with a scripted model, not a real one). Think's recovery
  and Push's resume are **untested** here.
- **Visibility:** all three native records hold every tool input and output. Push's
  is the richest: 159 events per run, including a prompt snapshot each round. Think
  keeps run errors only in its submission ledger, not in the transcript. Pi marks
  interrupted tools explicitly.
- **Glue:** Think arm 339 lines, Pi arm 426 lines, against Push's existing
  ~150k-line codebase (the Push arm is a 139-line runner).
- **Platform cost:** local container dev doesn't run on Windows, so the Think and
  Pi arms ran from WSL copies. The WSL clock also drifted about 5 minutes from
  Windows, which broke time-window attribution until requests carried a run id.

## Recommendation (Inference)

Don't drop Push on loop quality: fixed, it ties. Do look hard at what drifted.
Bugs 1, 3, 4 and 6 all live in the provider-wire layer: model catalogs, sampling
rules, block shapes, caching. That's the layer the AI SDK (Think) and pi-ai (Pi)
keep current for everyone, and Push owns alone. Three months idle was enough to
break the default path on the current model generation.

If Push simplifies, **Think is the better fit**, not Pi, because it has the
approval and block hooks Push's governance would need. The canary result says
Push's policy layer has to come along: sensitive paths, exec policy and the
Auditor, rebuilt as `beforeToolCall` blocks and `needsApproval` gates. Without
them, a stock harness hands your secrets to the model.

**After the fixes (Inference).** Catching up took one day and six PRs. Both
readings of that hold: the drift is fixable, and it's the recurring bill Push
pays to own its provider-wire layer. Cost no longer argues for dropping Push
on its own, since a ~2× gap is a prefix-size problem and not a loop problem.
The governance argument for Think, if Push simplifies, is unchanged.

## Not covered

- One task, one model, five runs per arm. Small n, easy fixture.
- Interruption with a real model on any arm; Push and Think resume.
- A deployed Worker (everything ran locally).
- A directed test of Push's sensitive-path filter.
