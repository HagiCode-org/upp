// Shared public contract for the release-hash snapshot. The check script, the build-time loader and
// the page all import this module, so classification, registry checks and snapshot validation have
// exactly one definition.
import { readFile } from 'node:fs/promises';

export const RELEASE_HASH_SCHEMA_VERSION = 1;
export const RELEASE_STATES = Object.freeze(['match', 'mismatch', 'unknown']);
export const RELEASE_SUMMARY_STATES = Object.freeze(['no-data', 'abnormal', 'incomplete', 'normal']);
export const RELEASE_REASONS = Object.freeze([
  'github-not-found',
  'github-forbidden',
  'github-rate-limited',
  'github-error',
  'github-invalid-response',
  'metadata-not-found',
  'metadata-http-error',
  'metadata-invalid',
  'metadata-commit-unknown',
  'too-large',
  'timeout',
  'dns',
  'tls',
  'redirect',
  'network',
  'not-checked',
]);

// A published commit may be abbreviated, but only from seven characters, as `git` itself does.
export const MIN_ABBREVIATED_HASH = 7;

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const HEX_HASH = /^[0-9a-f]{1,64}$/;
const MAIN_HASH = /^[0-9a-f]{40}$/;
const PUBLISHED_HASH = /^[0-9a-f]{7,64}$/;
const UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

export class ReleaseHashDataError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ReleaseHashDataError';
  }
}

function fail(message) {
  throw new ReleaseHashDataError(message);
}

function requireObject(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  return value;
}

function requireString(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    fail(`${label} must be a non-empty string`);
  }
  return value;
}

function requireArray(value, label) {
  if (!Array.isArray(value)) {
    fail(`${label} must be an array`);
  }
  return value;
}

// Rejects impossible dates such as 02-31, which Date.parse would otherwise roll over.
function requireUtc(value, label) {
  const ms = typeof value === 'string' && UTC_TIMESTAMP.test(value) ? Date.parse(value) : Number.NaN;
  if (Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 19) !== value.slice(0, 19)) {
    fail(`${label} must be a UTC ISO-8601 timestamp ending in Z`);
  }
  return ms;
}

// Lowercases and trims a commit reference. Anything that is not hexadecimal yields null.
export function normalizeHash(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const hash = value.trim().toLowerCase();
  return HEX_HASH.test(hash) ? hash : null;
}

// Both hashes present: equal, or a published prefix of at least seven characters, is a match.
// A missing side is unknown, and nothing is inferred from it.
export function classify(mainHash, publishedHash) {
  const main = normalizeHash(mainHash);
  const published = normalizeHash(publishedHash);
  if (main === null || published === null) {
    return 'unknown';
  }
  if (main === published) {
    return 'match';
  }
  if (published.length >= MIN_ABBREVIATED_HASH && main.startsWith(published)) {
    return 'match';
  }
  return 'mismatch';
}

// Checks every entry before any request is sent. Origins must be exactly `https://host[:port]`.
export function validateRegistry(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    fail('the release registry must be a non-empty array');
  }
  const ids = new Set();
  return entries.map((raw, index) => {
    const label = `registry[${index}]`;
    requireObject(raw, label);
    if (typeof raw.id !== 'string' || !ID_PATTERN.test(raw.id)) {
      fail(`${label}.id must be a lowercase identifier`);
    }
    if (ids.has(raw.id)) {
      fail(`duplicate registry id ${raw.id}`);
    }
    ids.add(raw.id);
    const name = requireString(raw.name, `${raw.id}.name`).trim();
    if (typeof raw.repository !== 'string' || !REPOSITORY_PATTERN.test(raw.repository)) {
      fail(`${raw.id}.repository must be owner/name`);
    }
    if (raw.branch !== 'main') {
      fail(`${raw.id}.branch must be main`);
    }
    let url;
    try {
      url = new URL(raw.origin);
    } catch {
      fail(`${raw.id}.origin is not a valid absolute URL`);
    }
    // `url.origin` drops paths, queries, fragments and credentials, so any difference rejects the value.
    if (url.protocol !== 'https:' || url.origin !== raw.origin) {
      fail(`${raw.id}.origin must be an absolute HTTPS origin without credentials, path, query or fragment`);
    }
    return { id: raw.id, name, repository: raw.repository, branch: 'main', origin: raw.origin };
  });
}

export async function loadRegistry(path) {
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    fail(`release registry cannot be read at ${path}: ${error.code ?? error.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail(`release registry at ${path} is not valid JSON`);
  }
  return validateRegistry(parsed);
}

function unknownResult(entry, reason) {
  return {
    id: entry.id,
    name: entry.name,
    repository: entry.repository,
    branch: entry.branch,
    publicOrigin: entry.origin,
    state: 'unknown',
    mainHash: null,
    publishedHash: null,
    publishedBranch: null,
    publishedBuiltAt: null,
    checkedAt: null,
    reason,
  };
}

// `observations` holds one entry per checked repository. Each carries the hashes it obtained, the
// safe reason for whichever side is missing, and the time it was observed. Classification happens here.
export function buildReleaseSnapshot({ generatedAt, runKey, registry, observations = [] }) {
  const byId = new Map();
  for (const observation of observations) {
    if (byId.has(observation.id)) {
      fail(`duplicate observation for ${observation.id}`);
    }
    byId.set(observation.id, observation);
  }
  const repositories = registry.map((entry) => {
    const observation = byId.get(entry.id);
    if (observation === undefined) {
      return unknownResult(entry, 'not-checked');
    }
    const state = classify(observation.mainHash, observation.publishedHash);
    const missingReason = observation.mainHash ? observation.publishedReason : observation.mainReason;
    return {
      ...unknownResult(entry, null),
      state,
      mainHash: observation.mainHash ?? null,
      publishedHash: observation.publishedHash ?? null,
      publishedBranch: observation.publishedBranch ?? null,
      publishedBuiltAt: observation.publishedBuiltAt ?? null,
      checkedAt: observation.checkedAt,
      reason: state === 'unknown' ? missingReason ?? null : null,
    };
  });
  return validateReleaseSnapshot({ schemaVersion: RELEASE_HASH_SCHEMA_VERSION, generatedAt, runKey, repositories }, { registry });
}

// Validates a snapshot against the registry. A snapshot with a runKey is a completed check; without one it is
// the explicit no-data state, in which every repository is `not-checked`.
export function validateReleaseSnapshot(snapshot, { registry }) {
  requireObject(snapshot, 'snapshot');
  if (snapshot.schemaVersion !== RELEASE_HASH_SCHEMA_VERSION) {
    fail(`unsupported release-hash schemaVersion ${JSON.stringify(snapshot.schemaVersion)}`);
  }
  const generatedMs = requireUtc(snapshot.generatedAt, 'generatedAt');
  if (snapshot.runKey !== null) {
    requireString(snapshot.runKey, 'runKey');
  }
  const repositories = requireArray(snapshot.repositories, 'repositories');
  const expectedIds = registry.map((entry) => entry.id);
  const actualIds = repositories.map((item) => item?.id);
  if (actualIds.length !== expectedIds.length || actualIds.some((id, index) => id !== expectedIds[index])) {
    fail('snapshot repositories must list each registry id exactly once, in registry order');
  }

  repositories.forEach((repo, index) => {
    const entry = registry[index];
    const label = `repositories[${index}]`;
    requireObject(repo, label);
    if (repo.name !== entry.name || repo.repository !== entry.repository
      || repo.branch !== entry.branch || repo.publicOrigin !== entry.origin) {
      fail(`${label} does not match its registry entry ${entry.id}`);
    }
    if (!RELEASE_STATES.includes(repo.state)) {
      fail(`${label}.state must be one of ${RELEASE_STATES.join(', ')}`);
    }
    if (repo.mainHash !== null && !MAIN_HASH.test(repo.mainHash)) {
      fail(`${label}.mainHash must be null or a 40-character lowercase commit`);
    }
    if (repo.publishedHash !== null && !PUBLISHED_HASH.test(repo.publishedHash)) {
      fail(`${label}.publishedHash must be null or 7 to 64 lowercase hexadecimal characters`);
    }
    if (repo.publishedBranch !== null) {
      requireString(repo.publishedBranch, `${label}.publishedBranch`);
    }
    if (repo.publishedBuiltAt !== null) {
      requireUtc(repo.publishedBuiltAt, `${label}.publishedBuiltAt`);
    }
    if (repo.reason !== null && !RELEASE_REASONS.includes(repo.reason)) {
      fail(`${label}.reason is not a supported category`);
    }
    if (repo.checkedAt !== null) {
      const checkedMs = requireUtc(repo.checkedAt, `${label}.checkedAt`);
      if (checkedMs > generatedMs) {
        fail(`${label}.checkedAt is later than generatedAt`);
      }
    }
    if (repo.state !== classify(repo.mainHash, repo.publishedHash)) {
      fail(`${label}.state ${repo.state} disagrees with its hashes`);
    }

    if (repo.reason === 'not-checked') {
      const empty = repo.mainHash === null && repo.publishedHash === null
        && repo.publishedBranch === null && repo.publishedBuiltAt === null && repo.checkedAt === null;
      if (snapshot.runKey !== null || !empty) {
        fail(`${label} is not-checked, which is valid only in a snapshot without runKey and without observations`);
      }
      return;
    }
    if (snapshot.runKey === null) {
      fail('a snapshot without runKey must contain only not-checked results');
    }
    if (repo.checkedAt === null) {
      fail(`${label} is an observed result and needs checkedAt`);
    }
    if (repo.state === 'unknown') {
      if (repo.reason === null) {
        fail(`${label} is unknown without a reason`);
      }
    } else if (repo.reason !== null) {
      fail(`${label} is ${repo.state} and must not carry a reason`);
    }
  });
  return snapshot;
}

// Overall state by precedence: abnormal (any mismatch), incomplete (any unknown), normal (all match).
export function summarizeReleaseHashes(snapshot) {
  const counts = { total: 0, match: 0, mismatch: 0, unknown: 0 };
  for (const repo of snapshot.repositories) {
    counts.total += 1;
    counts[repo.state] += 1;
  }
  let state = 'normal';
  if (snapshot.runKey === null) {
    state = 'no-data';
  } else if (counts.mismatch > 0) {
    state = 'abnormal';
  } else if (counts.unknown > 0) {
    state = 'incomplete';
  }
  return { state, counts };
}

// Presentation order: mismatches first, then unknowns, then matches. Registry order holds inside each group.
export function orderForDisplay(repositories) {
  const rank = { mismatch: 0, unknown: 1, match: 2 };
  return repositories
    .map((repo, index) => ({ repo, index }))
    .sort((left, right) => rank[left.repo.state] - rank[right.repo.state] || left.index - right.index)
    .map(({ repo }) => repo);
}
