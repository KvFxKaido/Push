## Agent eval — A/B direct arm (delegation-collapse)

**Stack:** `zen/glm-5.1` · 12 trials (1× per task) · started 2026-06-11T09:10:13.207Z

| task | trial | outcome | accept | rounds | wall | tool err | malformed |
|---|---|---|---|---|---|---|---|
| fix-string-typo | 1 | success | pass | 4 | 16.5s | 1/3 | 0 |
| fix-off-by-one | 1 | success | pass | 6 | 1m2s | 1/4 | 1 |
| implement-clamp | 1 | success | pass | 4 | 29.3s | 1/3 | 0 |
| fix-failing-test | 1 | success | pass | 4 | 49.6s | 3/7 | 0 |
| implement-from-test | 1 | success | pass | 4 | 40.2s | 1/4 | 0 |
| multi-file-rename | 1 | success | pass | 5 | 42.9s | 3/12 | 0 |
| json-config-update | 1 | success | pass | 6 | 30.3s | 1/4 | 1 |
| fix-regex-validator | 1 | success | pass | 6 | 51.3s | 2/5 | 0 |
| extract-helper | 1 | success | pass | 5 | 47.1s | 3/14 | 0 |
| add-cli-flag | 1 | **error** | pass | 6 | 19.3s | 1/5 | 0 |
| write-docs-section | 1 | **error** | pass | 7 | 1m12s | 1/8 | 1 |
| guard-error-handling | 1 | success | pass | 3 | 27.1s | 1/7 | 0 |

**Aggregate:** completion 10/12 (83%) · median rounds 5 · median wall 41.5s · tool-error rate 25% (19/76) · malformed 3 · adaptations 0 · error events 2

