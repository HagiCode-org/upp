import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, rm, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { strToU8, zipSync } from 'fflate';
import { assertBudgetFits, assertEventAllowed, runMonitor } from '../../scripts/monitor/run.mjs';
import { ConfigurationError, normalizeSites, presentationSites } from '../../scripts/monitor/config.mjs';
import { HistoryAccessError, artifactNameFor, createGitHubHistoryClient } from '../../scripts/monitor/history.mjs';
import { validateSnapshot } from '../../src/lib/status.mjs';

const CANARY = 'run-canary-91bd0e';
const servers = [];
const dirs = [];

after(async () => {
  for (const server of servers) {
    server.closeAllConnections?.();
    server.close();
  }
  for (const dir of dirs) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function outputDir() {
  const dir = await mkdtemp(join(tmpdir(), 'upp-run-'));
  dirs.push(dir);
  return dir;
}

async function startServer(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  return `http://127.0.0.1:${server.address().port}`;
}

const clockAt = (iso) => () => Date.parse(iso);

test('an outage is valid monitoring data and the run still completes', async () => {
  const up = await startServer((req, res) => res.end('ok'));
  const down = await startServer((req, res) => {
    res.statusCode = 503;
    res.end();
  });
  const targets = normalizeSites({
    sites: [
      { name: 'Up', url: `${up}/` },
      { name: 'Down', url: `${down}/`, slug: 'down' },
    ],
  });
  const dir = await outputDir();
  const logs = [];
  const { snapshot } = await runMonitor({
    targets,
    env: {},
    runKey: '40:1',
    outputDir: dir,
    now: clockAt('2026-10-17T12:00:00.000Z'),
    log: (line) => logs.push(line),
  });
  validateSnapshot(snapshot, { expectedSites: targets });
  assert.equal(snapshot.sites.find((site) => site.id === 'down').latest.status, 'down');
  assert.equal(snapshot.sites.find((site) => site.id === 'up').latest.status, 'up');
  assert.ok(logs.some((line) => line.startsWith('Down: down (unexpected-status)')));
  const written = JSON.parse(await readFile(join(dir, 'status.json'), 'utf8'));
  assert.equal(written.runKey, '40:1');
  assert.ok(JSON.parse(await readFile(join(dir, 'checkpoint.json'), 'utf8')).series.length === 2);
});

test('secret canaries never reach logs, status output or the checkpoint', async () => {
  const origin = await startServer((req, res) => {
    res.writeHead(302, { location: `${origin}/landing?token=${CANARY}` });
    res.end();
  });
  const targets = normalizeSites({
    sites: [{ name: 'Private', url: `${origin}/`, headers: [{ name: 'Authorization', secret: 'PRIVATE_TOKEN' }] }],
  });
  const dir = await outputDir();
  const logs = [];
  await runMonitor({
    targets,
    env: { PRIVATE_TOKEN: CANARY },
    runKey: '41:1',
    outputDir: dir,
    now: clockAt('2026-10-17T12:00:00.000Z'),
    log: (line) => logs.push(line),
  });
  const files = await Promise.all(['status.json', 'checkpoint.json'].map((name) => readFile(join(dir, name), 'utf8')));
  for (const text of [...logs, ...files]) {
    assert.equal(text.includes(CANARY), false);
  }
});

test('a missing monitoring secret stops the run before any probe is sent', async () => {
  let fetched = false;
  const targets = normalizeSites({
    sites: [{ name: 'Private', url: 'https://private.example.test/', headers: [{ name: 'Authorization', secret: 'NOT_SET' }] }],
  });
  await assert.rejects(
    runMonitor({
      targets,
      env: {},
      runKey: '42:1',
      outputDir: await outputDir(),
      fetch: async () => {
        fetched = true;
        return new Response('');
      },
    }),
    ConfigurationError,
  );
  assert.equal(fetched, false);
});

test('a denied history restore fails the run and leaves the previous output untouched', async () => {
  const dir = await outputDir();
  await writeFile(join(dir, 'status.json'), '{"previous":true}\n');
  const up = await startServer((req, res) => res.end('ok'));
  const targets = normalizeSites({ sites: [{ name: 'Up', url: `${up}/` }] });
  const client = createGitHubHistoryClient({
    owner: 'HagiCode-org',
    repo: 'upp',
    token: 't',
    fetch: async () => new Response('{}', { status: 403 }),
  });
  await assert.rejects(
    runMonitor({ targets, env: {}, client, branch: 'main', currentRunId: 50, runKey: '50:1', outputDir: dir }),
    HistoryAccessError,
  );
  assert.equal(await readFile(join(dir, 'status.json'), 'utf8'), '{"previous":true}\n');
  await assert.rejects(access(join(dir, 'checkpoint.json')));
});

test('a restored checkpoint from an earlier run contributes its observations', async () => {
  const up = await startServer((req, res) => res.end('ok'));
  const targets = normalizeSites({ sites: [{ name: 'Up', url: `${up}/`, slug: 'up' }] });
  const earlier = {
    schemaVersion: 1,
    runKey: '60:1',
    generatedAt: '2026-10-17T11:55:00.000Z',
    historyWindowDays: 30,
    continuity: { historyResetReason: null, restoredFromRunKey: null },
    series: [{
      siteId: 'up',
      definitionRevision: targets[0].definitionRevision,
      samples: [{
        runKey: '60:1',
        siteId: 'up',
        definitionRevision: targets[0].definitionRevision,
        checkedAt: '2026-10-17T11:55:00.000Z',
        status: 'down',
        httpStatus: 500,
        responseTimeMs: 20,
        attempts: 1,
        failureCategory: 'unexpected-status',
      }],
    }],
  };
  const archive = zipSync({ 'checkpoint.json': strToU8(JSON.stringify(earlier)) });
  const client = createGitHubHistoryClient({
    owner: 'HagiCode-org',
    repo: 'upp',
    token: 't',
    fetch: async (url) => {
      const parsed = new URL(url);
      if (parsed.pathname.endsWith('/monitor.yml/runs')) {
        return Response.json({ workflow_runs: [{ id: 60, run_attempt: 1, status: 'completed', conclusion: 'success', event: 'schedule', head_branch: 'main' }] });
      }
      if (parsed.pathname.endsWith('/runs/60/artifacts')) {
        return Response.json({ artifacts: [{ id: 600, name: artifactNameFor(60, 1), expired: false }] });
      }
      return new Response(archive, { status: 200 });
    },
  });
  const dir = await outputDir();
  const { snapshot, checkpoint } = await runMonitor({
    targets,
    env: {},
    client,
    branch: 'main',
    currentRunId: 61,
    runKey: '61:1',
    outputDir: dir,
    now: clockAt('2026-10-17T12:00:00.000Z'),
  });
  assert.equal(checkpoint.continuity.restoredFromRunKey, '60:1');
  assert.equal(snapshot.historyResetReason, null);
  assert.equal(snapshot.sites[0].window.totalChecks, 2);
  assert.equal(snapshot.sites[0].window.availabilityPercent, 50);
});

test('the preflight budget refuses worst cases that cannot fit the run budget', () => {
  const targets = normalizeSites({
    sites: Array.from({ length: 66 }, (_, index) => ({ name: `Site ${index}`, url: `https://site${index}.example.test/` })),
  });
  assert.equal(assertBudgetFits(targets, { concurrency: 4, runBudgetMs: 600_000 }), 17 * 20_000);
  assert.throws(() => assertBudgetFits(targets, { concurrency: 1, runBudgetMs: 600_000 }), /exceeds the run budget/);
});

test('only the default branch and scheduled or manual events may write checkpoints', () => {
  assert.doesNotThrow(() => assertEventAllowed({ eventName: 'schedule', refName: 'main', defaultBranch: 'main' }));
  assert.doesNotThrow(() => assertEventAllowed({ eventName: 'workflow_dispatch', refName: 'main', defaultBranch: 'main' }));
  assert.throws(() => assertEventAllowed({ eventName: 'workflow_dispatch', refName: 'feature', defaultBranch: 'main' }), /only on main/);
  assert.throws(() => assertEventAllowed({ eventName: 'pull_request', refName: 'main', defaultBranch: 'main' }), /may not write/);
});

test('presentation reads of an empty configuration produce a valid empty snapshot', () => {
  assert.deepEqual(presentationSites(normalizeSites({ sites: [] })), []);
});
