// Derivations for the homepage data wall. Everything here reads the validated public snapshot and
// invents no observation: grouping uses display names only, and every number comes from recent checks.
import { isStale } from './status.mjs';

export const KIND_ORDER = Object.freeze(['page', 'sitemap', 'robots', 'rss']);
export const KIND_LABEL = Object.freeze({ page: 'Page', sitemap: 'Sitemap', robots: 'Robots', rss: 'RSS' });

const SUFFIX = /^(.*\S)\s+(sitemap|robots|rss)$/i;

// A probe named "Docs Sitemap" belongs to the "Docs" family as its sitemap probe. Any other name is the family's page probe.
export function probeKind(name) {
  const match = SUFFIX.exec(name.trim());
  if (match === null) {
    return { family: name.trim(), kind: 'page' };
  }
  return { family: match[1], kind: match[2].toLowerCase() };
}

// Worst state first, so the board shows what needs attention at the top.
const RANK = Object.freeze({ down: 0, none: 1, stale: 2, up: 3 });

export function probeState(site, nowMs, staleAfterSeconds) {
  if (site.latest === null) {
    return 'none';
  }
  if (site.latest.status === 'down') {
    return 'down';
  }
  return isStale(site.latest.checkedAt, nowMs, staleAfterSeconds) ? 'stale' : 'up';
}

// Groups probes into families, keeping configured order inside each rank. Two probes of the same kind never merge:
// the second one becomes a family of its own, because a cell can show only one result.
export function groupFamilies(snapshot, nowMs = Date.parse(snapshot.generatedAt)) {
  const families = new Map();
  for (const [order, site] of snapshot.sites.entries()) {
    const { family, kind } = probeKind(site.name);
    let key = family.toLowerCase();
    if (families.get(key)?.probes[kind]) {
      key = `${key}\u0000${site.id}`;
    }
    let entry = families.get(key);
    if (!entry) {
      entry = { key, name: family, order, probes: {}, sites: [] };
      families.set(key, entry);
    }
    const state = probeState(site, nowMs, snapshot.staleAfterSeconds);
    entry.probes[kind] = { site, kind, state };
    entry.sites.push(site);
  }
  const list = [...families.values()].map((entry) => {
    const states = Object.values(entry.probes).map((probe) => probe.state);
    const worst = states.reduce((rank, state) => Math.min(rank, RANK[state]), RANK.up);
    const pooled = entry.sites.reduce(
      (sum, site) => ({ up: sum.up + site.window.successfulChecks, total: sum.total + site.window.totalChecks }),
      { up: 0, total: 0 },
    );
    return {
      ...entry,
      state: Object.keys(RANK).find((name) => RANK[name] === worst),
      rank: worst,
      pooled: { ...pooled, percent: pooled.total === 0 ? null : (100 * pooled.up) / pooled.total },
    };
  });
  return list.sort((left, right) => left.rank - right.rank || left.order - right.order);
}

export function percentile(values, fraction) {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

// One entry per monitor run, oldest first. A run is every probe that carries the same run key.
// Response time is the time to response headers, so a failing probe that answered still counts.
export function fleetRuns(snapshot) {
  const byRun = new Map();
  for (const site of snapshot.sites) {
    for (const check of site.recentChecks) {
      let run = byRun.get(check.runKey);
      if (!run) {
        run = { runKey: check.runKey, times: [], up: 0, down: 0, ms: [] };
        byRun.set(check.runKey, run);
      }
      run.times.push(Date.parse(check.checkedAt));
      if (check.status === 'up') {
        run.up += 1;
      } else {
        run.down += 1;
      }
      if (check.responseTimeMs !== null) {
        run.ms.push(check.responseTimeMs);
      }
    }
  }
  return [...byRun.values()]
    .map((run) => ({
      runKey: run.runKey,
      at: percentile(run.times, 0.5),
      total: run.up + run.down,
      up: run.up,
      down: run.down,
      measured: run.ms.length,
      medianMs: percentile(run.ms, 0.5),
      lowMs: percentile(run.ms, 0.1),
      highMs: percentile(run.ms, 0.9),
    }))
    .sort((left, right) => left.at - right.at);
}

// Latest response time per probe, grouped by endpoint kind. Probes with no observation are counted, never plotted.
export function kindLanes(snapshot, nowMs = Date.parse(snapshot.generatedAt)) {
  return KIND_ORDER.map((kind) => {
    const probes = [];
    let noData = 0;
    for (const site of snapshot.sites) {
      if (probeKind(site.name).kind !== kind) {
        continue;
      }
      if (site.latest === null) {
        noData += 1;
        continue;
      }
      probes.push({
        id: site.id,
        name: site.name,
        state: probeState(site, nowMs, snapshot.staleAfterSeconds),
        down: site.latest.status === 'down',
        ms: site.latest.responseTimeMs,
        httpStatus: site.latest.httpStatus,
      });
    }
    const measured = probes.filter((probe) => probe.ms !== null).map((probe) => probe.ms);
    return { kind, label: KIND_LABEL[kind], probes, noData, medianMs: percentile(measured, 0.5) };
  }).filter((lane) => lane.probes.length > 0 || lane.noData > 0);
}

export function formatMs(ms) {
  if (ms === null || ms === undefined) {
    return 'no response';
  }
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
}

export function clockUtc(ms) {
  return new Date(ms).toISOString().slice(11, 16);
}

export function describeAge(seconds) {
  const minutes = Math.floor(seconds / 60);
  if (minutes < 1) {
    return 'under a minute';
  }
  if (minutes < 120) {
    return `${minutes} min`;
  }
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

// Floors instead of rounding, so a share below 100 never reads as 100.0%.
export function formatShare(percent) {
  return percent === null ? null : `${(Math.floor(percent * 10) / 10).toFixed(1)}%`;
}
