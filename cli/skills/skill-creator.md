# Create or update a Push CLI skill

Create a focused skill in `.push/skills/<name>.md` (workspace skill) or improve an existing one.

Process:
1. Identify the target skill name and purpose from the request.
2. Check existing skills in `.push/skills/` (and `.claude/commands/` if relevant) to avoid duplicates or name collisions.
3. Use a valid skill filename: lowercase letters/numbers with optional hyphens (example: `api-review.md`).
4. Write the skill as Markdown:
   - first `# Heading` = short description shown in `/skills`
   - body = prompt template/instructions
   - include `{{args}}` where user-provided arguments should be inserted
5. Keep the skill narrow and executable. Prefer concrete steps and tool usage guidance over general advice.
6. If updating an existing skill, preserve useful behavior and call out what changed.
7. Suggest running `/skills reload` after creating/updating the file.

Quality bar:
- One job per skill
- Clear inputs/outputs
- Minimal assumptions about language/framework unless requested
- Avoid unsafe/destructive defaults

Task:
{{args}}
