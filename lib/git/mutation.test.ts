import { describe, expect, it } from 'vitest';
import { detectGitMutation } from './mutation.ts';

describe('detectGitMutation — non-mutating', () => {
  it.each([
    'git status',
    'git diff',
    'git show HEAD',
    'git branch --show-current',
    'ls -la',
    'cat package.json',
    'rg foo src',
    'cd /workspace && git status --porcelain',
    'echo hi 2>/dev/null', // fd redirect (2>) is not an output redirect
    '',
  ])('treats %j as non-mutating', (cmd) => {
    expect(detectGitMutation(cmd).isLikelyMutating).toBe(false);
  });
});

describe('detectGitMutation — mutating with reasons', () => {
  it.each([
    ['echo hi > out.txt', 'output redirect'],
    ['echo more >> out.txt', 'output redirect'],
    ['rm -rf dist', 'filesystem mutation'],
    ['mv a b', 'filesystem mutation'],
    ['git add .', 'git mutation'],
    ['git commit -m x', 'git mutation'],
    ['npm install', 'package install'],
    ['pip install requests', 'package install'],
    ['go mod tidy', 'package install'],
    ['cargo add serde', 'package install'],
    ['sed -i s/a/b/ f', 'in-place edit'],
    ['perl -pi -e s/a/b/ f', 'in-place edit'],
  ])('flags %j as mutating (%s)', (cmd, reason) => {
    expect(detectGitMutation(cmd)).toEqual({ isLikelyMutating: true, reason });
  });
});
