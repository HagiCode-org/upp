// Monitoring entry point: configuration, history restoration, checks, validation and generated checkpoint/public snapshot.
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  buildSnapshot,
  toUtcTimestamp,
  validateCheckpoint,
  validateSnapshot,
} from '../../src/lib/status.mjs';
import { ConfigurationError, loadManifest, monitoredTargets } from './config.mjs';
import { defaultManifestPath, defaultOutputDir } from '../../src/lib/paths.mjs';
import { DEFAULT_CONCURRENCY, checkTargets, createRuntime } from './check.mjs';
import { createGitHubHistoryClient, mergeHistory, restoreCheckpoint, runKeyFor, seriesSamples } from './history.mjs';

export const DEFAULT_RUN_BUDGET_MS = 10 * 60_000;
const ELIGIBLE_EVENTS = Object.freeze(['schedule', 'workflow_dispatch']);

// Preflight: the worst case (every target timing out on every attempt, in rounds of `concurrency`)
// must fit inside the run budget, or the run is refused before any probe starts.
export function assertBudgetFits(targets, { concurrency = DEFAULT_CONCURRENCY, runBudgetMs = DEFAULT_RUN_BUDGET_MS } = {}) {
  if (targets.length === 0) {
    return 0;
  }
  const perTargetMs = Math.max(...targets.map((target) => (target.request.maxAttempts ?? 1) * (target.request.timeoutMs ?? 0)));
  const worstCaseMs = Math.ceil(targets.length / concurrency) * perTargetMs;
  if (worstCaseMs > runBudgetMs) {
    throw new ConfigurationError(
      `worst-case probe time ${worstCaseMs} ms exceeds the run budget ${runBudgetMs} ms; lower targets or timeouts`,
    );
  }
  return worstCaseMs;
}

export function assertEventAllowed({ eventName, refName, defaultBranch }) {
  if (refName !== defaultBranch) {
    throw new ConfigurationError(`monitoring runs only on ${defaultBranch}; this run is on ${refName}`);
  }
  if (!ELIGIBLE_EVENTS.includes(eventName)) {
    throw new ConfigurationError(`event ${eventName} may not write monitoring checkpoints`);
  }
}

export async function runMonitor({
  targets,
  env,
  client = null,
  branch,
  currentRunId = null,
  runKey,
  outputDir,
  fetch: fetchImpl = globalThis.fetch,
  now = Date.now,
  clock = () => performance.now(),
  concurrency = DEFAULT_CONCURRENCY,
  runBudgetMs = DEFAULT_RUN_BUDGET_MS,
  log = () => {},
}) {
  const enabled = monitoredTargets(targets, env);
  assertBudgetFits(enabled, { concurrency, runBudgetMs });

  const restored = client
    ? await restoreCheckpoint({ client, branch, currentRunId })
    : { checkpoint: null, historyResetReason: 'first-run', restoredFromRunKey: null };
  if (!client) {
    log('history restoration skipped: no GitHub client configured');
  }

  const signal = AbortSignal.timeout(runBudgetMs);
  const runtime = createRuntime({ fetch: fetchImpl, env, now, clock, runKey, signal });
  const samples = await checkTargets(enabled, runtime, { concurrency });
  for (const sample of samples) {
    const target = enabled.find((item) => item.id === sample.siteId);
    const detail = sample.failureCategory ? ` (${sample.failureCategory})` : '';
    log(`${target.name}: ${sample.status}${detail}`);
  }

  const generatedAt = toUtcTimestamp(now());
  const checkpoint = mergeHistory({
    restored: restored.checkpoint,
    currentSamples: samples,
    runKey,
    generatedAt,
    historyResetReason: restored.historyResetReason,
  });
  const snapshot = buildSnapshot({
    generatedAt,
    runKey,
    historyResetReason: restored.historyResetReason,
    sites: enabled.map((target) => ({
      id: target.id,
      name: target.name,
      publicUrl: target.publicUrl,
      definitionRevision: target.definitionRevision,
      samples: seriesSamples(checkpoint, target.id, target.definitionRevision),
    })),
  });
  validateSnapshot(snapshot, { expectedSites: enabled });
  validateCheckpoint(checkpoint);

  // Files appear only after every validation has passed, so a failed run never replaces the previous pair.
  await writeJsonAtomic(`${outputDir}/status.json`, snapshot);
  await writeJsonAtomic(`${outputDir}/checkpoint.json`, checkpoint);
  return { snapshot, checkpoint };
}

async function writeJsonAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
  await rename(temporary, path);
}

async function main(env = process.env) {
  const inActions = env.GITHUB_ACTIONS === 'true';
  const defaultBranch = env.UPP_DEFAULT_BRANCH ?? 'main';
  const manifestPath = defaultManifestPath(env);
  const outputDir = defaultOutputDir(env);
  const runBudgetMs = Number(env.UPP_RUN_BUDGET_MS ?? DEFAULT_RUN_BUDGET_MS);
  const concurrency = Number(env.UPP_CONCURRENCY ?? DEFAULT_CONCURRENCY);

  if (inActions) {
    assertEventAllowed({ eventName: env.GITHUB_EVENT_NAME, refName: env.GITHUB_REF_NAME, defaultBranch });
  }
  const targets = await loadManifest(manifestPath);
  monitoredTargets(targets, env);

  const runId = env.GITHUB_RUN_ID ?? null;
  const runAttempt = env.GITHUB_RUN_ATTEMPT ?? '1';
  const runKey = runId ? runKeyFor(runId, runAttempt) : `local:${Date.now()}`;
  let client = null;
  if (inActions) {
    if (!env.GITHUB_TOKEN) {
      throw new ConfigurationError('GITHUB_TOKEN is required to restore checkpoint history in Actions');
    }
    const [owner, repo] = (env.GITHUB_REPOSITORY ?? '').split('/');
    client = createGitHubHistoryClient({ owner, repo, token: env.GITHUB_TOKEN });
  }

  const { snapshot } = await runMonitor({
    targets,
    env,
    client,
    branch: defaultBranch,
    currentRunId: runId,
    runKey,
    outputDir,
    concurrency,
    runBudgetMs,
    log: (line) => console.log(line),
  });
  const down = snapshot.sites.filter((site) => site.latest?.status === 'down').length;
  console.log(`Wrote ${snapshot.sites.length} observations (${down} down) to ${outputDir}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(`${error.name}: ${error.message}`);
      // 2 for configuration or preflight problems, 1 for runner, history or validation failures.
      process.exitCode = error instanceof ConfigurationError ? 2 : 1;
    });
}
