// Shared helpers for the release-hash tests. Nothing here touches the network: every request goes to a fake fetch.
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';

export const ROOT = resolve(import.meta.dirname, '..', '..');
export const REGISTRY_PATH = join(ROOT, 'src', 'data', 'release-repositories.json');
export const FIXTURES = join(ROOT, 'tests', 'fixtures', 'release-hash');
export const GENERATED_AT = '2026-10-17T09:35:02.114Z';
export const CHECKED_AT = '2026-10-17T09:35:01.000Z';

// Deterministic 40-character lowercase hash for a label.
export function hashFor(label) {
  return createHash('sha1').update(label).digest('hex');
}

export function mainHashFor(entry) {
  return hashFor(`main:${entry.id}`);
}

export function metadataBody({ commit, branch = 'main', builtAt = '2026-10-17T09:00:00Z', schemaVersion = 1 } = {}) {
  return JSON.stringify({ schemaVersion, build: { branch, commit, builtAt } });
}

// A request that only ends when its signal aborts, which is how a hung connection behaves.
export function hangUntilAborted(url, init) {
  return new Promise((_, reject) => {
    const fail = () => reject(new DOMException('aborted', 'AbortError'));
    if (init.signal.aborted) {
      fail();
    } else {
      init.signal.addEventListener('abort', fail, { once: true });
    }
  });
}

export function networkError(code) {
  return Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(code), { code }) });
}

// Fake fetch that records every call and the peak number of requests in flight.
export function fakeFetch(handler) {
  const calls = [];
  let inFlight = 0;
  let peak = 0;
  const fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    try {
      return await handler(String(url), init);
    } finally {
      inFlight -= 1;
    }
  };
  return { fetch, calls, peakInFlight: () => peak };
}

// A healthy web: every GitHub head equals the site's published commit unless a case overrides it.
export function healthyWeb(registry, { publishedFor = mainHashFor } = {}) {
  return async (url) => {
    const github = registry.find((entry) => url === `https://api.github.com/repos/${entry.repository}/commits/${entry.branch}`);
    if (github) {
      return new Response(mainHashFor(github), { status: 200 });
    }
    const site = registry.find((entry) => url === `${entry.origin}/.well-known/hagilight.metadata.json`);
    if (site) {
      return new Response(metadataBody({ commit: publishedFor(site) }), { status: 200 });
    }
    return new Response('unexpected request', { status: 500 });
  };
}

// One observation per registry entry, in registry order. `overrides` replaces fields for named ids.
export function observationsFor(registry, overrides = {}) {
  return registry.map((entry) => {
    const main = mainHashFor(entry);
    return {
      id: entry.id,
      mainHash: main,
      mainReason: null,
      publishedHash: main,
      publishedBranch: 'main',
      publishedBuiltAt: '2026-10-17T09:12:00Z',
      publishedReason: null,
      checkedAt: CHECKED_AT,
      ...overrides[entry.id],
    };
  });
}
