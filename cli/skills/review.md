# Review code changes for bugs and issues

1. If a file or path was specified, read it with read_file. Otherwise, run git_diff for uncommitted changes.
2. Analyze for: bugs, missing error handling, performance, style, security.
3. Present findings as a concise list ordered by severity, with file:line references.
4. If the code looks good, say so briefly.

{{args}}

Be direct. Flag real problems, skip nitpicks.
