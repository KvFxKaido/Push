/**
 * citation-format.test.mjs — shared CLI citation helpers.
 *
 * Covers the http(s) hardening and control-char stripping that both the
 * transcript REPL and the TUI framer rely on to render web-search sources.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  safeCitationUrl,
  citationHost,
  sanitizeCitationText,
  safeCitations,
  safeTerminalUrl,
} from '../citation-format.ts';

const ESC = String.fromCharCode(27); // ANSI escape introducer

describe('safeCitationUrl', () => {
  it('accepts http and https', () => {
    assert.equal(safeCitationUrl('https://a.test/x')?.href, 'https://a.test/x');
    assert.equal(safeCitationUrl('http://a.test')?.href, 'http://a.test/');
  });

  it('rejects javascript:, data:, and other non-http(s) schemes', () => {
    assert.equal(safeCitationUrl('javascript:alert(1)'), null);
    assert.equal(safeCitationUrl('data:text/html,<script>'), null);
    assert.equal(safeCitationUrl('file:///etc/passwd'), null);
  });

  it('returns null for unparseable input', () => {
    assert.equal(safeCitationUrl('not a url'), null);
    assert.equal(safeCitationUrl(''), null);
  });
});

describe('safeTerminalUrl', () => {
  it('accepts and normalizes absolute HTTP(S) destinations', () => {
    assert.equal(safeTerminalUrl('https://example.com/docs')?.href, 'https://example.com/docs');
    assert.equal(safeTerminalUrl('HTTP://EXAMPLE.COM/path')?.href, 'http://example.com/path');
  });

  it('rejects non-web, relative, padded, control-bearing, and invisible destinations', () => {
    for (const href of [
      'javascript:alert',
      'data:text/plain,hello',
      'file:///tmp/readme',
      'mailto:test@example.com',
      '/relative/path',
      '#section',
      ' https://example.com',
      'https://example.com\nnext',
      'https://example.com\u001b]8;;https://evil.test',
      'https://example.com/\u202eevil',
    ]) {
      assert.equal(safeTerminalUrl(href), null, href);
    }
  });
});

describe('citationHost', () => {
  it('drops a leading www.', () => {
    assert.equal(citationHost(new URL('https://www.example.com/page')), 'example.com');
    assert.equal(citationHost(new URL('https://sub.example.com')), 'sub.example.com');
  });
});

describe('sanitizeCitationText', () => {
  it('strips ANSI escape sequences, leaving inert printable text', () => {
    const hostile = `${ESC}[31mEvil${ESC}[0m`;
    const cleaned = sanitizeCitationText(hostile);
    assert.equal(cleaned.includes(ESC), false);
    assert.equal(cleaned, '[31mEvil [0m'.trim());
  });

  it('strips DEL and C1 control characters too', () => {
    const cleaned = sanitizeCitationText(
      `a${String.fromCharCode(127)}b${String.fromCharCode(0x9b)}c`,
    );
    assert.equal(cleaned, 'a b c');
  });

  it('strips zero-width and Bidi-override characters (visual spoofing)', () => {
    const ZWSP = '​'; // zero-width space
    const RLO = '‮'; // right-to-left override
    const BOM = '﻿'; // zero-width no-break space / BOM
    const cleaned = sanitizeCitationText(`a${ZWSP}b${RLO}c${BOM}`);
    for (const ch of [ZWSP, RLO, BOM]) {
      assert.equal(cleaned.includes(ch), false);
    }
    assert.equal(cleaned, 'a b c');
  });

  it('leaves plain text untouched (modulo trim)', () => {
    assert.equal(sanitizeCitationText('  Hello World  '), 'Hello World');
  });
});

describe('safeCitations', () => {
  it('keeps only http(s) entries, paired with the parsed URL, order preserved', () => {
    const result = safeCitations([
      { url: 'https://a.test', title: 'A', content: '', startIndex: 0, endIndex: 0 },
      { url: 'javascript:alert(1)', title: 'X', content: '', startIndex: 0, endIndex: 0 },
      { url: 'http://b.test/p', title: 'B', content: '', startIndex: 0, endIndex: 0 },
    ]);
    assert.equal(result.length, 2);
    assert.equal(result[0].citation.title, 'A');
    assert.equal(result[0].url.href, 'https://a.test/');
    assert.equal(result[1].citation.title, 'B');
    assert.equal(result[1].url.href, 'http://b.test/p');
  });
});
