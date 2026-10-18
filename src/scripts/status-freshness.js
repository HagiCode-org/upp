// Re-evaluates freshness on the visitor's clock. It contacts neither GitHub nor the monitored sites,
// and it never changes a recorded observation or its outcome.
import { STALE_AFTER_SECONDS, ageSeconds } from '../lib/status.mjs';
import { describeAge } from '../lib/wall.mjs';

const REFRESH_MS = 30_000;

function refreshFreshness(nowMs = Date.now()) {
  let anyStale = false;
  const staleBySite = new Map();
  for (const time of document.querySelectorAll('[data-observed-at]')) {
    const article = time.closest('[data-site-id]');
    const stale = ageSeconds(Date.parse(time.dataset.observedAt), nowMs) > STALE_AFTER_SECONDS;
    anyStale ||= stale;
    if (article) {
      staleBySite.set(article.dataset.siteId, stale);
      article.dataset.stale = stale ? 'true' : 'false';
      const overdue = article.querySelector('[data-overdue]');
      if (overdue) {
        overdue.hidden = !stale;
      }
    }
  }
  // Board cells follow their probe: an up result turns overdue and back, and a down or empty cell keeps its own state.
  for (const cell of document.querySelectorAll('[data-cell-site]')) {
    const stale = staleBySite.get(cell.dataset.cellSite);
    if (stale === undefined) {
      continue;
    }
    if (cell.dataset.state === 'up' && stale) {
      cell.dataset.state = 'stale';
    } else if (cell.dataset.state === 'stale' && !stale) {
      cell.dataset.state = 'up';
    }
  }
  const warning = document.querySelector('[data-overall-warning]');
  if (warning) {
    warning.hidden = !anyStale;
  }
  const gauge = document.querySelector('[data-age]');
  if (gauge) {
    const age = ageSeconds(Date.parse(gauge.dataset.newest), nowMs);
    const ratio = Math.min(1, age / STALE_AFTER_SECONDS);
    gauge.dataset.stale = age > STALE_AFTER_SECONDS ? 'true' : 'false';
    gauge.querySelector('[data-age-fill]')?.style.setProperty('--age', ratio.toFixed(3));
    const value = gauge.querySelector('[data-age-value]');
    if (value) {
      value.textContent = `${describeAge(age)} old`;
    }
  }
}

refreshFreshness();
window.setInterval(() => refreshFreshness(), REFRESH_MS);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    refreshFreshness();
  }
});
