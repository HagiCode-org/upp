import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSnapshot } from '../../src/lib/status.mjs';
import { fleetRuns, formatMs, formatShare, groupFamilies, kindLanes, percentile, probeKind } from '../../src/lib/wall.mjs';
import { laneChart, pulseChart } from '../../src/lib/wall-charts.mjs';

const NOW = Date.parse('2026-10-17T12:00:00.000Z');
const MINUTE = 60_000;

function sample(siteId, run, minutesAgo, status = 'up', ms = 100) {
  const up = status === 'up';
  return {
    runKey: `r${run}`,
    siteId,
    definitionRevision: 'rev',
    checkedAt: new Date(NOW - minutesAgo * MINUTE).toISOString(),
    status,
    httpStatus: up ? 200 : 503,
    responseTimeMs: ms,
    attempts: 1,
    failureCategory: up ? null : 'unexpected-status',
  };
}

function snapshotOf(entries) {
  return buildSnapshot({
    generatedAt: new Date(NOW).toISOString(),
    runKey: 'r9',
    historyResetReason: null,
    sites: entries.map(({ id, name, samples }) => ({ id, name, publicUrl: null, definitionRevision: 'rev', samples })),
  });
}

test('probe names split into a family and an endpoint kind', () => {
  assert.deepEqual(probeKind('HagiCode Docs'), { family: 'HagiCode Docs', kind: 'page' });
  assert.deepEqual(probeKind('HagiCode Docs Sitemap'), { family: 'HagiCode Docs', kind: 'sitemap' });
  assert.deepEqual(probeKind('newbe RSS'), { family: 'newbe', kind: 'rss' });
  assert.deepEqual(probeKind('Robots'), { family: 'Robots', kind: 'page' });
});

test('families put the worst state first and keep configured order within a state', () => {
  const snapshot = snapshotOf([
    { id: 'a', name: 'Alpha', samples: [sample('a', 9, 1)] },
    { id: 'a-map', name: 'Alpha Sitemap', samples: [sample('a-map', 9, 1)] },
    { id: 'b', name: 'Beta', samples: [] },
    { id: 'c', name: 'Gamma', samples: [sample('c', 9, 1, 'down')] },
    { id: 'd', name: 'Delta', samples: [sample('d', 9, 30)] },
  ]);
  const families = groupFamilies(snapshot);
  assert.deepEqual(families.map((family) => [family.name, family.state]), [
    ['Gamma', 'down'],
    ['Beta', 'none'],
    ['Delta', 'stale'],
    ['Alpha', 'up'],
  ]);
  assert.deepEqual(Object.keys(families[3].probes), ['page', 'sitemap']);
  assert.equal(families[3].pooled.total, 2);
});

test('a second probe of the same kind becomes its own family instead of replacing the first', () => {
  const snapshot = snapshotOf([
    { id: 'one', name: 'Index', samples: [sample('one', 9, 1)] },
    { id: 'two', name: 'index', samples: [sample('two', 9, 1)] },
  ]);
  assert.equal(groupFamilies(snapshot).length, 2);
});

test('a family with no observations has no availability share', () => {
  const [family] = groupFamilies(snapshotOf([{ id: 'a', name: 'Alpha', samples: [] }]));
  assert.equal(family.pooled.percent, null);
  assert.equal(formatShare(null), null);
});

test('a share below 100 never rounds up to 100.0%', () => {
  assert.equal(formatShare(99.96), '99.9%');
  assert.equal(formatShare(100), '100.0%');
  assert.equal(formatShare(0), '0.0%');
});

test('runs are grouped by run key with their own down count and latency summary', () => {
  const snapshot = snapshotOf([
    { id: 'a', name: 'A', samples: [sample('a', 1, 10, 'up', 100), sample('a', 2, 5, 'down', 400), sample('a', 3, 1, 'up', 100)] },
    { id: 'b', name: 'B', samples: [sample('b', 2, 5, 'up', 200), sample('b', 3, 1, 'up', 300)] },
  ]);
  const runs = fleetRuns(snapshot);
  assert.deepEqual(runs.map((run) => run.runKey), ['r1', 'r2', 'r3']);
  assert.deepEqual(runs.map((run) => [run.total, run.down]), [[1, 0], [2, 1], [2, 0]]);
  assert.equal(runs[1].medianMs, 300);
  assert.ok(runs[0].at < runs[2].at);
});

test('response times come only from probes that answered', () => {
  const snapshot = snapshotOf([
    { id: 'a', name: 'A', samples: [{ ...sample('a', 1, 1, 'down'), httpStatus: null, responseTimeMs: null, failureCategory: 'timeout' }] },
  ]);
  const [run] = fleetRuns(snapshot);
  assert.equal(run.measured, 0);
  assert.equal(run.medianMs, null);
  const [lane] = kindLanes(snapshot);
  assert.equal(lane.medianMs, null);
  assert.equal(lane.probes[0].ms, null);
});

test('kind lanes count probes without observations instead of plotting them', () => {
  const snapshot = snapshotOf([
    { id: 'a', name: 'A', samples: [sample('a', 1, 1, 'up', 80)] },
    { id: 'a-rss', name: 'A RSS', samples: [] },
  ]);
  const lanes = kindLanes(snapshot);
  assert.deepEqual(lanes.map((lane) => [lane.kind, lane.probes.length, lane.noData]), [['page', 1, 0], ['rss', 0, 1]]);
});

test('percentile interpolates and handles an empty list', () => {
  assert.equal(percentile([], 0.5), null);
  assert.equal(percentile([10, 20, 30, 40], 0.5), 25);
  assert.equal(percentile([5], 0.9), 5);
});

test('milliseconds read as ms below a second and seconds above', () => {
  assert.equal(formatMs(142), '142 ms');
  assert.equal(formatMs(1500), '1.5 s');
  assert.equal(formatMs(null), 'no response');
});

function runsAt(minutes) {
  return minutes.map((minute, index) => ({
    runKey: `r${index}`,
    at: NOW - minute * MINUTE,
    total: 4,
    up: 4,
    down: 0,
    measured: 4,
    medianMs: 100 + index,
    lowMs: 80,
    highMs: 150,
  }));
}

test('a gap longer than the freshness threshold splits the median line instead of bridging it', () => {
  const chart = pulseChart(runsAt([40, 35, 30, 5, 0]), { gapSeconds: 900 });
  assert.equal(chart.medianPaths.length, 2);
  assert.equal(chart.columns.length, 5);
  const steady = pulseChart(runsAt([20, 15, 10, 5, 0]), { gapSeconds: 900 });
  assert.equal(steady.medianPaths.length, 1);
});

test('one run still gets an axis and a marker, with no band to draw', () => {
  const chart = pulseChart(runsAt([0]));
  assert.equal(chart.columns.length, 1);
  assert.equal(chart.bandPaths.length, 0);
  assert.equal(chart.xTicks.length, 1);
  assert.ok(chart.columns[0].x > chart.left);
});

test('down bars scale with the highest down count and a clean run keeps a flat mark', () => {
  const runs = runsAt([10, 5, 0]);
  runs[1].down = 3;
  runs[1].up = 1;
  const chart = pulseChart(runs);
  assert.equal(chart.maxDown, 3);
  assert.ok(chart.columns[1].downHeight > chart.columns[0].downHeight);
  assert.equal(chart.columns[0].downHeight, 2);
});

test('lane chart keeps every measured probe and parks unanswered ones in the gutter', () => {
  const lanes = [{
    kind: 'page',
    label: 'Page',
    noData: 0,
    medianMs: 100,
    probes: [
      ...Array.from({ length: 12 }, (_, index) => ({ id: `p${index}`, name: `P${index}`, state: 'up', down: false, ms: 100, httpStatus: 200 })),
      { id: 'dead', name: 'Dead', state: 'down', down: true, ms: null, httpStatus: null },
    ],
  }];
  const chart = laneChart(lanes);
  const [lane] = chart.lanes;
  assert.equal(lane.dots.length, 12);
  assert.equal(lane.silent.length, 1);
  assert.equal(lane.silent[0].cx, chart.gutterX);
  // Identical latencies fan out over several rows instead of stacking into one dot.
  assert.ok(new Set(lane.dots.map((dot) => dot.cy)).size > 1);
});
