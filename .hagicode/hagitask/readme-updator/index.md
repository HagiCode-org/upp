---
public: true
multilingual: false
style: product
---

# README requirements

## Product focus

- Present `upp` as the static status page for HagiCode sites: it shows whether each monitored site is up, how fast it responds, its availability over the last 30 days and its recent checks, and whether each site's published build matches its repository `main`.
- Main features users get: an overall verdict with a per-site service board and response-time charts, a release hash status page, machine-readable `status.json` and `release-hash.json`, and an explicit `No data` state instead of invented numbers.
- Address people checking whether HagiCode sites are available, and maintainers who choose which sites are monitored.
- Lead with what the page tells a reader, then how to run it and configure the monitored sites.

## Required content

- Open with a short introduction of the status page and what each result means, including that availability covers observed checks only and that an overdue result is not a new outage.
- Describe the homepage and the release hash status page as visitors see them, and the public snapshot fields at the level readers need.
- Show install and commands, and the site manifest configuration (keys and defaults) used to choose monitored sites. Commands must match the `package.json` scripts.

## Exclusions

- Exclude Cloudflare account identifiers, tokens, secret values, internal hosts, machine-specific paths and private links.
- Keep repository maintenance instructions out of the README: repository layout, internal architecture, history checkpoints, the monitoring workflow, branch-based publication, CI and build internals, and contribution workflow.
