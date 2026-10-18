// Shared public contract for the status snapshot and checkpoint.
// The monitor runner and the Astro pages both import this module, so the
// validation rules and availability arithmetic have exactly one definition.

export const SNAPSHOT_SCHEMA_VERSION = 1;
export const CHECKPOINT_SCHEMA_VERSION = 1;
export const CHECK_INTERVAL_SECONDS = 300;
export const STALE_AFTER_SECONDS = 900;
export const HISTORY_WINDOW_DAYS = 30;
export const RECENT_CHECK_LIMIT = 20;

export const OUTCOMES = Object.freeze(['up', 'down']);
export const FAILURE_CATEGORIES = Object.freeze([
  'unexpected-status',
  'timeout',
  'dns',
  'tls',
  'redirect',
  'network',
]);
export const HISTORY_RESET_REASONS = Object.freeze(['first-run', 'expired-or-unavailable']);
export const OVERALL_STATES = Object.freeze(['empty', 'incomplete', 'stale', 'disruption', 'operational']);

const DAY_MS = 86_400_000;
const UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

export class StatusDataError extends Error {
  constructor(message) {
    super(message);
    this.name = 'StatusDataError';
  }
}

export function parseUtcTimestamp(value, label = 'timestamp') {
  if (typeof value !== 'string' || !UTC_TIMESTAMP.test(value)) {
    throw new StatusDataError(`${label} must be a UTC ISO-8601 timestamp ending in Z`);
  }
  const ms = Date.parse(value);
  // Date.parse rolls over impossible days such as 02-31, so compare the rendered fields.
  if (Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 19) !== value.slice(0, 19)) {
    throw new StatusDataError(`${label} is not a valid date`);
  }
  return ms;
}

export function toUtcTimestamp(ms) {
  return new Date(ms).toISOString();
}

// Public links never carry credentials, query strings or fragments.
export function toPublicUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new StatusDataError(`public URL is not a valid absolute URL`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new StatusDataError('public URL must use HTTP or HTTPS');
  }
  url.username = '';
  url.password = '';
  url.search = '';
  url.hash = '';
  return url.href;
}

export function ageSeconds(checkedAtMs, nowMs) {
  return Math.max(0, (nowMs - checkedAtMs) / 1000);
}

export function isStale(checkedAt, nowMs, staleAfterSeconds = STALE_AFTER_SECONDS) {
  return ageSeconds(Date.parse(checkedAt), nowMs) > staleAfterSeconds;
}

function requireObject(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new StatusDataError(`${label} must be an object`);
  }
  return value;
}

function requireString(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new StatusDataError(`${label} must be a non-empty string`);
  }
  return value;
}

function requireArray(value, label) {
  if (!Array.isArray(value)) {
    throw new StatusDataError(`${label} must be an array`);
  }
  return value;
}

export function validateSample(sample, label = 'sample') {
  requireObject(sample, label);
  requireString(sample.runKey, `${label}.runKey`);
  requireString(sample.siteId, `${label}.siteId`);
  requireString(sample.definitionRevision, `${label}.definitionRevision`);
  parseUtcTimestamp(sample.checkedAt, `${label}.checkedAt`);
  if (!OUTCOMES.includes(sample.status)) {
    throw new StatusDataError(`${label}.status must be one of ${OUTCOMES.join(', ')}`);
  }
  if (sample.httpStatus !== null && !(Number.isInteger(sample.httpStatus) && sample.httpStatus >= 100 && sample.httpStatus <= 599)) {
    throw new StatusDataError(`${label}.httpStatus must be null or an HTTP status code`);
  }
  if (sample.responseTimeMs !== null && !(Number.isFinite(sample.responseTimeMs) && sample.responseTimeMs >= 0)) {
    throw new StatusDataError(`${label}.responseTimeMs must be null or a finite nonnegative number`);
  }
  if (!Number.isInteger(sample.attempts) || sample.attempts < 1) {
    throw new StatusDataError(`${label}.attempts must be a positive integer`);
  }
  if (sample.status === 'up') {
    if (sample.httpStatus === null || sample.responseTimeMs === null || sample.failureCategory !== null) {
      throw new StatusDataError(`${label} is up but lacks an accepted response measurement`);
    }
  } else if (!FAILURE_CATEGORIES.includes(sample.failureCategory)) {
    throw new StatusDataError(`${label}.failureCategory must be one of ${FAILURE_CATEGORIES.join(', ')}`);
  }
  return sample;
}

// Samples in one series are unique per execution and kept in observation order.
function uniqueByRunKey(samples) {
  const seen = new Set();
  const unique = [];
  for (const sample of samples) {
    if (seen.has(sample.runKey)) {
      continue;
    }
    seen.add(sample.runKey);
    unique.push(sample);
  }
  return unique;
}

// Computes the active series for one site. Samples from other definition revisions,
// outside the window, or after `nowMs` do not affect the result.
export function summarizeSeries(samples, { nowMs, definitionRevision, historyWindowDays = HISTORY_WINDOW_DAYS }) {
  const startMs = nowMs - historyWindowDays * DAY_MS;
  const active = uniqueByRunKey(
    samples
      .filter((sample) => sample.definitionRevision === definitionRevision)
      .filter((sample) => {
        const checkedMs = Date.parse(sample.checkedAt);
        return checkedMs >= startMs && checkedMs <= nowMs;
      })
      .sort((left, right) => Date.parse(right.checkedAt) - Date.parse(left.checkedAt)),
  );
  const successfulChecks = active.filter((sample) => sample.status === 'up').length;
  const totalChecks = active.length;
  return {
    latest: active[0] ?? null,
    recentChecks: active.slice(0, RECENT_CHECK_LIMIT),
    window: {
      historyWindowDays,
      startsAt: toUtcTimestamp(startMs),
      endsAt: toUtcTimestamp(nowMs),
      firstObservedAt: active.length > 0 ? active[active.length - 1].checkedAt : null,
      successfulChecks,
      totalChecks,
      availabilityPercent: totalChecks === 0 ? null : (100 * successfulChecks) / totalChecks,
    },
  };
}

// Builds the public snapshot. `sites` is the enabled configuration in configured order.
export function buildSnapshot({ generatedAt, runKey, historyResetReason, sites }) {
  const generatedMs = parseUtcTimestamp(generatedAt, 'generatedAt');
  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    runKey,
    generatedAt,
    checkIntervalSeconds: CHECK_INTERVAL_SECONDS,
    staleAfterSeconds: STALE_AFTER_SECONDS,
    historyWindowDays: HISTORY_WINDOW_DAYS,
    historyResetReason,
    sites: sites.map((site) => {
      const summary = summarizeSeries(site.samples, {
        nowMs: generatedMs,
        definitionRevision: site.definitionRevision,
      });
      return {
        id: site.id,
        name: site.name,
        publicUrl: site.publicUrl,
        series: { definitionRevision: site.definitionRevision },
        latest: summary.latest,
        window: summary.window,
        recentChecks: summary.recentChecks,
      };
    }),
  };
}

function assertWindow(window, label) {
  requireObject(window, label);
  if (window.historyWindowDays !== HISTORY_WINDOW_DAYS) {
    throw new StatusDataError(`${label}.historyWindowDays must be ${HISTORY_WINDOW_DAYS}`);
  }
  parseUtcTimestamp(window.startsAt, `${label}.startsAt`);
  parseUtcTimestamp(window.endsAt, `${label}.endsAt`);
  if (window.firstObservedAt !== null) {
    parseUtcTimestamp(window.firstObservedAt, `${label}.firstObservedAt`);
  }
  if (!Number.isInteger(window.successfulChecks) || !Number.isInteger(window.totalChecks)) {
    throw new StatusDataError(`${label} check counts must be integers`);
  }
  if (window.successfulChecks < 0 || window.successfulChecks > window.totalChecks) {
    throw new StatusDataError(`${label} successful checks must be between 0 and the total`);
  }
  if (window.totalChecks === 0) {
    if (window.availabilityPercent !== null || window.firstObservedAt !== null) {
      throw new StatusDataError(`${label} without observations must have null availability and first observation`);
    }
    return;
  }
  const expected = (100 * window.successfulChecks) / window.totalChecks;
  if (typeof window.availabilityPercent !== 'number' || Math.abs(window.availabilityPercent - expected) > 1e-9) {
    throw new StatusDataError(`${label}.availabilityPercent does not match its observed counts`);
  }
}

// Validates a public snapshot. `expectedSites` is the enabled configuration; a completed
// snapshot (non-null runKey) must cover each of them exactly once with this run's observations.
export function validateSnapshot(snapshot, { expectedSites = null } = {}) {
  requireObject(snapshot, 'snapshot');
  if (snapshot.schemaVersion !== SNAPSHOT_SCHEMA_VERSION) {
    throw new StatusDataError(`unsupported snapshot schemaVersion ${JSON.stringify(snapshot.schemaVersion)}`);
  }
  const generatedMs = parseUtcTimestamp(snapshot.generatedAt, 'generatedAt');
  if (snapshot.runKey !== null) {
    requireString(snapshot.runKey, 'runKey');
  }
  if (snapshot.checkIntervalSeconds !== CHECK_INTERVAL_SECONDS
    || snapshot.staleAfterSeconds !== STALE_AFTER_SECONDS
    || snapshot.historyWindowDays !== HISTORY_WINDOW_DAYS) {
    throw new StatusDataError('snapshot cadence, freshness and window settings do not match this schema version');
  }
  if (snapshot.historyResetReason !== null && !HISTORY_RESET_REASONS.includes(snapshot.historyResetReason)) {
    throw new StatusDataError('historyResetReason is not a supported value');
  }

  const sites = requireArray(snapshot.sites, 'sites');
  const ids = new Set();
  for (const [index, site] of sites.entries()) {
    const label = `sites[${index}]`;
    requireObject(site, label);
    requireString(site.id, `${label}.id`);
    if (ids.has(site.id)) {
      throw new StatusDataError(`duplicate site id ${site.id}`);
    }
    ids.add(site.id);
    requireString(site.name, `${label}.name`);
    if (site.publicUrl !== null && toPublicUrl(site.publicUrl) !== site.publicUrl) {
      throw new StatusDataError(`${label}.publicUrl is not a safe public URL`);
    }
    requireString(site.series?.definitionRevision, `${label}.series.definitionRevision`);
    assertWindow(site.window, `${label}.window`);

    const recent = requireArray(site.recentChecks, `${label}.recentChecks`);
    if (recent.length > RECENT_CHECK_LIMIT) {
      throw new StatusDataError(`${label}.recentChecks exceeds ${RECENT_CHECK_LIMIT} entries`);
    }
    for (const [sampleIndex, sample] of recent.entries()) {
      validateSample(sample, `${label}.recentChecks[${sampleIndex}]`);
      if (sample.siteId !== site.id || sample.definitionRevision !== site.series.definitionRevision) {
        throw new StatusDataError(`${label}.recentChecks[${sampleIndex}] belongs to another series`);
      }
      if (Date.parse(sample.checkedAt) > generatedMs) {
        throw new StatusDataError(`${label}.recentChecks[${sampleIndex}] is later than generatedAt`);
      }
    }
    if (snapshot.runKey === null && (site.latest !== null || recent.length > 0 || site.window.totalChecks > 0)) {
      throw new StatusDataError('a snapshot without runKey must not contain observations');
    }
    if (site.latest !== null) {
      validateSample(site.latest, `${label}.latest`);
      if (site.latest.siteId !== site.id || site.latest.definitionRevision !== site.series.definitionRevision) {
        throw new StatusDataError(`${label}.latest belongs to another series`);
      }
      if (Date.parse(site.latest.checkedAt) > generatedMs) {
        throw new StatusDataError(`${label}.latest is later than generatedAt`);
      }
    }
    if (snapshot.runKey !== null && (site.latest === null || site.latest.runKey !== snapshot.runKey)) {
      throw new StatusDataError(`${label} has no observation from run ${snapshot.runKey}`);
    }
  }

  if (expectedSites) {
    const expectedIds = expectedSites.map((site) => site.id);
    if (new Set(expectedIds).size !== expectedIds.length) {
      throw new StatusDataError('configuration contains duplicate site ids');
    }
    const actual = [...ids].sort();
    const expected = [...expectedIds].sort();
    if (actual.length !== expected.length || actual.some((id, index) => id !== expected[index])) {
      throw new StatusDataError('snapshot sites do not match the enabled configuration');
    }
  }
  return snapshot;
}

// Validates a checkpoint and returns it. Checkpoints hold per-series observations only.
export function validateCheckpoint(checkpoint) {
  requireObject(checkpoint, 'checkpoint');
  if (checkpoint.schemaVersion !== CHECKPOINT_SCHEMA_VERSION) {
    throw new StatusDataError(`unsupported checkpoint schemaVersion ${JSON.stringify(checkpoint.schemaVersion)}`);
  }
  requireString(checkpoint.runKey, 'checkpoint.runKey');
  const generatedMs = parseUtcTimestamp(checkpoint.generatedAt, 'checkpoint.generatedAt');
  if (checkpoint.historyWindowDays !== HISTORY_WINDOW_DAYS) {
    throw new StatusDataError(`checkpoint.historyWindowDays must be ${HISTORY_WINDOW_DAYS}`);
  }
  const continuity = requireObject(checkpoint.continuity, 'checkpoint.continuity');
  if (continuity.historyResetReason !== null && !HISTORY_RESET_REASONS.includes(continuity.historyResetReason)) {
    throw new StatusDataError('checkpoint.continuity.historyResetReason is not supported');
  }
  if (continuity.restoredFromRunKey !== null) {
    requireString(continuity.restoredFromRunKey, 'checkpoint.continuity.restoredFromRunKey');
  }

  const seriesKeys = new Set();
  for (const [index, series] of requireArray(checkpoint.series, 'checkpoint.series').entries()) {
    const label = `checkpoint.series[${index}]`;
    requireObject(series, label);
    requireString(series.siteId, `${label}.siteId`);
    requireString(series.definitionRevision, `${label}.definitionRevision`);
    const key = `${series.siteId}\u0000${series.definitionRevision}`;
    if (seriesKeys.has(key)) {
      throw new StatusDataError(`${label} duplicates another series`);
    }
    seriesKeys.add(key);
    const runKeys = new Set();
    for (const [sampleIndex, sample] of requireArray(series.samples, `${label}.samples`).entries()) {
      validateSample(sample, `${label}.samples[${sampleIndex}]`);
      if (sample.siteId !== series.siteId || sample.definitionRevision !== series.definitionRevision) {
        throw new StatusDataError(`${label}.samples[${sampleIndex}] belongs to another series`);
      }
      if (runKeys.has(sample.runKey)) {
        throw new StatusDataError(`${label} repeats run ${sample.runKey}`);
      }
      runKeys.add(sample.runKey);
      if (Date.parse(sample.checkedAt) > generatedMs) {
        throw new StatusDataError(`${label}.samples[${sampleIndex}] is later than checkpoint.generatedAt`);
      }
    }
  }
  return checkpoint;
}

// Overall state by precedence: empty, incomplete, stale, disruption, operational.
// Stale and incomplete states never hide a failed last observation on a site row.
export function summarizeOverall(snapshot, nowMs = Date.parse(snapshot.generatedAt)) {
  const sites = snapshot.sites;
  const counts = { total: sites.length, up: 0, down: 0, noData: 0, stale: 0 };
  for (const site of sites) {
    if (site.latest === null) {
      counts.noData += 1;
      continue;
    }
    if (site.latest.status === 'up') {
      counts.up += 1;
    } else {
      counts.down += 1;
    }
    if (isStale(site.latest.checkedAt, nowMs, snapshot.staleAfterSeconds)) {
      counts.stale += 1;
    }
  }
  let state = 'operational';
  if (sites.length === 0) {
    state = 'empty';
  } else if (counts.noData > 0) {
    state = 'incomplete';
  } else if (counts.stale > 0) {
    state = 'stale';
  } else if (counts.down > 0) {
    state = 'disruption';
  }
  return { state, counts };
}
