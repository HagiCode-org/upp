import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  DEFAULT_BUDGET_MS,
  ReleaseCheckConfigurationError,
  assertBudgetFits,
  main,
  parseBudgetMs,
  publishReleaseSnapshot,
  runReleaseCheck,
} from '../../scripts/release-hash/run.mjs';
import { ReleaseHashDataError, buildReleaseSnapshot, loadRegistry, validateReleaseSnapshot } from '../../src/lib/release-hash.mjs';
import {
  GENERATED_AT,
  REGISTRY_PATH,
  ROOT,
  fakeFetch,
  hangUntilAborted,
  healthyWeb,
  hashFor,
  networkError,
  observationsFor,
} from './support.mjs';

const execFileAsync = promisify(execFile);
const SCRATCH = join(ROOT, '.test-output', 'release-hash');
const DOCS_GITHUB = 'https://api.github.com/repos/HagiCode-org/docs/commits/main';
const SITE_GITHUB_TOKEN = 'ghs_canary_release_check';
const registry = await loadRegistry(REGISTRY_PATH);
const FIXED_NOW = Date.parse(GENERATED_AT);
const fixedClock = () => FIXED_NOW;
const dirs = [];

after(async () => {
  await rm(SCRATCH, { recursive: true, force: true });
});

async function outputDir() {
  await mkdir(SCRATCH, { recursive: true });
  const dir = await mkdtemp(join(SCRATCH, 'out-'));
  dirs.push(dir);
  return dir;
}

const envFor = (dir, extra = {}) => ({
  UPP_MONITOR_OUTPUT: dir,
  GITHUB_RUN_ID: '555',
  GITHUB_RUN_ATTEMPT: '2',
  ...extra,
});

async function readSnapshot(dir) {
  return JSON.parse(await readFile(join(dir, 'release-hash.json'), 'utf8'));
}

test('an all-match run exits 0 and writes a validated snapshot with the run key', async () => {
  const dir = await outputDir();
  const web = fakeFetch(healthyWeb(registry));
  const lines = [];
  const code = await main({ env: envFor(dir), fetch: web.fetch, now: fixedClock, log: (line) => lines.push(line) });
  assert.equal(code, 0);
  const snapshot = await readSnapshot(dir);
  assert.equal(snapshot.runKey, '555:2');
  assert.equal(snapshot.repositories.length, 14);
  assert.doesNotThrow(() => validateReleaseSnapshot(snapshot, { registry }));
  assert.ok(snapshot.repositories.every((repo) => repo.state === 'match'));
  assert.equal(lines.length, 14);
  assert.equal(web.calls.length, 28);
});

test('a mismatch alone exits 0 and is recorded as data', async () => {
  const dir = await outputDir();
  const base = healthyWeb(registry, { publishedFor: (entry) => (entry.id === 'site' ? hashFor('stale-site') : hashFor(`main:${entry.id}`)) });
  const code = await main({ env: envFor(dir), fetch: fakeFetch(base).fetch, now: fixedClock, log: () => {} });
  assert.equal(code, 0);
  const snapshot = await readSnapshot(dir);
  const site = snapshot.repositories.find((repo) => repo.id === 'site');
  assert.equal(site.state, 'mismatch');
  assert.equal(snapshot.repositories.filter((repo) => repo.state === 'match').length, 13);
});

test('one failing repository does not stop the others from being checked', async () => {
  const dir = await outputDir();
  const base = healthyWeb(registry);
  const web = fakeFetch(async (url, init) => {
    if (url === DOCS_GITHUB) {
      throw networkError('ECONNRESET');
    }
    return base(url, init);
  });
  const snapshot = await runReleaseCheck({ registry, env: envFor(dir), fetch: web.fetch, now: fixedClock });
  const docs = snapshot.repositories.find((repo) => repo.id === 'docs');
  assert.equal(docs.state, 'unknown');
  assert.equal(docs.reason, 'network');
  assert.equal(snapshot.repositories.filter((repo) => repo.state === 'match').length, 13);
});

test('a transient GitHub failure is retried once and then recorded as match', async () => {
  const dir = await outputDir();
  const base = healthyWeb(registry);
  let docsCalls = 0;
  const web = fakeFetch(async (url, init) => {
    if (url === DOCS_GITHUB) {
      docsCalls += 1;
      if (docsCalls === 1) {
        throw networkError('ECONNRESET');
      }
    }
    return base(url, init);
  });
  const snapshot = await runReleaseCheck({ registry, env: envFor(dir), fetch: web.fetch, now: fixedClock });
  assert.equal(docsCalls, 2);
  assert.equal(snapshot.repositories.find((repo) => repo.id === 'docs').state, 'match');
});

test('a permanent GitHub 404 is not retried', async () => {
  const dir = await outputDir();
  const base = healthyWeb(registry);
  let docsCalls = 0;
  const web = fakeFetch(async (url, init) => {
    if (url === DOCS_GITHUB) {
      docsCalls += 1;
      return new Response('', { status: 404 });
    }
    return base(url, init);
  });
  const snapshot = await runReleaseCheck({ registry, env: envFor(dir), fetch: web.fetch, now: fixedClock });
  assert.equal(docsCalls, 1);
  const docs = snapshot.repositories.find((repo) => repo.id === 'docs');
  assert.deepEqual([docs.state, docs.reason], ['unknown', 'github-not-found']);
});

test('an invalid registry exits 2 before any request, and the previous snapshot is kept', async () => {
  const dir = await outputDir();
  const previous = '{"previous": true}\n';
  await writeFile(join(dir, 'release-hash.json'), previous);
  const badRegistry = join(dir, 'bad-registry.json');
  await writeFile(badRegistry, JSON.stringify([
    { id: 'docs', name: 'Docs', repository: 'HagiCode-org/docs', branch: 'main', origin: 'https://docs.hagicode.com' },
    { id: 'docs', name: 'Docs again', repository: 'HagiCode-org/docs', branch: 'main', origin: 'https://docs.hagicode.com' },
  ]));
  const web = fakeFetch(healthyWeb(registry));
  const code = await main({ env: envFor(dir, { UPP_RELEASE_REGISTRY: badRegistry }), fetch: web.fetch, now: fixedClock, log: () => {} });
  assert.equal(code, 2);
  assert.equal(web.calls.length, 0);
  assert.equal(await readFile(join(dir, 'release-hash.json'), 'utf8'), previous);
});

test('an invalid budget exits 2 before any request', async () => {
  const dir = await outputDir();
  const web = fakeFetch(healthyWeb(registry));
  const code = await main({ env: envFor(dir, { UPP_RELEASE_CHECK_BUDGET_MS: 'soon' }), fetch: web.fetch, now: fixedClock, log: () => {} });
  assert.equal(code, 2);
  assert.equal(web.calls.length, 0);
});

test('a budget smaller than the worst case exits 2 before any request', async () => {
  const dir = await outputDir();
  const web = fakeFetch(healthyWeb(registry));
  const code = await main({ env: envFor(dir, { UPP_RELEASE_CHECK_BUDGET_MS: '1000' }), fetch: web.fetch, now: fixedClock, log: () => {} });
  assert.equal(code, 2);
  assert.equal(web.calls.length, 0);
});

test('a validation failure exits 1 and leaves the previous file intact', async () => {
  const dir = await outputDir();
  assert.equal(await main({ env: envFor(dir), fetch: fakeFetch(healthyWeb(registry)).fetch, now: fixedClock, log: () => {} }), 0);
  const previous = await readFile(join(dir, 'release-hash.json'), 'utf8');

  // A clock that steps backwards puts every observation after the snapshot's generation time, which validation rejects.
  let calls = 0;
  const steppingClock = () => {
    calls += 1;
    return calls <= registry.length ? FIXED_NOW + 60_000 : FIXED_NOW;
  };
  const code = await main({ env: envFor(dir), fetch: fakeFetch(healthyWeb(registry)).fetch, now: steppingClock, log: () => {} });
  assert.equal(code, 1);
  assert.equal(await readFile(join(dir, 'release-hash.json'), 'utf8'), previous);
});

test('publishing rejects an invalid snapshot and keeps the previous file', async () => {
  const dir = await outputDir();
  const good = buildReleaseSnapshot({ generatedAt: GENERATED_AT, runKey: '1:1', registry, observations: observationsFor(registry) });
  await publishReleaseSnapshot({ snapshot: good, registry, outputDir: dir });
  const previous = await readFile(join(dir, 'release-hash.json'), 'utf8');
  const broken = structuredClone(good);
  broken.repositories[0].state = 'mismatch';
  await assert.rejects(publishReleaseSnapshot({ snapshot: broken, registry, outputDir: dir }), ReleaseHashDataError);
  assert.equal(await readFile(join(dir, 'release-hash.json'), 'utf8'), previous);
});

test('the run budget bounds the whole check, and exhausted requests are recorded as timeouts', async () => {
  const dir = await outputDir();
  const web = fakeFetch(hangUntilAborted);
  const started = Date.now();
  const snapshot = await runReleaseCheck({ registry, env: envFor(dir), fetch: web.fetch, now: fixedClock, budgetMs: 50, timeoutMs: 8_000 });
  assert.ok(Date.now() - started < 5_000, 'the check must finish near the budget, not at the request timeout');
  assert.equal(snapshot.repositories.every((repo) => repo.state === 'unknown' && repo.reason === 'timeout'), true);
});

test('no more than four repositories are checked at a time, two requests each', async () => {
  const dir = await outputDir();
  const base = healthyWeb(registry);
  const web = fakeFetch(async (url, init) => {
    await new Promise((resolve) => setImmediate(resolve));
    return base(url, init);
  });
  await runReleaseCheck({ registry, env: envFor(dir), fetch: web.fetch, now: fixedClock, concurrency: 4 });
  assert.ok(web.peakInFlight() > 1, 'requests should overlap');
  assert.ok(web.peakInFlight() <= 8, `peak ${web.peakInFlight()} exceeds four repositories with two requests each`);
});

test('the token reaches only GitHub, and never appears in the snapshot', async () => {
  const dir = await outputDir();
  const web = fakeFetch(healthyWeb(registry));
  await runReleaseCheck({ registry, env: envFor(dir, { GITHUB_TOKEN: SITE_GITHUB_TOKEN }), fetch: web.fetch, now: fixedClock });
  for (const call of web.calls) {
    const authorization = call.init.headers.authorization;
    if (call.url.startsWith('https://api.github.com/')) {
      assert.equal(authorization, `Bearer ${SITE_GITHUB_TOKEN}`);
    } else {
      assert.equal(authorization, undefined, call.url);
    }
  }
  assert.equal((await readFile(join(dir, 'release-hash.json'), 'utf8')).includes(SITE_GITHUB_TOKEN), false);
});

test('the budget preflight accepts the default budget and rejects a worst case above it', () => {
  assert.equal(parseBudgetMs(undefined), DEFAULT_BUDGET_MS);
  assert.equal(parseBudgetMs('120000'), 120_000);
  assert.throws(() => parseBudgetMs('0'), ReleaseCheckConfigurationError);
  assert.throws(() => parseBudgetMs('12.5'), ReleaseCheckConfigurationError);
  assert.equal(assertBudgetFits(14, { budgetMs: DEFAULT_BUDGET_MS }), 64_000);
  assert.throws(() => assertBudgetFits(14, { budgetMs: 60_000 }), ReleaseCheckConfigurationError);
});

test('the package script runs the check entry point, and the entry exits 2 without making requests', async () => {
  const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts['release-check'], 'node scripts/release-hash/run.mjs');

  const dir = await outputDir();
  const scrubbed = { PATH: process.env.PATH, HOME: process.env.HOME, UPP_MONITOR_OUTPUT: dir, UPP_RELEASE_CHECK_BUDGET_MS: '1' };
  await assert.rejects(execFileAsync('npm', ['run', 'release-check'], { cwd: ROOT, env: scrubbed, timeout: 60_000 }), (error) => {
    assert.equal(error.code, 2);
    assert.match(error.stderr, /ReleaseCheckConfigurationError/);
    return true;
  });
  await assert.rejects(readFile(join(dir, 'release-hash.json')));
});
