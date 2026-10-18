// Bounded fetchers for the release-hash check. Each returns a hash or a safe reason category.
// Response bodies, headers and error text never leave this module.
import { categorizeFailure } from '../monitor/check.mjs';

export const DEFAULT_REQUEST_TIMEOUT_MS = 8_000;
export const MAX_REDIRECTS = 5;
export const MAX_METADATA_BYTES = 64 * 1024;
export const METADATA_PATH = '/.well-known/hagilight.metadata.json';
const MAX_GITHUB_BYTES = 1024;
const GITHUB_API = 'https://api.github.com';
const USER_AGENT = 'hagicode-upp-release-check';
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAIN_HASH = /^[0-9a-f]{40}$/;
const PUBLISHED_COMMIT = /^[0-9a-f]{7,64}$/;
const BUILT_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const BRANCH = /^[\w./-]{1,100}$/;

function failed(reason) {
  return { hash: null, branch: null, builtAt: null, reason };
}

// One request under its own timeout. The same signal also covers the body read, and the whole check's
// signal aborts every request still in flight once the run budget is spent.
function requestScope({ timeoutMs, signal }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const abort = () => controller.abort();
  // A budget that is already spent must not leave a retry waiting for its own timeout.
  if (signal?.aborted) {
    controller.abort();
  }
  signal?.addEventListener('abort', abort, { once: true });
  return {
    signal: controller.signal,
    failureReason: (error) => (controller.signal.aborted ? 'timeout' : categorizeFailure(error)),
    done() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    },
  };
}

async function discard(response) {
  try {
    await response.body?.cancel();
  } catch {
    // The body is never read; a failed cancel only means the socket is already closed.
  }
}

// Reads at most `limit` bytes. An oversized body is cancelled and its content is never kept.
async function readBounded(response, limit) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) {
    await discard(response);
    return null;
  }
  if (!response.body) {
    return '';
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

function githubReason(response) {
  if (response.status === 404) {
    return 'github-not-found';
  }
  if (response.status === 429) {
    return 'github-rate-limited';
  }
  if (response.status === 401) {
    return 'github-forbidden';
  }
  if (response.status === 403) {
    const limited = response.headers.get('x-ratelimit-remaining') === '0' || response.headers.get('retry-after') !== null;
    return limited ? 'github-rate-limited' : 'github-forbidden';
  }
  return 'github-error';
}

// Head commit of `main`. The token is attached to this one request only; redirects are never followed.
export async function fetchMainHash(entry, {
  token,
  fetch: fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  signal,
} = {}) {
  const [owner, repo] = entry.repository.split('/');
  const url = `${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${entry.branch}`;
  const headers = {
    accept: 'application/vnd.github.sha',
    'user-agent': USER_AGENT,
    'x-github-api-version': '2022-11-28',
  };
  if (token) {
    headers.authorization = `Bearer ${token}`;
  }
  const scope = requestScope({ timeoutMs, signal });
  try {
    let response;
    try {
      response = await fetchImpl(url, { method: 'GET', headers, redirect: 'manual', signal: scope.signal });
    } catch (error) {
      return failed(scope.failureReason(error));
    }
    if (response.status < 200 || response.status > 299) {
      await discard(response);
      return failed(githubReason(response));
    }
    let text;
    try {
      text = await readBounded(response, MAX_GITHUB_BYTES);
    } catch (error) {
      return failed(scope.failureReason(error));
    }
    const hash = text?.trim() ?? '';
    return MAIN_HASH.test(hash) ? { hash, reason: null } : failed('github-invalid-response');
  } finally {
    scope.done();
  }
}

function redirectTarget(response, current) {
  const location = response.headers.get('location');
  if (!location) {
    return null;
  }
  try {
    const next = new URL(location, current);
    return next.protocol === 'https:' ? next.href : null;
  } catch {
    return null;
  }
}

function isHtml(response) {
  const type = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
  return type === 'text/html' || type === 'application/xhtml+xml';
}

function parseMetadata(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return failed('metadata-invalid');
  }
  const build = parsed?.build;
  if (parsed === null || typeof parsed !== 'object' || parsed.schemaVersion !== 1 || build === null || typeof build !== 'object') {
    return failed('metadata-invalid');
  }
  const commit = typeof build.commit === 'string' ? build.commit.trim().toLowerCase() : '';
  if (commit === 'unknown') {
    return failed('metadata-commit-unknown');
  }
  if (!PUBLISHED_COMMIT.test(commit)) {
    return failed('metadata-invalid');
  }
  // Branch and build time are display-only, so a value outside the expected shape is dropped rather than failing the check.
  const branch = typeof build.branch === 'string' && BRANCH.test(build.branch.trim()) ? build.branch.trim() : null;
  const builtAt = typeof build.builtAt === 'string' && BUILT_AT.test(build.builtAt) && !Number.isNaN(Date.parse(build.builtAt))
    ? build.builtAt
    : null;
  return { hash: commit, branch, builtAt, reason: null };
}

// Commit published by the live site. Each hop must stay on HTTPS and the total is capped at MAX_REDIRECTS.
export async function fetchPublishedHash(entry, {
  fetch: fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  signal,
} = {}) {
  let url = new URL(METADATA_PATH, entry.origin).href;
  for (let hops = 0; ; hops += 1) {
    const scope = requestScope({ timeoutMs, signal });
    try {
      let response;
      try {
        response = await fetchImpl(url, {
          method: 'GET',
          headers: { 'cache-control': 'no-cache' },
          redirect: 'manual',
          signal: scope.signal,
        });
      } catch (error) {
        return failed(scope.failureReason(error));
      }
      if (REDIRECT_STATUSES.has(response.status)) {
        await discard(response);
        const next = hops < MAX_REDIRECTS ? redirectTarget(response, url) : null;
        if (next === null) {
          return failed('redirect');
        }
        url = next;
        continue;
      }
      if (response.status === 404) {
        await discard(response);
        return failed('metadata-not-found');
      }
      if (response.status < 200 || response.status > 299) {
        await discard(response);
        return failed('metadata-http-error');
      }
      // A missing file is often answered with the site's HTML fallback page and a 200. Treat it as not published
      // before reading the body, so it is not reported as invalid or too large.
      if (isHtml(response)) {
        await discard(response);
        return failed('metadata-not-found');
      }
      let text;
      try {
        text = await readBounded(response, MAX_METADATA_BYTES);
      } catch (error) {
        return failed(scope.failureReason(error));
      }
      return text === null ? failed('too-large') : parseMetadata(text);
    } finally {
      scope.done();
    }
  }
}
