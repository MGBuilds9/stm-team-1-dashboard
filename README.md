# Basketball Team Dashboard

A reusable, offline-capable command center for one basketball team. Each team
gets its own Git repository and configuration while inheriting product upgrades
from this canonical base.

## What it includes

- Team-first schedule and results with official game links
- Direct YouTube game links when an exact upload is verified, plus a visually
  distinct league-channel fallback while the upload is pending
- Standings, roster, team leaders, and contextual league leaders
- Team statistics derived from published completed-game tables
- Local two-team box scores with official provider links
- Dark and light themes, desktop sidebar, mobile bottom rail, and noindex controls

## Data integrity

The app does not scrape a league in the browser. `npm run sync` selects the adapter
declared in `config/team.json`, whitelists a provider response into `TeamSnapshot`
V3 from Basketball OS, computes its canonical semantic hash, validates it with the
shared public contract, and writes only normalized data. A malformed or
inconsistent update fails before it can replace the last-known-good snapshot.
The V3 snapshot and strict receipt are one data pair: sync accepts an empty first
run only when both are absent, while sync and release fail closed if either file
is missing, malformed, or no longer describes the other.

Game-video availability is explicit: `verified_exact` opens the reviewed game
upload, `channel_only` links to the configured league channel with a reason, and
`not_expected` is limited to canceled and bye games. Exact links survive source
outages and are never replaced automatically by a different upload.

`npm run import:release` is the signed consumer boundary. It verifies the exact
Basketball OS release bytes, Ed25519 signature, team/league/season scope, sequence,
previous digest, audience, and video transitions before atomically replacing the
last-known-good release triplet. Team projects pin their allowed public keys in
`config/release-trust.json`; the reusable base intentionally ships with no trusted
production key.

STM pages are parsed from server-rendered HTML. TeamLinkt standings and leaders are
derived from official season scores and published event stat lines because its
public standings screen can default to another division. Provider responses are
never committed raw.

## Local development

Node 22 is the supported runtime.

```bash
npm ci --ignore-scripts
npm run sync
npm run dev
```

Useful gates:

```bash
npm run lint
npm test
npm run build
npm run test:e2e
```

`npm run fixtures:capture` refreshes sanitized STM parser fixtures. Provider-neutral
and TeamLinkt normalization tests run with `npm test`.

`npm run migrate:snapshot` upgrades an existing V2 snapshot and its sibling
receipt together, maps legacy video fields into the V3 union, recomputes the
semantic content hash, and writes the deterministic V3 receipt first and snapshot
last. An interrupted migration can resume only from the exact recomputable
V2-snapshot/V3-receipt state; a V3 snapshot without its exact V3 receipt fails
closed.

## Create a team project

Clone this repository, replace `config/team.json`, empty
`config/video-overrides.json`, run `npm run sync`, and commit the team configuration.
Keep this repository as the child project’s `upstream` remote:

```bash
git remote add upstream https://github.com/MGBuilds9/basketball-team-dashboard.git
git fetch upstream
git merge upstream/main
```

The base currently supports `stm` and `teamlinkt`. See
`config/tax-collectors.team.json` for a TeamLinkt example. Direct-video overrides
are keyed by stable game ID and are accepted only when YouTube confirms the video
belongs to the configured league channel.

## Branch and release model

- `main`: application code, tests, configuration, and workflows
- `data`: `snapshot.json` and `receipt.json` only
- `publish.yml`: the only production path

The sync workflow runs at 07:17, 15:17, and 23:17 America/Toronto and supports
manual dispatch. An unchanged source check stops before a data commit, browser test,
build, or deployment. A changed source produces one data commit and calls the shared
publish workflow. The publish workflow tests a resolved `main`/`data` pair, rejects
stale queued work, and deploys the exact uploaded artifact.

CI, sync, and publish verify the current data commit and its exact parent before
copying or building. The bounded depth-two check proves that the release edge has
zero or one parent and that `receipt.previousHash` names that parent snapshot; it
does not claim to audit every older commit in the branch. Sync re-verifies a newly
created data commit before push, so an interrupted or rejected run leaves the
remote last-known-good pair unchanged.

The transaction boundary is the two-file Git commit, not an atomic local
filesystem swap. If a direct local `npm run sync` process is interrupted while
replacing the pair, restore both files from the last committed `data` revision
before retrying.

Scheduled GitHub Actions can still be delayed by GitHub’s scheduler.

## Privacy and indexing

GitHub Pages is public hosting. This application is unlisted, not private. It ships
`noindex,nofollow,noarchive`, a deny-all `robots.txt`, and no analytics.
