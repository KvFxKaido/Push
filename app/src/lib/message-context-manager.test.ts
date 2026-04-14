import { describe, it, expect } from 'vitest';
import {
  createContextManager,
  type ContextBudget,
  type Message,
} from '@push/lib/message-context-manager';

/**
 * Smoke tests for the generic lib implementation. We build a stubbed
 * dependency bundle so the tests exercise the real control flow without
 * pulling in the web-side token estimator / compaction pipeline.
 */
describe('lib/message-context-manager (generic)', () => {
  interface FakeMsg extends Message {
    id: string;
  }

  const BUDGET: ContextBudget = {
    maxTokens: 100,
    targetTokens: 50,
    summarizeTokens: 40,
  };

  const makeDeps = () => ({
    mode: 'graceful' as 'graceful' | 'none',
    metrics: [] as Array<{ phase: string; beforeTokens: number; afterTokens: number }>,
    logs: [] as string[],
  });

  const build = (state: ReturnType<typeof makeDeps>) =>
    createContextManager<FakeMsg>({
      getContextMode: () => state.mode,
      // 1 token per character — simple linear estimator
      estimateMessageTokens: (m) => m.content.length,
      estimateContextTokens: (ms) => ms.reduce((sum, m) => sum + m.content.length, 0),
      compactMessage: (m) => ({ ...m, content: m.content.slice(0, 4) }),
      buildContextDigestBlock: (removed) => `[digest ${removed.length}]`,
      createDigestMessage: (content) => ({
        id: 'digest',
        role: 'user',
        content,
        isToolResult: true,
      }),
      recordContextMetric: (m) =>
        state.metrics.push({
          phase: m.phase,
          beforeTokens: m.beforeTokens,
          afterTokens: m.afterTokens,
        }),
      log: (line) => state.logs.push(line),
    });

  it('returns input unchanged when total tokens fit the summarize threshold', () => {
    const state = makeDeps();
    const mgr = build(state);
    const messages: FakeMsg[] = [
      { id: '1', role: 'user', content: 'hi' },
      { id: '2', role: 'assistant', content: 'hello' },
    ];
    const out = mgr.manageContext(messages, BUDGET);
    expect(out).toBe(messages);
    expect(state.metrics).toHaveLength(0);
  });

  it('short-circuits when the context mode is disabled', () => {
    const state = makeDeps();
    state.mode = 'none';
    const mgr = build(state);
    const huge: FakeMsg[] = Array.from({ length: 20 }, (_, i) => ({
      id: String(i),
      role: 'user' as const,
      content: 'x'.repeat(200),
    }));
    const out = mgr.manageContext(huge, BUDGET);
    expect(out).toBe(huge);
    expect(state.metrics).toHaveLength(0);
  });

  it('classifySummarizationCause distinguishes tool output, long message, and mixed', () => {
    const state = makeDeps();
    const mgr = build(state);
    const toolOnly: FakeMsg[] = [
      { id: '1', role: 'user', content: 'x'.repeat(900), isToolResult: true },
      { id: '2', role: 'user', content: 'short' },
    ];
    expect(mgr.classifySummarizationCause(toolOnly, 2)).toBe('tool_output');

    const longOnly: FakeMsg[] = [
      { id: '1', role: 'assistant', content: 'x'.repeat(900) },
      { id: '2', role: 'user', content: 'short' },
    ];
    expect(mgr.classifySummarizationCause(longOnly, 2)).toBe('long_message');

    const mixed: FakeMsg[] = [
      { id: '1', role: 'user', content: 'x'.repeat(900), isToolResult: true },
      { id: '2', role: 'assistant', content: 'y'.repeat(900) },
    ];
    expect(mgr.classifySummarizationCause(mixed, 2)).toBe('mixed');
  });

  it('summarizes verbose old messages when the summarize threshold is crossed', () => {
    const state = makeDeps();
    const mgr = build(state);
    // 10 messages — enough that the "recent tail boundary" (up to 14, or 6
    // once over 80% of summarizeTokens) leaves some messages outside and
    // eligible for compaction.
    const messages: FakeMsg[] = Array.from({ length: 10 }, (_, i) => ({
      id: String(i),
      role: i % 2 === 0 ? ('user' as const) : ('assistant' as const),
      content: 'xxxxxxxxxx', // 10 chars each → totals 100 tokens
      isToolResult: i > 0, // everything except the first is a tool result
    }));
    const before = messages.reduce((sum, m) => sum + m.content.length, 0);
    const out = mgr.manageContext(messages, BUDGET);
    expect(out.length).toBeGreaterThan(0);
    const totalAfter = out.reduce((sum, m) => sum + m.content.length, 0);
    // Something should have been trimmed — either via compaction or digest drop.
    expect(totalAfter).toBeLessThan(before);
    // At least one metric event should have been recorded.
    expect(state.metrics.length).toBeGreaterThan(0);
  });

  it('buildContextDigest returns the injected digest block', () => {
    const state = makeDeps();
    const mgr = build(state);
    const removed: FakeMsg[] = [
      { id: '1', role: 'user', content: 'a' },
      { id: '2', role: 'user', content: 'b' },
    ];
    expect(mgr.buildContextDigest(removed)).toBe('[digest 2]');
  });

  /**
   * Regression coverage for bugs flagged by Copilot on PR #283. The hard-trim
   * fallback branch previously (a) clobbered the digest message via a blind
   * `splice(1, 1)` and (b) reported `messages.length - hardResult.length` as the
   * drop count for the `hard_trim` phase — which mixes the pre-Phase-1 baseline
   * with the post-digest-insertion kept array.
   */
  describe('hard-trim fallback (PR #283 bug fixes)', () => {
    /**
     * Build a scenario that deterministically enters the hard-trim branch with
     * the digest inserted at kept[1]. Layout (30 messages):
     *   - msg[0..9]   : assistant, 8-char content (large, Phase-2 drops these)
     *   - msg[10]     : user, 1-char content — pinned as firstUserIdx
     *   - msg[11..29] : assistant, 1-char content (survive Phase 2, push digest
     *                   to kept[1] once msg[0..9] are removed)
     * Budget is tight enough that `kept` (21 messages) still overflows
     * `maxTokens`, triggering the hard-trim loop.
     */
    const buildHardTrimScenario = () => {
      let lastDigest: FakeMsg | null = null;
      const metrics: Array<{
        phase: string;
        beforeTokens: number;
        afterTokens: number;
        messagesDropped?: number;
      }> = [];
      const mgr = createContextManager<FakeMsg>({
        getContextMode: () => 'graceful',
        estimateMessageTokens: (m) => m.content.length,
        estimateContextTokens: (ms) => ms.reduce((sum, m) => sum + m.content.length, 0),
        compactMessage: (m) => ({ ...m, content: m.content.slice(0, 4) }),
        buildContextDigestBlock: (removed) => `[digest ${removed.length}]`,
        createDigestMessage: (content) => {
          const msg: FakeMsg = {
            id: 'digest-sentinel',
            role: 'user',
            content,
            isToolResult: true,
          };
          lastDigest = msg;
          return msg;
        },
        recordContextMetric: (m) =>
          metrics.push({
            phase: m.phase,
            beforeTokens: m.beforeTokens,
            afterTokens: m.afterTokens,
            messagesDropped: m.messagesDropped,
          }),
        log: () => {},
      });

      const messages: FakeMsg[] = [
        ...Array.from({ length: 10 }, (_, i) => ({
          id: `pre-${i}`,
          role: 'assistant' as const,
          content: 'aaaaaaaa', // 8 chars
        })),
        { id: 'user', role: 'user' as const, content: 'b' },
        ...Array.from({ length: 19 }, (_, i) => ({
          id: `post-${i}`,
          role: 'assistant' as const,
          content: 'c',
        })),
      ];

      const budget: ContextBudget = {
        maxTokens: 25,
        targetTokens: 20,
        summarizeTokens: 30,
      };

      return {
        mgr,
        messages,
        budget,
        metrics,
        getDigest: () => lastDigest,
      };
    };

    it('preserves the digest message through the hard-trim loop', () => {
      const { mgr, messages, budget, metrics, getDigest } = buildHardTrimScenario();
      const out = mgr.manageContext(messages, budget);

      // The hard-trim branch should have fired.
      const hardTrim = metrics.find((m) => m.phase === 'hard_trim');
      expect(hardTrim).toBeDefined();

      // Digest must be identifiable and must survive the loop.
      const digest = getDigest();
      expect(digest).not.toBeNull();
      expect(out.some((m) => m === digest)).toBe(true);

      // It should still sit near the top of the kept window, right after the
      // pinned first user message — which is where it was originally inserted.
      expect(out[1]).toBe(digest);
    });

    it('reports hard_trim messagesDropped relative to the kept baseline', () => {
      const { mgr, messages, budget, metrics } = buildHardTrimScenario();
      const out = mgr.manageContext(messages, budget);

      const hardTrim = metrics.find((m) => m.phase === 'hard_trim');
      expect(hardTrim).toBeDefined();

      // Exact math for this scenario (see buildHardTrimScenario comment):
      //   Phase 2 drops msg[0..9]  → toRemove.size = 10
      //   kept = [msg[10], digest, msg[11..29]]  → kept.length = 21
      //   Hard-trim loop peels 4 messages before hitting the digest guard
      //   → hardResult.length = 17
      //   → messagesDropped (correct: kept.length - hardResult.length) = 4
      //   The old buggy formula would report messages.length - hardResult.length
      //   = 30 - 17 = 13, so this assertion also guards Bug 2 from regressing.
      expect(out.length).toBe(17);
      expect(hardTrim?.messagesDropped).toBe(4);
    });
  });

  /**
   * Regression coverage for the Copilot edge case flagged on PR #285: the
   * hard-trim fallback previously only excluded `digestMessage` and protected
   * `idx === 0` / the recent tail. That works when the pinned first user
   * message lands at `kept[0]` (the common case, where `firstUserIdx === 0`
   * in the original array). But when the history starts with tool results or
   * an assistant preamble BEFORE the first user message, those earlier
   * messages can survive Phase 2 and push the pinned user message to
   * `kept[>= 1]`. In that layout, the hard-trim `findIndex` filter would
   * happily remove the pinned user once its index > 0 — violating the
   * "Always keep the first user message" guarantee that the earlier phases
   * enforce. See
   * https://github.com/KvFxKaido/Push/pull/285#discussion_r3076833967.
   *
   * The fix captures the pinned message **by reference** after Phase 1 (so
   * the reference tracks the possibly-compacted object that actually lands
   * in `kept`), and adds `msg !== pinnedUserMessage` to the `findIndex`
   * filter alongside `msg !== digestMessage`. Index-tracking would be
   * fragile under splice shifts; reference equality survives splicing.
   */
  describe('hard-trim fallback (PR #285 pinned-message protection)', () => {
    /**
     * Build a scenario where the pinned first user message is NOT at
     * `kept[0]`. Layout (29 messages):
     *   - msg[0]        : assistant, 25 chars (Phase 1 compacts to 10 chars;
     *                     Phase 2 drops it because of budget pressure)
     *   - msg[1]        : assistant, 2 chars (survives Phase 2 — after
     *                     dropping msg[0], currentTokens == targetTokens
     *                     and Phase 2 exits, so msg[1] and msg[2] are
     *                     never reached by the Phase 2 drop loop)
     *   - msg[2]        : assistant, 2 chars (same)
     *   - msg[3]        : user, 1 char — firstUserIdx = 3 (the pinned one)
     *   - msg[4..28]    : assistant, 1 char each (25 messages)
     *
     * After Phase 1 + Phase 2 + digest insertion:
     *   kept = [msg[1], msg[2], user, digest, msg[4..28]] — length 29
     *   → pinned user sits at kept[2], NOT kept[0]
     *
     * Kept token count (2 + 2 + 1 + digest-10 + 25) = 40 > maxTokens (35),
     * so hard-trim runs. Without the fix, the `findIndex` filter would
     * remove msg[2] on iter 1 (shifting user to idx 1), then remove the
     * user on iter 2. With the fix, the pinned-reference check blocks
     * the user and hard-trim peels from the assistant tail instead.
     */
    const buildPinnedMessageScenario = () => {
      const mgr = createContextManager<FakeMsg>({
        getContextMode: () => 'graceful',
        estimateMessageTokens: (m) => m.content.length,
        estimateContextTokens: (ms) => ms.reduce((sum, m) => sum + m.content.length, 0),
        // Less-aggressive compaction than the PR #283 scenario — we need
        // msg[0] to compact to 10 chars (not 4) so dropping it alone
        // gets Phase 2 exactly to `targetTokens`, leaving msg[1] and
        // msg[2] in place and pushing the pinned user to kept[2].
        compactMessage: (m) => ({ ...m, content: m.content.slice(0, 10) }),
        buildContextDigestBlock: (removed) => `[digest ${removed.length}]`,
        createDigestMessage: (content) => ({
          id: 'digest-sentinel',
          role: 'user',
          content,
          isToolResult: true,
        }),
        log: () => {},
      });

      const PINNED_USER_ID = 'pinned-user';
      const messages: FakeMsg[] = [
        { id: 'heavy-0', role: 'assistant', content: 'x'.repeat(25) },
        { id: 'small-1', role: 'assistant', content: 'aa' },
        { id: 'small-2', role: 'assistant', content: 'bb' },
        { id: PINNED_USER_ID, role: 'user', content: 'u' },
        ...Array.from({ length: 25 }, (_, i) => ({
          id: `tail-${i}`,
          role: 'assistant' as const,
          content: 'c',
        })),
      ];

      const budget: ContextBudget = {
        maxTokens: 35,
        targetTokens: 30,
        summarizeTokens: 30,
      };

      return { mgr, messages, budget, pinnedUserId: PINNED_USER_ID };
    };

    it('preserves the pinned first user message when it is not at kept[0]', () => {
      const { mgr, messages, budget, pinnedUserId } = buildPinnedMessageScenario();
      const out = mgr.manageContext(messages, budget);

      // Identify the pinned user by its stable id rather than by object
      // reference: Phase 1 replaces `result[i]` with a new `compactMessage`
      // copy for every message it visits, so the object reference that
      // ends up in `kept`/`out` is NOT the same as the input `messages[3]`
      // object. The id survives unchanged (compactMessage spreads the
      // whole message and only rewrites `content`), so id-based lookup is
      // the robust check. Before the pinned-message fix, the hard-trim
      // `findIndex` filter would remove this message once it landed at
      // `idx === 1` after the first iteration dropped `msg[2]`.
      const pinnedInOut = out.find(
        (m) => m.id === pinnedUserId && m.role === 'user' && !m.isToolResult,
      );
      expect(pinnedInOut).toBeDefined();

      // Sanity: the pinned user is the only `role === 'user' && !isToolResult`
      // message in the input, so if the id lookup above fails it's
      // genuinely gone — no other user message could stand in.
      const userCount = out.filter((m) => m.role === 'user' && !m.isToolResult).length;
      expect(userCount).toBe(1);
    });
  });
});
