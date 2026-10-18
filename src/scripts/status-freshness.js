// Re-evaluates freshness on the visitor's clock. It contacts neither GitHub nor the monitored sites,
// and it never changes a recorded observation or its outcome.
import { STALE_AFTER_SECONDS, ageSeconds } from '../lib/status.mjs';

const REFRESH_MS = 60_000;

function refreshFreshness(nowMs = Date.now()) {
  let anyStale = false;
  for (const time of document.querySelectorAll('[data-observed-at]')) {
    const article = time.closest('[data-site-id]');
    const stale = ageSeconds(Date.parse(time.dataset.observedAt), nowMs) > STALE_AFTER_SECONDS;
    anyStale ||= stale;
    if (article) {
      article.dataset.stale = stale ? 'true' : 'false';
      const overdue = article.querySelector('[data-overdue]');
      if (overdue) {
        overdue.hidden = !stale;
      }
    }
  }
  const warning = document.querySelector('[data-overall-warning]');
  if (warning) {
    warning.hidden = !anyStale;
  }
}

refreshFreshness();
window.setInterval(() => refreshFreshness(), REFRESH_MS);
