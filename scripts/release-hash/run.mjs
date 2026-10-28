// Entry point behind `pnpm run release-check`. Compares each registered repository's main head with the commit
// its site publishes, validates the snapshot, and atomically replaces .monitor-data/release-hash.json.
// Mismatches and unknowns are recorded as data and exit 0. Registry and preflight problems exit 2,
// and validation or write failures exit 1.
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  ReleaseHashDataError,
  buildReleaseSnapshot,
  loadRegistry,
  validateReleaseSnapshot,
} from '../../src/lib/release-hash.mjs';
import { defaultOutputDir, defaultReleaseRegistryPath } from '../../src/lib/paths.mjs';
import { toUtcTimestamp } from '../../src/lib/status.mjs';
import { DEFAULT_REQUEST_TIMEOUT_MS, fetchMainHash, fetchPublishedHash } from './fetch.mjs';

export const DEFAULT_CONCURRENCY = 4;
export const DEFAULT_BUDGET_MS = 120_000;
// One initial attempt plus one retry, and only for transient failures.
export const ATTEMPTS = 2;
const RETRYABLE = new Set(['timeout', 'network']);

export class ReleaseCheckConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ReleaseCheckConfigurationError';
  }
}

export function parseBudgetMs(value) {
  if (value === undefined || value === '') {
    return DEFAULT_BUDGET_MS;
  }
  const ms = Number(value);
  if (!Number.isInteger(ms) || ms <= 0) {
    throw new ReleaseCheckConfigurationError('UPP_RELEASE_CHECK_BUDGET_MS must be a positive whole number of milliseconds');
  }
  return ms;
}

// Worst case: every round of `concurrency` repositories times out on every attempt. It must fit the budget before any request starts.
export function assertBudgetFits(count, { concurrency = DEFAULT_CONCURRENCY, budgetMs = DEFAULT_BUDGET_MS, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS } = {}) {
  const worstCaseMs = Math.ceil(count / concurrency) * ATTEMPTS * timeoutMs;
  if (worstCaseMs > budgetMs) {
    throw new ReleaseCheckConfigurationError(
      `worst-case check time ${worstCaseMs} ms exceeds the budget ${budgetMs} ms; lower UPP_RELEASE_CHECK_BUDGET_MS or the request timeout`,
    );
  }
  return worstCaseMs;
}

async function withRetry(probe) {
  const first = await probe();
  return RETRYABLE.has(first.reason) ? probe() : first;
}

async function checkRepository(entry, { token, fetch, timeoutMs, signal, now }) {
  const [main, published] = await Promise.all([
    withRetry(() => fetchMainHash(entry, { token, fetch, timeoutMs, signal })),
    withRetry(() => fetchPublishedHash(entry, { fetch, timeoutMs, signal })),
  ]);
  return {
    id: entry.id,
    mainHash: main.hash,
    mainReason: main.reason,
    publishedHash: published.hash,
    publishedBranch: published.branch,
    publishedBuiltAt: published.builtAt,
    publishedReason: published.reason,
    checkedAt: toUtcTimestamp(now()),
  };
}

// Bounded concurrency. One repository's failure is already a reason category, so it never stops the others.
async function checkAll(registry, options) {
  const observations = new Array(registry.length);
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < registry.length) {
      const index = nextIndex;
      nextIndex += 1;
      observations[index] = await checkRepository(registry[index], options);
    }
  };
  await Promise.all(Array.from({ length: Math.min(options.concurrency, registry.length) }, worker));
  return observations;
}

// Validation runs before anything is written, and the file appears only after the rename, so a failed run keeps the previous snapshot.
export async function publishReleaseSnapshot({ snapshot, registry, outputDir }) {
  validateReleaseSnapshot(snapshot, { registry });
  await mkdir(outputDir, { recursive: true });
  const path = join(outputDir, 'release-hash.json');
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(snapshot, null, 2)}\n`);
  await rename(temporary, path);
  return path;
}

export async function runReleaseCheck({
  registry,
  env = process.env,
  outputDir = defaultOutputDir(env),
  fetch = globalThis.fetch,
  now = Date.now,
  concurrency = DEFAULT_CONCURRENCY,
  timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  budgetMs = DEFAULT_BUDGET_MS,
  log = () => {},
}) {
  const signal = AbortSignal.timeout(budgetMs);
  const observations = await checkAll(registry, {
    token: env.GITHUB_TOKEN,
    fetch,
    timeoutMs,
    signal,
    now,
    concurrency,
  });
  const runId = env.GITHUB_RUN_ID;
  const runKey = runId ? `${runId}:${env.GITHUB_RUN_ATTEMPT ?? '1'}` : `local:${now()}`;
  const snapshot = buildReleaseSnapshot({
    generatedAt: toUtcTimestamp(now()),
    runKey,
    registry,
    observations,
  });
  await publishReleaseSnapshot({ snapshot, registry, outputDir });
  for (const repo of snapshot.repositories) {
    log(`${repo.name}: ${repo.state}${repo.reason ? ` (${repo.reason})` : ''}`);
  }
  return snapshot;
}

export async function main({ env = process.env, fetch = globalThis.fetch, now = Date.now, log = (line) => console.log(line) } = {}) {
  let registry;
  let budgetMs;
  try {
    budgetMs = parseBudgetMs(env.UPP_RELEASE_CHECK_BUDGET_MS);
    registry = await loadRegistry(defaultReleaseRegistryPath(env));
    assertBudgetFits(registry.length, { budgetMs });
  } catch (error) {
    if (error instanceof ReleaseHashDataError || error instanceof ReleaseCheckConfigurationError) {
      console.error(`${error.name}: ${error.message}`);
      return 2;
    }
    throw error;
  }

  try {
    await runReleaseCheck({ registry, env, fetch, now, budgetMs, log });
    return 0;
  } catch (error) {
    console.error(`${error.name}: ${error.message}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(`${error.name}: ${error.message}`);
      process.exitCode = 1;
    });
}
