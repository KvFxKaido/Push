/**
 * Tests for `cli/pushd-relay-pair-bundle.ts` (Phase 2.f).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  encodeRemotePairBundle,
  decodeRemotePairBundle,
  __test__,
} from '../pushd-relay-pair-bundle.ts';

const VALID_INPUT = {
  deploymentUrl: 'https://relay.example/api',
  sessionId: 'pushd-host.local',
  token: 'pushd_da_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
};

describe('encode/decodeRemotePairBundle', () => {
  it('roundtrips a valid input', () => {
    const encoded = encodeRemotePairBundle(VALID_INPUT);
    assert.ok(encoded.startsWith(__test__.PREFIX), `expected prefix: ${encoded}`);
    const decoded = decodeRemotePairBundle(encoded);
    assert.deepEqual(decoded, VALID_INPUT);
  });

  it('rejects empty / wrong-prefix tokens at encode time', () => {
    assert.throws(() => encodeRemotePairBundle({ ...VALID_INPUT, token: '' }));
    assert.throws(() => encodeRemotePairBundle({ ...VALID_INPUT, token: 'wrong_prefix_xxx' }));
    assert.throws(() => encodeRemotePairBundle({ ...VALID_INPUT, deploymentUrl: '' }));
    assert.throws(() => encodeRemotePairBundle({ ...VALID_INPUT, sessionId: '' }));
  });

  it('decode returns null for any malformed input', () => {
    assert.equal(decodeRemotePairBundle(''), null);
    assert.equal(decodeRemotePairBundle('not-a-bundle'), null);
    assert.equal(decodeRemotePairBundle(`${__test__.PREFIX}`), null);
    assert.equal(decodeRemotePairBundle(`${__test__.PREFIX}!!!not-base64url!!!`), null);
    // base64url of 'plain text' is not JSON
    const notJson = Buffer.from('plain text', 'utf8').toString('base64url');
    assert.equal(decodeRemotePairBundle(`${__test__.PREFIX}${notJson}`), null);
  });

  it('decode rejects wrong bundle version', () => {
    const payload = JSON.stringify({
      v: 99,
      deploymentUrl: VALID_INPUT.deploymentUrl,
      sessionId: VALID_INPUT.sessionId,
      token: VALID_INPUT.token,
    });
    const encoded = `${__test__.PREFIX}${Buffer.from(payload, 'utf8').toString('base64url')}`;
    assert.equal(decodeRemotePairBundle(encoded), null);
  });

  it('decode rejects payload with non-attach-token shape', () => {
    const payload = JSON.stringify({
      v: __test__.BUNDLE_VERSION,
      deploymentUrl: VALID_INPUT.deploymentUrl,
      sessionId: VALID_INPUT.sessionId,
      token: 'pushd_relay_xxxx', // operator token, not phone-attach
    });
    const encoded = `${__test__.PREFIX}${Buffer.from(payload, 'utf8').toString('base64url')}`;
    assert.equal(decodeRemotePairBundle(encoded), null);
  });

  it('decode tolerates leading/trailing whitespace (terminal paste copy)', () => {
    const encoded = encodeRemotePairBundle(VALID_INPUT);
    assert.deepEqual(decodeRemotePairBundle(`  ${encoded}  \n`), VALID_INPUT);
  });

  it('decode rejects extra fields with missing required ones', () => {
    const payload = JSON.stringify({
      v: __test__.BUNDLE_VERSION,
      deploymentUrl: VALID_INPUT.deploymentUrl,
      // sessionId missing
      token: VALID_INPUT.token,
    });
    const encoded = `${__test__.PREFIX}${Buffer.from(payload, 'utf8').toString('base64url')}`;
    assert.equal(decodeRemotePairBundle(encoded), null);
  });

  // PR #530 review: bundle carries the public ids so the web pair
  // panel can show them for revocation guidance.
  it('roundtrips attachTokenId + deviceTokenId when provided', () => {
    const withIds = {
      ...VALID_INPUT,
      attachTokenId: 'pdat_abc123',
      deviceTokenId: 'pdt_xyz789',
    };
    const encoded = encodeRemotePairBundle(withIds);
    assert.deepEqual(decodeRemotePairBundle(encoded), withIds);
  });

  it('omits optional id fields when not provided (back-compat)', () => {
    const encoded = encodeRemotePairBundle(VALID_INPUT);
    const decoded = decodeRemotePairBundle(encoded);
    assert.deepEqual(decoded, VALID_INPUT);
    // Fields should be absent from the result, not present-as-undefined.
    assert.equal('attachTokenId' in (decoded ?? {}), false);
    assert.equal('deviceTokenId' in (decoded ?? {}), false);
  });
});
