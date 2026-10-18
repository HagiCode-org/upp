import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HISTORY_WINDOW_DAYS,
  StatusDataError,
  buildSnapshot,
  summarizeOverall,
  summarizeSeries,
  toPublicUrl,
  validateCheckpoint,
  validateSnapshot,
} from '../../src/lib/status.mjs';

const NOW = '2026-10-17T12:00:00.000Z';
const NOW_MS = Date.parse(NOW);
const REVISION = 'rev-a';

function sample(siteId, runKey, checkedAt, status = 'up', overrides = {}) {
  const up = status === 'up';
  return {
    runKey,
    siteId,
    definitionRevision: REVISION,
    checkedAt,
    status,
    httpStatus: up ? 200 : null,
    responseTimeMs: up ? 120 : null,
    attempts: 1,
    failureCategory: up ? null : 'timeout',
    ...overrides,
  };
}

function site(id, samples = [], overrides = {}) {
  return { id, name: `Site ${id}`, publicUrl: `https://${id}.example.test/`, definitionRevision: REVISION, samples, ...overrides };
}

test('mixed results produce sample-based availability and the latest observation', () => {
  const samples = [
    sample('a', 'r1', '2026-10-17T11:00:00.000Z', 'up'),
    sample('a', 'r2', '2026-10-17T11:05:00.000Z', 'down'),
    sample('a', 'r3', '2026-10-17T11:10:00.000Z', 'up'),
    sample('a', 'r4', '2026-10-17T11:15:00.000Z', 'up'),
  ];
  const result = summarizeSeries(samples, { nowMs: NOW_MS, definitionRevision: REVISION });
  assert.equal(result.window.totalChecks, 4);
  assert.equal(result.window.successfulChecks, 3);
  assert.equal(result.window.availabilityPercent, 75);
  assert.equal(result.window.firstObservedAt, '2026-10-17T11:00:00.000Z');
  assert.equal(result.latest.runKey, 'r4');
  assert.deepEqual(result.recentChecks.map((item) => item.runKey), ['r4', 'r3', 'r2', 'r1']);
});

test('no observations yields null availability rather than zero or one hundred', () => {
  const result = summarizeSeries([], { nowMs: NOW_MS, definitionRevision: REVISION });
  assert.equal(result.latest, null);
  assert.equal(result.window.totalChecks, 0);
  assert.equal(result.window.availabilityPercent, null);
  assert.equal(result.window.firstObservedAt, null);
});

test('samples from another revision, outside the window, or after the snapshot are ignored', () => {
  const samples = [
    sample('a', 'old', '2026-10-17T11:00:00.000Z', 'down', { definitionRevision: 'rev-b' }),
    sample('a', 'ancient', new Date(NOW_MS - (HISTORY_WINDOW_DAYS + 1) * 86_400_000).toISOString(), 'down'),
    sample('a', 'future', '2026-10-17T12:30:00.000Z', 'down'),
    sample('a', 'current', '2026-10-17T11:30:00.000Z', 'up'),
  ];
  const result = summarizeSeries(samples, { nowMs: NOW_MS, definitionRevision: REVISION });
  assert.equal(result.window.totalChecks, 1);
  assert.equal(result.window.availabilityPercent, 100);
});

test('duplicate execution samples are counted once', () => {
  const samples = [
    sample('a', 'r1', '2026-10-17T11:00:00.000Z', 'up'),
    sample('a', 'r1', '2026-10-17T11:00:00.000Z', 'up'),
  ];
  assert.equal(summarizeSeries(samples, { nowMs: NOW_MS, definitionRevision: REVISION }).window.totalChecks, 1);
});

test('recent checks are capped at twenty newest observations', () => {
  const samples = Array.from({ length: 25 }, (_, index) => {
    const minutes = String(index).padStart(2, '0');
    return sample('a', `r${index}`, `2026-10-17T11:${minutes}:00.000Z`, 'up');
  });
  const result = summarizeSeries(samples, { nowMs: NOW_MS, definitionRevision: REVISION });
  assert.equal(result.recentChecks.length, 20);
  assert.equal(result.window.totalChecks, 25);
});

test('mixed snapshot with a stale site is reported as stale without hiding the failed site', () => {
  const snapshot = buildSnapshot({
    generatedAt: NOW,
    runKey: 'run-1',
    historyResetReason: null,
    sites: [
      site('a', [sample('a', 'run-1', NOW, 'down')]),
      site('b', [sample('b', 'run-1', '2026-10-17T11:00:00.000Z', 'up')]),
    ],
  });
  validateSnapshot(snapshot, { expectedSites: [{ id: 'a' }, { id: 'b' }] });
  assert.equal(summarizeOverall(snapshot).state, 'stale');
  assert.equal(snapshot.sites[0].latest.status, 'down');
});

test('a fresh failed observation produces disruption', () => {
  const snapshot = buildSnapshot({
    generatedAt: NOW,
    runKey: 'run-1',
    historyResetReason: null,
    sites: [
      site('a', [sample('a', 'run-1', NOW, 'down')]),
      site('b', [sample('b', 'run-1', NOW, 'up')]),
    ],
  });
  assert.equal(summarizeOverall(snapshot).state, 'disruption');
  assert.equal(summarizeOverall(snapshot).counts.down, 1);
});

test('empty configuration is valid and never claims operational', () => {
  const snapshot = buildSnapshot({ generatedAt: NOW, runKey: null, historyResetReason: null, sites: [] });
  validateSnapshot(snapshot, { expectedSites: [] });
  assert.equal(summarizeOverall(snapshot).state, 'empty');
});

test('sites without observations make the overall state incomplete', () => {
  const snapshot = buildSnapshot({
    generatedAt: NOW,
    runKey: null,
    historyResetReason: null,
    sites: [site('a'), site('b')],
  });
  validateSnapshot(snapshot, { expectedSites: [{ id: 'a' }, { id: 'b' }] });
  const summary = summarizeOverall(snapshot);
  assert.equal(summary.state, 'incomplete');
  assert.equal(summary.counts.noData, 2);
  assert.equal(snapshot.sites[0].window.availabilityPercent, null);
});

test('a completed snapshot with an incomplete current execution is rejected', () => {
  const snapshot = buildSnapshot({
    generatedAt: NOW,
    runKey: 'run-2',
    historyResetReason: null,
    sites: [
      site('a', [sample('a', 'run-2', NOW)]),
      site('b', [sample('b', 'run-1', NOW)]),
    ],
  });
  assert.throws(() => validateSnapshot(snapshot, { expectedSites: [{ id: 'a' }, { id: 'b' }] }), StatusDataError);
});

test('a snapshot that does not match the enabled configuration is rejected', () => {
  const snapshot = buildSnapshot({
    generatedAt: NOW,
    runKey: null,
    historyResetReason: null,
    sites: [site('a')],
  });
  assert.throws(() => validateSnapshot(snapshot, { expectedSites: [{ id: 'a' }, { id: 'extra' }] }), /do not match/);
});

test('unsupported schema versions and invalid timestamps are rejected', () => {
  const snapshot = buildSnapshot({ generatedAt: NOW, runKey: null, historyResetReason: null, sites: [] });
  assert.throws(() => validateSnapshot({ ...snapshot, schemaVersion: 2 }), /unsupported snapshot schemaVersion/);
  assert.throws(() => validateSnapshot({ ...snapshot, generatedAt: '2026-10-17T12:00:00+02:00' }), /UTC ISO-8601/);
  assert.throws(() => validateSnapshot({ ...snapshot, generatedAt: '2026-02-31T12:00:00.000Z' }), /not a valid date/);
});

test('invalid measurements and status values are rejected', () => {
  const snapshot = buildSnapshot({
    generatedAt: NOW,
    runKey: 'run-1',
    historyResetReason: null,
    sites: [site('a', [sample('a', 'run-1', NOW, 'up', { responseTimeMs: -1 })])],
  });
  assert.throws(() => validateSnapshot(snapshot), /responseTimeMs/);
  const badStatus = buildSnapshot({
    generatedAt: NOW,
    runKey: 'run-1',
    historyResetReason: null,
    sites: [site('a', [sample('a', 'run-1', NOW, 'maybe')])],
  });
  assert.throws(() => validateSnapshot(badStatus), /status must be one of/);
});

test('observations later than generation time are rejected', () => {
  const snapshot = buildSnapshot({
    generatedAt: NOW,
    runKey: 'run-1',
    historyResetReason: null,
    sites: [site('a', [sample('a', 'run-1', NOW)])],
  });
  snapshot.sites[0].latest.checkedAt = '2026-10-17T12:00:01.000Z';
  assert.throws(() => validateSnapshot(snapshot), /later than generatedAt/);
});

test('availability that disagrees with its counts is rejected', () => {
  const snapshot = buildSnapshot({
    generatedAt: NOW,
    runKey: 'run-1',
    historyResetReason: null,
    sites: [site('a', [sample('a', 'run-1', NOW)])],
  });
  snapshot.sites[0].window.availabilityPercent = 50;
  assert.throws(() => validateSnapshot(snapshot), /does not match/);
});

test('public URLs drop credentials, query strings and fragments', () => {
  assert.equal(toPublicUrl('https://user:pass@example.test/path?token=abc#frag'), 'https://example.test/path');
  assert.throws(() => toPublicUrl('ftp://example.test/'), /HTTP or HTTPS/);
  assert.throws(() => toPublicUrl('not a url'), /not a valid absolute URL/);
});

test('checkpoints reject duplicate series, mismatched samples and unsupported versions', () => {
  const checkpoint = {
    schemaVersion: 1,
    runKey: 'run-1',
    generatedAt: NOW,
    historyWindowDays: HISTORY_WINDOW_DAYS,
    continuity: { historyResetReason: null, restoredFromRunKey: null },
    series: [{ siteId: 'a', definitionRevision: REVISION, samples: [sample('a', 'run-1', NOW)] }],
  };
  assert.equal(validateCheckpoint(checkpoint), checkpoint);
  assert.throws(() => validateCheckpoint({ ...checkpoint, schemaVersion: 9 }), /unsupported checkpoint/);
  assert.throws(
    () => validateCheckpoint({ ...checkpoint, series: [checkpoint.series[0], checkpoint.series[0]] }),
    /duplicates another series/,
  );
  assert.throws(
    () => validateCheckpoint({
      ...checkpoint,
      series: [{ siteId: 'b', definitionRevision: REVISION, samples: [sample('a', 'run-1', NOW)] }],
    }),
    /another series/,
  );
});
