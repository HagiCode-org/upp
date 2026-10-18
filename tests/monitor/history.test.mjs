import { test } from 'node:test';
import assert from 'node:assert/strict';
import { strToU8, zipSync } from 'fflate';
import {
  HistoryAccessError,
  HistoryApiError,
  HistoryDataError,
  artifactNameFor,
  createGitHubHistoryClient,
  mergeHistory,
  restoreCheckpoint,
  runKeyFor,
  seriesSamples,
} from '../../scripts/monitor/history.mjs';
import { buildSnapshot, summarizeOverall, validateSnapshot } from '../../src/lib/status.mjs';

const REVISION = 'rev-a';
const OWNER = 'HagiCode-org';
const REPO = 'upp';
const BRANCH = 'main';

function sample(siteId, runKey, checkedAt, status = 'up', definitionRevision = REVISION) {
  const up = status === 'up';
  return {
    runKey,
    siteId,
    definitionRevision,
    checkedAt,
    status,
    httpStatus: up ? 200 : 503,
    responseTimeMs: up ? 100 : 40,
    attempts: 1,
    failureCategory: up ? null : 'unexpected-status',
  };
}

function run(id, overrides = {}) {
  return {
    id,
    run_attempt: 1,
    status: 'completed',
    conclusion: 'success',
    event: 'schedule',
    head_branch: BRANCH,
    created_at: '2026-10-17T10:00:00Z',
    ...overrides,
  };
}

function checkpointArchive(checkpoint) {
  return zipSync({ 'checkpoint.json': strToU8(JSON.stringify(checkpoint)) });
}

function checkpointFor(runKey, generatedAt, series, continuity = {}) {
  return {
    schemaVersion: 1,
    runKey,
    generatedAt,
    historyWindowDays: 30,
    continuity: { historyResetReason: null, restoredFromRunKey: null, ...continuity },
    series,
  };
}

// Routes the GitHub endpoints used by restoration to in-memory fixtures.
function mockGitHub({ pages = [], artifacts = {}, downloads = {}, runsStatus = 200 }) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    const parsed = new URL(url);
    if (parsed.pathname.endsWith('/actions/workflows/monitor.yml/runs')) {
      if (runsStatus !== 200) {
        return new Response('{}', { status: runsStatus });
      }
      const page = Number(parsed.searchParams.get('page'));
      return Response.json({ workflow_runs: pages[page - 1] ?? [] });
    }
    const artifactsMatch = parsed.pathname.match(/\/actions\/runs\/(\d+)\/artifacts$/);
    if (artifactsMatch) {
      return Response.json({ artifacts: artifacts[artifactsMatch[1]] ?? [] });
    }
    const zipMatch = parsed.pathname.match(/\/actions\/artifacts\/(\d+)\/zip$/);
    if (zipMatch) {
      const entry = downloads[zipMatch[1]];
      if (!entry) {
        return new Response('gone', { status: 404 });
      }
      return new Response(entry.bytes ?? entry, { status: entry.status ?? 200 });
    }
    return new Response('unexpected', { status: 500 });
  };
  const client = createGitHubHistoryClient({ owner: OWNER, repo: REPO, token: 'test-token', fetch: fetchImpl });
  return { client, calls };
}

test('no eligible monitoring run is a normal first run', async () => {
  const { client } = mockGitHub({
    pages: [[
      run(1, { event: 'pull_request' }),
      run(2, { conclusion: 'failure' }),
      run(3, { head_branch: 'feature/x' }),
      run(4, { status: 'in_progress', conclusion: null }),
    ]],
  });
  const result = await restoreCheckpoint({ client, branch: BRANCH, currentRunId: 99 });
  assert.deepEqual(result, { checkpoint: null, historyResetReason: 'first-run', restoredFromRunKey: null });
});

test('the newest eligible run is selected across pages, skipping ineligible runs', async () => {
  const filler = Array.from({ length: 100 }, (_, index) => run(1000 + index, { event: 'push' }));
  const checkpoint = checkpointFor('7:1', '2026-10-17T09:55:00.000Z', [
    { siteId: 'a', definitionRevision: REVISION, samples: [sample('a', '7:1', '2026-10-17T09:55:00.000Z')] },
  ]);
  const { client, calls } = mockGitHub({
    pages: [
      filler,
      [run(8, { event: 'workflow_dispatch', conclusion: 'failure' }), run(7, { event: 'workflow_dispatch' })],
    ],
    artifacts: { 8: [], 7: [{ id: 70, name: artifactNameFor(7, 1), expired: false }] },
    downloads: { 70: { bytes: checkpointArchive(checkpoint) } },
  });
  const result = await restoreCheckpoint({ client, branch: BRANCH, currentRunId: 99 });
  assert.equal(result.restoredFromRunKey, '7:1');
  assert.equal(result.historyResetReason, null);
  assert.equal(result.checkpoint.runKey, '7:1');
  assert.ok(calls.some((url) => url.includes('page=2')));
  assert.equal(calls.some((url) => url.includes('/runs/8/artifacts')), false);
});

test('the current run is never restored as its own history', async () => {
  const { client } = mockGitHub({ pages: [[run(99)]] });
  const result = await restoreCheckpoint({ client, branch: BRANCH, currentRunId: 99 });
  assert.equal(result.historyResetReason, 'first-run');
});

test('an expired or deleted newest artifact starts a new window with an explicit reason', async () => {
  const expired = mockGitHub({
    pages: [[run(5)]],
    artifacts: { 5: [{ id: 50, name: artifactNameFor(5, 1), expired: true }] },
  });
  assert.equal((await restoreCheckpoint({ client: expired.client, branch: BRANCH, currentRunId: 99 })).historyResetReason, 'expired-or-unavailable');

  const missing = mockGitHub({ pages: [[run(5)]], artifacts: { 5: [] } });
  assert.equal((await restoreCheckpoint({ client: missing.client, branch: BRANCH, currentRunId: 99 })).historyResetReason, 'expired-or-unavailable');
});

test('a download that disappears is unavailable only after the listing confirms it', async () => {
  const { client } = mockGitHub({
    pages: [[run(5)]],
    artifacts: { 5: [{ id: 50, name: artifactNameFor(5, 1), expired: false }] },
    downloads: {},
  });
  // The first listing shows the artifact; the confirming listing no longer does.
  const listings = [[{ id: 50, name: artifactNameFor(5, 1), expired: false }], []];
  client.listRunArtifacts = async () => listings.shift() ?? [];
  assert.equal(
    (await restoreCheckpoint({ client, branch: BRANCH, currentRunId: 99 })).historyResetReason,
    'expired-or-unavailable',
  );
});

test('a download that fails while the artifact is still listed is an API failure', async () => {
  const { client } = mockGitHub({
    pages: [[run(5)]],
    artifacts: { 5: [{ id: 50, name: artifactNameFor(5, 1), expired: false }] },
    downloads: {},
  });
  // The listing keeps the artifact on both reads while the download reports 404.
  const listed = [{ id: 50, name: artifactNameFor(5, 1), expired: false }];
  client.listRunArtifacts = async () => listed;
  client.downloadArtifact = async () => null;
  await assert.rejects(restoreCheckpoint({ client, branch: BRANCH, currentRunId: 99 }), HistoryApiError);
});

test('denied access and API errors fail instead of becoming empty history', async () => {
  const denied = mockGitHub({ runsStatus: 403 });
  await assert.rejects(restoreCheckpoint({ client: denied.client, branch: BRANCH, currentRunId: 99 }), HistoryAccessError);

  const failing = mockGitHub({ runsStatus: 500 });
  await assert.rejects(restoreCheckpoint({ client: failing.client, branch: BRANCH, currentRunId: 99 }), HistoryApiError);
});

test('corrupt archives, incompatible versions and mismatched identities are data errors', async () => {
  const cases = {
    corrupt: { bytes: strToU8('not a zip archive') },
    incompatible: { bytes: checkpointArchive({ ...checkpointFor('5:1', '2026-10-17T09:00:00.000Z', []), schemaVersion: 9 }) },
    mismatched: { bytes: checkpointArchive(checkpointFor('6:1', '2026-10-17T09:00:00.000Z', [])) },
  };
  for (const [name, download] of Object.entries(cases)) {
    const { client } = mockGitHub({
      pages: [[run(5)]],
      artifacts: { 5: [{ id: 50, name: artifactNameFor(5, 1), expired: false }] },
      downloads: { 50: download },
    });
    await assert.rejects(restoreCheckpoint({ client, branch: BRANCH, currentRunId: 99 }), HistoryDataError, name);
  }
});

test('a two-execution fixture keeps earlier up and down observations without filling gaps', () => {
  const first = mergeHistory({
    restored: null,
    currentSamples: [
      sample('a', '1:1', '2026-10-17T11:00:00.000Z', 'up'),
      sample('b', '1:1', '2026-10-17T11:00:00.000Z', 'up'),
    ],
    runKey: '1:1',
    generatedAt: '2026-10-17T11:00:30.000Z',
    historyResetReason: 'first-run',
  });
  const second = mergeHistory({
    restored: first,
    currentSamples: [
      sample('a', '2:1', '2026-10-17T11:05:00.000Z', 'down'),
      sample('b', '2:1', '2026-10-17T11:05:00.000Z', 'up'),
    ],
    runKey: '2:1',
    generatedAt: '2026-10-17T11:05:30.000Z',
    historyResetReason: null,
  });
  const third = mergeHistory({
    restored: second,
    currentSamples: [
      sample('a', '3:1', '2026-10-17T11:10:00.000Z', 'up'),
      sample('b', '3:1', '2026-10-17T11:10:00.000Z', 'up'),
    ],
    runKey: '3:1',
    generatedAt: '2026-10-17T11:10:30.000Z',
    historyResetReason: null,
  });

  assert.equal(third.continuity.restoredFromRunKey, '2:1');
  const snapshot = buildSnapshot({
    generatedAt: third.generatedAt,
    runKey: '3:1',
    historyResetReason: null,
    sites: [
      { id: 'a', name: 'A', publicUrl: 'https://a.example.test/', definitionRevision: REVISION, samples: seriesSamples(third, 'a', REVISION) },
      { id: 'b', name: 'B', publicUrl: 'https://b.example.test/', definitionRevision: REVISION, samples: seriesSamples(third, 'b', REVISION) },
    ],
  });
  validateSnapshot(snapshot, { expectedSites: [{ id: 'a' }, { id: 'b' }] });
  const siteA = snapshot.sites[0];
  assert.equal(siteA.window.totalChecks, 3);
  assert.equal(siteA.window.successfulChecks, 2);
  assert.ok(Math.abs(siteA.window.availabilityPercent - (200 / 3)) < 1e-9);
  assert.equal(siteA.recentChecks[1].status, 'down');
  assert.equal(snapshot.sites[1].window.availabilityPercent, 100);
  assert.equal(summarizeOverall(snapshot).state, 'operational');
});

test('a repeated execution is deduplicated and samples older than the window are pruned', () => {
  const old = sample('a', '0:1', '2026-08-01T00:00:00.000Z', 'down');
  const restored = checkpointFor('1:1', '2026-10-17T11:00:30.000Z', [
    { siteId: 'a', definitionRevision: REVISION, samples: [old, sample('a', '1:1', '2026-10-17T11:00:00.000Z')] },
  ]);
  const merged = mergeHistory({
    restored,
    currentSamples: [sample('a', '1:1', '2026-10-17T11:00:00.000Z'), sample('a', '2:1', '2026-10-17T11:05:00.000Z')],
    runKey: '2:1',
    generatedAt: '2026-10-17T11:05:30.000Z',
    historyResetReason: null,
  });
  const samples = seriesSamples(merged, 'a', REVISION);
  assert.deepEqual(samples.map((item) => item.runKey), ['1:1', '2:1']);
});

test('a changed definition starts a separate series that does not affect the active percentage', () => {
  const restored = checkpointFor('1:1', '2026-10-17T11:00:30.000Z', [
    { siteId: 'a', definitionRevision: 'rev-old', samples: [sample('a', '1:1', '2026-10-17T11:00:00.000Z', 'down', 'rev-old')] },
  ]);
  const merged = mergeHistory({
    restored,
    currentSamples: [sample('a', '2:1', '2026-10-17T11:05:00.000Z', 'up', 'rev-new')],
    runKey: '2:1',
    generatedAt: '2026-10-17T11:05:30.000Z',
    historyResetReason: null,
  });
  const snapshot = buildSnapshot({
    generatedAt: merged.generatedAt,
    runKey: '2:1',
    historyResetReason: null,
    sites: [{ id: 'a', name: 'A', publicUrl: null, definitionRevision: 'rev-new', samples: seriesSamples(merged, 'a', 'rev-new') }],
  });
  assert.equal(snapshot.sites[0].window.availabilityPercent, 100);
  assert.equal(snapshot.sites[0].window.totalChecks, 1);
  assert.equal(merged.series.length, 2);
});

test('the artifact and run key derive from run id and attempt', () => {
  assert.equal(artifactNameFor(12, 2), 'site-availability-12-2');
  assert.equal(runKeyFor(12, 2), '12:2');
});
