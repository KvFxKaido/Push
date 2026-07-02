/*
 * The "shell parsing" and "known read-only command policy" suites below
 * exercise lib/codex-derived/command-safety.ts and are adapted from OpenAI
 * Codex's command-safety tests:
 * https://github.com/openai/codex
 * Inspected revision: db887d03e1f907467e33271572dffb73bceecd6b
 * Upstream paths:
 * - codex-rs/shell-command/src/command_safety/is_safe_command.rs
 * - codex-rs/shell-command/src/command_safety/is_dangerous_command.rs
 *
 * Copyright 2025 OpenAI
 * Modifications Copyright (c) 2026 Shawn Montgomery
 * SPDX-License-Identifier: Apache-2.0
 *
 * The "dangerous command policy" suite exercises lib/command-policy.ts,
 * which is Push-native (MIT) — git-mutation guards and find/rg high-risk
 * escalation have no upstream Codex counterpart. See lib/command-policy.ts
 * for the full explanation.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  commandMightBeDangerous,
  commandRequiresApproval,
  isKnownSafeReadOnlyCommand,
  isSinglePlainCommand,
  parsePlainCommandSequence,
  splitShellWords,
} from '../../lib/command-policy.ts';

describe('command policy shell parsing', () => {
  it('splits quoted shell words without invoking shell expansion', () => {
    assert.deepEqual(splitShellWords('git show "HEAD:file name.txt"'), [
      'git',
      'show',
      'HEAD:file name.txt',
    ]);
  });

  it('parses plain command sequences joined by safe shell operators', () => {
    assert.deepEqual(parsePlainCommandSequence('git status && rg "hello world" | wc -l'), [
      ['git', 'status'],
      ['rg', 'hello world'],
      ['wc', '-l'],
    ]);
  });

  it('rejects redirects, substitutions, grouping, and backgrounding as non-plain shell', () => {
    assert.equal(parsePlainCommandSequence('git status > out.txt'), null);
    assert.equal(parsePlainCommandSequence('echo $(pwd)'), null);
    assert.equal(parsePlainCommandSequence('(git status)'), null);
    assert.equal(parsePlainCommandSequence('git status &'), null);
  });

  it('detects only one plain command for approval-bypass matching', () => {
    assert.equal(isSinglePlainCommand('chmod 755 script.sh'), true);
    assert.equal(isSinglePlainCommand('chmod 755 script.sh && rm -rf /'), false);
    assert.equal(isSinglePlainCommand('chmod 755 script.sh > /dev/null'), false);
  });
});

describe('approval-level command policy', () => {
  it('requires approval for git operations routed or blocked by the git oracle', () => {
    assert.equal(commandRequiresApproval('git commit -m "fix"'), true);
    assert.equal(commandRequiresApproval('git push origin main'), true);
    assert.equal(commandRequiresApproval('git checkout main'), true);
    assert.equal(commandRequiresApproval('git switch -c feature/new'), true);
    assert.equal(commandRequiresApproval('git merge feature/new'), true);
    assert.equal(
      commandRequiresApproval('git remote set-url origin https://github.com/attacker/repo.git'),
      true,
    );
  });

  it('recurses through sudo/doas and simple shell wrappers', () => {
    assert.equal(commandRequiresApproval('sudo git push origin main'), true);
    assert.equal(commandRequiresApproval('sudo -E -u root git push origin main'), true);
    assert.equal(commandRequiresApproval('doas -u root git push origin main'), true);
    assert.equal(commandRequiresApproval("bash -lc 'git status && git push origin main'"), true);
  });

  it('requires approval for git flow commands behind redirects and grouping', () => {
    assert.equal(commandRequiresApproval('git push origin main >/tmp/out'), true);
    assert.equal(commandRequiresApproval('git commit -m x 2>&1'), true);
    assert.equal(commandRequiresApproval('(git merge feature/new)'), true);
    assert.equal(commandRequiresApproval('true && git push origin main >/tmp/out'), true);
    assert.equal(
      commandRequiresApproval('{ git remote set-url origin https://evil.example/r.git; }'),
      true,
    );
    assert.equal(commandRequiresApproval("bash -lc 'git commit -m x >/tmp/out'"), true);
  });

  it('does not scan harmless parsed string arguments as git operations', () => {
    assert.equal(commandRequiresApproval('echo "git push origin main"'), false);
    assert.equal(commandRequiresApproval('bash -lc \'echo "git push origin main"\''), false);
    assert.equal(commandRequiresApproval('echo "git push origin main" >/tmp/out'), false);
    assert.equal(commandRequiresApproval('printf "x|git push origin main" >/tmp/out'), false);
    assert.equal(
      commandRequiresApproval('bash -lc \'echo "git push origin main" >/tmp/out\''),
      false,
    );
  });

  it('keeps sanctioned git and non-git commands out of the approval path', () => {
    assert.equal(commandRequiresApproval('git status'), false);
    assert.equal(commandRequiresApproval('git add -A'), false);
    assert.equal(commandRequiresApproval('git fetch origin main'), false);
    assert.equal(commandRequiresApproval('npm install'), false);
  });
});

describe('known read-only command policy', () => {
  it('allows read-only git commands', () => {
    assert.equal(isKnownSafeReadOnlyCommand('git status'), true);
    assert.equal(isKnownSafeReadOnlyCommand('git log -p -1'), true);
    assert.equal(isKnownSafeReadOnlyCommand('git diff -- src/index.ts'), true);
    assert.equal(isKnownSafeReadOnlyCommand('git show HEAD:package.json'), true);
    assert.equal(isKnownSafeReadOnlyCommand('git branch --show-current'), true);
  });

  it('does not treat mutating or ambiguous git commands as known read-only', () => {
    assert.equal(isKnownSafeReadOnlyCommand('git fetch origin main'), false);
    assert.equal(isKnownSafeReadOnlyCommand('git branch feature/new'), false);
    assert.equal(isKnownSafeReadOnlyCommand('git branch -D old'), false);
    assert.equal(isKnownSafeReadOnlyCommand('git --git-dir=.evil status'), false);
    assert.equal(isKnownSafeReadOnlyCommand('git diff --output patch.txt'), false);
  });

  it('allows safe find, rg, sed, and base64 forms while rejecting unsafe options', () => {
    assert.equal(isKnownSafeReadOnlyCommand('find . -name file.txt'), true);
    assert.equal(isKnownSafeReadOnlyCommand('find . -name file.txt -delete'), false);
    assert.equal(isKnownSafeReadOnlyCommand('rg "TODO" src'), true);
    assert.equal(isKnownSafeReadOnlyCommand('rg --pre "node helper.js" TODO src'), false);
    assert.equal(isKnownSafeReadOnlyCommand('sed -n 1,5p README.md'), true);
    assert.equal(isKnownSafeReadOnlyCommand('base64 README.md'), true);
    assert.equal(isKnownSafeReadOnlyCommand('base64 --output out.b64 README.md'), false);
  });

  it('classifies shell wrappers only when every nested command is read-only', () => {
    assert.equal(isKnownSafeReadOnlyCommand("bash -lc 'git status && rg TODO src'"), true);
    assert.equal(isKnownSafeReadOnlyCommand("zsh -c 'find . -name file.txt | wc -l'"), true);
    assert.equal(isKnownSafeReadOnlyCommand("bash -lc 'git status && npm install'"), false);
    assert.equal(isKnownSafeReadOnlyCommand("bash -lc 'git status > out.txt'"), false);
  });
});

describe('dangerous command policy', () => {
  it('detects destructive commands directly and through shell wrappers', () => {
    assert.equal(commandMightBeDangerous('rm -rf /'), true);
    assert.equal(commandMightBeDangerous('find . -name "*.tmp" -delete'), true);
    assert.equal(commandMightBeDangerous('find . -name "*.tmp" -delete > deleted.log'), true);
    assert.equal(commandMightBeDangerous("bash -lc 'git status && rm -rf /'"), true);
    assert.equal(commandMightBeDangerous("bash -lc 'find . -delete'"), true);
    assert.equal(commandMightBeDangerous("bash -lc 'find . -delete > deleted.log'"), true);
  });

  it('detects dangerous git and rg invocations', () => {
    assert.equal(commandMightBeDangerous('git reset --hard HEAD~1'), true);
    assert.equal(commandMightBeDangerous('git clean -fdx'), true);
    assert.equal(commandMightBeDangerous('git push origin main --force'), true);
    assert.equal(commandMightBeDangerous('git push origin main -f'), true);
    assert.equal(commandMightBeDangerous('git push origin main --force-with-lease'), true);
    assert.equal(commandMightBeDangerous('git push origin main --force-with-lease=main:abc'), true);
    assert.equal(commandMightBeDangerous('git checkout .'), true);
    assert.equal(commandMightBeDangerous('git restore .'), true);
    assert.equal(commandMightBeDangerous('rg --pre ./helper TODO src'), true);
    assert.equal(commandMightBeDangerous('rg --pre ./helper TODO src > out'), true);
    assert.equal(commandMightBeDangerous("bash -lc 'rg --pre ./helper TODO src > out'"), true);
  });

  it('does not scan harmless parsed string arguments as dangerous commands', () => {
    assert.equal(commandMightBeDangerous('echo "rm -rf /"'), false);
    assert.equal(commandMightBeDangerous('bash -lc \'echo "find . -delete"\''), false);
  });

  it('does not flag non-mutating git checkout/restore of a specific file', () => {
    assert.equal(commandMightBeDangerous('git checkout -- src/index.ts'), false);
    assert.equal(commandMightBeDangerous('git restore src/index.ts'), false);
  });

  it('unwraps sudo/doas to check the wrapped git command too', () => {
    assert.equal(commandMightBeDangerous('sudo git reset --hard HEAD~1'), true);
    assert.equal(commandMightBeDangerous('sudo -E -u root git reset --hard HEAD~1'), true);
    assert.equal(commandMightBeDangerous('doas git clean -f'), true);
    assert.equal(commandMightBeDangerous('doas -u root git clean -f'), true);
  });

  it('does not mark ordinary non-read-only commands as dangerous', () => {
    assert.equal(commandMightBeDangerous('npm install'), false);
    assert.equal(commandMightBeDangerous('git fetch origin main'), false);
    assert.equal(commandMightBeDangerous('node scripts/build.js'), false);
  });
});
