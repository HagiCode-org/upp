# Upp - Agent Configuration

## Root Configuration

Inherits all behavior from `/AGENTS.md` at the monorepo root. Local rules extend or override the root file for this repository.

## Project Context

This repository is the static status page for HagiCode sites (status.hagicode.com), built with Astro 7 (static output) and deployed on Cloudflare via `wrangler.jsonc` assets, publishing alongside `dist/` on `gh-pages`. A scheduled GitHub Actions workflow probes each configured site, keeps a bounded history as a run artifact (`checkpoint.json`), and the page renders the latest validated snapshot plus `/status.json`. It also serves a release-hash sync check at `/release-hashes/` and `/release-hash.json`, comparing each registered repository's `main` head against its published commit.

## Working Directory

Run commands from `repos/upp/`.

## Key Commands

```bash
npm ci
npm run dev
npm run build
npm test
npm run monitor          # probe enabled sites, write .monitor-data/
npm run release-check    # compare registered repos' main head vs published commit
```

`npm run build` with no `.monitor-data/status.json` renders every site in the explicit no-data state and makes no network requests; only `npm run monitor` probes sites. `npm test` runs `node --test` over `tests/**/*.test.mjs`.

## Key Paths

- `src/lib/`: status/release-hash domain logic (`status.mjs`, `load-status.mjs`, `release-hash.mjs`, `load-release-hash.mjs`, `present.mjs`, `wall.mjs`, `wall-charts.mjs`)
- `src/pages/`: `index.astro` (status wall), `status.json.ts`, `release-hashes.astro`, `release-hash.json.ts`
- `src/components/status/`, `src/components/wall/`: Astro/UI components
- `src/data/release-repositories.json`: registry of repositories compared by the release-hash check
- `scripts/monitor/`: probing (`run.mjs`, `check.mjs`, `history.mjs`, `config.mjs`)
- `scripts/release-hash/`: `run.mjs`, `fetch.mjs`
- `.upptimerc.yml`: site manifest (Upptime-layout `sites:` list); path overridable via `UPP_SITE_MANIFEST`
- `.github/workflows/monitor.yml`: scheduled probe (`3/5 * * * *`, `main` only), budgets via `UPP_RUN_BUDGET_MS` / `UPP_RELEASE_CHECK_BUDGET_MS`
- `.github/workflows/deploy-gh-pages.yml`: downloads the monitor run's validated `dist/` artifact and publishes it to `gh-pages` (no rebuild/re-probe)

## Agent Guidelines

- Any manifest key not in the documented set (`name`, `url`, `slug`, `expectedStatusCodes`, `method`, `headers`, `timeoutMs`, `maxAttempts`, `enabled`, `__dangerous__body_down_if_text_missing`) is rejected before probing.
- A site's identity is its `slug`, or one derived from `name`; renaming without setting `slug` starts new history.
- `status.json` / `release-hash.json` are built only from a validated snapshot; a malformed or incomplete snapshot fails the build rather than producing a partial page.
- Response bodies are read only for configured body-text checks and are never stored; secrets referenced by `headers.secret` are read from environment variables, never written to output.
- Keep `@hagicode/hagilight` and `@hagicode/hagilight-core` pinned to the same exact version.
- To add a release-hash target, append an entry to `src/data/release-repositories.json` with a unique `id` and an exact HTTPS `origin` (no path/query/credentials), then run `npm run release-check` locally with `GITHUB_TOKEN` set.

## References

- `README.md`
