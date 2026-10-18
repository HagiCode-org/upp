import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { loadReleaseData, serializeReleaseSnapshot } from '../../src/lib/load-release-hash.mjs';
import { ReleaseHashDataError, loadRegistry, validateReleaseSnapshot } from '../../src/lib/release-hash.mjs';
import { runReleaseCheck } from '../../scripts/release-hash/run.mjs';
import { FIXTURES, REGISTRY_PATH, ROOT, fakeFetch, healthyWeb } from '../release-hash/support.mjs';

const execFileAsync = promisify(execFile);
const SCRATCH = join(ROOT, '.test-output', 'release-hash-page');
const STATUS_FIXTURES = join(ROOT, 'tests', 'fixtures', 'status');
const MANIFEST = join(STATUS_FIXTURES, 'sites-upptime-format.yml');
const ASTRO = join(ROOT, 'node_modules', 'astro', 'bin', 'astro.mjs');
const registry = await loadRegistry(REGISTRY_PATH);
const dirs = [];

after(async () => {
  await rm(SCRATCH, { recursive: true, force: true });
});

async function scratch(name) {
  await mkdir(SCRATCH, { recursive: true });
  const dir = await mkdtemp(join(SCRATCH, `${name}-`));
  dirs.push(dir);
  return dir;
}

// Runs a real Astro build against a monitor output directory that holds only the fixtures for this case.
// `work` reuses a scratch directory when a test needs to inspect it after a failed build, and `extra` and `extraEnv` pass flags and environment through.
async function build({ name, work: existing = null, releaseFixture = null, releaseRaw = null, statusFixture = null, monitorOutput = null, extra = [], extraEnv = {} }) {
  const work = existing ?? (await scratch(name));
  const output = monitorOutput ?? join(work, 'monitor');
  await mkdir(output, { recursive: true });
  if (statusFixture) {
    await copyFile(join(STATUS_FIXTURES, 'snapshots', `${statusFixture}.json`), join(output, 'status.json'));
  }
  if (releaseFixture) {
    await copyFile(join(FIXTURES, `${releaseFixture}.json`), join(output, 'release-hash.json'));
  }
  if (releaseRaw !== null) {
    await writeFile(join(output, 'release-hash.json'), releaseRaw);
  }
  const outDir = join(work, 'dist');
  await execFileAsync(process.execPath, [ASTRO, 'build', '--outDir', outDir, ...extra], {
    cwd: ROOT,
    env: {
      ...process.env,
      UPP_SITE_MANIFEST: MANIFEST,
      UPP_MONITOR_OUTPUT: output,
      UPP_RELEASE_REGISTRY: REGISTRY_PATH,
      UPP_SITE_URL: 'https://status.example.test',
      ...extraEnv,
    },
    timeout: 170_000,
  });
  return { outDir, output };
}

function count(html, pattern) {
  return html.match(pattern)?.length ?? 0;
}

// Rows as rendered, in display order: id, state attribute and the visible state label.
function renderedRows(html) {
  return [...html.matchAll(/data-release-id="([^"]+)" data-state="([^"]+)">[\s\S]*?<span class="state-label">([^<]+)<\/span>/g)]
    .map((match) => ({ id: match[1], state: match[2], label: match[3] }));
}

async function snapshotOf(outDir) {
  return JSON.parse(await readFile(join(outDir, 'release-hash.json'), 'utf8'));
}

// The page and the endpoint are built from one snapshot, so each rendered state must equal the JSON state for its repository.
function assertPageMatchesJson(html, snapshot) {
  const rows = renderedRows(html);
  assert.equal(rows.length, registry.length);
  const byId = new Map(snapshot.repositories.map((repo) => [repo.id, repo]));
  for (const row of rows) {
    assert.equal(row.state, byId.get(row.id).state, row.id);
  }
}

test('with no snapshot the page shows No data for every repository and makes no all-normal claim', async () => {
  const { outDir } = await build({ name: 'no-data' });
  const html = await readFile(join(outDir, 'release-hashes', 'index.html'), 'utf8');
  assert.equal(count(html, /<main[\s>]/g), 1);
  assert.equal(count(html, /<footer[\s>]/g), 1);
  assert.match(html, /No release-hash data/);
  assert.match(html, /No release-hash snapshot is present in this build/);
  assert.doesNotMatch(html, /All \d+ repositories match/);
  const rows = renderedRows(html);
  assert.equal(rows.length, 14);
  assert.ok(rows.every((row) => row.label === 'No data'));
  const snapshot = await snapshotOf(outDir);
  assert.equal(snapshot.runKey, null);
  assert.ok(snapshot.repositories.every((repo) => repo.state === 'unknown' && repo.reason === 'not-checked'));
  assertPageMatchesJson(html, snapshot);
});

test('an all-match snapshot is the only case that states every repository matches', async () => {
  const { outDir } = await build({ name: 'all-match', releaseFixture: 'all-match' });
  const html = await readFile(join(outDir, 'release-hashes', 'index.html'), 'utf8');
  assert.match(html, /All 14 repositories match their published versions/);
  assert.equal(count(html, /<main[\s>]/g), 1);
  assert.equal(count(html, /<footer[\s>]/g), 1);
  const rows = renderedRows(html);
  assert.ok(rows.every((row) => row.label === 'Match'));
  assertPageMatchesJson(html, await snapshotOf(outDir));
  const short = (await snapshotOf(outDir)).repositories[0].mainHash.slice(0, 7);
  assert.match(html, new RegExp(`>${short}<`));
});

test('a mismatch is abnormal and the rows are ordered mismatch, unknown, then match', async () => {
  const { outDir } = await build({ name: 'mixed', releaseFixture: 'mixed' });
  const html = await readFile(join(outDir, 'release-hashes', 'index.html'), 'utf8');
  assert.match(html, /Abnormal: 1 of 14 repositories differ from their published site/);
  assert.match(html, /11 match · 1 mismatch · 2 unknown/);
  const rows = renderedRows(html);
  assert.deepEqual(rows.slice(0, 3).map((row) => [row.id, row.label]), [
    ['site', 'Mismatch'],
    ['hagilight', 'Unknown'],
    ['trait', 'Unknown'],
  ]);
  assert.ok(rows.slice(3).every((row) => row.label === 'Match'));
  assert.match(html, /GitHub rate limit reached/);
  assert.match(html, /published metadata file not found/);
  assert.doesNotMatch(html, /All \d+ repositories match/);
  assertPageMatchesJson(html, await snapshotOf(outDir));
});

test('unknown results without a mismatch read as incomplete, never as normal', async () => {
  const { outDir } = await build({ name: 'unknown-only', releaseFixture: 'unknown-only' });
  const html = await readFile(join(outDir, 'release-hashes', 'index.html'), 'utf8');
  assert.match(html, /Incomplete: 2 of 14 repositories could not be compared/);
  assert.doesNotMatch(html, /All \d+ repositories match/);
  const rows = renderedRows(html);
  assert.deepEqual(rows.slice(0, 2).map((row) => row.id), ['cost', 'docs']);
  assert.match(html, /timed out/);
  assertPageMatchesJson(html, await snapshotOf(outDir));
});

test('the status page and the release-hash page link to each other, and the JSON endpoint is served', async () => {
  const { outDir } = await build({ name: 'links', releaseFixture: 'all-match' });
  const index = await readFile(join(outDir, 'index.html'), 'utf8');
  const release = await readFile(join(outDir, 'release-hashes', 'index.html'), 'utf8');
  assert.match(index, /href="\/release-hashes\/"/);
  assert.match(release, /href="\/"/);
  assert.match(release, /href="\/release-hash\.json"/);
  const served = await readFile(join(outDir, 'release-hash.json'), 'utf8');
  assert.equal(served, serializeReleaseSnapshot(JSON.parse(served)));
});

test('a malformed release snapshot fails the build instead of rendering a reassuring page', async () => {
  await assert.rejects(build({ name: 'malformed-json', releaseRaw: '{"schemaVersion": 1,' }), (error) => {
    assert.match(`${error.stdout}${error.stderr}`, /not valid JSON/);
    return true;
  });
  const bad = JSON.parse(await readFile(join(FIXTURES, 'all-match.json'), 'utf8'));
  bad.schemaVersion = 2;
  await assert.rejects(build({ name: 'unsupported-version', releaseRaw: JSON.stringify(bad) }), (error) => {
    assert.match(`${error.stdout}${error.stderr}`, /unsupported release-hash schemaVersion/);
    return true;
  });
});

test('loading with no snapshot is the no-data state and makes no network request', async () => {
  const work = await scratch('loader-absent');
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = () => {
    requests += 1;
    throw new Error('the build must not reach the network');
  };
  try {
    const { snapshot, source } = await loadReleaseData({ UPP_MONITOR_OUTPUT: work, UPP_RELEASE_REGISTRY: REGISTRY_PATH });
    assert.equal(source, 'no-data');
    assert.equal(snapshot.runKey, null);
    assert.equal(snapshot.repositories.length, 14);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(requests, 0);
});

test('loading a malformed snapshot throws the release-hash error', async () => {
  const work = await scratch('loader-malformed');
  await writeFile(join(work, 'release-hash.json'), '{"schemaVersion": 1, "generatedAt": "soon"}');
  await assert.rejects(loadReleaseData({ UPP_MONITOR_OUTPUT: work, UPP_RELEASE_REGISTRY: REGISTRY_PATH }), ReleaseHashDataError);
});

test('an artifact built after the check carries a valid snapshot and leaves the status output byte-identical', async () => {
  const work = await scratch('contract');
  const output = join(work, 'monitor');
  await mkdir(output, { recursive: true });
  await copyFile(join(STATUS_FIXTURES, 'snapshots', 'all-up.json'), join(output, 'status.json'));
  const web = fakeFetch(healthyWeb(registry));
  await runReleaseCheck({
    registry,
    env: { UPP_MONITOR_OUTPUT: output, GITHUB_RUN_ID: '777', GITHUB_RUN_ATTEMPT: '1' },
    outputDir: output,
    fetch: web.fetch,
    now: () => Date.parse('2026-10-17T09:35:02.114Z'),
  });
  const { outDir } = await build({ name: 'contract-build', monitorOutput: output });

  const releaseSnapshot = JSON.parse(await readFile(join(outDir, 'release-hash.json'), 'utf8'));
  assert.doesNotThrow(() => validateReleaseSnapshot(releaseSnapshot, { registry }));
  assert.equal(releaseSnapshot.runKey, '777:1');
  const release = await readFile(join(outDir, 'release-hashes', 'index.html'), 'utf8');
  assertPageMatchesJson(release, releaseSnapshot);

  const served = await readFile(join(outDir, 'status.json'), 'utf8');
  const fixture = await readFile(join(STATUS_FIXTURES, 'snapshots', 'all-up.json'), 'utf8');
  assert.equal(served, fixture);
});

// The homepage sync entry sits after the availability summary and before the services list.
function homepageOrder(html) {
  return ['class="summary"', 'class="sync-entry"', 'class="services-section"'].map((marker) => html.indexOf(marker));
}

test('the homepage sync entry sits between the summary and the services, with one link to the release-hash page', async () => {
  const { outDir } = await build({ name: 'entry-order', releaseFixture: 'mixed', statusFixture: 'all-up' });
  const html = await readFile(join(outDir, 'index.html'), 'utf8');
  const [summary, entry, services] = homepageOrder(html);
  assert.ok(summary >= 0 && summary < entry && entry < services, `order ${summary} ${entry} ${services}`);
  assert.equal(count(html, /href="\/release-hashes\/"/g), 1);
  assert.match(html, /<a href="\/release-hashes\/">View release hash status<\/a>/);
  assert.doesNotMatch(html, /compare each site's published commit/);
});

test('the sync entry copy follows the release-hash state and claims normal only when every result matches', async () => {
  const allMatch = await build({ name: 'entry-all-match', releaseFixture: 'all-match', statusFixture: 'all-up' });
  const matchHtml = await readFile(join(allMatch.outDir, 'index.html'), 'utf8');
  assert.match(matchHtml, /data-release-state="normal"/);
  assert.match(matchHtml, /All 14 repositories match their published versions/);
  assert.match(matchHtml, /class="sync-counts">14 match · 0 mismatch · 0 unknown</);

  const mixed = await build({ name: 'entry-mixed', releaseFixture: 'mixed', statusFixture: 'all-up' });
  const mixedHtml = await readFile(join(mixed.outDir, 'index.html'), 'utf8');
  assert.match(mixedHtml, /data-release-state="abnormal"/);
  assert.match(mixedHtml, /Abnormal: 1 of 14 repositories differ from their published site/);
  assert.match(mixedHtml, /class="sync-detail">11 match · 1 mismatch · 2 unknown</);
  assert.doesNotMatch(mixedHtml, /All \d+ repositories match/);

  const unknown = await build({ name: 'entry-unknown', releaseFixture: 'unknown-only', statusFixture: 'all-up' });
  const unknownHtml = await readFile(join(unknown.outDir, 'index.html'), 'utf8');
  assert.match(unknownHtml, /data-release-state="incomplete"/);
  assert.match(unknownHtml, /Incomplete: 2 of 14 repositories could not be compared/);
  assert.doesNotMatch(unknownHtml, /All \d+ repositories match/);
});

test('a non-root base path prefixes the sync entry link', async () => {
  const work = await scratch('entry-base');
  // Astro has no CLI flag for base, so a scratch config sets it. The config lives under the repo, so its imports resolve.
  const config = join(work, 'astro.base.config.mjs');
  await writeFile(config, [
    "import { defineConfig } from 'astro/config';",
    "import { hagilight, hagilightFavicon } from '@hagicode/hagilight/integration';",
    "export default defineConfig({ site: 'https://status.example.test', base: '/upp-preview', output: 'static', integrations: [hagilight({ rss: false, llms: false }), hagilightFavicon()] });",
    '',
  ].join('\n'));
  // Astro joins --config onto the root, so the path must be relative to the repo root.
  const { outDir } = await build({ name: 'entry-base-build', work, releaseFixture: 'all-match', statusFixture: 'all-up', extra: ['--config', relative(ROOT, config)] });
  // The base path changes the links, not the folder layout: the output is still written at the root of outDir.
  const html = await readFile(join(outDir, 'index.html'), 'utf8');
  assert.match(html, /<a href="\/upp-preview\/release-hashes\/">View release hash status<\/a>/);
  assert.doesNotMatch(html, /<a href="\/release-hashes\/"/);
});

test('a mismatch leaves the availability heading operational, and a down site leaves the entry at all match', async () => {
  const mismatch = await build({ name: 'independence-mismatch', releaseFixture: 'mixed', statusFixture: 'all-up' });
  const mismatchHtml = await readFile(join(mismatch.outDir, 'index.html'), 'utf8');
  assert.match(mismatchHtml, /summary-heading">Last observed: All services operational</);
  assert.match(mismatchHtml, /data-release-state="abnormal"/);

  const down = await build({ name: 'independence-down', releaseFixture: 'all-match', statusFixture: 'down' });
  const downHtml = await readFile(join(down.outDir, 'index.html'), 'utf8');
  assert.match(downHtml, /summary-heading">Last observed: one or more services down</);
  assert.match(downHtml, /data-release-state="normal"/);
  assert.match(downHtml, /All 14 repositories match their published versions/);
});

test('with no snapshot the homepage shows the no-data entry with a link and makes no fetch request', async () => {
  const work = await scratch('entry-no-data-offline');
  // A preload module records any fetch the build makes and refuses it, so a silent network request fails the build.
  const log = join(work, 'fetch-log.txt');
  const preload = join(work, 'block-fetch.mjs');
  await writeFile(preload, [
    "import { appendFileSync } from 'node:fs';",
    `globalThis.fetch = (input) => { appendFileSync(${JSON.stringify(log)}, String(input) + '\\n'); throw new Error('the build must not reach the network'); };`,
    '',
  ].join('\n'));
  const nodeOptions = [process.env.NODE_OPTIONS, `--import=${pathToFileURL(preload).href}`].filter(Boolean).join(' ');
  // Astro's own telemetry posts over fetch during a build, so it is switched off here to leave only the page's requests under test.
  const extraEnv = { NODE_OPTIONS: nodeOptions, ASTRO_TELEMETRY_DISABLED: '1' };
  const { outDir } = await build({ name: 'entry-no-data-offline-build', work, extraEnv });
  const html = await readFile(join(outDir, 'index.html'), 'utf8');
  assert.match(html, /data-release-state="no-data"/);
  assert.match(html, /No release-hash data/);
  assert.match(html, /<a href="\/release-hashes\/">View release hash status<\/a>/);
  assert.doesNotMatch(html, /All \d+ repositories match/);
  assert.equal(existsSync(log), false, existsSync(log) ? await readFile(log, 'utf8') : '');
});

test('an invalid release-hash snapshot fails the homepage build and leaves no homepage', async () => {
  const work = await scratch('invalid-homepage');
  const bad = JSON.parse(await readFile(join(FIXTURES, 'all-match.json'), 'utf8'));
  bad.schemaVersion = 2;
  await assert.rejects(build({ name: 'invalid-homepage-build', work, releaseRaw: JSON.stringify(bad) }), (error) => {
    assert.notEqual(error.code, 0);
    assert.match(`${error.stdout}${error.stderr}`, /unsupported release-hash schemaVersion/);
    return true;
  });
  assert.equal(existsSync(join(work, 'dist', 'index.html')), false);
});
