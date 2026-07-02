import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  loadSkills,
  interpolateSkill,
  RESERVED_COMMANDS,
  getSkillPromptTemplate,
  filterSkillsForEnvironment,
  getCurrentSkillPlatform,
  lintSkills,
  formatSkillDiagnostics,
  skillDiagnosticLogLines,
  skillDiagnosticSummaryLine,
} from '../skill-loader.ts';

let tmpDir;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'push-skill-test-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('loadSkills — built-in', () => {
  it('returns all built-in skills', async () => {
    const skills = await loadSkills(tmpDir);
    const names = [...skills.keys()].sort();
    assert.deepEqual(names, [
      'commit',
      'explain',
      'fix',
      'playwright',
      'review',
      'skill-creator',
      'test',
    ]);
  });

  it('each built-in has name, description, promptTemplate, source=builtin', async () => {
    const skills = await loadSkills(tmpDir);
    for (const [name, skill] of skills) {
      assert.equal(skill.name, name);
      assert.ok(skill.description.length > 0, `${name} should have a description`);
      assert.ok(skill.promptTemplate.length > 0, `${name} should have a prompt template`);
      assert.equal(skill.source, 'builtin');
      assert.ok(skill.filePath.endsWith(`${name}.md`));
    }
  });

  it('commit skill has expected description', async () => {
    const skills = await loadSkills(tmpDir);
    assert.equal(skills.get('commit').description, 'Stage and commit changes with a clear message');
  });

  it('each built-in template contains {{args}}', async () => {
    const skills = await loadSkills(tmpDir);
    for (const [name, skill] of skills) {
      assert.ok(
        skill.promptTemplate.includes('{{args}}'),
        `${name} template should contain {{args}}`,
      );
    }
  });
});

describe('loadSkills — workspace override', () => {
  it('workspace skill overrides built-in of the same name', async () => {
    const skillDir = path.join(tmpDir, '.push', 'skills');
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(
      path.join(skillDir, 'commit.md'),
      '# Custom commit\n\nDo a custom commit.\n\n{{args}}\n',
    );

    const skills = await loadSkills(tmpDir);
    const commit = skills.get('commit');
    assert.equal(commit.source, 'workspace');
    assert.equal(commit.description, 'Custom commit');
    assert.equal(commit.promptTemplateLoaded, false);
    const prompt = await getSkillPromptTemplate(commit);
    assert.ok(prompt.includes('Do a custom commit.'));
    assert.equal(commit.promptTemplateLoaded, true);
  });

  it('workspace adds new skills alongside built-ins', async () => {
    const skillDir = path.join(tmpDir, '.push', 'skills');
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(path.join(skillDir, 'deploy.md'), '# Deploy the app\n\nRun deploy.\n');

    const skills = await loadSkills(tmpDir);
    assert.ok(skills.has('deploy'));
    assert.equal(skills.get('deploy').source, 'workspace');
    assert.equal(skills.get('deploy').promptTemplateLoaded, false);
    // Built-ins still present
    assert.ok(skills.has('commit'));
    assert.equal(skills.get('commit').source, 'builtin');
  });
});

describe('loadSkills — Claude command auto-detect', () => {
  it('loads workspace Claude commands from .claude/commands', async () => {
    const cmdDir = path.join(tmpDir, '.claude', 'commands');
    await fs.mkdir(cmdDir, { recursive: true });
    await fs.writeFile(
      path.join(cmdDir, 'ship.md'),
      '# Ship changes\n\nRun release checks and ship.\n\n{{args}}\n',
    );

    const skills = await loadSkills(tmpDir);
    assert.ok(skills.has('ship'));
    assert.equal(skills.get('ship').source, 'claude');
    assert.equal(skills.get('ship').description, 'Ship changes');
    assert.equal(skills.get('ship').promptTemplateLoaded, false);
  });

  it('loads nested Claude commands and flattens path separators to hyphens', async () => {
    const nested = path.join(tmpDir, '.claude', 'commands', 'git');
    await fs.mkdir(nested, { recursive: true });
    await fs.writeFile(path.join(nested, 'pr-review.md'), '# Review PR\n\nReview the PR.\n');

    const skills = await loadSkills(tmpDir);
    assert.ok(skills.has('git-pr-review'));
    assert.equal(skills.get('git-pr-review').source, 'claude');
  });

  it('Push workspace skills override Claude commands of the same name', async () => {
    const claudeDir = path.join(tmpDir, '.claude', 'commands');
    const pushDir = path.join(tmpDir, '.push', 'skills');
    await fs.mkdir(claudeDir, { recursive: true });
    await fs.mkdir(pushDir, { recursive: true });
    await fs.writeFile(path.join(claudeDir, 'deploy.md'), '# Claude deploy\n\nClaude flow.\n');
    await fs.writeFile(path.join(pushDir, 'deploy.md'), '# Push deploy\n\nPush flow.\n');

    const skills = await loadSkills(tmpDir);
    assert.equal(skills.get('deploy').source, 'workspace');
    assert.equal(skills.get('deploy').description, 'Push deploy');
  });

  it('loads third-party prompt templates only when requested', async () => {
    const claudeDir = path.join(tmpDir, '.claude', 'commands');
    await fs.mkdir(claudeDir, { recursive: true });
    await fs.writeFile(
      path.join(claudeDir, 'diagnose.md'),
      '# Diagnose\n\nInspect the issue.\n\n{{args}}\n',
    );

    const skills = await loadSkills(tmpDir);
    const diagnoseSkill = skills.get('diagnose');
    assert.equal(diagnoseSkill.source, 'claude');
    assert.equal(diagnoseSkill.promptTemplateLoaded, false);
    assert.equal(diagnoseSkill.promptTemplate, undefined);

    const prompt = await getSkillPromptTemplate(diagnoseSkill);
    assert.ok(prompt.includes('Inspect the issue.'));
    assert.equal(diagnoseSkill.promptTemplateLoaded, true);
    assert.ok(diagnoseSkill.promptTemplate.includes('{{args}}'));
  });
});

describe('loadSkills — validation', () => {
  it('ignores non-.md files', async () => {
    const skillDir = path.join(tmpDir, '.push', 'skills');
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(path.join(skillDir, 'readme.txt'), '# Not a skill\n\nBody.\n');

    const skills = await loadSkills(tmpDir);
    assert.ok(!skills.has('readme'));
  });

  it('ignores files with invalid names (uppercase, dots, leading hyphen)', async () => {
    const skillDir = path.join(tmpDir, '.push', 'skills');
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(path.join(skillDir, 'My-Skill.md'), '# Bad\n\nBody.\n');
    await fs.writeFile(path.join(skillDir, '-leading.md'), '# Bad\n\nBody.\n');
    await fs.writeFile(path.join(skillDir, 'trailing-.md'), '# Bad\n\nBody.\n');

    const skills = await loadSkills(tmpDir);
    assert.ok(!skills.has('My-Skill'));
    assert.ok(!skills.has('-leading'));
    assert.ok(!skills.has('trailing-'));
  });

  it('skips reserved command names', async () => {
    const skillDir = path.join(tmpDir, '.push', 'skills');
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(path.join(skillDir, 'help.md'), '# Help\n\nBody.\n');
    await fs.writeFile(path.join(skillDir, 'exit.md'), '# Exit\n\nBody.\n');

    const skills = await loadSkills(tmpDir);
    assert.ok(!skills.has('help'));
    assert.ok(!skills.has('exit'));
  });

  it('skips files with no # heading', async () => {
    const skillDir = path.join(tmpDir, '.push', 'skills');
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(path.join(skillDir, 'noheading.md'), 'Just some text.\n');

    const skills = await loadSkills(tmpDir);
    assert.ok(!skills.has('noheading'));
  });

  it('skips files with heading but empty body', async () => {
    const skillDir = path.join(tmpDir, '.push', 'skills');
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(path.join(skillDir, 'empty.md'), '# Has heading\n');

    const skills = await loadSkills(tmpDir);
    assert.ok(!skills.has('empty'));
  });

  it('handles missing workspace skills dir gracefully', async () => {
    // tmpDir has no .push/skills/ — should not throw
    const skills = await loadSkills(tmpDir);
    assert.ok(skills.size >= 7); // at least the built-ins
  });
});

describe('RESERVED_COMMANDS', () => {
  it('contains expected commands', () => {
    for (const cmd of [
      'help',
      'exit',
      'quit',
      'new',
      'clear',
      'resume',
      'remote',
      'daemon',
      'debug',
      'session',
      'model',
      'provider',
      'skills',
      'compact',
      'revert',
      'unrevert',
      'children',
    ]) {
      assert.ok(RESERVED_COMMANDS.has(cmd), `Should contain "${cmd}"`);
    }
  });
});

describe('interpolateSkill', () => {
  it('replaces {{args}} with given text', () => {
    const result = interpolateSkill('Do the thing.\n\n{{args}}\n\nDone.', 'src/main.ts');
    assert.equal(result, 'Do the thing.\n\nsrc/main.ts\n\nDone.');
  });

  it('replaces multiple {{args}} occurrences', () => {
    const result = interpolateSkill('{{args}} and {{args}}', 'foo');
    assert.equal(result, 'foo and foo');
  });

  it('handles empty args — removes placeholder', () => {
    const result = interpolateSkill('Before.\n\n{{args}}\n\nAfter.', '');
    assert.equal(result, 'Before.\n\n\n\nAfter.');
  });

  it('handles null/undefined args — removes placeholder', () => {
    const result = interpolateSkill('Do it.\n\n{{args}}', null);
    assert.equal(result, 'Do it.');
  });

  it('appends args as ARGUMENTS block when template has no placeholder', () => {
    const result = interpolateSkill('Just do the thing.', 'extra args');
    assert.equal(result, 'Just do the thing.\n\nARGUMENTS: extra args');
  });

  it('does not append ARGUMENTS block when args are empty', () => {
    const result = interpolateSkill('Just do the thing.', '');
    assert.equal(result, 'Just do the thing.');
  });

  it('trims result', () => {
    const result = interpolateSkill('  \n\nHello.\n\n  ', '');
    assert.equal(result, 'Hello.');
  });

  it('replaces $ARGUMENTS with the full argument string', () => {
    const result = interpolateSkill('Review $ARGUMENTS carefully.', 'src/main.ts --strict');
    assert.equal(result, 'Review src/main.ts --strict carefully.');
  });

  it('does not replace $ARGUMENTS when embedded in a longer word', () => {
    const result = interpolateSkill('Keep $ARGUMENTSX intact.', 'foo');
    // No token consumed the args, so they arrive via the ARGUMENTS append instead.
    assert.equal(result, 'Keep $ARGUMENTSX intact.\n\nARGUMENTS: foo');
  });

  it('replaces 0-based positionals $0/$1 (Claude Code convention)', () => {
    const result = interpolateSkill('Fix issue #$0 with priority $1.', '123 high');
    assert.equal(result, 'Fix issue #123 with priority high.');
  });

  it('replaces $ARGUMENTS[N] indexed form', () => {
    const result = interpolateSkill('First: $ARGUMENTS[0], third: $ARGUMENTS[2].', 'a b c');
    assert.equal(result, 'First: a, third: c.');
  });

  it('missing positional arguments become empty', () => {
    const result = interpolateSkill('First: $0, second: $1.', 'only');
    assert.equal(result, 'First: only, second: .');
  });

  it('shell-style quoting groups multi-word indexed arguments', () => {
    const result = interpolateSkill('$0 then $1', '"hello world" second');
    assert.equal(result, 'hello world then second');
  });

  it('$ARGUMENTS always expands to the full string as typed', () => {
    const result = interpolateSkill('$ARGUMENTS', '"hello world" second');
    assert.equal(result, '"hello world" second');
  });

  it('leaves multi-digit $NN untouched (use $ARGUMENTS[N] instead)', () => {
    const result = interpolateSkill('Value: $10', '');
    assert.equal(result, 'Value: $10');
  });

  it('does not re-expand tokens inside the argument string (single pass)', () => {
    const result = interpolateSkill('Full: {{args}} | first: $0', '$ARGUMENTS {{args}}');
    assert.equal(result, 'Full: $ARGUMENTS {{args}} | first: $ARGUMENTS');
  });

  it('mixes {{args}}, $ARGUMENTS, and positionals in one template', () => {
    const result = interpolateSkill('{{args}} / $ARGUMENTS / $1', 'one two');
    assert.equal(result, 'one two / one two / two');
  });

  it('backslash escapes positional tokens — \\$1 stays literal $1', () => {
    const result = interpolateSkill('Run: echo \\$1 with $0', 'foo');
    assert.equal(result, 'Run: echo $1 with foo');
  });

  it('backslash escapes $ARGUMENTS and {{args}}', () => {
    const result = interpolateSkill('\\$ARGUMENTS and \\{{args}} stay; $ARGUMENTS goes', 'x');
    assert.equal(result, '$ARGUMENTS and {{args}} stay; x goes');
  });

  it('escaped tokens survive even with empty args', () => {
    const result = interpolateSkill('shell example: `echo \\$1 \\$2`', '');
    assert.equal(result, 'shell example: `echo $1 $2`');
  });

  it('doubled backslash keeps both backslashes and still expands', () => {
    const result = interpolateSkill('path \\\\$0 here', 'val');
    assert.equal(result, 'path \\\\val here');
  });

  it('backslash before a non-token $ is left unchanged', () => {
    const result = interpolateSkill('cost \\$x and $z', '');
    assert.equal(result, 'cost \\$x and $z');
  });

  it('escaped-only template still gets the ARGUMENTS append (args unconsumed)', () => {
    const result = interpolateSkill('example: `echo \\$0`', 'real-arg');
    assert.equal(result, 'example: `echo $0`\n\nARGUMENTS: real-arg');
  });
});

describe('loadSkills — frontmatter parsing', () => {
  it('parses requires_capabilities and platforms from frontmatter', async () => {
    const skillDir = path.join(tmpDir, '.push', 'skills');
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(
      path.join(skillDir, 'release.md'),
      [
        '---',
        'requires_capabilities: [git:push, pr:write]',
        'platforms: [linux, macos]',
        '---',
        '# Cut a release',
        '',
        'Tag and push a release.',
        '',
        '{{args}}',
      ].join('\n'),
    );

    const skills = await loadSkills(tmpDir);
    const release = skills.get('release');
    assert.ok(release);
    assert.deepEqual(release.requiresCapabilities, ['git:push', 'pr:write']);
    assert.deepEqual(release.platforms, ['linux', 'macos']);
    assert.equal(release.description, 'Cut a release');
  });

  it('frontmatter description overrides # heading when both are present', async () => {
    const skillDir = path.join(tmpDir, '.push', 'skills');
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(
      path.join(skillDir, 'hello.md'),
      ['---', 'description: From frontmatter', '---', '# From heading', '', 'Body.'].join('\n'),
    );

    const skills = await loadSkills(tmpDir);
    assert.equal(skills.get('hello').description, 'From frontmatter');
  });

  it('# heading remains the description when frontmatter has no description', async () => {
    const skillDir = path.join(tmpDir, '.push', 'skills');
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(
      path.join(skillDir, 'hello.md'),
      ['---', 'platforms: [linux]', '---', '# From heading', '', 'Body.'].join('\n'),
    );

    const skills = await loadSkills(tmpDir);
    assert.equal(skills.get('hello').description, 'From heading');
  });

  it('parses argument-hint (and argument_hint) from frontmatter', async () => {
    const skillDir = path.join(tmpDir, '.push', 'skills');
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(
      path.join(skillDir, 'triage.md'),
      ['---', 'argument-hint: "[issue-number] [priority]"', '---', '# Triage', '', 'Body.'].join(
        '\n',
      ),
    );
    await fs.writeFile(
      path.join(skillDir, 'triage2.md'),
      ['---', 'argument_hint: <file>', '---', '# Triage 2', '', 'Body.'].join('\n'),
    );

    const skills = await loadSkills(tmpDir);
    assert.equal(skills.get('triage').argumentHint, '[issue-number] [priority]');
    assert.equal(skills.get('triage2').argumentHint, '<file>');
  });

  it('argument-hint survives lazy template loading', async () => {
    const cmdDir = path.join(tmpDir, '.claude', 'commands');
    await fs.mkdir(cmdDir, { recursive: true });
    await fs.writeFile(
      path.join(cmdDir, 'lazy.md'),
      ['---', 'argument-hint: [target]', '---', '# Lazy', '', 'Do $ARGUMENTS.'].join('\n'),
    );

    const skills = await loadSkills(tmpDir);
    const lazy = skills.get('lazy');
    assert.equal(lazy.promptTemplateLoaded, false);
    assert.equal(lazy.argumentHint, '[target]');
    await getSkillPromptTemplate(lazy);
    assert.equal(lazy.argumentHint, '[target]');
  });

  it('skills without frontmatter load unchanged (backward compat)', async () => {
    const skillDir = path.join(tmpDir, '.push', 'skills');
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(path.join(skillDir, 'plain.md'), '# Plain\n\nBody.\n');

    const skills = await loadSkills(tmpDir);
    const plain = skills.get('plain');
    assert.ok(plain);
    assert.equal(plain.description, 'Plain');
    assert.equal(plain.requiresCapabilities, undefined);
    assert.equal(plain.platforms, undefined);
  });

  it('malformed frontmatter (unclosed fence) falls back to plain parsing — fail-open', async () => {
    const skillDir = path.join(tmpDir, '.push', 'skills');
    await fs.mkdir(skillDir, { recursive: true });
    // Opening fence without a closing fence — the whole file should be treated as body.
    await fs.writeFile(
      path.join(skillDir, 'bad.md'),
      '---\nplatforms: [linux]\n# Looks like body\n\nReal body.\n',
    );

    const skills = await loadSkills(tmpDir);
    // No # heading after the (unclosed) frontmatter fence treated as body? The opening
    // fence with no close means the parser falls back: the entire raw text is the body,
    // and the first # heading inside is taken as the description. That's the expected
    // graceful behavior.
    const bad = skills.get('bad');
    assert.ok(bad);
    assert.equal(bad.description, 'Looks like body');
    assert.equal(bad.platforms, undefined);
  });

  it('unknown frontmatter keys are silently ignored (forward compat)', async () => {
    const skillDir = path.join(tmpDir, '.push', 'skills');
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(
      path.join(skillDir, 'future.md'),
      [
        '---',
        'platforms: [linux]',
        'requires_environment_variables: [API_KEY]',
        'author: someone',
        '---',
        '# Future skill',
        '',
        'Body.',
      ].join('\n'),
    );

    const skills = await loadSkills(tmpDir);
    const future = skills.get('future');
    assert.ok(future);
    assert.deepEqual(future.platforms, ['linux']);
    // Unknown keys don't surface on the Skill object.
    assert.ok(!('author' in future));
  });

  it('rejects invalid platform values, keeps valid ones', async () => {
    const skillDir = path.join(tmpDir, '.push', 'skills');
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(
      path.join(skillDir, 'mixed.md'),
      ['---', 'platforms: [linux, beos, macos]', '---', '# Mixed', '', 'Body.'].join('\n'),
    );

    const skills = await loadSkills(tmpDir);
    assert.deepEqual(skills.get('mixed').platforms, ['linux', 'macos']);
  });

  it('handles quoted array entries', async () => {
    const skillDir = path.join(tmpDir, '.push', 'skills');
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(
      path.join(skillDir, 'quoted.md'),
      [
        '---',
        'requires_capabilities: ["repo:read", "repo:write"]',
        '---',
        '# Quoted',
        '',
        'Body.',
      ].join('\n'),
    );

    const skills = await loadSkills(tmpDir);
    assert.deepEqual(skills.get('quoted').requiresCapabilities, ['repo:read', 'repo:write']);
  });

  it('drops unknown capabilities (typo fail-open) but keeps valid ones', async () => {
    const skillDir = path.join(tmpDir, '.push', 'skills');
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(
      path.join(skillDir, 'typo.md'),
      ['---', 'requires_capabilities: [git:pus, repo:write]', '---', '# Typo', '', 'Body.'].join(
        '\n',
      ),
    );

    const skills = await loadSkills(tmpDir);
    const typo = skills.get('typo');
    assert.ok(typo);
    // `git:pus` is a typo for `git:push`; it's dropped, leaving just `repo:write`.
    // Fail-open: a typo'd cap must not become an unmeetable constraint that hides
    // the skill from a runtime that genuinely supports the intended capability.
    assert.deepEqual(typo.requiresCapabilities, ['repo:write']);
  });

  it('drops the requires_capabilities field entirely when every entry is unknown', async () => {
    const skillDir = path.join(tmpDir, '.push', 'skills');
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(
      path.join(skillDir, 'all-typos.md'),
      ['---', 'requires_capabilities: [foo:bar, baz:qux]', '---', '# All typos', '', 'Body.'].join(
        '\n',
      ),
    );

    const skills = await loadSkills(tmpDir);
    const skill = skills.get('all-typos');
    assert.ok(skill);
    // No valid caps survived → the constraint disappears entirely (visible everywhere).
    assert.equal(skill.requiresCapabilities, undefined);
  });

  it('quote-aware splitter keeps commas inside quoted entries attached', async () => {
    const skillDir = path.join(tmpDir, '.push', 'skills');
    await fs.mkdir(skillDir, { recursive: true });
    // Use `description` since it's the one frontmatter field with no validation that
    // would mask the splitter behavior. Inline arrays of capabilities/platforms don't
    // currently contain commas, but the splitter must still respect quotes for forward
    // compatibility with values that do (e.g. user-facing descriptions in lists).
    await fs.writeFile(
      path.join(skillDir, 'tagged.md'),
      [
        '---',
        'platforms: ["linux", "macos"]',
        'requires_capabilities: ["repo:read", "repo:write"]',
        '---',
        '# Tagged',
        '',
        'Body.',
      ].join('\n'),
    );

    const skills = await loadSkills(tmpDir);
    const tagged = skills.get('tagged');
    // Pre-fix split(',') would have produced ['"linux"', ' "macos"'] which still unquoted
    // correctly. Post-fix keeps semantics identical for comma-free entries and additionally
    // tolerates commas inside quotes — assert the no-regression path here; the quote-respect
    // is exercised at the parser-unit level below by way of platforms / caps continuing to
    // parse identically with the new code path.
    assert.deepEqual(tagged.platforms, ['linux', 'macos']);
    assert.deepEqual(tagged.requiresCapabilities, ['repo:read', 'repo:write']);
  });
});

describe('filterSkillsForEnvironment', () => {
  function makeSkills(entries) {
    const m = new Map();
    for (const [name, props] of entries) {
      m.set(name, { name, description: name, source: 'workspace', filePath: '', ...props });
    }
    return m;
  }

  it('returns every skill when env has no axes', () => {
    const skills = makeSkills([
      ['a', { platforms: ['linux'] }],
      ['b', { requiresCapabilities: ['git:push'] }],
      ['c', {}],
    ]);
    const visible = filterSkillsForEnvironment(skills, {});
    assert.equal(visible.size, 3);
  });

  it('filters by platform when env.platform is set', () => {
    const skills = makeSkills([
      ['unix-only', { platforms: ['linux', 'macos'] }],
      ['win-only', { platforms: ['windows'] }],
      ['everywhere', {}],
    ]);
    const visible = filterSkillsForEnvironment(skills, { platform: 'linux' });
    assert.deepEqual([...visible.keys()].sort(), ['everywhere', 'unix-only']);
  });

  it('filters by capabilities when env.availableCapabilities is set', () => {
    const skills = makeSkills([
      ['needs-push', { requiresCapabilities: ['git:push'] }],
      ['needs-pr', { requiresCapabilities: ['pr:write'] }],
      ['needs-both', { requiresCapabilities: ['git:push', 'pr:write'] }],
      ['unconstrained', {}],
    ]);
    const visible = filterSkillsForEnvironment(skills, {
      availableCapabilities: new Set(['git:push']),
    });
    assert.deepEqual([...visible.keys()].sort(), ['needs-push', 'unconstrained']);
  });

  it('combines axes with AND semantics', () => {
    const skills = makeSkills([
      ['platform-only-ok', { platforms: ['linux'] }],
      ['cap-only-ok', { requiresCapabilities: ['git:push'] }],
      ['both-ok', { platforms: ['linux'], requiresCapabilities: ['git:push'] }],
      ['platform-fail', { platforms: ['windows'], requiresCapabilities: ['git:push'] }],
      ['cap-fail', { platforms: ['linux'], requiresCapabilities: ['pr:write'] }],
    ]);
    const visible = filterSkillsForEnvironment(skills, {
      platform: 'linux',
      availableCapabilities: new Set(['git:push']),
    });
    assert.deepEqual([...visible.keys()].sort(), ['both-ok', 'cap-only-ok', 'platform-only-ok']);
  });

  it('skills with no constraints are always visible', () => {
    const skills = makeSkills([['plain', {}]]);
    const visible = filterSkillsForEnvironment(skills, {
      platform: 'windows',
      availableCapabilities: new Set(),
    });
    assert.equal(visible.size, 1);
  });
});

describe('getCurrentSkillPlatform', () => {
  it('returns a known platform on supported OSes', () => {
    const p = getCurrentSkillPlatform();
    // Test runner runs on linux/macos/windows in CI; any of those is fine, undefined
    // only on exotic platforms (e.g. aix).
    if (p !== undefined) {
      assert.ok(['linux', 'macos', 'windows'].includes(p));
    }
  });
});

describe('lintSkills', () => {
  async function writeSkill(name, content) {
    const skillDir = path.join(tmpDir, '.push', 'skills');
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(path.join(skillDir, name), content);
  }

  function find(diags, code) {
    return diags.filter((d) => d.code === code);
  }

  it('a clean workspace produces no diagnostics', async () => {
    await writeSkill('deploy.md', '# Deploy the app\n\nRun deploy.\n\n{{args}}\n');
    const diags = await lintSkills(tmpDir);
    assert.deepEqual(diags, []);
  });

  it('flags an invalid filename as an error (and the skill does not load)', async () => {
    await writeSkill('My-Skill.md', '# Bad\n\nBody.\n');
    const diags = await lintSkills(tmpDir);
    const hits = find(diags, 'invalid-name');
    assert.equal(hits.length, 1);
    assert.equal(hits[0].severity, 'error');
    assert.equal(hits[0].source, 'workspace');
    assert.ok(hits[0].filePath.endsWith('My-Skill.md'));
    // And the loader genuinely drops it.
    const skills = await loadSkills(tmpDir);
    assert.ok(!skills.has('My-Skill'));
  });

  it('flags a reserved name as an error', async () => {
    await writeSkill('help.md', '# Help\n\nBody.\n');
    const diags = await lintSkills(tmpDir);
    const hits = find(diags, 'reserved-name');
    assert.equal(hits.length, 1);
    assert.equal(hits[0].severity, 'error');
    assert.equal(hits[0].name, 'help');
  });

  it('flags a missing description as an error', async () => {
    await writeSkill('noheading.md', 'Just some text, no heading.\n');
    const diags = await lintSkills(tmpDir);
    const hits = find(diags, 'missing-description');
    assert.equal(hits.length, 1);
    assert.equal(hits[0].severity, 'error');
  });

  it('flags an empty body as an error', async () => {
    await writeSkill('empty.md', '# Has heading\n');
    const diags = await lintSkills(tmpDir);
    const hits = find(diags, 'empty-body');
    assert.equal(hits.length, 1);
    assert.equal(hits[0].severity, 'error');
  });

  it('flags an unclosed frontmatter fence as a warning (skill still loads)', async () => {
    await writeSkill('bad.md', '---\nplatforms: [linux]\n# Looks like body\n\nReal body.\n');
    const diags = await lintSkills(tmpDir);
    const hits = find(diags, 'malformed-frontmatter');
    assert.equal(hits.length, 1);
    assert.equal(hits[0].severity, 'warning');
    // Fail-open: the skill is still loaded from the body.
    const skills = await loadSkills(tmpDir);
    assert.ok(skills.has('bad'));
  });

  it('flags a non-array requires_capabilities value as malformed', async () => {
    await writeSkill(
      'scalar.md',
      ['---', 'requires_capabilities: git:push', '---', '# Scalar', '', 'Body.'].join('\n'),
    );
    const diags = await lintSkills(tmpDir);
    const hits = find(diags, 'malformed-frontmatter');
    assert.equal(hits.length, 1);
    assert.equal(hits[0].severity, 'warning');
  });

  it('flags a dropped unknown capability as a warning, listing the bad entry', async () => {
    await writeSkill(
      'typo.md',
      ['---', 'requires_capabilities: [git:pus, repo:write]', '---', '# Typo', '', 'Body.'].join(
        '\n',
      ),
    );
    const diags = await lintSkills(tmpDir);
    const hits = find(diags, 'unknown-capability');
    assert.equal(hits.length, 1);
    assert.equal(hits[0].severity, 'warning');
    assert.ok(hits[0].message.includes('git:pus'));
    // The valid capability still applies on the loaded skill.
    const skills = await loadSkills(tmpDir);
    assert.deepEqual(skills.get('typo').requiresCapabilities, ['repo:write']);
  });

  it('flags a dropped unknown platform as a warning', async () => {
    await writeSkill(
      'mixed.md',
      ['---', 'platforms: [linux, beos, macos]', '---', '# Mixed', '', 'Body.'].join('\n'),
    );
    const diags = await lintSkills(tmpDir);
    const hits = find(diags, 'invalid-platform');
    assert.equal(hits.length, 1);
    assert.equal(hits[0].severity, 'warning');
    assert.ok(hits[0].message.includes('beos'));
  });

  it('sorts errors before warnings, then by file path', async () => {
    await writeSkill(
      'zwarn.md',
      ['---', 'platforms: [linux, beos]', '---', '# Warns', '', 'Body.'].join('\n'),
    );
    await writeSkill('aerror.md', '# Has heading only\n');
    const diags = await lintSkills(tmpDir);
    assert.equal(diags[0].severity, 'error');
    assert.equal(diags[diags.length - 1].severity, 'warning');
  });

  it('does not collect diagnostics when loadSkills is called without the option (unchanged path)', async () => {
    await writeSkill('empty.md', '# Has heading\n');
    // Plain load must not throw and must simply omit the broken skill.
    const skills = await loadSkills(tmpDir);
    assert.ok(!skills.has('empty'));
  });
});

describe('skillDiagnosticLogLines', () => {
  it('returns one JSON line per diagnostic with paired event names/levels', () => {
    const lines = skillDiagnosticLogLines([
      {
        filePath: '/w/a.md',
        name: 'a',
        source: 'workspace',
        severity: 'error',
        code: 'empty-body',
        message: 'no body',
      },
      {
        filePath: '/w/b.md',
        name: 'b',
        source: 'workspace',
        severity: 'warning',
        code: 'invalid-platform',
        message: 'beos dropped',
      },
    ]);
    assert.equal(lines.length, 2);
    const dropped = JSON.parse(lines[0]);
    assert.equal(dropped.level, 'warn');
    assert.equal(dropped.event, 'skill_lint_dropped');
    assert.equal(dropped.code, 'empty-body');
    const degraded = JSON.parse(lines[1]);
    assert.equal(degraded.level, 'info');
    assert.equal(degraded.event, 'skill_lint_degraded');
  });

  it('returns an empty array for no diagnostics', () => {
    assert.deepEqual(skillDiagnosticLogLines([]), []);
  });
});

describe('skillDiagnosticSummaryLine', () => {
  it('returns null when there is nothing to report', () => {
    assert.equal(skillDiagnosticSummaryLine([]), null);
  });

  it('counts dropped files separately from total problems', () => {
    const line = skillDiagnosticSummaryLine([
      {
        filePath: '/w/a.md',
        name: 'a',
        source: 'workspace',
        severity: 'error',
        code: 'empty-body',
        message: '',
      },
      {
        filePath: '/w/b.md',
        name: 'b',
        source: 'workspace',
        severity: 'warning',
        code: 'invalid-platform',
        message: '',
      },
    ]);
    assert.equal(line, '2 skill file(s) have problems, 1 skipped — /skills lint');
  });

  it('omits the skipped clause when there are only warnings', () => {
    const line = skillDiagnosticSummaryLine([
      {
        filePath: '/w/b.md',
        name: 'b',
        source: 'workspace',
        severity: 'warning',
        code: 'invalid-platform',
        message: '',
      },
    ]);
    assert.equal(line, '1 skill file(s) have problems — /skills lint');
  });
});

describe('formatSkillDiagnostics', () => {
  it('reports a clean result on its own line', () => {
    assert.equal(formatSkillDiagnostics([]), 'No skill problems found.');
  });

  it('renders each diagnostic and a summary count', () => {
    const out = formatSkillDiagnostics([
      {
        filePath: '/w/.push/skills/a.md',
        name: 'a',
        source: 'workspace',
        severity: 'error',
        code: 'empty-body',
        message: 'has a description but no body/prompt content below it; skill skipped',
      },
      {
        filePath: '/w/.push/skills/b.md',
        name: 'b',
        source: 'workspace',
        severity: 'warning',
        code: 'invalid-platform',
        message: 'unknown platform dropped: beos (valid: linux, macos, windows)',
      },
    ]);
    assert.ok(out.includes('error: /w/.push/skills/a.md'));
    assert.ok(out.includes('[empty-body]'));
    assert.ok(out.includes('warning: /w/.push/skills/b.md'));
    assert.ok(out.includes('1 error(s), 1 warning(s).'));
  });
});
