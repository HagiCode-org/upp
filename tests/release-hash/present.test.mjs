import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RELEASE_REASONS } from '../../src/lib/release-hash.mjs';
import { releaseReasonLabel, releaseStateLabel, releaseSummaryCopy, shortHash } from '../../src/lib/present.mjs';
import { hashFor } from './support.mjs';

const FULL = hashFor('present-hash');
const repo = (state, reason = null) => ({ state, reason });

test('every state has a text label, and an unchecked repository reads as No data', () => {
  assert.equal(releaseStateLabel(repo('match')), 'Match');
  assert.equal(releaseStateLabel(repo('mismatch')), 'Mismatch');
  assert.equal(releaseStateLabel(repo('unknown', 'timeout')), 'Unknown');
  assert.equal(releaseStateLabel(repo('unknown', 'not-checked')), 'No data');
});

test('every reason category has a human label, so no raw code is shown', () => {
  for (const reason of RELEASE_REASONS) {
    assert.notEqual(releaseReasonLabel(reason), 'check failed', reason);
  }
  assert.equal(releaseReasonLabel('unlisted-reason'), 'check failed');
});

test('a hash is abbreviated to seven characters, and null stays null', () => {
  assert.equal(shortHash(FULL), FULL.slice(0, 7));
  assert.equal(shortHash(FULL).length, 7);
  assert.equal(shortHash(null), null);
});

test('the all-normal sentence appears only for an all-match summary', () => {
  const normal = releaseSummaryCopy({ state: 'normal', counts: { total: 14, match: 14, mismatch: 0, unknown: 0 } });
  assert.match(normal.heading, /^All 14 repositories match their published versions$/);

  const abnormal = releaseSummaryCopy({ state: 'abnormal', counts: { total: 14, match: 12, mismatch: 1, unknown: 1 } });
  assert.match(abnormal.heading, /^Abnormal: 1 of 14 repositories differ from their published site$/);
  assert.doesNotMatch(abnormal.heading, /All/);
  assert.match(abnormal.detail, /12 match · 1 mismatch · 1 unknown/);

  const incomplete = releaseSummaryCopy({ state: 'incomplete', counts: { total: 14, match: 13, mismatch: 0, unknown: 1 } });
  assert.match(incomplete.heading, /^Incomplete: 1 of 14 repositories could not be compared$/);
  assert.doesNotMatch(incomplete.heading, /All/);
  assert.doesNotMatch(incomplete.detail, /All/);

  const noData = releaseSummaryCopy({ state: 'no-data', counts: { total: 14, match: 0, mismatch: 0, unknown: 14 } });
  assert.doesNotMatch(noData.heading, /All/);
});
