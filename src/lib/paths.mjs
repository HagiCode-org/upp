// Default locations shared by the monitor CLI and the Astro build. Both run from the package root.
import { resolve } from 'node:path';

export function defaultManifestPath(env = process.env) {
  return env.UPP_SITE_MANIFEST ?? resolve(process.cwd(), '.upptimerc.yml');
}

export function defaultOutputDir(env = process.env) {
  return env.UPP_MONITOR_OUTPUT ?? resolve(process.cwd(), '.monitor-data');
}

export function defaultReleaseRegistryPath(env = process.env) {
  return env.UPP_RELEASE_REGISTRY ?? resolve(process.cwd(), 'src', 'data', 'release-repositories.json');
}
