import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  AUDITOR_GATE_DEFAULT,
  AUDITOR_GATE_ENV_VAR,
  parseBooleanSetting,
  resolveAuditorGateEnabled,
} from '../../lib/auditor-policy.ts';

describe('auditor-policy (shared cross-surface resolver)', () => {
  it('defaults to ON — the documented required gate', () => {
    assert.equal(AUDITOR_GATE_DEFAULT, true);
    assert.equal(resolveAuditorGateEnabled(), true);
    assert.equal(resolveAuditorGateEnabled({}), true);
  });

  it('names the shared env var', () => {
    assert.equal(AUDITOR_GATE_ENV_VAR, 'PUSH_AUDITOR_GATE');
  });

  it('env override beats the explicit per-surface setting', () => {
    // env says off, surface setting says on → env wins (operator override)
    assert.equal(resolveAuditorGateEnabled({ explicit: true, env: 'false' }), false);
    // env says on, surface setting says off → env wins
    assert.equal(resolveAuditorGateEnabled({ explicit: false, env: 'true' }), true);
  });

  it('explicit setting applies when env carries no opinion', () => {
    assert.equal(resolveAuditorGateEnabled({ explicit: false }), false);
    assert.equal(resolveAuditorGateEnabled({ explicit: true }), true);
    assert.equal(resolveAuditorGateEnabled({ explicit: false, env: '' }), false);
    assert.equal(resolveAuditorGateEnabled({ explicit: false, env: 'garbage' }), false);
  });

  it('falls back to the default when neither tier has an opinion', () => {
    assert.equal(resolveAuditorGateEnabled({ env: '' }), AUDITOR_GATE_DEFAULT);
    assert.equal(
      resolveAuditorGateEnabled({ explicit: undefined, env: undefined }),
      AUDITOR_GATE_DEFAULT,
    );
    assert.equal(resolveAuditorGateEnabled({ explicit: null }), AUDITOR_GATE_DEFAULT);
  });

  describe('parseBooleanSetting', () => {
    it('parses truthy string forms', () => {
      for (const v of ['1', 'true', 'TRUE', 'yes', 'on', 'enabled', ' On ']) {
        assert.equal(parseBooleanSetting(v), true, `expected ${JSON.stringify(v)} → true`);
      }
    });
    it('parses falsy string forms', () => {
      for (const v of ['0', 'false', 'FALSE', 'no', 'off', 'disabled', ' Off ']) {
        assert.equal(parseBooleanSetting(v), false, `expected ${JSON.stringify(v)} → false`);
      }
    });
    it('returns undefined for no-opinion values so resolution can fall through', () => {
      for (const v of ['', '   ', 'maybe', undefined, null, {}, NaN]) {
        assert.equal(
          parseBooleanSetting(v),
          undefined,
          `expected ${JSON.stringify(v)} → undefined`,
        );
      }
    });
    it('passes through booleans and numbers', () => {
      assert.equal(parseBooleanSetting(true), true);
      assert.equal(parseBooleanSetting(false), false);
      assert.equal(parseBooleanSetting(1), true);
      assert.equal(parseBooleanSetting(0), false);
    });
  });
});
