/**
 * Eval task manifest — ~12 small, deterministic coding tasks with
 * mechanical acceptance.
 *
 * Design constraints:
 *  - Fixtures are tiny CommonJS projects (no npm install, no network);
 *    acceptance is plain `node` so trials are fast and repeatable.
 *  - Acceptance commands live HERE, not as workspace files, so the agent
 *    can't satisfy a task by editing its own grader. They're still shown
 *    to the model (the headless brief includes them) — knowing the target
 *    is fine; rewriting it is not.
 *  - Shell quoting: commands are shell-executed (`runCommandInResolvedShell`),
 *    so `node -e` payloads are single-quoted and the inline JS uses double
 *    quotes only. validateTasks() flags unbalanced single quotes.
 *  - Prompts name the exact files involved. The point of the harness is to
 *    measure loop mechanics (rounds, tool errors, wall-clock), not
 *    repo-archaeology skill — keep discovery noise out of the signal.
 */

import type { EvalTask } from './eval-lib';

const PKG = '{\n  "name": "eval-fixture",\n  "private": true\n}\n';

export const EVAL_TASKS: EvalTask[] = [
  {
    id: 'fix-string-typo',
    title: 'Fix a greeting typo',
    prompt:
      'In src/greet.js the greeting is misspelled ("Helo"). Fix it so greet("Ada") returns exactly "Hello, Ada!".',
    files: {
      'package.json': PKG,
      'src/greet.js':
        'function greet(name) {\n' +
        '  return "Helo, " + name + "!";\n' +
        '}\n' +
        'module.exports = { greet };\n',
    },
    accept: [
      'node -e \'const { greet } = require("./src/greet.js"); if (greet("Ada") !== "Hello, Ada!") { console.error("got: " + greet("Ada")); process.exit(1); }\'',
    ],
    solution: {
      'src/greet.js':
        'function greet(name) {\n' +
        '  return "Hello, " + name + "!";\n' +
        '}\n' +
        'module.exports = { greet };\n',
    },
    tags: ['edit', 'single-file'],
  },
  {
    id: 'fix-off-by-one',
    title: 'Fix pagination off-by-one',
    prompt:
      'src/paginate.js has an off-by-one bug: page numbers are 1-based, but paginate(items, 1, 2) currently skips the first page. Fix paginate so page 1 returns the first `size` items.',
    files: {
      'package.json': PKG,
      'src/paginate.js':
        'function paginate(items, page, size) {\n' +
        '  const start = page * size;\n' +
        '  return items.slice(start, start + size);\n' +
        '}\n' +
        'module.exports = { paginate };\n',
    },
    accept: [
      'node -e \'const { paginate } = require("./src/paginate.js"); const a = paginate(["a","b","c","d"], 1, 2); const b = paginate(["a","b","c","d"], 2, 2); if (JSON.stringify(a) !== JSON.stringify(["a","b"]) || JSON.stringify(b) !== JSON.stringify(["c","d"])) process.exit(1);\'',
    ],
    solution: {
      'src/paginate.js':
        'function paginate(items, page, size) {\n' +
        '  const start = (page - 1) * size;\n' +
        '  return items.slice(start, start + size);\n' +
        '}\n' +
        'module.exports = { paginate };\n',
    },
    tags: ['fix', 'single-file'],
  },
  {
    id: 'implement-clamp',
    title: 'Implement clamp from a stub',
    prompt:
      'Implement the clamp(value, min, max) function in src/clamp.js (currently a TODO stub). It must return min when value < min, max when value > max, and value otherwise.',
    files: {
      'package.json': PKG,
      'src/clamp.js':
        'function clamp(value, min, max) {\n' +
        '  // TODO: implement\n' +
        '  return value;\n' +
        '}\n' +
        'module.exports = { clamp };\n',
    },
    accept: [
      'node -e \'const { clamp } = require("./src/clamp.js"); if (clamp(5, 0, 10) !== 5 || clamp(-3, 0, 10) !== 0 || clamp(42, 0, 10) !== 10) process.exit(1);\'',
    ],
    solution: {
      'src/clamp.js':
        'function clamp(value, min, max) {\n' +
        '  if (value < min) return min;\n' +
        '  if (value > max) return max;\n' +
        '  return value;\n' +
        '}\n' +
        'module.exports = { clamp };\n',
    },
    tags: ['implement', 'single-file'],
  },
  {
    id: 'fix-failing-test',
    title: 'Make a failing test pass',
    prompt:
      'The test in tests/date-format.test.js fails: formatDate in src/date-format.js returns MM/DD/YYYY but the test expects YYYY-MM-DD. Fix src/date-format.js so the test passes. Do not modify the test file.',
    files: {
      'package.json': PKG,
      'src/date-format.js':
        'function formatDate(date) {\n' +
        '  const y = date.getUTCFullYear();\n' +
        '  const m = String(date.getUTCMonth() + 1).padStart(2, "0");\n' +
        '  const d = String(date.getUTCDate()).padStart(2, "0");\n' +
        '  return m + "/" + d + "/" + y;\n' +
        '}\n' +
        'module.exports = { formatDate };\n',
      'tests/date-format.test.js':
        'const { test } = require("node:test");\n' +
        'const assert = require("node:assert");\n' +
        'const { formatDate } = require("../src/date-format.js");\n' +
        '\n' +
        'test("formatDate returns YYYY-MM-DD", () => {\n' +
        '  assert.strictEqual(formatDate(new Date(Date.UTC(2026, 5, 10))), "2026-06-10");\n' +
        '  assert.strictEqual(formatDate(new Date(Date.UTC(1999, 0, 1))), "1999-01-01");\n' +
        '});\n',
    },
    accept: [
      'node --test tests/date-format.test.js',
      'node -e \'const fs = require("fs"); const t = fs.readFileSync("tests/date-format.test.js", "utf8"); if (!t.includes("YYYY-MM-DD") || !t.includes("2026-06-10")) { console.error("test file was modified"); process.exit(1); }\'',
    ],
    solution: {
      'src/date-format.js':
        'function formatDate(date) {\n' +
        '  const y = date.getUTCFullYear();\n' +
        '  const m = String(date.getUTCMonth() + 1).padStart(2, "0");\n' +
        '  const d = String(date.getUTCDate()).padStart(2, "0");\n' +
        '  return y + "-" + m + "-" + d;\n' +
        '}\n' +
        'module.exports = { formatDate };\n',
    },
    tags: ['fix', 'test-driven'],
  },
  {
    id: 'implement-from-test',
    title: 'Implement a module to satisfy an existing test',
    prompt:
      'tests/kebab.test.js tests a toKebabCase function from src/kebab.js, but src/kebab.js is an empty stub. Implement toKebabCase so the test passes. Do not modify the test file.',
    files: {
      'package.json': PKG,
      'src/kebab.js': 'module.exports = { toKebabCase: null };\n',
      'tests/kebab.test.js':
        'const { test } = require("node:test");\n' +
        'const assert = require("node:assert");\n' +
        'const { toKebabCase } = require("../src/kebab.js");\n' +
        '\n' +
        'test("toKebabCase handles camelCase, spaces, and underscores", () => {\n' +
        '  assert.strictEqual(toKebabCase("helloWorld"), "hello-world");\n' +
        '  assert.strictEqual(toKebabCase("Hello World"), "hello-world");\n' +
        '  assert.strictEqual(toKebabCase("snake_case_name"), "snake-case-name");\n' +
        '  assert.strictEqual(toKebabCase("already-kebab"), "already-kebab");\n' +
        '});\n',
    },
    accept: [
      'node --test tests/kebab.test.js',
      'node -e \'const fs = require("fs"); const t = fs.readFileSync("tests/kebab.test.js", "utf8"); if (!t.includes("snake_case_name")) { console.error("test file was modified"); process.exit(1); }\'',
    ],
    solution: {
      'src/kebab.js':
        'function toKebabCase(input) {\n' +
        '  return input\n' +
        '    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")\n' +
        '    .replace(/[\\s_]+/g, "-")\n' +
        '    .toLowerCase();\n' +
        '}\n' +
        'module.exports = { toKebabCase };\n',
    },
    tags: ['implement', 'test-driven'],
  },
  {
    id: 'multi-file-rename',
    title: 'Rename a function across three files',
    prompt:
      'Rename the function fetchData to loadData everywhere it appears: it is defined in src/data.js and used in src/app.js and src/report.js. The exported name and all call sites must change; behavior must stay identical.',
    files: {
      'package.json': PKG,
      'src/data.js':
        'function fetchData(key) {\n' +
        '  return { key, value: "v-" + key };\n' +
        '}\n' +
        'module.exports = { fetchData };\n',
      'src/app.js':
        'const { fetchData } = require("./data.js");\n' +
        'function appMain() {\n' +
        '  return fetchData("app").value;\n' +
        '}\n' +
        'module.exports = { appMain };\n',
      'src/report.js':
        'const { fetchData } = require("./data.js");\n' +
        'function buildReport() {\n' +
        '  return "report:" + fetchData("report").value;\n' +
        '}\n' +
        'module.exports = { buildReport };\n',
    },
    accept: [
      'node -e \'const { loadData } = require("./src/data.js"); const { appMain } = require("./src/app.js"); const { buildReport } = require("./src/report.js"); if (typeof loadData !== "function" || appMain() !== "v-app" || buildReport() !== "report:v-report") process.exit(1);\'',
      'node -e \'const fs = require("fs"); for (const f of ["src/data.js", "src/app.js", "src/report.js"]) { if (fs.readFileSync(f, "utf8").includes("fetchData")) { console.error("fetchData still present in " + f); process.exit(1); } }\'',
    ],
    solution: {
      'src/data.js':
        'function loadData(key) {\n' +
        '  return { key, value: "v-" + key };\n' +
        '}\n' +
        'module.exports = { loadData };\n',
      'src/app.js':
        'const { loadData } = require("./data.js");\n' +
        'function appMain() {\n' +
        '  return loadData("app").value;\n' +
        '}\n' +
        'module.exports = { appMain };\n',
      'src/report.js':
        'const { loadData } = require("./data.js");\n' +
        'function buildReport() {\n' +
        '  return "report:" + loadData("report").value;\n' +
        '}\n' +
        'module.exports = { buildReport };\n',
    },
    tags: ['refactor', 'multi-file'],
  },
  {
    id: 'json-config-update',
    title: 'Update a JSON config',
    prompt:
      'In config/settings.json: change "port" from 3000 to 8080 and add a top-level "logLevel" key set to "debug". Keep all other keys unchanged and keep the file valid JSON.',
    files: {
      'package.json': PKG,
      'config/settings.json': '{\n  "port": 3000,\n  "host": "127.0.0.1",\n  "retries": 2\n}\n',
    },
    accept: [
      'node -e \'const c = JSON.parse(require("fs").readFileSync("config/settings.json", "utf8")); if (c.port !== 8080 || c.logLevel !== "debug" || c.host !== "127.0.0.1" || c.retries !== 2) process.exit(1);\'',
    ],
    solution: {
      'config/settings.json':
        '{\n  "port": 8080,\n  "host": "127.0.0.1",\n  "retries": 2,\n  "logLevel": "debug"\n}\n',
    },
    tags: ['edit', 'config'],
  },
  {
    id: 'fix-regex-validator',
    title: 'Fix a broken email validator regex',
    prompt:
      'isValidEmail in src/validate.js is broken: it accepts strings without an "@" and rejects addresses with a dot in the local part (like "first.last@example.com"). Fix the validation so the basic shape local@domain.tld works: non-empty local part (letters, digits, dots, hyphens, underscores, plus), an "@", and a domain with at least one dot.',
    files: {
      'package.json': PKG,
      'src/validate.js':
        'function isValidEmail(input) {\n' +
        '  return /^[a-z0-9_-]*@?[a-z0-9.-]*$/i.test(input);\n' +
        '}\n' +
        'module.exports = { isValidEmail };\n',
    },
    accept: [
      'node -e \'const { isValidEmail } = require("./src/validate.js"); const good = ["a@b.co", "first.last@example.com", "x_y+z@mail.example.org"]; const bad = ["", "plainstring", "no-at.example.com", "a@b"]; for (const g of good) if (!isValidEmail(g)) { console.error("rejected good: " + g); process.exit(1); } for (const b of bad) if (isValidEmail(b)) { console.error("accepted bad: " + b); process.exit(1); }\'',
    ],
    solution: {
      'src/validate.js':
        'function isValidEmail(input) {\n' +
        '  return /^[a-z0-9._+-]+@[a-z0-9-]+(\\.[a-z0-9-]+)+$/i.test(input);\n' +
        '}\n' +
        'module.exports = { isValidEmail };\n',
    },
    tags: ['fix', 'single-file'],
  },
  {
    id: 'extract-helper',
    title: 'Extract a duplicated helper into a shared module',
    prompt:
      'src/download.js and src/upload.js contain identical copies of a formatBytes function. Extract it into a new file src/format.js (module.exports = { formatBytes }) and make both files require it from there. Both modules must keep working; neither may define its own formatBytes afterwards.',
    files: {
      'package.json': PKG,
      'src/download.js':
        'function formatBytes(n) {\n' +
        '  if (n < 1024) return n + " B";\n' +
        '  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";\n' +
        '  return (n / (1024 * 1024)).toFixed(1) + " MB";\n' +
        '}\n' +
        'function downloadSummary(bytes) {\n' +
        '  return "downloaded " + formatBytes(bytes);\n' +
        '}\n' +
        'module.exports = { downloadSummary };\n',
      'src/upload.js':
        'function formatBytes(n) {\n' +
        '  if (n < 1024) return n + " B";\n' +
        '  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";\n' +
        '  return (n / (1024 * 1024)).toFixed(1) + " MB";\n' +
        '}\n' +
        'function uploadSummary(bytes) {\n' +
        '  return "uploaded " + formatBytes(bytes);\n' +
        '}\n' +
        'module.exports = { uploadSummary };\n',
    },
    accept: [
      'node -e \'const { formatBytes } = require("./src/format.js"); const { downloadSummary } = require("./src/download.js"); const { uploadSummary } = require("./src/upload.js"); if (formatBytes(512) !== "512 B" || downloadSummary(2048) !== "downloaded 2.0 KB" || uploadSummary(3145728) !== "uploaded 3.0 MB") process.exit(1);\'',
      'node -e \'const fs = require("fs"); for (const f of ["src/download.js", "src/upload.js"]) { const s = fs.readFileSync(f, "utf8"); if (s.includes("function formatBytes")) { console.error("formatBytes still defined in " + f); process.exit(1); } if (!s.includes("require(\\u0022./format")) { console.error(f + " does not require ./format"); process.exit(1); } }\'',
    ],
    solution: {
      'src/format.js':
        'function formatBytes(n) {\n' +
        '  if (n < 1024) return n + " B";\n' +
        '  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";\n' +
        '  return (n / (1024 * 1024)).toFixed(1) + " MB";\n' +
        '}\n' +
        'module.exports = { formatBytes };\n',
      'src/download.js':
        'const { formatBytes } = require("./format.js");\n' +
        'function downloadSummary(bytes) {\n' +
        '  return "downloaded " + formatBytes(bytes);\n' +
        '}\n' +
        'module.exports = { downloadSummary };\n',
      'src/upload.js':
        'const { formatBytes } = require("./format.js");\n' +
        'function uploadSummary(bytes) {\n' +
        '  return "uploaded " + formatBytes(bytes);\n' +
        '}\n' +
        'module.exports = { uploadSummary };\n',
    },
    tags: ['refactor', 'multi-file'],
  },
  {
    id: 'add-cli-flag',
    title: 'Add a flag to a small CLI',
    prompt:
      'bin/tool.js is a tiny CLI that prints "Hello, <name>!" from --name. Add a --shout boolean flag: when present, the output is uppercased (e.g. "HELLO, ADA!"). Without --shout, behavior must not change.',
    files: {
      'package.json': PKG,
      'bin/tool.js':
        'const args = process.argv.slice(2);\n' +
        'function readFlag(name) {\n' +
        '  const i = args.indexOf("--" + name);\n' +
        '  return i === -1 ? null : args[i + 1];\n' +
        '}\n' +
        'const name = readFlag("name") || "world";\n' +
        'console.log("Hello, " + name + "!");\n',
    },
    accept: [
      'node -e \'const { execFileSync } = require("child_process"); const plain = execFileSync("node", ["bin/tool.js", "--name", "Ada"]).toString().trim(); const shout = execFileSync("node", ["bin/tool.js", "--name", "Ada", "--shout"]).toString().trim(); if (plain !== "Hello, Ada!" || shout !== "HELLO, ADA!") { console.error("plain=" + plain + " shout=" + shout); process.exit(1); }\'',
    ],
    solution: {
      'bin/tool.js':
        'const args = process.argv.slice(2);\n' +
        'function readFlag(name) {\n' +
        '  const i = args.indexOf("--" + name);\n' +
        '  return i === -1 ? null : args[i + 1];\n' +
        '}\n' +
        'const name = readFlag("name") || "world";\n' +
        'const shout = args.includes("--shout");\n' +
        'const message = "Hello, " + name + "!";\n' +
        'console.log(shout ? message.toUpperCase() : message);\n',
    },
    tags: ['implement', 'cli'],
  },
  {
    id: 'write-docs-section',
    title: 'Document a module in the README',
    prompt:
      'Add a "## Usage" section to README.md documenting the greet function from src/greet.js: include at least one fenced js code block showing require() of "./src/greet.js" and a greet() call. Keep the existing title line intact.',
    files: {
      'package.json': PKG,
      'README.md': '# eval-fixture\n\nA tiny fixture project.\n',
      'src/greet.js':
        'function greet(name) {\n' +
        '  return "Hello, " + name + "!";\n' +
        '}\n' +
        'module.exports = { greet };\n',
    },
    accept: [
      'node -e \'const s = require("fs").readFileSync("README.md", "utf8"); if (!s.startsWith("# eval-fixture")) { console.error("title changed"); process.exit(1); } if (!s.includes("## Usage")) { console.error("no Usage section"); process.exit(1); } if (!/```js[\\s\\S]*require\\(.\\.\\/src\\/greet\\.js.\\)[\\s\\S]*greet\\(/.test(s)) { console.error("no js code block with require + greet call"); process.exit(1); }\'',
    ],
    solution: {
      'README.md':
        '# eval-fixture\n' +
        '\n' +
        'A tiny fixture project.\n' +
        '\n' +
        '## Usage\n' +
        '\n' +
        '```js\n' +
        'const { greet } = require("./src/greet.js");\n' +
        '\n' +
        'console.log(greet("Ada")); // "Hello, Ada!"\n' +
        '```\n',
    },
    tags: ['docs'],
  },
  {
    id: 'guard-error-handling',
    title: 'Make a config reader fail soft',
    prompt:
      'readConfig in src/read-config.js currently throws when the file is missing or contains invalid JSON. Change it to return null in both of those cases instead of throwing, while still returning the parsed object for a valid file.',
    files: {
      'package.json': PKG,
      'src/read-config.js':
        'const fs = require("fs");\n' +
        'function readConfig(file) {\n' +
        '  return JSON.parse(fs.readFileSync(file, "utf8"));\n' +
        '}\n' +
        'module.exports = { readConfig };\n',
      'config/good.json': '{ "ok": true }\n',
      'config/bad.json': '{ not json\n',
    },
    accept: [
      'node -e \'const { readConfig } = require("./src/read-config.js"); if (readConfig("config/missing.json") !== null) { console.error("missing file did not return null"); process.exit(1); } if (readConfig("config/bad.json") !== null) { console.error("invalid json did not return null"); process.exit(1); } const good = readConfig("config/good.json"); if (!good || good.ok !== true) { console.error("valid file broken"); process.exit(1); }\'',
    ],
    solution: {
      'src/read-config.js':
        'const fs = require("fs");\n' +
        'function readConfig(file) {\n' +
        '  try {\n' +
        '    return JSON.parse(fs.readFileSync(file, "utf8"));\n' +
        '  } catch {\n' +
        '    return null;\n' +
        '  }\n' +
        '}\n' +
        'module.exports = { readConfig };\n',
    },
    tags: ['fix', 'error-handling'],
  },
];
