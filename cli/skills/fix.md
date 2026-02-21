# Diagnose and fix a bug or issue

1. If an error was described, use search_files and read_file to locate relevant code.
2. If no specific issue, run git_status/git_diff for recent breakage, then run tests to find failures.
3. Explain the root cause briefly.
4. Implement the fix with edit_file (preferred) or write_file.
5. Run tests to verify the fix if tests exist.
6. Summarize what was wrong and what changed.

{{args}}

If you cannot determine the root cause, say so and explain what you tried.
