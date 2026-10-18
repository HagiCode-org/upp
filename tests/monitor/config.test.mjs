import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import {
  ConfigurationError,
  definitionRevisionFor,
  monitoredTargets,
  normalizeSites,
  presentationSites,
} from '../../scripts/monitor/config.mjs';
import { validateSnapshot, buildSnapshot } from '../../src/lib/status.mjs';

const FIXTURE = new URL('../fixtures/status/sites-upptime-format.yml', import.meta.url);

async function loadFixture() {
  return normalizeSites(parse(await readFile(FIXTURE, 'utf8')));
}

function manifest(sites) {
  return { sites };
}

test('a real-format manifest keeps order, explicit identities and enabled flags', async () => {
  const targets = await loadFixture();
  assert.deepEqual(targets.map((target) => target.id), [
    'hagicode-website',
    'hagi-code-website-sitemap',
    'hagi-code-website-robots',
    'retired-docs',
  ]);
  assert.deepEqual(targets.map((target) => target.enabled), [true, true, true, false]);
  assert.equal(targets[1].request.acceptedStatuses[0], 200);
  assert.equal(targets[2].publicUrl, 'https://www.hagicode.example.test/robots.txt');
});

test('disabled targets are excluded from presentation and monitoring without a second list', async () => {
  const targets = await loadFixture();
  const presented = presentationSites(targets);
  assert.deepEqual(presented.map((site) => site.id), ['hagicode-website', 'hagi-code-website-sitemap', 'hagi-code-website-robots']);
  assert.deepEqual(monitoredTargets(targets, {}).map((target) => target.id), presented.map((site) => site.id));
});

test('presentation reads do not require monitoring secrets', () => {
  const targets = normalizeSites(manifest([
    { name: 'Private', url: 'https://private.example.test/', headers: [{ name: 'Authorization', secret: 'PRIVATE_TOKEN' }] },
  ]));
  assert.equal(presentationSites(targets).length, 1);
  assert.throws(() => monitoredTargets(targets, {}), /PRIVATE_TOKEN/);
  assert.equal(monitoredTargets(targets, { PRIVATE_TOKEN: 'value' }).length, 1);
});

test('duplicate identities are rejected, including names that derive the same identity', () => {
  assert.throws(() => normalizeSites(manifest([
    { name: 'One', url: 'https://one.example.test/', slug: 'same' },
    { name: 'Two', url: 'https://two.example.test/', slug: 'same' },
  ])), /duplicate site identity same/);
  assert.throws(() => normalizeSites(manifest([
    { name: 'Docs Site', url: 'https://one.example.test/' },
    { name: 'docs site', url: 'https://two.example.test/' },
  ])), /duplicate site identity docs-site/);
});

test('invalid URLs, embedded credentials and non-HTTP schemes are rejected before probing', () => {
  assert.throws(() => normalizeSites(manifest([{ name: 'Bad', url: 'not a url' }])), /not a valid absolute URL/);
  assert.throws(() => normalizeSites(manifest([{ name: 'Bad', url: 'ftp://example.test/' }])), /HTTP or HTTPS/);
  assert.throws(
    () => normalizeSites(manifest([{ name: 'Bad', url: 'https://user:pass@example.test/' }])),
    /must not embed credentials/,
  );
});

test('unsupported check-affecting settings are rejected by name', () => {
  assert.throws(
    () => normalizeSites(manifest([{ name: 'Body', url: 'https://example.test/', __dangerous__body_down_if_text_missing: 'x' }])),
    /__dangerous__body_down_if_text_missing is a check-affecting setting/,
  );
  assert.throws(
    () => normalizeSites(manifest([{ name: 'Post', url: 'https://example.test/', method: 'POST' }])),
    /method must be one of GET, HEAD/,
  );
  assert.throws(
    () => normalizeSites(manifest([{ name: 'Slow', url: 'https://example.test/', timeoutMs: 999999 }])),
    /timeoutMs must be an integer/,
  );
  assert.throws(
    () => normalizeSites(manifest([{ name: 'Codes', url: 'https://example.test/', expectedStatusCodes: [] }])),
    /nonempty list/,
  );
});

test('secret references must name environment variables and headers must be valid', () => {
  assert.throws(
    () => normalizeSites(manifest([{ name: 'S', url: 'https://example.test/', headers: [{ name: 'Authorization', secret: 'lower' }] }])),
    /must name an environment variable/,
  );
  assert.throws(
    () => normalizeSites(manifest([{ name: 'S', url: 'https://example.test/', headers: [{ name: 'Bad Name', secret: 'TOKEN' }] }])),
    /not a valid header name/,
  );
});

test('the definition revision changes with the request but not with names, order or secret values', () => {
  const base = normalizeSites(manifest([{ name: 'Alpha', url: 'https://example.test/a', slug: 'alpha' }]))[0];
  const renamed = normalizeSites(manifest([{ name: 'Renamed', url: 'https://example.test/a', slug: 'alpha' }]))[0];
  const changedUrl = normalizeSites(manifest([{ name: 'Alpha', url: 'https://example.test/b', slug: 'alpha' }]))[0];
  assert.equal(base.definitionRevision, renamed.definitionRevision);
  assert.notEqual(base.definitionRevision, changedUrl.definitionRevision);
  assert.equal(definitionRevisionFor(base.request), base.definitionRevision);
});

test('the presentation snapshot without observations validates against the enabled configuration', async () => {
  const sites = presentationSites(await loadFixture());
  const snapshot = buildSnapshot({ generatedAt: '2026-10-17T12:00:00.000Z', runKey: null, historyResetReason: null, sites });
  assert.equal(validateSnapshot(snapshot, { expectedSites: sites }), snapshot);
});

test('configuration errors are typed', () => {
  assert.throws(() => normalizeSites({}), ConfigurationError);
});
