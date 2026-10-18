import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { MAX_METADATA_BYTES, fetchMainHash, fetchPublishedHash } from '../../scripts/release-hash/fetch.mjs';
import { REGISTRY_PATH, fakeFetch, hangUntilAborted as hang, hashFor, metadataBody, networkError } from './support.mjs';

const registry = JSON.parse(await readFile(REGISTRY_PATH, 'utf8'));
const docs = registry.find((entry) => entry.id === 'docs');
const MAIN = hashFor('fetch-main');
const GITHUB_URL = 'https://api.github.com/repos/HagiCode-org/docs/commits/main';
const SITE_URL = 'https://docs.hagicode.com/.well-known/hagilight.metadata.json';
const respond = (body = '', init = {}) => new Response(body, { status: 200, ...init });
const reasonOf = (status, headers = {}) => fakeFetch(async () => respond('', { status, headers }));
// Only the hash and reason are meaningful for the main-branch fetch.
const mainResult = async (options) => {
  const { hash, reason } = await fetchMainHash(docs, options);
  return { hash, reason };
};

test('a GitHub head is returned as the 40-character commit with the sha media type and no redirects', async () => {
  const web = fakeFetch(async () => respond(`${MAIN}\n`));
  const result = await fetchMainHash(docs, { fetch: web.fetch });
  assert.deepEqual(result, { hash: MAIN, reason: null });
  const [call] = web.calls;
  assert.equal(call.url, GITHUB_URL);
  assert.equal(call.init.redirect, 'manual');
  assert.equal(call.init.headers.accept, 'application/vnd.github.sha');
});

test('the token is attached only to the GitHub request, and only when it is set', async () => {
  const withToken = fakeFetch(async () => respond(MAIN));
  await fetchMainHash(docs, { fetch: withToken.fetch, token: 'ghs_test' });
  assert.equal(withToken.calls[0].init.headers.authorization, 'Bearer ghs_test');

  const withoutToken = fakeFetch(async () => respond(MAIN));
  await fetchMainHash(docs, { fetch: withoutToken.fetch });
  assert.equal(withoutToken.calls[0].init.headers.authorization, undefined);
});

test('GitHub status codes map to their reason categories', async () => {
  const cases = [
    [404, {}, 'github-not-found'],
    [401, {}, 'github-forbidden'],
    [403, {}, 'github-forbidden'],
    [403, { 'x-ratelimit-remaining': '0' }, 'github-rate-limited'],
    [403, { 'retry-after': '60' }, 'github-rate-limited'],
    [429, {}, 'github-rate-limited'],
    [500, {}, 'github-error'],
  ];
  for (const [status, headers, reason] of cases) {
    const web = reasonOf(status, headers);
    assert.deepEqual(await mainResult({ fetch: web.fetch }), { hash: null, reason }, `${status} ${JSON.stringify(headers)}`);
  }
});

test('a GitHub redirect is never followed and is reported as an error', async () => {
  const web = reasonOf(301, { location: 'https://api.github.com/repositories/1/commits/main' });
  assert.deepEqual(await mainResult({ fetch: web.fetch }), { hash: null, reason: 'github-error' });
  assert.equal(web.calls.length, 1);
});

test('bad GitHub bodies are invalid responses, including an oversized one', async () => {
  const bodies = ['not-a-commit', 'A'.repeat(40), `${MAIN}00`, 'x'.repeat(5000)];
  for (const body of bodies) {
    const web = fakeFetch(async () => respond(body));
    assert.deepEqual(await mainResult({ fetch: web.fetch }), { hash: null, reason: 'github-invalid-response' });
  }
});

test('a DNS failure and a hung request map to dns and timeout', async () => {
  const dns = fakeFetch(async () => { throw networkError('ENOTFOUND'); });
  assert.deepEqual(await mainResult({ fetch: dns.fetch }), { hash: null, reason: 'dns' });
  const hung = fakeFetch(hang);
  assert.deepEqual(await mainResult({ fetch: hung.fetch, timeoutMs: 20 }), { hash: null, reason: 'timeout' });
});

test('the published commit is lowercased and build branch and time are kept when present', async () => {
  const web = fakeFetch(async () => respond(metadataBody({ commit: 'A1B2C3D4E5F6', branch: 'main', builtAt: '2026-10-17T09:00:00Z' })));
  const result = await fetchPublishedHash(docs, { fetch: web.fetch });
  assert.deepEqual(result, { hash: 'a1b2c3d4e5f6', branch: 'main', builtAt: '2026-10-17T09:00:00Z', reason: null });
  assert.equal(web.calls[0].url, SITE_URL);
  assert.equal(web.calls[0].init.headers['cache-control'], 'no-cache');
});

test('a short published commit is accepted and malformed build metadata is dropped, not fatal', async () => {
  const web = fakeFetch(async () => respond(metadataBody({ commit: 'a1b2c3d', branch: 'bad branch with spaces', builtAt: 'yesterday' })));
  const result = await fetchPublishedHash(docs, { fetch: web.fetch });
  assert.equal(result.hash, 'a1b2c3d');
  assert.equal(result.branch, null);
  assert.equal(result.builtAt, null);
});

test('the unknown commit, wrong schema, non-JSON and malformed commit are classified as published-side reasons', async () => {
  const cases = [
    [metadataBody({ commit: 'unknown' }), 'metadata-commit-unknown'],
    [metadataBody({ commit: 'UNKNOWN' }), 'metadata-commit-unknown'],
    [metadataBody({ commit: 'a1b2c3d', schemaVersion: 2 }), 'metadata-invalid'],
    [metadataBody({ commit: 'a1b2c3g' }), 'metadata-invalid'],
    [metadataBody({ commit: 'a1b2c3' }), 'metadata-invalid'],
    ['<html>not json</html>', 'metadata-invalid'],
    ['null', 'metadata-invalid'],
  ];
  for (const [body, reason] of cases) {
    const web = fakeFetch(async () => respond(body));
    assert.deepEqual(await fetchPublishedHash(docs, { fetch: web.fetch }), { hash: null, branch: null, builtAt: null, reason }, body);
  }
});

test('a 404 and other non-success statuses map to metadata reasons', async () => {
  const notFound = reasonOf(404);
  assert.equal((await fetchPublishedHash(docs, { fetch: notFound.fetch })).reason, 'metadata-not-found');
  const serverError = reasonOf(503);
  assert.equal((await fetchPublishedHash(docs, { fetch: serverError.fetch })).reason, 'metadata-http-error');
});

test('a 200 HTML fallback page is reported as not found, whatever its size or content', async () => {
  const html = { 'content-type': 'text/html; charset=utf-8' };
  const bodies = ['<!doctype html><html></html>', metadataBody({ commit: 'a1b2c3d' }), 'x'.repeat(MAX_METADATA_BYTES + 1)];
  for (const body of bodies) {
    const web = fakeFetch(async () => respond(body, { headers: html }));
    assert.deepEqual(await fetchPublishedHash(docs, { fetch: web.fetch }), { hash: null, branch: null, builtAt: null, reason: 'metadata-not-found' });
  }
  const declared = fakeFetch(async () => respond('', { headers: { ...html, 'content-length': String(MAX_METADATA_BYTES + 1) } }));
  assert.equal((await fetchPublishedHash(docs, { fetch: declared.fetch })).reason, 'metadata-not-found');
});

test('an oversized metadata body is rejected at the byte cap and never kept', async () => {
  const oversized = 'x'.repeat(MAX_METADATA_BYTES + 1);
  const web = fakeFetch(async () => respond(oversized));
  const result = await fetchPublishedHash(docs, { fetch: web.fetch });
  assert.deepEqual(result, { hash: null, branch: null, builtAt: null, reason: 'too-large' });
  const declared = fakeFetch(async () => respond('', { headers: { 'content-length': String(MAX_METADATA_BYTES + 1) } }));
  assert.equal((await fetchPublishedHash(docs, { fetch: declared.fetch })).reason, 'too-large');
});

test('endless redirects stop after five followed hops', async () => {
  const web = fakeFetch(async () => respond('', { status: 302, headers: { location: 'https://docs.hagicode.com/loop' } }));
  assert.deepEqual(await fetchPublishedHash(docs, { fetch: web.fetch }), { hash: null, branch: null, builtAt: null, reason: 'redirect' });
  assert.equal(web.calls.length, 6);
});

test('an HTTPS redirect is followed, and an HTTP redirect is refused', async () => {
  const followed = fakeFetch(async (url) => (url === SITE_URL
    ? respond('', { status: 301, headers: { location: 'https://docs.hagicode.com/moved/meta.json' } })
    : respond(metadataBody({ commit: 'a1b2c3d4' }))));
  assert.equal((await fetchPublishedHash(docs, { fetch: followed.fetch })).hash, 'a1b2c3d4');
  assert.equal(followed.calls.length, 2);

  const downgraded = fakeFetch(async () => respond('', { status: 301, headers: { location: 'http://docs.hagicode.com/meta.json' } }));
  assert.equal((await fetchPublishedHash(docs, { fetch: downgraded.fetch })).reason, 'redirect');
  assert.equal(downgraded.calls.length, 1);
});

test('network failures on the site map to their transport categories', async () => {
  const tls = fakeFetch(async () => { throw networkError('UNABLE_TO_VERIFY_LEAF_SIGNATURE'); });
  assert.equal((await fetchPublishedHash(docs, { fetch: tls.fetch })).reason, 'tls');
  const hung = fakeFetch(hang);
  assert.equal((await fetchPublishedHash(docs, { fetch: hung.fetch, timeoutMs: 20 })).reason, 'timeout');
});

test('the Authorization header never reaches a site origin, even when a GitHub token is set', async () => {
  const web = fakeFetch(async () => respond(metadataBody({ commit: 'a1b2c3d4' })));
  await fetchPublishedHash(docs, { fetch: web.fetch });
  for (const call of web.calls) {
    assert.equal(call.init.headers.authorization, undefined);
  }
});
