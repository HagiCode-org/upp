# upp

Static status page for HagiCode sites. A scheduled GitHub Actions workflow checks each enabled site, keeps a bounded history in an Actions artifact, and builds an Astro page that shows the last observed results. The page reuses the shared presentation from [`@hagicode/hagilight`](https://www.npmjs.com/package/@hagicode/hagilight) (pinned to `0.13.0`).

Outages are recorded as data. The workflow fails only for configuration, history, validation, or build problems.

## Install and commands

```sh
npm ci              # installs from package-lock.json
npm test            # node --test over tests/**
npm run build       # astro build into dist/
npm run monitor     # probe enabled sites and write .monitor-data/
```

Node 24 or later is required. Installing `@hagicode/hagilight` pulls in its Astro integration; the Astro version it supports is `>=7`.

### Local no-data preview

`npm run build` with no `.monitor-data/status.json` renders every enabled site in the explicit no-data state (`No data`, `No monitoring snapshot is present in this build`). Building and viewing the page make no monitoring requests. Only `npm run monitor` probes sites.

To render a real snapshot locally, run `npm run monitor` first (it probes the configured sites over the network) and then `npm run build`.

## Configuration

The site list is read from a manifest in the existing Upptime layout (`sites:` with `name`, `url`, and optional `slug`, `expectedStatusCodes`, `method`, `headers`, `timeoutMs`, `maxAttempts`, `enabled`). Set the path with `UPP_SITE_MANIFEST`. The default is `.upptimerc.yml` at the package root.

> **Open item:** the manifest path default and the handling of Upptime's body-text checks (`__dangerous__body_down_if_text_missing`) are still being decided. The current loader rejects that key by name, so the Upptime manifest at `repos/upptime/.upptimerc.yml` is not accepted as-is.

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

Any other key is rejected before probing. A rename changes the derived identity, so set `slug` to keep a site's history when renaming.

Each target carries a `definitionRevision` computed from the unresolved request (method, URL, accepted statuses, header names and secret names, timeout, attempts). Changing a request definition starts a new series. Display names, ordering, and secret values do not.

Monitoring needs every secret referenced by an enabled target. Missing secrets fail preflight before any request is sent. Presentation reads never resolve secrets.

## Monitoring behavior

- Redirects are followed up to 10 hops, and every hop must be HTTP or HTTPS. Authentication headers are sent only to the original origin.
- An attempt covers the whole request, redirects included, under one timeout.
- Up to 4 targets run concurrently. A slow or failing target does not hold up the others.
- A failed attempt is retried once by default. The run keeps one final observation per target.
- Response time is measured to response headers, in milliseconds. Transport failures have no response time.
- Response bodies are never read or stored.
- Failure categories: `unexpected-status`, `timeout`, `dns`, `tls`, `redirect`, `network`.
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
- Steps: `npm ci`, `npm run monitor` (validation, restore, checks, snapshot), `npm run build`, then staging of `checkpoint.json` and `dist/`, then upload. The upload runs only after every earlier step succeeds.
- Timeouts: the job has a 15-minute limit. The probe budget is 10 minutes (`UPP_RUN_BUDGET_MS`).
- Secrets: none are referenced today. Add each referenced secret to the monitor step's `env` as the target's `secret` name.

To run it manually, use **Actions → Site availability monitor → Run workflow** on `main`. Manual runs use the same configuration and output as scheduled runs.

Scheduled runs are best effort. GitHub may delay or skip them, so timestamps and sample counts show what was actually observed.

Download the output from the run's **Artifacts** section as `site-availability-<run-id>-<run-attempt>`. The archive contains `checkpoint.json` at its root and the static site under `dist/`.

## Cloudflare deployment

`.github/workflows/deploy-cloudflare.yml` publishes the artifact's `dist/` as Cloudflare Workers static assets (`wrangler.jsonc`, Worker name `upp`).

- Triggers: `workflow_run` after a successful `Site availability monitor` run on `main`, and `workflow_dispatch` (optional `run_id`; default is the latest successful monitor run).
- It downloads the monitor artifact and deploys that `dist/`. It does not rebuild or probe, so the published page is exactly what the monitor validated.
- Only this workflow uses hosting credentials. The monitor workflow still has none.

Required repository secrets: `CLOUDFLARE_API_TOKEN` (permission: Workers Scripts: Edit) and `CLOUDFLARE_ACCOUNT_ID`. Attach the custom domain (for example `status.hagicode.com`, matching `UPP_SITE_URL`) to the `upp` Worker in the Cloudflare dashboard, or add a `routes` entry to `wrangler.jsonc`.
