// Build-time loader for the release-hash snapshot. It reads only the local file and the committed registry,
// so building or viewing the page never makes a GitHub or site request.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ReleaseHashDataError, buildReleaseSnapshot, loadRegistry, validateReleaseSnapshot } from './release-hash.mjs';
import { defaultOutputDir, defaultReleaseRegistryPath } from './paths.mjs';
import { toUtcTimestamp } from './status.mjs';

export function serializeReleaseSnapshot(snapshot) {
  return `${JSON.stringify(snapshot, null, 2)}\n`;
}

// A missing file is the explicit no-data state. A present but invalid file always fails the build.
export async function loadReleaseData(env = process.env) {
  const registry = await loadRegistry(defaultReleaseRegistryPath(env));
  const path = join(defaultOutputDir(env), 'release-hash.json');

  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
    const snapshot = buildReleaseSnapshot({
      generatedAt: toUtcTimestamp(Date.now()),
      runKey: null,
      registry,
    });
    return { snapshot, source: 'no-data' };
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ReleaseHashDataError(`${path} is not valid JSON`);
  }
  return { snapshot: validateReleaseSnapshot(parsed, { registry }), source: 'snapshot' };
}
