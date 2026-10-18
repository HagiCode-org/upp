// Regenerates the snapshot fixtures used by the build tests. Run: node tests/fixtures/status/generate-snapshots.mjs
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildSnapshot, validateSnapshot } from '../../../src/lib/status.mjs';
import { loadManifest, presentationSites } from '../../../scripts/monitor/config.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const targets = await loadManifest(join(here, 'sites-upptime-format.yml'));
const sites = presentationSites(targets);
const GENERATED = '2026-10-17T12:00:00.000Z';

function observation(site, runKey, checkedAt, status) {
  const up = status === 'up';
  return {
    runKey,
    siteId: site.id,
    definitionRevision: site.definitionRevision,
    checkedAt,
    status,
    httpStatus: up ? 200 : 503,
    responseTimeMs: up ? 142 : 37,
    attempts: up ? 1 : 2,
    failureCategory: up ? null : 'unexpected-status',
  };
}

// Earlier executions give each site a short history with a mix of outcomes.
function history(site, runKey, latestAt, latestStatus) {
  return [
    observation(site, '89:1', '2026-10-17T11:45:00.000Z', 'up'),
    observation(site, '89:2', '2026-10-17T11:50:00.000Z', site.id === 'hagi-code-website-robots' ? 'down' : 'up'),
    observation(site, runKey, latestAt, latestStatus),
  ];
}

function snapshotFor(name, runKey, samplesFor, reset = null) {
  const snapshot = buildSnapshot({
    generatedAt: GENERATED,
    runKey,
    historyResetReason: reset,
    sites: sites.map((site) => ({ ...site, samples: samplesFor(site) })),
  });
  return { name, snapshot: validateSnapshot(snapshot, { expectedSites: sites }) };
}

const scenarios = [
  snapshotFor('all-up', '90:1', (site) => history(site, '90:1', '2026-10-17T11:58:00.000Z', 'up'), 'first-run'),
  snapshotFor('down', '90:1', (site) => history(site, '90:1', '2026-10-17T11:58:00.000Z', site.id === 'hagi-code-website-robots' ? 'down' : 'up')),
];

await mkdir(join(here, 'snapshots'), { recursive: true });
for (const { name, snapshot } of scenarios) {
  await writeFile(join(here, 'snapshots', `${name}.json`), `${JSON.stringify(snapshot, null, 2)}\n`);
}
console.log(`wrote ${scenarios.length} snapshot fixtures`);
