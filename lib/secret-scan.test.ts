import { describe, expect, it } from 'vitest';
import {
  formatSecretFindings,
  maskSecret,
  resolveSecretScanEnabled,
  scanDiffForSecrets,
  scanTextForSecrets,
  SECRET_RULES,
} from './secret-scan.ts';

// Synthetic, non-functional credentials shaped to match each rule. None are
// real secrets — they exist only to exercise the regexes.
const SAMPLES: Record<string, string> = {
  'private-key': '-----BEGIN RSA PRIVATE KEY-----',
  'github-token': `ghp_${'A1b2'.repeat(9)}`, // gh prefix + 36 chars
  'openai-key': `sk-${'Ab1'.repeat(8)}xyz`,
  'google-api-key': `AIza${'B'.repeat(35)}`,
  'aws-access-key-id': 'AKIAIOSFODNN7EXAMPLE',
  'aws-secret-access-key': `aws_secret_access_key = ${'a'.repeat(40)}`,
  'slack-token': 'xoxb-1234567890-abcdefghij',
  'stripe-secret-key': `sk_live_${'A1b2'.repeat(6)}`,
  'gcp-service-account': '"type": "service_account"',
};

describe('scanTextForSecrets', () => {
  for (const rule of SECRET_RULES) {
    it(`detects ${rule.id}`, () => {
      const sample = SAMPLES[rule.id];
      expect(sample, `missing sample for ${rule.id}`).toBeDefined();
      const findings = scanTextForSecrets(sample);
      expect(findings.some((f) => f.ruleId === rule.id)).toBe(true);
    });
  }

  it('returns nothing for benign code', () => {
    const benign = [
      'const greeting = "hello world";',
      'function add(a, b) { return a + b; }',
      'Authorization: Bearer <token>', // bare Bearer is deliberately not blocked
      'password = ask_user()',
      'sk-short', // too short to be an OpenAI key
    ].join('\n');
    expect(scanTextForSecrets(benign)).toEqual([]);
  });

  it('finds multiple distinct secrets in one blob', () => {
    const blob = `${SAMPLES['github-token']}\n${SAMPLES['aws-access-key-id']}`;
    const ids = scanTextForSecrets(blob).map((f) => f.ruleId);
    expect(ids).toContain('github-token');
    expect(ids).toContain('aws-access-key-id');
  });
});

describe('maskSecret', () => {
  it('never returns the raw secret and keeps only a short fingerprint', () => {
    const secret = SAMPLES['github-token'];
    const masked = maskSecret(secret);
    expect(masked).not.toBe(secret);
    expect(masked).not.toContain(secret.slice(4, -2));
    expect(masked).toContain('…');
  });

  it('collapses short matches to ****', () => {
    expect(maskSecret('abc')).toBe('****');
  });
});

describe('scanDiffForSecrets', () => {
  it('flags secrets on added lines only, not context or removed lines', () => {
    const diff = [
      'diff --git a/config.ts b/config.ts',
      '--- a/config.ts',
      '+++ b/config.ts',
      '@@ -1,3 +1,4 @@',
      ' const ok = true;', // context
      `-const old = "${SAMPLES['github-token']}";`, // removed — must NOT flag
      `+const token = "${SAMPLES['openai-key']}";`, // added — must flag
      ' export default token;',
    ].join('\n');

    const findings = scanDiffForSecrets(diff);
    expect(findings).toHaveLength(1);
    expect(findings[0].ruleId).toBe('openai-key');
    expect(findings[0].file).toBe('config.ts');
    expect(findings[0].line).toBe(2); // context line 1, added line 2
  });

  it('does not flag the +++ file header line itself', () => {
    const diff = ['+++ b/sk-not-a-secret.ts', '@@ -0,0 +1 @@', '+const x = 1;'].join('\n');
    expect(scanDiffForSecrets(diff)).toEqual([]);
  });

  it('returns nothing for a clean diff', () => {
    const diff = ['+++ b/x.ts', '@@ -0,0 +1 @@', '+const x = 1;'].join('\n');
    expect(scanDiffForSecrets(diff)).toEqual([]);
  });

  it('does not let a "\\ No newline at end of file" marker shift line numbers', () => {
    const diff = [
      '+++ b/keys.ts',
      '@@ -1,2 +1,3 @@',
      ' const a = 1;', // context → new line 1, advance to 2
      '-const old = 2;', // removed → no advance
      '\\ No newline at end of file', // metadata → must NOT advance
      `+const k = "${SAMPLES['aws-access-key-id']}";`, // added → new line 2
    ].join('\n');
    const findings = scanDiffForSecrets(diff);
    expect(findings).toHaveLength(1);
    expect(findings[0].line).toBe(2);
  });
});

describe('formatSecretFindings', () => {
  it('names the rule labels and a location without leaking the secret', () => {
    const findings = scanDiffForSecrets(
      [`+++ b/a.ts`, '@@ -0,0 +1 @@', `+const k = "${SAMPLES['aws-access-key-id']}";`].join('\n'),
    );
    const reason = formatSecretFindings(findings);
    expect(reason).toContain('AWS access key ID');
    expect(reason).toContain('a.ts:1');
    expect(reason).not.toContain(SAMPLES['aws-access-key-id']);
    expect(reason.toLowerCase()).toContain('remove');
  });
});

describe('resolveSecretScanEnabled', () => {
  it('defaults to on', () => {
    expect(resolveSecretScanEnabled()).toBe(true);
  });
  it('honors the env override above an explicit setting', () => {
    expect(resolveSecretScanEnabled({ env: '0', explicit: true })).toBe(false);
    expect(resolveSecretScanEnabled({ env: 'off' })).toBe(false);
  });
  it('falls through to the explicit setting when env is silent', () => {
    expect(resolveSecretScanEnabled({ env: '', explicit: false })).toBe(false);
    expect(resolveSecretScanEnabled({ explicit: 'yes' })).toBe(true);
  });
});
