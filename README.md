# upp

Static status page for HagiCode sites. A scheduled GitHub Actions workflow checks each enabled site, keeps a bounded history in an Actions artifact, and builds an Astro page that shows the last observed results. The page reuses the shared presentation from [`@hagicode/hagilight`](https://www.npmjs.com/package/@hagicode/hagilight) (pinned to `0.13.0`).

Outages are recorded as data. The workflow fails only for configuration, history, validation, or build problems.

## Install and commands

```sh
npm ci              # installs from package-lock.json
npm test            # node --test over tests/**
npm run build       # astro build into dist/
npm run monitor     # probe enabled sites and write .monitor-data/
npm run release-check  # compare each repository's main head with its published commit
```

Node 24 or later is required. Installing `@hagicode/hagilight` pulls in its Astro integration; the Astro version it supports is `>=7`.

### Local no-data preview

`npm run build` with no `.monitor-data/status.json` renders every enabled site in the explicit no-data state (`No data`, `No monitoring snapshot is present in this build`). Building and viewing the page make no monitoring requests. Only `npm run monitor` probes sites.

To render a real snapshot locally, run `npm run monitor` first (it probes the configured sites over the network) and then `npm run build`.

## Configuration

The site list is read from a manifest in the existing Upptime layout (`sites:` with `name`, `url`, and optional `slug`, `expectedStatusCodes`, `method`, `headers`, `timeoutMs`, `maxAttempts`, `enabled`). Set the path with `UPP_SITE_MANIFEST`. The default is `.upptimerc.yml` at the package root.

The repository includes `.upptimerc.yml`, copied from `repos/upptime/.upptimerc.yml`, so the default monitor and build commands work without a path override. The site list and Upptime body-text checks are preserved. Top-level Upptime metadata is retained for reference; it does not configure this Astro site's presentation or deployment.

| Key | Meaning |
| --- | --- |
| `name` | Display name. Required. |
| `url` | Absolute `http` or `https` URL. Credentials in the URL are rejected. |
| `slug` | Explicit stable identity. Otherwise derived from `name`. Identities must be unique. |
| `method` | `GET` (default) or `HEAD`. |
| `expectedStatusCodes` | Accepted final statuses. Default: any `2xx`. |
| `headers` | List of `{ name, secret }`. `secret` names an environment variable, never a value. |
| `timeoutMs` | Per-attempt timeout, 1000 to 30000. Default 10000. |
| `maxAttempts` | 1 to 3. Default 2. |
| `enabled` | `false` removes the site from the active list and from new probes. |
| `__dangerous__body_down_if_text_missing` | Nonempty, case-sensitive text required in the response body. GET only. |

Any other key is rejected before probing. A rename changes the derived identity, so set `slug` to keep a site's history when renaming.

Each target carries a `definitionRevision` computed from the unresolved request (method, URL, accepted statuses, header names and secret names, timeout, attempts). Changing a request definition starts a new series. Display names, ordering, and secret values do not.

Monitoring needs every secret referenced by an enabled target. Missing secrets fail preflight before any request is sent. Presentation reads never resolve secrets.

## Monitoring behavior

- Redirects are followed up to 10 hops, and every hop must be HTTP or HTTPS. Authentication headers are sent only to the original origin.
- An attempt covers the whole request, redirects included, under one timeout.
- Up to 4 targets run concurrently. A slow or failing target does not hold up the others.
- A failed attempt is retried once by default. The run keeps one final observation per target.
- Response time is measured to response headers, in milliseconds. Transport failures have no response time.
- Response bodies are read only for configured body-text checks, streamed within the attempt timeout with bounded matching memory, and never stored. Reading stops once the text matches.
- Failure categories: `unexpected-status`, `missing-body-text`, `timeout`, `dns`, `tls`, `redirect`, `network`.
- Exit codes: `0` when the run completes, including when sites are down. `2` for configuration or preflight problems, such as a missing secret, an unsupported key, or a worst-case probe time over the run budget. `1` for history access, history data, runner, or validation failures.

## History and checkpoints

Each completed scheduled or manual run on `main` writes one artifact named `site-availability-<run-id>-<run-attempt>`. It contains:

- `checkpoint.json` (schema version 1): run key `<run-id>:<run-attempt>`, generation time, continuity metadata, and per-series observations.
- `dist/`: the static page and `status.json`, built from the same validated snapshot.

The restore step selects the newest eligible run (completed, successful, default branch, `schedule` or `workflow_dispatch`). The history window is 30 days. Observations are deduplicated by run and pruned outside the window.

- If no eligible run exists, the run is a first run (`historyResetReason: "first-run"`).
- If the newest eligible artifact has expired or been removed, the window restarts (`"expired-or-unavailable"`).
- Access denied, API failures, corrupt archives, and incompatible schema versions fail the run. They are never treated as empty history.

Artifact retention is requested as 30 days. The effective retention is whatever the repository's Actions policy allows. An expired artifact after a long gap is an explicit history loss.

## Public snapshot (`status.json`)

The page and `status.json` come from the same validated snapshot. Fields:

- `schemaVersion` (1), `runKey` (`null` for local no-data output), `generatedAt` (UTC).
- `checkIntervalSeconds` (300), `staleAfterSeconds` (900), `historyWindowDays` (30), `historyResetReason`.
- `sites[]`: `id`, `name`, `publicUrl` (no credentials or query string), `series.definitionRevision`, `latest` (or `null`), `window`, and `recentChecks` (up to 20, newest first).
- `window`: `startsAt`, `endsAt`, `firstObservedAt`, `successfulChecks`, `totalChecks`, `availabilityPercent`.

Interpreting the numbers:

- `availabilityPercent` is `100 × successfulChecks / totalChecks` over observed checks in the window. It is not continuous uptime. Gaps between observations are excluded, not counted as up or down.
- With no observations, `availabilityPercent` and `latest` are `null`. The page shows `No data`, never zero or one hundred.
- A result is a last observation. When `generatedAt` or the visitor's clock is more than 15 minutes past a site's latest observation, the page marks it overdue. An overdue result is not a new outage.
- A snapshot with a `runKey` must contain this run's observation for every enabled site. A malformed or incomplete supplied snapshot fails the build; it never becomes an empty page.

## Monitoring workflow

`.github/workflows/monitor.yml`:

- Triggers: `schedule` (`*/5 * * * *`) and `workflow_dispatch`, both on `main` only. Pull request events never run it.
- Permissions: `contents: read` and `actions: read`. No write access and no hosting credentials.
- Concurrency group `site-availability-monitor` with `cancel-in-progress: false`, so one checkpoint writer runs at a time. Delayed or queued runs produce gaps, not synthetic observations.
- Steps: `npm ci`, `npm run monitor` (validation, restore, checks, snapshot), `npm run release-check` (release hashes, see below), `npm run build`, then staging of `checkpoint.json` and `dist/`, then upload. The upload runs only after every earlier step succeeds.
- Timeouts: the job has a 15-minute limit. The probe budget is 10 minutes (`UPP_RUN_BUDGET_MS`), and the release-hash check has 2 minutes (`UPP_RELEASE_CHECK_BUDGET_MS`).
- Secrets: none are referenced today. Add each referenced secret to the monitor step's `env` as the target's `secret` name.

To run it manually, use **Actions → Site availability monitor → Run workflow** on `main`. Manual runs use the same configuration and output as scheduled runs.

Scheduled runs are best effort. GitHub may delay or skip them, so timestamps and sample counts show what was actually observed.

Download the output from the run's **Artifacts** section as `site-availability-<run-id>-<run-attempt>`. The archive contains `checkpoint.json` at its root and the static site under `dist/`.

## Homepage data wall

The homepage reads the same validated snapshot as `status.json` and draws it as a wall instead of a list of services. Nothing on it is measured separately.

- **Verdict band:** the overall state, a bar of up, down and no-data probes, and how old the newest observation is. The age is recomputed on the visitor's clock every 30 seconds.
- **Fleet pulse:** per monitor run, the median response time with the middle 80% of probes, and how many probes were down. Runs more than the freshness threshold apart are drawn as separate segments, so a gap stays a gap.
- **Response time by endpoint:** the latest response of every probe on a log scale, one lane per endpoint kind (page, sitemap, robots, RSS). A probe that never answered sits in a separate "no response" column.
- **Service board:** probes grouped into families by display name (`Docs`, `Docs Sitemap`, `Docs Robots`, `Docs RSS` form one row). Families with a down probe come first. A row opens to the full per-probe facts and recent checks.
- **Sync check:** one square per repository, mismatches first, with the same counts and link as before.

The charts are static SVG. `d3-scale` and `d3-shape` run only at build time and compute geometry in `src/lib/wall-charts.mjs`. Derived series live in `src/lib/wall.mjs`. The page ships a few lines of script for freshness and for the hover or focus readout. Every value is also present as text or in a visually hidden table, and the entrance animation is skipped under `prefers-reduced-motion`.

Grouping uses the display names, so renaming a probe can move it to another row. It never changes a probe's identity or history.

## Release hash status

`/release-hashes/` compares each registered repository's `main` head commit on GitHub with the commit its published site was built from, read from `/.well-known/hagilight.metadata.json`. The page is cross-linked from the service status page, and the same validated data is served as `/release-hash.json`.

The service status homepage shows a compact sync check entry directly after the availability summary and before the services list. It gives the sync state and the per-state counts, and links to `/release-hashes/`. It reads the same snapshot at build time, so a build without a snapshot shows the no-data entry, and an invalid snapshot fails the homepage build as it fails the release-hash page. A sync result never changes the availability summary, and an outage never changes the sync entry.

### Registry

The compared repositories are listed in `src/data/release-repositories.json`. Each entry has an `id` (lowercase, unique), a `name`, a GitHub `repository` as `owner/name`, `branch` (always `main`), and an `origin`. The origin must be an exact HTTPS origin: no path, query, fragment, trailing slash, or credentials. Invalid entries fail the check before any request is sent.

To add a repository, append an entry with a new `id`, make sure its site emits the well-known metadata file, and run `npm run release-check` locally with `GITHUB_TOKEN` set. Set `UPP_RELEASE_REGISTRY` to a different file to test a candidate registry without editing the committed one.

### States and reasons

| State | Meaning |
| --- | --- |
| `match` | Both hashes are known, and the published commit equals the `main` head or is a prefix of it with at least 7 characters. |
| `mismatch` | Both hashes are known and they differ. The page shows this as abnormal. |
| `unknown` | One side could not be read. The row shows a reason, and no comparison is inferred. |
| `No data` | The build has no snapshot, so the row is not checked yet. |

The summary is `abnormal` when any repository mismatches, `incomplete` when none mismatch but some are unknown, and `normal` only when every repository matches. Unknown reasons are one of: `github-not-found`, `github-forbidden`, `github-rate-limited`, `github-error`, `github-invalid-response`, `metadata-not-found`, `metadata-http-error`, `metadata-invalid`, `metadata-commit-unknown`, `too-large`, `timeout`, `dns`, `tls`, `redirect`, `network`, and `not-checked`.

### `release-hash.json`

- `schemaVersion` (1), `generatedAt` (UTC), and `runKey` (`null` only for the local no-data state; otherwise `<run-id>:<run-attempt>` or `local:<time>`).
- `repositories[]` in registry order: `id`, `name`, `repository`, `branch`, `publicOrigin`, `state`, `mainHash` (40 hex or `null`), `publishedHash` (7 to 64 hex or `null`), `publishedBranch`, `publishedBuiltAt`, `checkedAt`, and `reason` (`null` for `match` and `mismatch`).

The file never contains tokens or response bodies. Reasons are fixed categories, so response text cannot reach the output.

### Running the check

```sh
npm run release-check
```

The check reads `GITHUB_TOKEN` when it is set, and sends it only to `api.github.com`. Without a token, GitHub's anonymous rate limit applies and rate-limited repositories show as `unknown`. Each repository gets up to two attempts for timeouts and network errors only, with an 8-second timeout per request and four repositories at a time. The whole check must finish inside `UPP_RELEASE_CHECK_BUDGET_MS` (default `120000`). The worst case is checked before any request, so an impossible budget fails early.

Exit codes:

- `0`: the snapshot was written. Mismatches and unknowns are data and do not fail the run.
- `1`: validation or writing failed. The previous `.monitor-data/release-hash.json` is kept.
- `2`: the registry is invalid, the budget is invalid, or the worst case exceeds the budget. No request was made.

The snapshot is written to `.monitor-data/release-hash.json` (or `UPP_MONITOR_OUTPUT`), next to `status.json`.

### Local preview

`npm run build` without `.monitor-data/release-hash.json` renders every repository as `No data`, with no GitHub or site requests. A malformed or invalid file fails the build. To preview real results, run `npm run release-check` first, which makes network requests, and then `npm run build`.

### Assumptions

- Compared repositories are public and readable with the workflow's `GITHUB_TOKEN`. A private or missing repository shows as `unknown` with `github-not-found`.
- Every compared site serves `/.well-known/hagilight.metadata.json` with `schemaVersion` 1. A site that does not is shown as `unknown`, never as a mismatch.
- Origins are HTTPS. Redirects are followed at most five times, and each hop must also be HTTPS.
- Results are point-in-time observations. There is no history, and a site caught mid-deploy can show a short-lived mismatch until the next run.

## Branch-based publication

`.github/workflows/deploy-gh-pages.yml` publishes the validated artifact to `gh-pages`, following the OpenSpec Docs publication pattern. The branch contains `dist/` and `wrangler.jsonc` (Worker name `upp`).

- Triggers: `workflow_run` after a successful `Site availability monitor` run on `main`, and `workflow_dispatch` (optional `run_id`; default is the latest successful monitor run).
- It downloads the monitor artifact and publishes that `dist/`. It does not rebuild or probe, so the published page is exactly what the monitor validated. Checkpoints stay in Actions artifacts and are not published to the branch.
- Only the publisher has `contents: write`; the monitor remains read-only. Publication uses the built-in `GITHUB_TOKEN`, with no Cloudflare account ID or API token secrets.

Connect the Cloudflare project's Git integration to the `gh-pages` branch. The output is already built: use no install/build step (or a no-op where required), and deploy the root `wrangler.jsonc` with assets in `dist/`. Configure the custom domain in the hosting dashboard. A successful GitHub publication confirms the branch update; the hosting platform manages the subsequent deployment.

Each publication replaces `gh-pages` with a single latest commit (`force_orphan: true`), matching OpenSpec Docs. To roll back, publish a previous successful monitor run using `run_id`; do not rely on branch history. Organization policy must allow the publisher's `GITHUB_TOKEN` to write repository contents.
