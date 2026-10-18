// Adapts the existing site manifest into normalized monitor targets.
// Presentation reads never resolve secrets; monitoring reads resolve only the secrets that enabled targets reference.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import { toPublicUrl } from '../../src/lib/status.mjs';
import { SUPPORTED_METHODS, DEFAULT_TIMEOUT_MS, DEFAULT_MAX_ATTEMPTS } from './check.mjs';

export const SUPPORTED_SITE_KEYS = Object.freeze([
  'name',
  'url',
  'slug',
  'method',
  'expectedStatusCodes',
  'headers',
  'timeoutMs',
  'maxAttempts',
  'enabled',
  '__dangerous__body_down_if_text_missing',
]);
export const MAX_TIMEOUT_MS = 30_000;
export const MAX_ATTEMPTS_LIMIT = 3;
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
const HEADER_NAME_PATTERN = /^[A-Za-z0-9-]+$/;
const SECRET_NAME_PATTERN = /^[A-Z_][A-Z0-9_]*$/;

export class ConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigurationError';
  }
}

function fail(message) {
  throw new ConfigurationError(message);
}

function slugify(name) {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63);
}

function normalizeHeaders(value, label) {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    fail(`${label}.headers must be a list of { name, secret } references`);
  }
  return value.map((item, index) => {
    if (item === null || typeof item !== 'object' || typeof item.name !== 'string' || typeof item.secret !== 'string') {
      fail(`${label}.headers[${index}] must have a name and a secret reference`);
    }
    if (!HEADER_NAME_PATTERN.test(item.name)) {
      fail(`${label}.headers[${index}].name is not a valid header name`);
    }
    if (!SECRET_NAME_PATTERN.test(item.secret)) {
      fail(`${label}.headers[${index}].secret must name an environment variable`);
    }
    return { name: item.name.toLowerCase(), secret: item.secret };
  });
}

function normalizeAcceptedStatuses(value, label) {
  if (value === undefined) {
    return null;
  }
  if (!Array.isArray(value) || value.length === 0) {
    fail(`${label}.expectedStatusCodes must be a nonempty list of status codes`);
  }
  for (const code of value) {
    if (!Number.isInteger(code) || code < 100 || code > 599) {
      fail(`${label}.expectedStatusCodes contains an invalid status code`);
    }
  }
  return [...new Set(value)].sort((left, right) => left - right);
}

function boundedInteger(value, label, min, max, fallback) {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isInteger(value) || value < min || value > max) {
    fail(`${label} must be an integer from ${min} to ${max}`);
  }
  return value;
}

// The revision covers only the unresolved request definition, so display names, ordering and
// secret values never start a new series. Secret names are included; secret values never are.
export function definitionRevisionFor(request) {
  const canonical = JSON.stringify({
    method: request.method,
    url: request.url,
    acceptedStatuses: request.acceptedStatuses,
    headers: request.headers.map(({ name, secret }) => ({ name, secret })),
    timeoutMs: request.timeoutMs,
    maxAttempts: request.maxAttempts,
    ...(request.requiredBodyText === undefined ? {} : { requiredBodyText: request.requiredBodyText }),
  });
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

export function normalizeSites(manifest) {
  if (manifest === null || typeof manifest !== 'object' || !Array.isArray(manifest.sites)) {
    fail('the site manifest must contain a sites list');
  }
  const ids = new Set();
  const targets = [];
  for (const [index, raw] of manifest.sites.entries()) {
    const label = `sites[${index}]`;
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      fail(`${label} must be an object`);
    }
    for (const key of Object.keys(raw)) {
      if (!SUPPORTED_SITE_KEYS.includes(key)) {
        fail(`${label}.${key} is a check-affecting setting this monitor does not support`);
      }
    }
    if (typeof raw.name !== 'string' || raw.name.trim().length === 0) {
      fail(`${label}.name must be a non-empty string`);
    }
    const id = raw.slug ?? slugify(raw.name);
    if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
      fail(`${label} has no valid identity; set slug to a lowercase identifier`);
    }
    if (ids.has(id)) {
      fail(`duplicate site identity ${id}`);
    }
    ids.add(id);

    if (typeof raw.url !== 'string') {
      fail(`${label}.url must be a string`);
    }
    let url;
    try {
      url = new URL(raw.url);
    } catch {
      fail(`${label}.url is not a valid absolute URL`);
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      fail(`${label}.url must use HTTP or HTTPS`);
    }
    if (url.username || url.password) {
      fail(`${label}.url must not embed credentials; use a header secret reference`);
    }

    const method = (raw.method ?? 'GET').toUpperCase();
    if (!SUPPORTED_METHODS.includes(method)) {
      fail(`${label}.method must be one of ${SUPPORTED_METHODS.join(', ')}`);
    }
    const requiredBodyText = raw.__dangerous__body_down_if_text_missing;
    if (requiredBodyText !== undefined &&
        (typeof requiredBodyText !== 'string' || requiredBodyText.length === 0 || method === 'HEAD')) {
      fail(`${label}.__dangerous__body_down_if_text_missing must be a nonempty string with GET`);
    }
    const request = {
      method,
      ...(requiredBodyText === undefined ? {} : { requiredBodyText }),
      url: url.href,
      headers: normalizeHeaders(raw.headers, label),
      acceptedStatuses: normalizeAcceptedStatuses(raw.expectedStatusCodes, label),
      timeoutMs: boundedInteger(raw.timeoutMs, `${label}.timeoutMs`, 1000, MAX_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
      maxAttempts: boundedInteger(raw.maxAttempts, `${label}.maxAttempts`, 1, MAX_ATTEMPTS_LIMIT, DEFAULT_MAX_ATTEMPTS),
    };
    if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') {
      fail(`${label}.enabled must be true or false`);
    }
    targets.push({
      id,
      name: raw.name.trim(),
      publicUrl: toPublicUrl(url.href),
      definitionRevision: definitionRevisionFor(request),
      enabled: raw.enabled ?? true,
      request,
    });
  }
  return targets;
}

// Presentation-only read: validates names and public links, never resolves secrets.
export function presentationSites(targets) {
  return targets
    .filter((target) => target.enabled)
    .map(({ id, name, publicUrl, definitionRevision }) => ({ id, name, publicUrl, definitionRevision, samples: [] }));
}

// Monitoring read: every enabled target's referenced secrets must be present before probing starts.
export function monitoredTargets(targets, env) {
  const enabled = targets.filter((target) => target.enabled);
  for (const target of enabled) {
    for (const { secret } of target.request.headers) {
      if (typeof env[secret] !== 'string' || env[secret].length === 0) {
        fail(`target ${target.id} references secret ${secret}, which is not set`);
      }
    }
  }
  return enabled;
}

export async function loadManifest(path) {
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    fail(`site manifest cannot be read at ${path}: ${error.code ?? error.message}`);
  }
  let manifest;
  try {
    manifest = parse(text, { uniqueKeys: true });
  } catch (error) {
    fail(`site manifest is not valid YAML: ${error.message}`);
  }
  return normalizeSites(manifest);
}
