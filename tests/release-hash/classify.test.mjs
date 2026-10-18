import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, normalizeHash } from '../../src/lib/release-hash.mjs';
import { hashFor } from './support.mjs';

const MAIN = hashFor('classify-main');
const OTHER = hashFor('classify-other');

test('equal hashes match', () => {
  assert.equal(classify(MAIN, MAIN), 'match');
});

test('a seven-character prefix of the main hash matches', () => {
  assert.equal(classify(MAIN, MAIN.slice(0, 7)), 'match');
});

test('a six-character value is too short to match and mismatches', () => {
  assert.equal(classify(MAIN, MAIN.slice(0, 6)), 'mismatch');
});

test('a differing hash mismatches', () => {
  assert.equal(classify(MAIN, OTHER), 'mismatch');
});

test('a published hash longer than the main hash cannot prefix-match', () => {
  assert.equal(classify(MAIN.slice(0, 20), MAIN), 'mismatch');
});

test('uppercase input is normalized before comparison', () => {
  assert.equal(classify(MAIN.toUpperCase(), MAIN), 'match');
  assert.equal(classify(MAIN, MAIN.slice(0, 7).toUpperCase()), 'match');
});

test('a missing side is unknown and nothing is inferred from it', () => {
  assert.equal(classify(null, MAIN), 'unknown');
  assert.equal(classify(MAIN, null), 'unknown');
  assert.equal(classify(undefined, undefined), 'unknown');
  assert.equal(classify('', MAIN), 'unknown');
});

test('a value that is not hexadecimal is treated as missing', () => {
  assert.equal(classify('zzzzzzz', MAIN), 'unknown');
  assert.equal(classify(MAIN, `${MAIN.slice(0, 7)}g`), 'unknown');
});

test('normalizeHash trims and lowercases, and rejects non-hexadecimal text', () => {
  assert.equal(normalizeHash(`  ${MAIN.toUpperCase()}\n`), MAIN);
  assert.equal(normalizeHash('not-hex'), null);
  assert.equal(normalizeHash(42), null);
  assert.equal(normalizeHash(null), null);
});
