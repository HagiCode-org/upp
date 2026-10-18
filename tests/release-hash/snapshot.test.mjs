import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  ReleaseHashDataError,
  buildReleaseSnapshot,
  orderForDisplay,
  summarizeReleaseHashes,
  validateReleaseSnapshot,
} from '../../src/lib/release-hash.mjs';
import { FIXTURES, GENERATED_AT, REGISTRY_PATH, hashFor, observationsFor } from './support.mjs';

const registry = JSON.parse(await readFile(REGISTRY_PATH, 'utf8'));
const RUN_KEY = '123456789:1';
const allMatch = () => buildReleaseSnapshot({ generatedAt: GENERATED_AT, runKey: RUN_KEY, registry, observations: observationsFor(registry) });
const clone = (value) => JSON.parse(JSON.stringify(value));

test('a complete run with every match summarizes as normal', () => {
  const snapshot = allMatch();
  assert.equal(snapshot.schemaVersion, 1);
  assert.deepEqual(snapshot.repositories.map((repo) => repo.id), registry.map((entry) => entry.id));
  assert.deepEqual(summarizeReleaseHashes(snapshot), {
    state: 'normal',
    counts: { total: 14, match: 14, mismatch: 0, unknown: 0 },
  });
});

test('the no-data snapshot marks every repository not-checked and summarizes as no-data', () => {
  const snapshot = buildReleaseSnapshot({ generatedAt: GENERATED_AT, runKey: null, registry });
  assert.ok(snapshot.repositories.every((repo) => repo.state === 'unknown' && repo.reason === 'not-checked'));
  assert.ok(snapshot.repositories.every((repo) => repo.checkedAt === null && repo.mainHash === null));
  assert.equal(summarizeReleaseHashes(snapshot).state, 'no-data');
});

test('an unsupported version and bad timestamps are rejected', () => {
  const snapshot = allMatch();
  assert.throws(() => validateReleaseSnapshot({ ...snapshot, schemaVersion: 2 }, { registry }), /unsupported release-hash schemaVersion/);
  assert.throws(() => validateReleaseSnapshot({ ...snapshot, generatedAt: '2026-10-17T09:35:02+02:00' }, { registry }), /UTC ISO-8601/);
  assert.throws(() => validateReleaseSnapshot({ ...snapshot, generatedAt: '2026-02-31T09:35:02.000Z' }, { registry }), /UTC ISO-8601/);
  const late = clone(snapshot);
  late.repositories[0].checkedAt = '2026-10-17T10:00:00.000Z';
  assert.throws(() => validateReleaseSnapshot(late, { registry }), /later than generatedAt/);
});

test('a state that disagrees with its hashes is rejected', () => {
  const snapshot = clone(allMatch());
  snapshot.repositories[0].state = 'mismatch';
  assert.throws(() => validateReleaseSnapshot(snapshot, { registry }), /disagrees with its hashes/);
  const claimed = clone(allMatch());
  claimed.repositories[1].publishedHash = null;
  assert.throws(() => validateReleaseSnapshot(claimed, { registry }), /disagrees with its hashes/);
});

test('a missing or reordered registry id is rejected', () => {
  const missing = clone(allMatch());
  missing.repositories.pop();
  assert.throws(() => validateReleaseSnapshot(missing, { registry }), /exactly once, in registry order/);
  const reordered = clone(allMatch());
  [reordered.repositories[0], reordered.repositories[1]] = [reordered.repositories[1], reordered.repositories[0]];
  assert.throws(() => validateReleaseSnapshot(reordered, { registry }), /exactly once, in registry order/);
});

test('not-checked is rejected when the snapshot carries a runKey', () => {
  const snapshot = clone(buildReleaseSnapshot({ generatedAt: GENERATED_AT, runKey: null, registry }));
  snapshot.runKey = RUN_KEY;
  assert.throws(() => validateReleaseSnapshot(snapshot, { registry }), /not-checked/);
});

test('a snapshot without runKey may not carry observed results', () => {
  const snapshot = clone(allMatch());
  snapshot.runKey = null;
  assert.throws(() => validateReleaseSnapshot(snapshot, { registry }), /only not-checked results/);
});

test('reasons outside the fixed list, and reasons on settled states, are rejected', () => {
  const unknownReason = allMatch();
  unknownReason.repositories[0].reason = 'a response body with text';
  assert.throws(() => validateReleaseSnapshot(unknownReason, { registry }), /not a supported category/);
  const settled = clone(allMatch());
  settled.repositories[0].reason = 'timeout';
  assert.throws(() => validateReleaseSnapshot(settled, { registry }), /must not carry a reason/);
});

test('a registry field that disagrees with the snapshot is rejected', () => {
  const snapshot = clone(allMatch());
  snapshot.repositories[0].publicOrigin = 'https://elsewhere.hagicode.com';
  assert.throws(() => validateReleaseSnapshot(snapshot, { registry }), /does not match its registry entry/);
});

test('summary precedence is abnormal over incomplete over normal', () => {
  const mismatchAndUnknown = buildReleaseSnapshot({
    generatedAt: GENERATED_AT,
    runKey: RUN_KEY,
    registry,
    observations: observationsFor(registry, {
      site: { publishedHash: hashFor('stale-site') },
      trait: { publishedHash: null, publishedBranch: null, publishedBuiltAt: null, publishedReason: 'metadata-not-found' },
    }),
  });
  assert.equal(summarizeReleaseHashes(mismatchAndUnknown).state, 'abnormal');
  assert.equal(summarizeReleaseHashes(mismatchAndUnknown).counts.unknown, 1);

  const unknownOnly = buildReleaseSnapshot({
    generatedAt: GENERATED_AT,
    runKey: RUN_KEY,
    registry,
    observations: observationsFor(registry, {
      trait: { publishedHash: null, publishedBranch: null, publishedBuiltAt: null, publishedReason: 'metadata-not-found' },
    }),
  });
  assert.equal(summarizeReleaseHashes(unknownOnly).state, 'incomplete');
  assert.equal(summarizeReleaseHashes(allMatch()).state, 'normal');
});

test('an observation missing for a registry entry is recorded as not-checked only when there is no run key', () => {
  const partial = observationsFor(registry).slice(1);
  assert.throws(
    () => buildReleaseSnapshot({ generatedAt: GENERATED_AT, runKey: RUN_KEY, registry, observations: partial }),
    /not-checked/,
  );
  assert.throws(
    () => buildReleaseSnapshot({ generatedAt: GENERATED_AT, runKey: RUN_KEY, registry, observations: [...observationsFor(registry), observationsFor(registry)[0]] }),
    /duplicate observation/,
  );
});

test('display order puts mismatches first, then unknowns, then matches, each in registry order', () => {
  const snapshot = buildReleaseSnapshot({
    generatedAt: GENERATED_AT,
    runKey: RUN_KEY,
    registry,
    observations: observationsFor(registry, {
      soul: { publishedHash: hashFor('old-soul') },
      cost: { publishedHash: null, publishedBranch: null, publishedBuiltAt: null, publishedReason: 'metadata-not-found' },
      trait: { publishedHash: hashFor('old-trait') },
    }),
  });
  const order = orderForDisplay(snapshot.repositories).map((repo) => repo.id);
  // Mismatches (soul, trait) in registry order, then the unknown (cost), then every match in registry order.
  assert.deepEqual(order.slice(0, 3), ['soul', 'trait', 'cost']);
  assert.equal(order.length, 14);
  assert.equal(order[3], 'hagilight');
});

test('the shipped fixtures validate against the registry', async () => {
  for (const name of ['all-match', 'mixed', 'unknown-only']) {
    const fixture = JSON.parse(await readFile(join(FIXTURES, `${name}.json`), 'utf8'));
    assert.doesNotThrow(() => validateReleaseSnapshot(fixture, { registry }), name);
  }
});

test('the error type is ReleaseHashDataError for every validation failure', () => {
  assert.throws(() => validateReleaseSnapshot({}, { registry }), ReleaseHashDataError);
});
