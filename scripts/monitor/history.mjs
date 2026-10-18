// Checkpoint history: restores the newest eligible Actions artifact and merges this run into it.
import { unzipSync } from 'fflate';
import {
  CHECKPOINT_SCHEMA_VERSION,
  HISTORY_WINDOW_DAYS,
  StatusDataError,
  validateCheckpoint,
} from '../../src/lib/status.mjs';

export const MONITOR_WORKFLOW_FILE = 'monitor.yml';
export const CHECKPOINT_ENTRY = 'checkpoint.json';
export const MAX_CHECKPOINT_BYTES = 10 * 1024 * 1024;
const DAY_MS = 86_400_000;
const ELIGIBLE_EVENTS = Object.freeze(['schedule', 'workflow_dispatch']);

export class HistoryAccessError extends Error {
  constructor(message) {
    super(message);
    this.name = 'HistoryAccessError';
  }
}

export class HistoryApiError extends Error {
  constructor(message) {
    super(message);
    this.name = 'HistoryApiError';
  }
}

export class HistoryDataError extends Error {
  constructor(message) {
    super(message);
    this.name = 'HistoryDataError';
  }
}

// Artifact name and run key both derive from the run id and attempt, so reruns never collide.
export function artifactNameFor(runId, runAttempt) {
  return `site-availability-${runId}-${runAttempt}`;
}

export function runKeyFor(runId, runAttempt) {
  return `${runId}:${runAttempt}`;
}

export function seriesSamples(checkpoint, siteId, definitionRevision) {
  if (!checkpoint) {
    return [];
  }
  const series = checkpoint.series.find(
    (item) => item.siteId === siteId && item.definitionRevision === definitionRevision,
  );
  return series ? series.samples : [];
}

// GitHub REST client limited to the reads needed for restoration. The fetch implementation is injected for tests.
export function createGitHubHistoryClient({ owner, repo, token, fetch: fetchImpl = globalThis.fetch, apiBase = 'https://api.github.com' }) {
  const headers = {
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    authorization: `Bearer ${token}`,
  };

  async function request(path, { accept } = {}) {
    return fetchImpl(`${apiBase}${path}`, {
      headers: accept ? { ...headers, accept } : headers,
      redirect: 'follow',
    });
  }

  async function getJson(path) {
    const response = await request(path);
    if (response.status === 401 || response.status === 403) {
      throw new HistoryAccessError(`GitHub denied access to ${path.split('?')[0]} (HTTP ${response.status})`);
    }
    if (!response.ok) {
      throw new HistoryApiError(`GitHub API request failed with HTTP ${response.status}`);
    }
    try {
      return await response.json();
    } catch {
      throw new HistoryDataError('GitHub API returned a body that is not JSON');
    }
  }

  return {
    // Pages through completed runs of the monitor workflow, newest first.
    async *iterateWorkflowRuns({ branch, perPage = 100, maxPages = 20 }) {
      for (let page = 1; page <= maxPages; page += 1) {
        const query = new URLSearchParams({
          branch,
          status: 'completed',
          per_page: String(perPage),
          page: String(page),
        });
        const body = await getJson(`/repos/${owner}/${repo}/actions/workflows/${MONITOR_WORKFLOW_FILE}/runs?${query}`);
        const runs = Array.isArray(body.workflow_runs) ? body.workflow_runs : [];
        for (const run of runs) {
          yield run;
        }
        if (runs.length < perPage) {
          return;
        }
      }
      throw new HistoryApiError('monitor run discovery exceeded its page limit');
    },

    async listRunArtifacts(runId) {
      const body = await getJson(`/repos/${owner}/${repo}/actions/runs/${runId}/artifacts?per_page=100`);
      return Array.isArray(body.artifacts) ? body.artifacts : [];
    },

    // Returns the archive bytes, or null when GitHub reports the artifact as gone.
    async downloadArtifact(artifactId) {
      const response = await request(`/repos/${owner}/${repo}/actions/artifacts/${artifactId}/zip`, {
        accept: 'application/vnd.github+json',
      });
      if (response.status === 401 || response.status === 403) {
        throw new HistoryAccessError(`GitHub denied access to artifact ${artifactId} (HTTP ${response.status})`);
      }
      if (response.status === 404 || response.status === 410) {
        return null;
      }
      if (!response.ok) {
        throw new HistoryApiError(`artifact download failed with HTTP ${response.status}`);
      }
      return new Uint8Array(await response.arrayBuffer());
    },
  };
}

export function parseCheckpointArchive(bytes, expectedRunKey) {
  let entries;
  try {
    entries = unzipSync(bytes, { filter: (file) => file.name === CHECKPOINT_ENTRY && file.size <= MAX_CHECKPOINT_BYTES });
  } catch {
    throw new HistoryDataError('checkpoint archive is corrupt');
  }
  const contents = entries[CHECKPOINT_ENTRY];
  if (!contents) {
    throw new HistoryDataError('checkpoint archive has no checkpoint.json');
  }
  let parsed;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(contents));
  } catch {
    throw new HistoryDataError('checkpoint.json is not valid UTF-8 JSON');
  }
  if (parsed?.schemaVersion !== CHECKPOINT_SCHEMA_VERSION) {
    throw new HistoryDataError(`unsupported checkpoint schemaVersion ${JSON.stringify(parsed?.schemaVersion)}`);
  }
  let checkpoint;
  try {
    checkpoint = validateCheckpoint(parsed);
  } catch (error) {
    if (error instanceof StatusDataError) {
      throw new HistoryDataError(`checkpoint.json is invalid: ${error.message}`);
    }
    throw error;
  }
  if (checkpoint.runKey !== expectedRunKey) {
    throw new HistoryDataError('checkpoint run identity does not match its artifact name');
  }
  return checkpoint;
}

// Restores the newest eligible completed checkpoint.
// Returns { checkpoint, historyResetReason, restoredFromRunKey }.
// A missing eligible run is a first run; an eligible run whose artifact has expired or
// been removed starts a new window. Access, API and data failures throw.
export async function restoreCheckpoint({ client, branch, currentRunId }) {
  let newestEligible = null;
  for await (const run of client.iterateWorkflowRuns({ branch })) {
    if (String(run.id) === String(currentRunId)) {
      continue;
    }
    if (run.status !== 'completed' || run.conclusion !== 'success') {
      continue;
    }
    if (run.head_branch !== branch || !ELIGIBLE_EVENTS.includes(run.event)) {
      continue;
    }
    newestEligible = run;
    break;
  }
  if (!newestEligible) {
    return { checkpoint: null, historyResetReason: 'first-run', restoredFromRunKey: null };
  }

  const runAttempt = newestEligible.run_attempt ?? 1;
  const runKey = runKeyFor(newestEligible.id, runAttempt);
  const artifactName = artifactNameFor(newestEligible.id, runAttempt);
  const artifacts = await client.listRunArtifacts(newestEligible.id);
  const artifact = artifacts.find((item) => item.name === artifactName);
  if (!artifact || artifact.expired === true) {
    return { checkpoint: null, historyResetReason: 'expired-or-unavailable', restoredFromRunKey: null };
  }

  const bytes = await client.downloadArtifact(artifact.id);
  if (bytes === null) {
    // Treat a vanished download as unavailable only when the listing confirms the artifact is gone.
    const relisted = await client.listRunArtifacts(newestEligible.id);
    const still = relisted.find((item) => item.id === artifact.id);
    if (!still || still.expired === true) {
      return { checkpoint: null, historyResetReason: 'expired-or-unavailable', restoredFromRunKey: null };
    }
    throw new HistoryApiError('artifact download failed although the artifact is still listed');
  }

  const checkpoint = parseCheckpointArchive(bytes, runKey);
  return { checkpoint, historyResetReason: null, restoredFromRunKey: runKey };
}

// Merges this execution into the restored series. Each series is deduplicated by runKey and pruned to the window.
// Series for disabled sites and previous definition revisions remain until they age out.
export function mergeHistory({ restored, currentSamples, runKey, generatedAt, historyResetReason }) {
  const generatedMs = Date.parse(generatedAt);
  const cutoffMs = generatedMs - HISTORY_WINDOW_DAYS * DAY_MS;
  const series = new Map();

  const add = (sample) => {
    const key = `${sample.siteId}\u0000${sample.definitionRevision}`;
    if (!series.has(key)) {
      series.set(key, { siteId: sample.siteId, definitionRevision: sample.definitionRevision, samples: new Map() });
    }
    const target = series.get(key).samples;
    if (!target.has(sample.runKey)) {
      target.set(sample.runKey, sample);
    }
  };

  for (const item of restored?.series ?? []) {
    for (const sample of item.samples) {
      if (Date.parse(sample.checkedAt) >= cutoffMs) {
        add(sample);
      }
    }
  }
  for (const sample of currentSamples) {
    add(sample);
  }

  const output = [...series.values()]
    .map((item) => ({
      siteId: item.siteId,
      definitionRevision: item.definitionRevision,
      samples: [...item.samples.values()].sort((left, right) => Date.parse(left.checkedAt) - Date.parse(right.checkedAt)),
    }))
    .filter((item) => item.samples.length > 0)
    .sort((left, right) => (left.siteId === right.siteId
      ? left.definitionRevision.localeCompare(right.definitionRevision)
      : left.siteId.localeCompare(right.siteId)));

  return validateCheckpoint({
    schemaVersion: CHECKPOINT_SCHEMA_VERSION,
    runKey,
    generatedAt,
    historyWindowDays: HISTORY_WINDOW_DAYS,
    continuity: {
      historyResetReason,
      restoredFromRunKey: restored ? restored.runKey : null,
    },
    series: output,
  });
}
