import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadSkills, interpolateSkill, RESERVED_COMMANDS, getSkillPromptTemplate } from '../skill-loader.mjs';

let tmpDir;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'push-skill-test-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('loadSkills — built-in', () => {
  it('returns all 5 built-in skills', async () => {
    const skills = await loadSkills(tmpDir);
    const names = [...skills.keys()].sort();
    assert.deepEqual(names, ['commit', 'explain', 'fix', 'review', 'test']);
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
    await fs.writeFile(path.join(skillDir, 'commit.md'), '# Custom commit\n\nDo a custom commit.\n\n{{args}}\n');

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
    await fs.writeFile(path.join(cmdDir, 'ship.md'), '# Ship changes\n\nRun release checks and ship.\n\n{{args}}\n');

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
    await fs.writeFile(path.join(claudeDir, 'debug.md'), '# Debug\n\nInspect the issue.\n\n{{args}}\n');

    const skills = await loadSkills(tmpDir);
    const debugSkill = skills.get('debug');
    assert.equal(debugSkill.source, 'claude');
    assert.equal(debugSkill.promptTemplateLoaded, false);
    assert.equal(debugSkill.promptTemplate, undefined);

    const prompt = await getSkillPromptTemplate(debugSkill);
    assert.ok(prompt.includes('Inspect the issue.'));
    assert.equal(debugSkill.promptTemplateLoaded, true);
    assert.ok(debugSkill.promptTemplate.includes('{{args}}'));
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
    assert.ok(skills.size >= 5); // at least the built-ins
  });
});

describe('RESERVED_COMMANDS', () => {
  it('contains expected commands', () => {
    for (const cmd of ['help', 'exit', 'quit', 'new', 'session', 'model', 'provider', 'skills']) {
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

  it('handles template with no {{args}} placeholder', () => {
    const result = interpolateSkill('Just do the thing.', 'extra args');
    assert.equal(result, 'Just do the thing.');
  });

  it('trims result', () => {
    const result = interpolateSkill('  \n\nHello.\n\n  ', '');
    assert.equal(result, 'Hello.');
  });
});
