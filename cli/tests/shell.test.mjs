import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { getCommandShellCandidates } from '../shell.ts';

describe('getCommandShellCandidates', () => {
  it('builds Windows candidates with bash-first fallback and cmd last', () => {
    const candidates = getCommandShellCandidates('win32', {
      PUSH_SHELL: 'C:\\Program Files\\Git\\bin\\bash.exe',
      SHELL: 'C:\\msys64\\usr\\bin\\bash.exe',
      SystemRoot: 'C:\\Windows',
      ProgramFiles: 'C:\\Program Files',
      ComSpec: 'C:\\Windows\\System32\\cmd.exe',
    });

    assert.equal(candidates[0].bin, 'C:\\Program Files\\Git\\bin\\bash.exe');
    assert.deepEqual(candidates[0].argsPrefix, ['-l', '-s']);
    assert.equal(candidates[0].commandMode, 'stdin');
    assert.equal(candidates[1].bin, 'C:\\msys64\\usr\\bin\\bash.exe');
    assert.ok(
      candidates.some((candidate) => candidate.bin === 'C:\\Windows\\System32\\bash.exe'),
    );
    assert.ok(candidates.some((candidate) => candidate.bin === 'bash'));
    assert.ok(candidates.some((candidate) => candidate.bin === 'pwsh'));
    assert.equal(candidates.at(-1).bin, 'C:\\Windows\\System32\\cmd.exe');
    assert.deepEqual(candidates.at(-1).argsPrefix, ['/d', '/s', '/c']);
  });

  it('uses shell-appropriate command flags for sh and powershell', () => {
    const shCandidate = getCommandShellCandidates('linux', {
      PUSH_SHELL: '/bin/sh',
    })[0];
    assert.deepEqual(shCandidate.argsPrefix, ['-c']);
    assert.equal(shCandidate.commandMode, 'argv');

    const powershellCandidate = getCommandShellCandidates('win32', {
      PUSH_SHELL: 'powershell.exe',
    })[0];
    assert.deepEqual(powershellCandidate.argsPrefix, ['-NoLogo', '-NoProfile', '-Command']);
    assert.equal(powershellCandidate.commandMode, 'argv');
  });
});
