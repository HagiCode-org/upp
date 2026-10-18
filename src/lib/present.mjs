// Presentation helpers shared by the Astro components and the freshness script.
import { STALE_AFTER_SECONDS } from './status.mjs';

const FAILURE_LABELS = Object.freeze({
  'unexpected-status': 'unexpected HTTP status',
  'missing-body-text': 'required response text missing',
  timeout: 'timed out',
  dns: 'DNS lookup failed',
  tls: 'TLS handshake failed',
  redirect: 'redirect not followed',
  network: 'connection failed',
});

const OVERALL_COPY = Object.freeze({
  empty: {
    heading: 'No sites configured',
    detail: 'The monitoring configuration lists no enabled sites, so no service status is shown.',
  },
  incomplete: {
    heading: 'Monitoring data incomplete',
    detail: 'Some enabled sites have no observations yet. This page makes no overall claim.',
  },
  stale: {
    heading: 'Monitoring data delayed',
    detail: 'The newest observations are older than the freshness threshold. Results are the last values observed, not current checks.',
  },
  disruption: {
    heading: 'Last observed: one or more services down',
    detail: 'The most recent checks found at least one service unavailable.',
  },
  operational: {
    heading: 'Last observed: All services operational',
    detail: 'The most recent checks reached every enabled service.',
  },
});

export const FRESHNESS_NOTE = `Checks are scheduled about every 5 minutes. An observation older than ${STALE_AFTER_SECONDS / 60} minutes is marked overdue, and an overdue result is still the last observed value, not a new outage. Times are UTC.`;

export function formatUtc(iso) {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

export function formatUtcSeconds(iso) {
  return `${iso.slice(0, 19).replace('T', ' ')} UTC`;
}

export function formatPercent(value) {
  return value === null ? null : `${value.toFixed(2)}%`;
}

export function outcomeLabel(sample) {
  if (sample === null) {
    return 'No data';
  }
  return sample.status === 'up' ? 'Up' : 'Down';
}

export function outcomeDetail(sample) {
  if (sample === null) {
    return 'No observation yet';
  }
  if (sample.status === 'up') {
    return `HTTP ${sample.httpStatus}`;
  }
  const reason = FAILURE_LABELS[sample.failureCategory] ?? 'check failed';
  return sample.httpStatus === null ? reason : `${reason} (HTTP ${sample.httpStatus})`;
}

export function overallCopy(state) {
  return OVERALL_COPY[state];
}

const RELEASE_STATE_LABELS = Object.freeze({ match: 'Match', mismatch: 'Mismatch', unknown: 'Unknown' });

const RELEASE_REASON_LABELS = Object.freeze({
  'github-not-found': 'repository not found on GitHub',
  'github-forbidden': 'GitHub denied access to the repository',
  'github-rate-limited': 'GitHub rate limit reached',
  'github-error': 'GitHub request failed',
  'github-invalid-response': 'GitHub returned an unexpected response',
  'metadata-not-found': 'published metadata file not found',
  'metadata-http-error': 'published metadata request failed',
  'metadata-invalid': 'published metadata is not valid',
  'metadata-commit-unknown': 'site did not record its build commit',
  'too-large': 'published metadata is too large',
  timeout: 'timed out',
  dns: 'DNS lookup failed',
  tls: 'TLS handshake failed',
  redirect: 'redirects did not resolve',
  network: 'connection failed',
  'not-checked': 'not checked in this build',
});

export const RELEASE_FRESHNESS_NOTE = 'Results are observed on every monitor run and show the state at the time of that check. They are not a history. Times are UTC.';

// Each state has a text label, so colour is never the only signal. A repository without an observation reads as No data.
export function releaseStateLabel(repo) {
  if (repo.reason === 'not-checked') {
    return 'No data';
  }
  return RELEASE_STATE_LABELS[repo.state];
}

export function releaseReasonLabel(reason) {
  return RELEASE_REASON_LABELS[reason] ?? 'check failed';
}

// Commit hashes are shown abbreviated to seven characters. The full value stays available in the page.
export function shortHash(hash) {
  return hash === null ? null : hash.slice(0, 7);
}

export function releaseCountsText(counts) {
  return `${counts.match} match · ${counts.mismatch} mismatch · ${counts.unknown} unknown`;
}

// The all-normal sentence appears only when every result is a match.
export function releaseSummaryCopy(summary) {
  const { counts } = summary;
  if (summary.state === 'no-data') {
    return {
      heading: 'No release-hash data',
      detail: 'No release-hash snapshot is present in this build. Results appear after a monitor run. Building or viewing this page made no GitHub or site requests.',
    };
  }
  if (summary.state === 'normal') {
    return {
      heading: `All ${counts.total} repositories match their published versions`,
      detail: "Every repository's main branch head is the commit its site publishes.",
    };
  }
  if (summary.state === 'abnormal') {
    return {
      heading: `Abnormal: ${counts.mismatch} of ${counts.total} repositories differ from their published site`,
      detail: releaseCountsText(counts),
    };
  }
  return {
    heading: `Incomplete: ${counts.unknown} of ${counts.total} repositories could not be compared`,
    detail: `${releaseCountsText(counts)}. This page makes no claim that every repository is normal.`,
  };
}
