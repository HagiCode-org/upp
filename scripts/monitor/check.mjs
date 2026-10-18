// Bounded HTTP checker. Secrets and request details stay inside this module:
// callers receive only the sample produced from the final attempt.
import { toUtcTimestamp } from '../../src/lib/status.mjs';

export const DEFAULT_TIMEOUT_MS = 10_000;
export const DEFAULT_MAX_ATTEMPTS = 2;
export const DEFAULT_CONCURRENCY = 4;
export const MAX_REDIRECTS = 10;
export const SUPPORTED_METHODS = Object.freeze(['GET', 'HEAD']);

export class RunnerError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RunnerError';
  }
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const DNS_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'EAI_NONAME', 'EAI_FAIL']);
const TLS_CODE_PATTERN = /CERT|TLS|SSL|SELF_SIGNED|UNABLE_TO_VERIFY/;

export function isAccepted(httpStatus, acceptedStatuses) {
  if (acceptedStatuses) {
    return acceptedStatuses.includes(httpStatus);
  }
  return httpStatus >= 200 && httpStatus <= 299;
}

// Header values are resolved from the environment only at probe time.
// The unresolved definition (secret names only) is what the revision digest covers.
export function resolveHeaders(headerRefs, env) {
  const headers = {};
  for (const { name, secret } of headerRefs) {
    const value = env[secret];
    if (typeof value !== 'string' || value.length === 0) {
      throw new RunnerError(`secret ${secret} is not set for a configured header`);
    }
    headers[name] = value;
  }
  return headers;
}

function errorCodes(error) {
  const codes = [];
  let current = error;
  for (let depth = 0; current && depth < 4; depth += 1) {
    if (typeof current.code === 'string') {
      codes.push(current.code);
    }
    current = current.cause;
  }
  return codes;
}

export function categorizeFailure(error) {
  const codes = errorCodes(error);
  if (codes.some((code) => code.startsWith('UND_ERR_') && code.includes('TIMEOUT'))) {
    return 'timeout';
  }
  if (codes.some((code) => DNS_CODES.has(code))) {
    return 'dns';
  }
  if (codes.some((code) => TLS_CODE_PATTERN.test(code))) {
    return 'tls';
  }
  return 'network';
}

async function discardBody(response) {
  try {
    await response.body?.cancel();
  } catch {
    // The body is never read; a failed cancel only means the socket is already closed.
  }
}

function withoutSecretHeaders() {
  return {};
}

async function bodyContains(response, text) {
  if (!response.body) return false;
  const decoder = new TextDecoder();
  let tail = '';
  // Retain only enough text to match across chunks; never store the response body.
  for await (const chunk of response.body) {
    const content = tail + decoder.decode(chunk, { stream: true });
    if (content.includes(text)) return true;
    tail = text.length > 1 ? content.slice(-(text.length - 1)) : '';
  }
  return (tail + decoder.decode()).includes(text);
}

// One attempt covers the whole request, including redirects, under a single timeout.
async function attemptOnce(request, headers, runtime) {
  const checkedAt = runtime.now();
  const started = runtime.clock();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), request.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const abortOnRunBudget = () => controller.abort();
  runtime.signal?.addEventListener('abort', abortOnRunBudget, { once: true });

  const failure = (failureCategory, httpStatus = null, responseTimeMs = null) => ({
    ok: false,
    checkedAt,
    httpStatus,
    responseTimeMs,
    failureCategory,
  });

  try {
    let url = request.url;
    let currentHeaders = headers;
    let origin = new URL(url).origin;
    for (let hops = 0; ; hops += 1) {
      const response = await runtime.fetch(url, {
        method: request.method,
        headers: currentHeaders,
        redirect: 'manual',
        signal: controller.signal,
      });
      const explicitlyAccepted = request.acceptedStatuses?.includes(response.status) ?? false;
      if (REDIRECT_STATUSES.has(response.status) && !explicitlyAccepted) {
        await discardBody(response);
        if (hops >= MAX_REDIRECTS) {
          return failure('redirect');
        }
        let next;
        try {
          const location = response.headers.get('location');
          if (!location) {
            return failure('redirect');
          }
          next = new URL(location, url);
        } catch {
          return failure('redirect');
        }
        if (next.protocol !== 'https:' && next.protocol !== 'http:') {
          return failure('redirect');
        }
        if (next.origin !== origin) {
          // Authentication headers never travel to a different origin.
          currentHeaders = withoutSecretHeaders();
          origin = next.origin;
        }
        url = next.href;
        continue;
      }

      const responseTimeMs = runtime.clock() - started;
      if (!isAccepted(response.status, request.acceptedStatuses)) {
        await discardBody(response);
        return failure('unexpected-status', response.status, responseTimeMs);
      }
      if (request.requiredBodyText !== undefined) {
        if (!await bodyContains(response, request.requiredBodyText)) {
          return failure('missing-body-text', response.status, responseTimeMs);
        }
      } else {
        await discardBody(response);
      }
      return { ok: true, checkedAt, httpStatus: response.status, responseTimeMs, failureCategory: null };
    }
  } catch (error) {
    if (runtime.signal?.aborted) {
      throw new RunnerError('the run budget was exhausted before this target finished');
    }
    if (controller.signal.aborted) {
      return failure('timeout');
    }
    return failure(categorizeFailure(error));
  } finally {
    clearTimeout(timer);
    runtime.signal?.removeEventListener('abort', abortOnRunBudget);
  }
}

// Returns the single final observation for one target and execution.
export async function checkTarget(target, runtime) {
  const { request } = target;
  const headers = resolveHeaders(request.headers, runtime.env);
  const maxAttempts = request.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  let last = null;
  let attempts = 0;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    attempts = attempt;
    last = await attemptOnce(request, headers, runtime);
    if (last.ok) {
      break;
    }
  }
  return {
    runKey: runtime.runKey,
    siteId: target.id,
    definitionRevision: target.definitionRevision,
    checkedAt: toUtcTimestamp(last.checkedAt),
    status: last.ok ? 'up' : 'down',
    httpStatus: last.httpStatus,
    responseTimeMs: last.responseTimeMs === null ? null : Math.round(last.responseTimeMs),
    attempts,
    failureCategory: last.failureCategory,
  };
}

// Checks every target with bounded concurrency. A slow or failing target yields its own
// observation and never stops the others; only runner errors abort the batch.
export async function checkTargets(targets, runtime, { concurrency = DEFAULT_CONCURRENCY } = {}) {
  const results = new Array(targets.length);
  let nextIndex = 0;
  let runnerError = null;
  const worker = async () => {
    while (nextIndex < targets.length && runnerError === null) {
      const index = nextIndex;
      nextIndex += 1;
      try {
        results[index] = await checkTarget(targets[index], runtime);
      } catch (error) {
        runnerError ??= error;
      }
    }
  };
  const workers = Array.from({ length: Math.min(concurrency, targets.length) }, worker);
  await Promise.all(workers);
  if (runnerError) {
    throw runnerError;
  }
  return results;
}

export function createRuntime({
  fetch: fetchImpl = globalThis.fetch,
  env = process.env,
  now = Date.now,
  clock = () => performance.now(),
  runKey,
  signal,
} = {}) {
  return { fetch: fetchImpl, env, now, clock, runKey, signal };
}
