import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectPromptPattern, executeToolCall as _rawExecuteToolCall } from '../tools.ts';

// Default `role: 'coder'` so the kernel role check admits these
// direct-executor unit tests; overridden per call where a specific
// role is under test.
const executeToolCall = (call, root, opts = {}) =>
  _rawExecuteToolCall(call, root, { role: 'coder', ...opts });

// ─── detectPromptPattern — positive cases ──────────────────────

describe('detectPromptPattern: matches real prompts', () => {
  const positives = [
    // apt / dnf style
    ['Do you want to continue? [Y/n] ', 'stdout'],
    ['Is this ok [y/N]: ', 'stdout'],
    // npm / yarn style
    ['Proceed (y/n)? ', 'stdout'],
    // ssh first-connect
    ['Are you sure you want to continue connecting (yes/no/[fingerprint])? ', 'stderr'],
    // sudo / ssh password
    ['[sudo] password for alice: ', 'stderr'],
    ["Enter passphrase for key '/home/alice/.ssh/id_rsa': ", 'stderr'],
    // git over https
    ["Username for 'https://github.com': ", 'stderr'],
    // question with decision verb
    ['Overwrite existing file? ', 'stdout'],
    ['Continue with the install? ', 'stdout'],
    // multi-line chunk with the prompt as the last line
    ['Installing package foo...\nRemove conflicting package bar? ', 'stdout'],
  ];

  for (const [text, source] of positives) {
    it(`matches: ${JSON.stringify(text)} on ${source}`, () => {
      assert.equal(detectPromptPattern(text, source), true);
    });
  }
});

// ─── detectPromptPattern — negative cases ──────────────────────

describe('detectPromptPattern: rejects non-prompts', () => {
  const negatives = [
    // Previously false-positive on /confirm/i
    ['Confirmed deletion of 3 files.', 'stdout'],
    ['Please confirm your email address by clicking the link.', 'stdout'],
    // Previously false-positive on /\?\s*$/
    ['echo "How are you?"\n', 'stdout'],
    ['Ready?', 'stdout'],
    ['Build succeeded. Any questions?', 'stdout'],
    // Passwords mentioned mid-sentence, not as a prompt
    ['Your password was reset successfully.', 'stdout'],
    // Question without a decision verb
    ['What time is it? ', 'stdout'],
    // Empty / whitespace
    ['', 'stdout'],
    ['   \n\n', 'stdout'],
    // Meta chunks never count
    ['Password: ', 'meta'],
    ['[y/N]', 'meta'],
  ];

  for (const [text, source] of negatives) {
    it(`does not match: ${JSON.stringify(text)} on ${source}`, () => {
      assert.equal(detectPromptPattern(text, source), false);
    });
  }
});

// ─── detectPromptPattern — defensive ───────────────────────────

describe('detectPromptPattern: defensive input handling', () => {
  it('returns false for non-string input', () => {
    assert.equal(detectPromptPattern(undefined, 'stdout'), false);
    assert.equal(detectPromptPattern(null, 'stdout'), false);
    assert.equal(detectPromptPattern(42, 'stdout'), false);
  });

  it('defaults source to stdout', () => {
    assert.equal(detectPromptPattern('[y/N]'), true);
  });
});

// ─── integration: trap flips on a hanging prompt, clears on close ──

describe('exec_session interactive trap (integration)', () => {
  // The trap timer fires 2s after the prompt chunk. Give ourselves a budget
  // that accounts for bash startup (~1.2s on CI) + the 2s threshold.
  const BUDGET_MS = 10_000;

  it('sets meta.interactive_trap=true when a session hangs on a prompt', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'push-trap-test-'));
    let sessionId;
    try {
      // Print a y/N-looking line without a newline, then sleep long enough
      // for the trap timer (2s) to fire but short enough that the test
      // exits in a reasonable time.
      const start = await executeToolCall(
        {
          tool: 'exec_start',
          args: {
            command: 'printf "Continue? [y/N] "; sleep 5',
            timeout_ms: 15_000,
          },
        },
        root,
        { allowExec: true },
      );
      assert.equal(start.ok, true);
      sessionId = start.meta?.session_id;
      assert.ok(sessionId);

      const deadline = Date.now() + BUDGET_MS;
      let sawTrap = false;
      let fromSeq = 0;
      while (Date.now() < deadline && !sawTrap) {
        const poll = await executeToolCall(
          {
            tool: 'exec_poll',
            args: { session_id: sessionId, from_seq: fromSeq, max_chars: 4096 },
          },
          root,
        );
        assert.equal(poll.ok, true);
        fromSeq = poll.meta.next_seq;
        if (poll.meta.interactive_trap === true) {
          sawTrap = true;
          assert.ok(
            poll.text.includes('INTERACTIVE_PROMPT_DETECTED'),
            'warning banner should appear in text output when trap is set',
          );
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 150));
      }

      assert.equal(sawTrap, true, 'expected trap to fire within budget');
    } finally {
      if (sessionId) {
        await executeToolCall({ tool: 'exec_stop', args: { session_id: sessionId } }, root).catch(
          () => {},
        );
      }
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('clears trap once the session exits normally', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'push-trap-clear-'));
    let sessionId;
    try {
      // Prompt-shaped output but the process exits immediately — trap should
      // never be reported after close.
      const start = await executeToolCall(
        {
          tool: 'exec_start',
          args: {
            command: 'echo "Continue? [y/N]"; exit 0',
            timeout_ms: 10_000,
          },
        },
        root,
        { allowExec: true },
      );
      assert.equal(start.ok, true);
      sessionId = start.meta?.session_id;

      // Wait for the session to close. The trap timer is 2s; give the
      // close handler 5s to clear it.
      const deadline = Date.now() + 8_000;
      let running = true;
      let lastPoll;
      let fromSeq = 0;
      while (Date.now() < deadline && running) {
        lastPoll = await executeToolCall(
          {
            tool: 'exec_poll',
            args: { session_id: sessionId, from_seq: fromSeq, max_chars: 4096 },
          },
          root,
        );
        fromSeq = lastPoll.meta.next_seq;
        running = Boolean(lastPoll.meta.running);
        if (running) await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.equal(running, false, 'session should have exited');

      // Wait past the trap threshold, then poll again — trap must be false
      // because the session is closed.
      await new Promise((resolve) => setTimeout(resolve, 2_500));
      const finalPoll = await executeToolCall(
        {
          tool: 'exec_poll',
          args: { session_id: sessionId, from_seq: fromSeq, max_chars: 4096 },
        },
        root,
      );
      assert.equal(finalPoll.meta.interactive_trap, false);
    } finally {
      if (sessionId) {
        await executeToolCall({ tool: 'exec_stop', args: { session_id: sessionId } }, root).catch(
          () => {},
        );
      }
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
