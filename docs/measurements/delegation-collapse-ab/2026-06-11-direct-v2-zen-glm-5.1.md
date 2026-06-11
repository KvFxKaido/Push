## Agent eval — A/B direct arm v2 (post loop-breaker + allow-exec fixes)

**Stack:** `zen/glm-5.1` · 12 trials (1× per task) · started 2026-06-11T09:55:59.340Z

| task | trial | outcome | accept | rounds | wall | tool err | malformed |
|---|---|---|---|---|---|---|---|
| fix-string-typo | 1 | success | pass | 3 | 40.5s | 1/4 | 0 |
| fix-off-by-one | 1 | success | pass | 4 | 21.6s | 0/3 | 0 |
| implement-clamp | 1 | success | pass | 4 | 25.1s | 1/4 | 0 |
| fix-failing-test | 1 | success | pass | 6 | 15.4s | 0/5 | 2 |
| implement-from-test | 1 | success | pass | 2 | 17.0s | 0/4 | 0 |
| multi-file-rename | 1 | success | pass | 5 | 50.6s | 2/10 | 0 |
| json-config-update | 1 | success | pass | 5 | 28.6s | 1/5 | 0 |
| fix-regex-validator | 1 | success | pass | 4 | 42.7s | 0/3 | 0 |
| extract-helper | 1 | success | pass | 6 | 1m28s | 2/10 | 0 |
| add-cli-flag | 1 | success | pass | 6 | 24.3s | 0/5 | 0 |
| write-docs-section | 1 | **acceptance_failed** | **fail** | 14 | 1m28s | 4/13 | 1 |
| guard-error-handling | 1 | success | pass | 6 | 38.1s | 1/5 | 6 |

**Aggregate:** completion 11/12 (92%) · median rounds 5 · median wall 33.3s · tool-error rate 17% (12/71) · malformed 9 · adaptations 0 · error events 0

