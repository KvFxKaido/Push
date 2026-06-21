import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  RUN_TOKEN_BUDGET_DEFAULT,
  RUN_TOKEN_BUDGET_ENV_VAR,
  RUN_TOKEN_BUDGET_WARN_RATIO,
  createRunTokenLedger,
  parseTokenBudgetSetting,
  resolveRunTokenBudget,
} from '../../lib/run-cost-budget.ts';

describe('run-cost-budget — parseTokenBudgetSetting', () => {
  it('treats a positive number/string as a cap (floored)', () => {
    assert.equal(parseTokenBudgetSetting(50_000), 50_000);
    assert.equal(parseTokenBudgetSetting(50_000.9), 50_000);
    assert.equal(parseTokenBudgetSetting('50000'), 50_000);
    // human-typed separators
    assert.equal(parseTokenBudgetSetting('50_000'), 50_000);
    assert.equal(parseTokenBudgetSetting('50,000'), 50_000);
  });

  it('maps an explicit zero/negative/"off" to null (uncapped, an opinion)', () => {
    assert.equal(parseTokenBudgetSetting(0), null);
    assert.equal(parseTokenBudgetSetting(-5), null);
    assert.equal(parseTokenBudgetSetting('0'), null);
    assert.equal(parseTokenBudgetSetting('off'), null);
    assert.equal(parseTokenBudgetSetting('none'), null);
    assert.equal(parseTokenBudgetSetting('unlimited'), null);
  });

  it('returns undefined (no opinion) for empty / garbage / non-finite', () => {
    assert.equal(parseTokenBudgetSetting(undefined), undefined);
    assert.equal(parseTokenBudgetSetting(''), undefined);
    assert.equal(parseTokenBudgetSetting('   '), undefined);
    assert.equal(parseTokenBudgetSetting('garbage'), undefined);
    assert.equal(parseTokenBudgetSetting(Number.NaN), undefined);
    assert.equal(parseTokenBudgetSetting(Infinity), undefined);
    assert.equal(parseTokenBudgetSetting({}), undefined);
  });
});

describe('run-cost-budget — resolveRunTokenBudget (precedence)', () => {
  it('defaults to off when nothing carries an opinion', () => {
    assert.equal(RUN_TOKEN_BUDGET_DEFAULT, null);
    assert.equal(resolveRunTokenBudget(), null);
    assert.equal(resolveRunTokenBudget({}), null);
    assert.equal(resolveRunTokenBudget({ env: '', explicit: '' }), null);
    assert.equal(resolveRunTokenBudget({ env: 'garbage' }), null);
  });

  it('names the shared env var', () => {
    assert.equal(RUN_TOKEN_BUDGET_ENV_VAR, 'PUSH_RUN_TOKEN_BUDGET');
  });

  it('env override beats the explicit per-surface setting', () => {
    // env caps, surface unset
    assert.equal(resolveRunTokenBudget({ env: '100000' }), 100_000);
    // env says off, surface says cap → env wins (operator override)
    assert.equal(resolveRunTokenBudget({ explicit: 100_000, env: 'off' }), null);
    // env caps lower than surface → env wins
    assert.equal(resolveRunTokenBudget({ explicit: 100_000, env: '20000' }), 20_000);
  });

  it('explicit setting applies when env carries no opinion', () => {
    assert.equal(resolveRunTokenBudget({ explicit: 75_000 }), 75_000);
    assert.equal(resolveRunTokenBudget({ explicit: 75_000, env: '' }), 75_000);
    assert.equal(resolveRunTokenBudget({ explicit: 75_000, env: 'garbage' }), 75_000);
    assert.equal(resolveRunTokenBudget({ explicit: 0 }), null);
  });
});

describe('run-cost-budget — createRunTokenLedger', () => {
  it('an uncapped ledger is always ok', () => {
    const ledger = createRunTokenLedger();
    ledger.record({ usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } });
    const verdict = ledger.check(null);
    assert.equal(verdict.state, 'ok');
    assert.equal(verdict.limitTokens, null);
    assert.equal(verdict.remainingTokens, null);
    assert.equal(verdict.usedTokens, 15);
  });

  it('prefers reported totalTokens and counts the source', () => {
    const ledger = createRunTokenLedger();
    assert.equal(
      ledger.record({
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        estimatedTokens: 999,
      }),
      'reported',
    );
    const snap = ledger.snapshot();
    assert.equal(snap.usedTokens, 15);
    assert.equal(snap.reportedRounds, 1);
    assert.equal(snap.estimatedRounds, 0);
  });

  it('falls back to inputTokens+outputTokens when totalTokens is absent/zero', () => {
    const ledger = createRunTokenLedger();
    assert.equal(
      ledger.record({ usage: { inputTokens: 10, outputTokens: 5, totalTokens: 0 } }),
      'reported',
    );
    assert.equal(ledger.snapshot().usedTokens, 15);
  });

  it('fails closed to the estimate when usage is missing', () => {
    const ledger = createRunTokenLedger();
    assert.equal(ledger.record({ usage: undefined, estimatedTokens: 1234 }), 'estimated');
    const snap = ledger.snapshot();
    assert.equal(snap.usedTokens, 1234);
    assert.equal(snap.estimatedRounds, 1);
    assert.equal(snap.reportedRounds, 0);
  });

  it('records nothing when neither usage nor a positive estimate is available', () => {
    const ledger = createRunTokenLedger();
    assert.equal(ledger.record({}), 'none');
    assert.equal(ledger.record({ estimatedTokens: 0 }), 'none');
    assert.equal(ledger.snapshot().usedTokens, 0);
  });

  it('crosses ok → warn → exceeded against a cap', () => {
    const ledger = createRunTokenLedger();
    const limit = 1000;
    // below warn ratio
    ledger.record({ usage: { inputTokens: 0, outputTokens: 0, totalTokens: 500 } });
    assert.equal(ledger.check(limit).state, 'ok');
    // cross the warn ratio (0.9) but stay under the limit
    ledger.record({ usage: { inputTokens: 0, outputTokens: 0, totalTokens: 450 } });
    const warn = ledger.check(limit);
    assert.equal(warn.state, 'warn');
    assert.equal(warn.usedTokens, 950);
    assert.equal(warn.remainingTokens, 50);
    // reach the limit → exceeded, remaining floored at 0
    ledger.record({ usage: { inputTokens: 0, outputTokens: 0, totalTokens: 100 } });
    const exceeded = ledger.check(limit);
    assert.equal(exceeded.state, 'exceeded');
    assert.equal(exceeded.remainingTokens, 0);
  });

  it('warn ratio is the documented 0.9', () => {
    assert.equal(RUN_TOKEN_BUDGET_WARN_RATIO, 0.9);
  });
});
