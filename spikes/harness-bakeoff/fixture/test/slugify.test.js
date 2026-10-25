import assert from 'node:assert/strict';
import { test } from 'node:test';
import { slugify } from '../src/slugify.js';

test('lowercases and joins words', () => {
  assert.equal(slugify('Hello World'), 'hello-world');
});

test('collapses runs of punctuation and spaces', () => {
  assert.equal(slugify('Ships -- & -- Shipping, Inc.'), 'ships-shipping-inc');
});

test('strips accents', () => {
  assert.equal(slugify('Crème Brûlée'), 'creme-brulee');
});

test('trims leading and trailing separators', () => {
  assert.equal(slugify('  ...Hello!  '), 'hello');
});
