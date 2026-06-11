## Agent eval — A/B delegated arm v2 (post loop-breaker + allow-exec fixes)

**Stack:** `zen/glm-5.1` (delegated) · 12 trials (1× per task) · started 2026-06-11T10:04:22.131Z

| task | trial | outcome | accept | rounds | wall | tool err | malformed |
|---|---|---|---|---|---|---|---|
| fix-string-typo | 1 | success | pass | 4 | 24.9s | 1/4 | 0 |
| fix-off-by-one | 1 | success | pass | 4 | 26.1s | 0/3 | 0 |
| implement-clamp | 1 | success | pass | 6 | 48.9s | 0/5 | 0 |
| fix-failing-test | 1 | success | pass | 6 | 49.8s | 1/6 | 1 |
| implement-from-test | 1 | success | pass | 5 | 2m24s | 1/6 | 1 |
| multi-file-rename | 1 | success | pass | 9 | 1m11s | 0/8 | 0 |
| json-config-update | 1 | success | pass | 4 | 50.8s | 0/4 | 0 |
| fix-regex-validator | 1 | success | pass | 4 | 1m4s | 0/6 | 0 |
| extract-helper | 1 | success | pass | 11 | 1m59s | 5/18 | 0 |
| add-cli-flag | 1 | success | pass | 5 | 54.4s | 1/6 | 0 |
| write-docs-section | 1 | success | pass | 14 | 2m39s | 6/17 | 1 |
| guard-error-handling | 1 | **delegation_failed** | n/a | 0 | 2m26s | 0/0 | 0 |

**Aggregate:** completion 11/12 (92%) · median rounds 5 · median wall 59.3s · tool-error rate 18% (15/83) · malformed 3 · adaptations 0 · error events 1

