# Find and run tests, diagnose failures

1. Check for test config: package.json scripts, Cargo.toml, pyproject.toml, Makefile.
2. Run the test command with exec.
3. If tests fail, read the failing test files and source code to diagnose root cause.
4. Summarize: passed/failed counts, and for each failure explain the likely cause.

{{args}}

If a specific test was given, run only that. Otherwise run the full suite.
