# Automate browser tasks with playwright-cli (Chrome)

Use `playwright-cli` through `exec` for browser automation and web validation.

Default workflow:
1. Prefer host execution (no local Docker sandbox) because `playwright-cli` sessions need to persist across multiple commands.
2. Open Chrome explicitly: `playwright-cli open --browser=chrome <url>`
3. Use `playwright-cli snapshot --filename=.push/tmp/playwright-snapshot.yaml` (or another file path) instead of printing large snapshots to stdout.
4. Read snapshot files with `read_file` to inspect element refs, then use `click`, `fill`, `type`, `press`, etc.
5. Save screenshots to files (`playwright-cli screenshot --filename=.push/tmp/page.png`) instead of relying on stdout.
6. Close the browser when done: `playwright-cli close`

Notes:
- If running in headless mode (`push run`), `exec` requires `--allow-exec`.
- If a command fails because no browser is installed, use `playwright-cli install-browser`.
- Keep outputs small: prefer file outputs + `read_file`.

Task:
{{args}}
