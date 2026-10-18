// Regenerates the release-hash snapshot fixtures through the shared contract.
// Run from the package root: node tests/fixtures/release-hash/generate-snapshots.mjs
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildReleaseSnapshot, loadRegistry } from '../../../src/lib/release-hash.mjs';
import { GENERATED_AT, REGISTRY_PATH, hashFor, observationsFor } from '../../release-hash/support.mjs';

const RUN_KEY = '123456789:1';
const registry = await loadRegistry(REGISTRY_PATH);
const outputDir = import.meta.dirname;

const scenarios = {
  // Every repository matches its published site: the only summary that may claim all normal.
  'all-match': observationsFor(registry),
  // One mismatch and two unknowns with different reasons: abnormal, and the mismatch outranks the unknowns.
  mixed: observationsFor(registry, {
    site: { publishedHash: hashFor('stale:site') },
    trait: { publishedHash: null, publishedBranch: null, publishedBuiltAt: null, publishedReason: 'metadata-not-found' },
    hagilight: { mainHash: null, mainReason: 'github-rate-limited' },
  }),
  // Only unknowns beside matches: incomplete, which must never read as normal.
  'unknown-only': observationsFor(registry, {
    docs: { mainHash: null, mainReason: 'timeout' },
    cost: { publishedHash: null, publishedBranch: null, publishedBuiltAt: null, publishedReason: 'metadata-commit-unknown' },
  }),
};

for (const [name, observations] of Object.entries(scenarios)) {
  const snapshot = buildReleaseSnapshot({ generatedAt: GENERATED_AT, runKey: RUN_KEY, registry, observations });
  await writeFile(join(outputDir, `${name}.json`), `${JSON.stringify(snapshot, null, 2)}\n`);
}
