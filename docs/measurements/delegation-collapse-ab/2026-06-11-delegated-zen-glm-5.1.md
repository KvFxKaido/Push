## Agent eval — A/B delegated arm (delegation-collapse)

**Stack:** `zen/glm-5.1` (delegated) · 12 trials (1× per task) · started 2026-06-11T09:18:44.739Z

| task | trial | outcome | accept | rounds | wall | tool err | malformed |
|---|---|---|---|---|---|---|---|
| fix-string-typo | 1 | success | pass | 5 | 37.6s | 2/5 | 0 |
| fix-off-by-one | 1 | success | pass | 4 | 1m1s | 1/5 | 0 |
| implement-clamp | 1 | success | pass | 5 | 46.3s | 1/4 | 0 |
| fix-failing-test | 1 | success | pass | 5 | 41.3s | 2/6 | 0 |
| implement-from-test | 1 | success | pass | 4 | 1m15s | 1/6 | 0 |
| multi-file-rename | 1 | success | pass | 6 | 1m9s | 3/11 | 0 |
| json-config-update | 1 | success | pass | 3 | 38.2s | 1/4 | 0 |
| fix-regex-validator | 1 | success | pass | 4 | 1m8s | 1/3 | 0 |
| extract-helper | 1 | success | pass | 7 | 2m51s | 12/24 | 0 |
| add-cli-flag | 1 | success | pass | 6 | 1m26s | 1/5 | 0 |
| write-docs-section | 1 | **delegation_failed** | n/a | 0 | 1m4s | 1/8 | 2 |
| guard-error-handling | 1 | **success** | **fail** | 5 | 49.0s | 0/7 | 1 |

**Aggregate:** completion 10/12 (83%) · median rounds 5 · median wall 1m3s · tool-error rate 30% (26/88) · malformed 3 · adaptations 0 · error events 1

