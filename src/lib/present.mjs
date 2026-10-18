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
