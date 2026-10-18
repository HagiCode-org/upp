import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { ReleaseHashDataError, loadRegistry, validateRegistry } from '../../src/lib/release-hash.mjs';
import { REGISTRY_PATH } from './support.mjs';

const registry = JSON.parse(await readFile(REGISTRY_PATH, 'utf8'));
const entry = (overrides = {}) => ({
  id: 'example',
  name: 'Example',
  repository: 'HagiCode-org/example',
  branch: 'main',
  origin: 'https://example.hagicode.com',
  ...overrides,
});

test('the registry lists the 14 compared repositories with unique ids', async () => {
  const loaded = await loadRegistry(REGISTRY_PATH);
  assert.equal(loaded.length, 14);
  assert.equal(new Set(loaded.map((item) => item.id)).size, 14);
  assert.ok(loaded.every((item) => item.branch === 'main'));
});

test('awesome-site publishes at its own origin and docker-compose-builder maps to its GitHub repository', () => {
  const byId = new Map(registry.map((item) => [item.id, item]));
  assert.equal(byId.get('awesome-site').origin, 'https://awesome.hagicode.com');
  assert.equal(byId.get('docker-compose-builder').repository, 'HagiCode-org/docker-compose-builder');
  assert.equal(byId.get('site').origin, 'https://www.hagicode.com');
});

test('every registry origin is an absolute HTTPS origin and every repository is owner/name', () => {
  for (const item of registry) {
    assert.equal(new URL(item.origin).origin, item.origin, item.id);
    assert.equal(new URL(item.origin).protocol, 'https:', item.id);
    assert.match(item.repository, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, item.id);
  }
});

test('a valid entry is accepted and its name is trimmed', () => {
  const [accepted] = validateRegistry([entry({ name: '  Example  ' })]);
  assert.equal(accepted.name, 'Example');
});

test('duplicate identities are rejected before any request', () => {
  assert.throws(() => validateRegistry([entry(), entry()]), /duplicate registry id example/);
});

test('a malformed repository name is rejected', () => {
  assert.throws(() => validateRegistry([entry({ repository: 'example' })]), ReleaseHashDataError);
  assert.throws(() => validateRegistry([entry({ repository: 'a/b/c' })]), /owner\/name/);
});

test('origins that are not exact HTTPS origins are rejected', () => {
  const rejected = [
    'http://example.hagicode.com',
    'https://example.hagicode.com/',
    'https://example.hagicode.com/path',
    'https://example.hagicode.com?x=1',
    'https://example.hagicode.com#top',
    'https://user:secret@example.hagicode.com',
    'https://Example.hagicode.com',
    'not a url',
  ];
  for (const origin of rejected) {
    assert.throws(() => validateRegistry([entry({ origin })]), ReleaseHashDataError, origin);
  }
});

test('the branch is fixed to main and the registry cannot be empty', () => {
  assert.throws(() => validateRegistry([entry({ branch: 'master' })]), /branch must be main/);
  assert.throws(() => validateRegistry([]), /non-empty array/);
});

test('an unreadable or non-JSON registry file fails with the registry error', async () => {
  await assert.rejects(loadRegistry('/nonexistent/release-repositories.json'), ReleaseHashDataError);
});
