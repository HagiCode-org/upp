// Build-time loader for the public snapshot. Presentation reads use only the site manifest's
// names and public links; they never resolve monitoring secrets.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadManifest, presentationSites } from '../../scripts/monitor/config.mjs';
import { buildSnapshot, StatusDataError, toUtcTimestamp, validateSnapshot } from './status.mjs';
import { defaultManifestPath, defaultOutputDir } from './paths.mjs';

export function serializeSnapshot(snapshot) {
  return `${JSON.stringify(snapshot, null, 2)}\n`;
}

// A missing status file is the explicit no-data state. A present but invalid file always fails the build.
export async function loadStatusData(env = process.env) {
  const targets = await loadManifest(defaultManifestPath(env));
  const expectedSites = presentationSites(targets);
  const path = join(defaultOutputDir(env), 'status.json');

  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
    const snapshot = buildSnapshot({
      generatedAt: toUtcTimestamp(Date.now()),
      runKey: null,
      historyResetReason: null,
      sites: expectedSites,
    });
    return { snapshot: validateSnapshot(snapshot, { expectedSites }), source: 'no-data' };
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new StatusDataError(`${path} is not valid JSON`);
  }
  return { snapshot: validateSnapshot(parsed, { expectedSites }), source: 'snapshot' };
}
