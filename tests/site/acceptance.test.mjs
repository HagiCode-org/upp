import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { strToU8, unzipSync, zipSync } from 'fflate';
import { runMonitor } from '../../scripts/monitor/run.mjs';
import { createGitHubHistoryClient, artifactNameFor, runKeyFor, HistoryApiError } from '../../scripts/monitor/history.mjs';
import { loadManifest } from '../../scripts/monitor/config.mjs';

const execFileAsync = promisify(execFile);
const ROOT = resolve(import.meta.dirname, '..', '..');
const SCRATCH = join(ROOT, '.test-output', 'acceptance');
const CANARY = 'acceptance-canary-4e8a21';
const REPO = 'HagiCode-org/upp';

let flakyStatus = 200;
const requestsSeen = [];
const server = http.createServer((req, res) => {
  requestsSeen.push({ path: req.url, authorization: req.headers.authorization });
  if (req.url === '/stable') {
    res.end('stable');
  } else if (req.url === '/flaky') {
    res.statusCode = flakyStatus;
    res.end();
  } else if (req.url === '/private') {
    res.statusCode = req.headers.authorization === CANARY ? 200 : 401;
    res.end();
  } else {
    res.statusCode = 404;
    res.end();
  }
});
await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
const origin = `http://127.0.0.1:${server.address().port}`;

after(async () => {
  server.closeAllConnections?.();
  server.close();
  await rm(SCRATCH, { recursive: true, force: true });
});

// In-memory Actions store: workflow runs, their artifacts, and downloadable archives.
function createStore() {
  const runs = [];
  const artifacts = new Map();
  let nextArtifactId = 1000;
  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname.endsWith('/actions/workflows/monitor.yml/runs')) {
      return Response.json({ workflow_runs: runs.slice().reverse() });
    }
    const listing = parsed.pathname.match(/\/actions\/runs\/(\d+)\/artifacts$/);
    if (listing) {
      return Response.json({ artifacts: artifacts.get(listing[1]) ?? [] });
    }
    const download = parsed.pathname.match(/\/actions\/artifacts\/(\d+)\/zip$/);
    if (download) {
      for (const list of artifacts.values()) {
        const found = list.find((item) => String(item.id) === download[1]);
        if (found) {
          return new Response(found.bytes, { status: 200 });
        }
      }
      return new Response('', { status: 404 });
    }
    return new Response('unexpected', { status: 500 });
  };
  const publish = (runId, attempt, bytes) => {
    runs.push({ id: Number(runId), run_attempt: attempt, status: 'completed', conclusion: 'success', event: 'schedule', head_branch: 'main' });
    const list = artifacts.get(String(runId)) ?? [];
    list.push({ id: nextArtifactId, name: artifactNameFor(runId, attempt), expired: false, bytes });
    nextArtifactId += 1;
    artifacts.set(String(runId), list);
  };
  return { fetchImpl, publish, runs, artifacts };
}

async function writeManifest(dir) {
  const path = join(dir, 'sites.yml');
  await writeFile(path, [
    'sites:',
    `  - name: Stable Site`,
    `    url: ${origin}/stable`,
    `  - name: Flaky Site`,
    `    url: ${origin}/flaky`,
    `  - name: Private Site`,
    `    url: ${origin}/private`,
    `    headers:`,
    `      - name: authorization`,
    `        secret: PRIVATE_TOKEN`,
    '',
  ].join('\n'));
  return path;
}

async function listFiles(dir) {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.isFile()) {
      files.push(join(entry.parentPath ?? entry.path, entry.name));
    }
  }
  return files;
}

async function buildSite({ manifest, monitorOutput, outDir }) {
  await execFileAsync(process.execPath, [join(ROOT, 'node_modules', 'astro', 'bin', 'astro.mjs'), 'build', '--outDir', outDir], {
    cwd: ROOT,
    env: {
      ...process.env,
      UPP_SITE_MANIFEST: manifest,
      UPP_MONITOR_OUTPUT: monitorOutput,
      UPP_SITE_URL: 'https://status.example.test',
    },
    timeout: 170_000,
  });
}

// One complete execution: restore, check, snapshot, static generation, then packaging.
async function execute(store, manifest, runId, clockIso) {
  const dir = join(SCRATCH, `run-${runId}`);
  const monitorOutput = join(dir, 'monitor');
  const logs = [];
  const client = createGitHubHistoryClient({ owner: 'HagiCode-org', repo: 'upp', token: 'test', fetch: store.fetchImpl });
  const result = await runMonitor({
    targets: await loadManifest(manifest),
    env: { PRIVATE_TOKEN: CANARY },
    client,
    branch: 'main',
    currentRunId: runId,
    runKey: runKeyFor(runId, 1),
    outputDir: monitorOutput,
    now: () => Date.parse(clockIso),
    log: (line) => logs.push(line),
  });
  const outDir = join(dir, 'dist');
  await buildSite({ manifest, monitorOutput, outDir });

  const entries = { 'checkpoint.json': strToU8(await readFile(join(monitorOutput, 'checkpoint.json'), 'utf8')) };
  for (const file of await listFiles(outDir)) {
    entries[`dist/${relative(outDir, file).split(sep).join('/')}`] = new Uint8Array(await readFile(file));
  }
  const archive = zipSync(entries);
  store.publish(runId, 1, archive);
  return { result, logs, outDir, monitorOutput, archive };
}

test('three linked executions cover an outage, its recovery, and consistent static output', async () => {
  await rm(SCRATCH, { recursive: true, force: true });
  await mkdir(SCRATCH, { recursive: true });
  const manifest = await writeManifest(SCRATCH);
  const store = createStore();

  flakyStatus = 200;
  const first = await execute(store, manifest, 101, '2026-10-17T12:00:00.000Z');

  flakyStatus = 503;
  const second = await execute(store, manifest, 102, '2026-10-17T12:05:00.000Z');
  assert.equal(second.result.checkpoint.continuity.restoredFromRunKey, '101:1');
  const flakyDown = second.result.snapshot.sites.find((site) => site.id === 'flaky-site');
  assert.equal(flakyDown.latest.status, 'down');
  assert.equal(flakyDown.window.totalChecks, 2);
  assert.equal(flakyDown.window.availabilityPercent, 50);

  flakyStatus = 200;
  const third = await execute(store, manifest, 103, '2026-10-17T12:10:00.000Z');
  const flakyRecovered = third.result.snapshot.sites.find((site) => site.id === 'flaky-site');
  assert.equal(flakyRecovered.latest.status, 'up');
  assert.equal(flakyRecovered.window.totalChecks, 3);
  assert.equal(flakyRecovered.window.successfulChecks, 2);
  assert.ok(Math.abs(flakyRecovered.window.availabilityPercent - 200 / 3) < 1e-9);
  assert.equal(flakyRecovered.recentChecks.at(-1).status, 'up');
  assert.equal(flakyRecovered.recentChecks.some((check) => check.status === 'down'), true);

  // HTML and JSON from the same build agree on the observed-check numbers.
  const html = await readFile(join(third.outDir, 'index.html'), 'utf8');
  const json = JSON.parse(await readFile(join(third.outDir, 'status.json'), 'utf8'));
  assert.equal(json.runKey, '103:1');
  assert.match(html, /66\.67% \(2 of 3 observed checks/);
  assert.equal(json.sites.find((site) => site.id === 'flaky-site').window.totalChecks, 3);
  assert.match(html, /Last observed: All services operational/);
  assert.equal(second.result.snapshot.sites.find((site) => site.id === 'flaky-site').latest.status, 'down');
  assert.match(await readFile(join(second.outDir, 'index.html'), 'utf8'), /Last observed: one or more services down/);
});

test('a failed restore fails the run and leaves the last complete artifact untouched', async () => {
  await mkdir(SCRATCH, { recursive: true });
  const manifest = await writeManifest(SCRATCH);
  const store = createStore();
  flakyStatus = 200;
  await execute(store, manifest, 201, '2026-10-17T12:00:00.000Z');
  const before = store.artifacts.get('201')[0].bytes;

  const failingStore = {
    ...store,
    fetchImpl: async (url) => {
      if (new URL(url).pathname.endsWith('/monitor.yml/runs')) {
        return new Response('{}', { status: 500 });
      }
      return store.fetchImpl(url);
    },
  };
  const client = createGitHubHistoryClient({ owner: 'HagiCode-org', repo: 'upp', token: 'test', fetch: failingStore.fetchImpl });
  const output = join(SCRATCH, 'run-202', 'monitor');
  await assert.rejects(
    runMonitor({
      targets: await loadManifest(manifest),
      env: { PRIVATE_TOKEN: CANARY },
      client,
      branch: 'main',
      currentRunId: 202,
      runKey: runKeyFor(202, 1),
      outputDir: output,
      now: () => Date.parse('2026-10-17T12:05:00.000Z'),
    }),
    HistoryApiError,
  );
  await assert.rejects(readFile(join(output, 'checkpoint.json')));
  assert.equal(store.artifacts.get('201')[0].bytes, before);
  assert.equal(store.runs.some((run) => run.id === 202), false);
});

test('the packaged output and logs contain no secret canary', async () => {
  await mkdir(SCRATCH, { recursive: true });
  const manifest = await writeManifest(SCRATCH);
  const store = createStore();
  flakyStatus = 503;
  const packaged = await execute(store, manifest, 301, '2026-10-17T12:00:00.000Z');
  const archiveEntries = unzipSync(packaged.archive);
  const scanned = [];
  for (const [name, bytes] of Object.entries(archiveEntries)) {
    scanned.push(`${name}:${new TextDecoder().decode(bytes)}`);
  }
  scanned.push(...packaged.logs);
  for (const text of scanned) {
    assert.equal(text.includes(CANARY), false);
  }
  // The canary was genuinely used for the authenticated request, so the absence check is meaningful.
  assert.ok(requestsSeen.some((entry) => entry.authorization === CANARY));
});
