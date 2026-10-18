import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile, copyFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { serializeSnapshot } from '../../src/lib/load-status.mjs';

const execFileAsync = promisify(execFile);
const ROOT = resolve(import.meta.dirname, '..', '..');
const FIXTURES = join(ROOT, 'tests', 'fixtures', 'status');
// Scoped to this file: test files run in parallel, and another file's cleanup must not delete a build's inputs mid-run.
const SCRATCH = join(ROOT, '.test-output', 'build');
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

// Runs a real Astro build. The monitor output directory is always set so the build never reads a developer's data.
async function build({ manifest = join(FIXTURES, 'sites-upptime-format.yml'), snapshot = null, name }) {
  const work = await scratch(name);
  const output = join(work, 'monitor');
  await mkdir(output, { recursive: true });
  if (snapshot) {
    await copyFile(join(FIXTURES, 'snapshots', `${snapshot}.json`), join(output, 'status.json'));
  }
  const outDir = join(work, 'dist');
  const env = {
    ...process.env,
    UPP_SITE_MANIFEST: manifest,
    UPP_MONITOR_OUTPUT: output,
    UPP_SITE_URL: 'https://status.example.test',
  };
  try {
    await execFileAsync(process.execPath, [join(ROOT, 'node_modules', 'astro', 'bin', 'astro.mjs'), 'build', '--outDir', outDir], {
      cwd: ROOT,
      env,
      timeout: 170_000,
    });
    return { ok: true, outDir, work };
  } catch (error) {
    return { ok: false, error: `${error.stdout ?? ''}${error.stderr ?? ''}`, work };
  }
}

function count(html, pattern) {
  return html.match(pattern)?.length ?? 0;
}

test('with no snapshot the build renders the explicit no-data state and one main region and footer', async () => {
  const result = await build({ name: 'no-data' });
  assert.equal(result.ok, true, result.error);
  const html = await readFile(join(result.outDir, 'index.html'), 'utf8');
  assert.equal(count(html, /<main[\s>]/g), 1);
  assert.equal(count(html, /<footer[\s>]/g), 1);
  assert.match(html, /No monitoring snapshot is present in this build/);
  assert.match(html, /Powered By hagilight@/);
  assert.match(html, /HagiCode Website/);
  assert.doesNotMatch(html, /All services operational/);
  const json = JSON.parse(await readFile(join(result.outDir, 'status.json'), 'utf8'));
  assert.equal(json.runKey, null);
  assert.equal(json.sites.length, 3);
  assert.ok(json.sites.every((site) => site.latest === null));
});

test('an all-up snapshot renders its observations and the JSON matches the snapshot bytes', async () => {
  const result = await build({ snapshot: 'all-up', name: 'all-up' });
  assert.equal(result.ok, true, result.error);
  const html = await readFile(join(result.outDir, 'index.html'), 'utf8');
  assert.match(html, /Last observed: All services operational/);
  assert.equal(count(html, /data-observed-at=/g), 3);
  assert.match(html, /Observed-check availability/);
  assert.match(html, /Share of observed checks that succeeded, not continuous uptime/);
  const served = await readFile(join(result.outDir, 'status.json'), 'utf8');
  const fixture = await readFile(join(FIXTURES, 'snapshots', 'all-up.json'), 'utf8');
  assert.equal(served, serializeSnapshot(JSON.parse(fixture)));
  assert.equal(served, fixture);
});

test('a down site is shown as down while the summary keeps the last-observed wording', async () => {
  const result = await build({ snapshot: 'down', name: 'down' });
  assert.equal(result.ok, true, result.error);
  const html = await readFile(join(result.outDir, 'index.html'), 'utf8');
  assert.match(html, /Last observed: one or more services down/);
  assert.match(html, /data-outcome="down"/);
  assert.match(html, /unexpected HTTP status \(HTTP 503\)/);
  assert.match(html, /data-outcome="up"/);
  assert.equal(count(html, /<main[\s>]/g), 1);
});

test('an empty configuration renders No sites configured and no fabricated services', async () => {
  const manifest = join(FIXTURES, 'sites-empty.yml');
  const result = await build({ manifest, snapshot: null, name: 'empty' });
  assert.equal(result.ok, true, result.error);
  const html = await readFile(join(result.outDir, 'index.html'), 'utf8');
  assert.match(html, /No sites configured/);
  assert.doesNotMatch(html, /All services operational/);
  assert.equal(count(html, /class="service"/g), 0);
});

test('an invalid supplied snapshot fails the build instead of rendering a reassuring page', async () => {
  const work = await scratch('invalid-version');
  const bad = JSON.parse(await readFile(join(FIXTURES, 'snapshots', 'all-up.json'), 'utf8'));
  bad.schemaVersion = 2;
  const fixtureDir = join(work, 'fixtures');
  await mkdir(fixtureDir, { recursive: true });
  const badFile = join(fixtureDir, 'invalid.json');
  await writeFile(badFile, JSON.stringify(bad));
  const output = join(work, 'monitor');
  await mkdir(output, { recursive: true });
  await copyFile(badFile, join(output, 'status.json'));
  const outDir = join(work, 'dist');
  await assert.rejects(
    execFileAsync(process.execPath, [join(ROOT, 'node_modules', 'astro', 'bin', 'astro.mjs'), 'build', '--outDir', outDir], {
      cwd: ROOT,
      env: { ...process.env, UPP_SITE_MANIFEST: join(FIXTURES, 'sites-upptime-format.yml'), UPP_MONITOR_OUTPUT: output },
      timeout: 170_000,
    }),
    (error) => {
      assert.match(`${error.stdout}${error.stderr}`, /unsupported snapshot schemaVersion/);
      return true;
    },
  );
});

test('a snapshot that omits an enabled site fails the build as incomplete coverage', async () => {
  const work = await scratch('missing-site');
  const partial = JSON.parse(await readFile(join(FIXTURES, 'snapshots', 'all-up.json'), 'utf8'));
  partial.sites = partial.sites.slice(1);
  const output = join(work, 'monitor');
  await mkdir(output, { recursive: true });
  await writeFile(join(output, 'status.json'), JSON.stringify(partial));
  await assert.rejects(
    execFileAsync(process.execPath, [join(ROOT, 'node_modules', 'astro', 'bin', 'astro.mjs'), 'build', '--outDir', join(work, 'dist')], {
      cwd: ROOT,
      env: { ...process.env, UPP_SITE_MANIFEST: join(FIXTURES, 'sites-upptime-format.yml'), UPP_MONITOR_OUTPUT: output },
      timeout: 170_000,
    }),
    (error) => {
      assert.match(`${error.stdout}${error.stderr}`, /do not match the enabled configuration/);
      return true;
    },
  );
});
