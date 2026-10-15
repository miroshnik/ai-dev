# A project's CI with the spec skill — workflow fragment

The "Wiring into a repository" section of `SKILL.md`, item 4: pnpm
(`packageManager` in `package.json`), standards and architecture in one
`test-spec` job, the rest of Vitest in 3 shards, Playwright in 2 — the
shard's files by the last green run's durations (`spec-shard`, section
"Shards by durations");
concurrency — per `docs/ci-concurrency.md`. `test-spec` runs the `test:spec`
script once per run, without shards and browsers: standards and architecture
are static checks over the code (`checks.md`); `unit` runs `test`, which
excludes them, `e2e` — only the browser tests. The jobs call the project's
scripts, not the runner directly: the split between `test` and `test:spec` is
in one place (only the shard listing repeats `test`'s `--exclude`), and
locally the same scripts run what CI runs. The scripts are
wrapped in `slot` under Bun (the `slot` skill; no queue in CI) — hence
`oven-sh/setup-bun@v2` in those jobs. The jobs write blob reports, the
`spec` job merges them with the runners' own tools and builds `docs/spec` with
`--strict`; on `main` it hands it as an artifact to the `spec-publish` job —
the only one with a write token (no CI on `main` — publishing on PR merge,
section at the end). The skill's scripts run under Bun: `oven-sh/setup-bun@v2`
next to the project's Node in `spec`, instead of it in `spec-publish` and
`spec-diff`. `spec-diff` is its own light job after `spec`: git
history, Bun and the merged reports (harness tests are visible only in the
report; their base is the `tests.json` of the `spec` branch). The
`.spec-claims.xml` claims report goes there too: its tests are in `tests.json`,
and without the report they show up as "deleted" in every PR.

```yaml
on:
  pull_request:
  push:
    branches: [main]

concurrency: # main — a run gets its own group: it doesn't wait and isn't displaced; the queue is at spec-publish
  group: ci-${{ github.event.pull_request.number || github.run_id }}
  cancel-in-progress: ${{ github.event_name == 'pull_request' }}

jobs:
  test-spec: # standards and architecture — once per run, no shards: green or red in a minute
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: pnpm/action-setup@v6
      - uses: actions/setup-node@v7
        with: { node-version: 24, cache: pnpm }
      - uses: oven-sh/setup-bun@v2 # package.json checks go through slot under Bun
      - run: pnpm install --frozen-lockfile
      - run: pnpm test:spec --reporter=default --reporter=blob --outputFile.blob=vitest-blob/spec.json
      - uses: actions/upload-artifact@v7
        with: { name: vitest-blob-spec, path: vitest-blob/, retention-days: 1 }
      - uses: actions/upload-artifact@v7 # example code and exception reasons — for spec-doc
        with: { name: spec-meta-spec, path: .spec-meta/, retention-days: 1, include-hidden-files: true }

  unit:
    runs-on: ubuntu-latest
    permissions: { contents: read, actions: read } # spec-run and gh run download: the last green run's reports
    strategy:
      fail-fast: false
      matrix: { shard: [1, 2, 3] }
    steps:
      - uses: actions/checkout@v7
      - uses: pnpm/action-setup@v6
      - uses: actions/setup-node@v7
        with: { node-version: 24, cache: pnpm }
      - uses: oven-sh/setup-bun@v2
      - run: pnpm install --frozen-lockfile
      - name: the last green run's reports — durations for the shard
        continue-on-error: true # without them the shards split by count
        env: { GH_TOKEN: '${{ github.token }}' }
        run: |
          run=$(bun --no-env-file .agents/skills/spec/scripts/spec-run.ts --artifact spec-reports)
          [ -z "$run" ] || gh run download "$run" --name spec-reports --dir .spec-last
      # the files of test (the same --exclude: standards and architecture — test-spec) by the durations, not --shard
      - run: |
          pnpm exec vitest list --filesOnly --json=.spec-files.json --exclude 'tests/standards/**' --exclude 'tests/architecture/**'
          files=$(bun --no-env-file .agents/skills/spec/scripts/spec-shard.ts --shard ${{ matrix.shard }}/${{ strategy.job-total }} --runner vitest --list .spec-files.json --report .spec-last/.spec-report.json)
          [ -n "$files" ] || { echo "shard ${{ matrix.shard }}: no files"; exit 0; } # without filters the runner would run everything
          list=(); while IFS= read -r f; do list+=("$f"); done <<< "$files"
          pnpm test "${list[@]}" --reporter=default --reporter=blob --outputFile.blob=vitest-blob/${{ matrix.shard }}.json
      - uses: actions/upload-artifact@v7
        with: { name: 'vitest-blob-${{ matrix.shard }}', path: vitest-blob/, retention-days: 1 }
      - uses: actions/upload-artifact@v7 # entry-point log — for spec-claims
        with: { name: 'spec-journal-unit-${{ matrix.shard }}', path: .spec-journal/, retention-days: 1, include-hidden-files: true }
      - uses: actions/upload-artifact@v7 # example code and exception reasons — for spec-doc
        with: { name: 'spec-meta-unit-${{ matrix.shard }}', path: .spec-meta/, retention-days: 1, include-hidden-files: true }

  e2e:
    runs-on: ubuntu-latest
    permissions: { contents: read, actions: read }
    strategy:
      fail-fast: false
      matrix: { shard: [1, 2] }
    steps:
      - uses: actions/checkout@v7
      - uses: pnpm/action-setup@v6
      - uses: actions/setup-node@v7
        with: { node-version: 24, cache: pnpm }
      - uses: oven-sh/setup-bun@v2 # spec-run, spec-shard
      - run: pnpm install --frozen-lockfile
      - run: pnpm exec playwright install --with-deps
      - name: the last green run's reports — durations for the shard
        continue-on-error: true
        env: { GH_TOKEN: '${{ github.token }}' }
        run: |
          run=$(bun --no-env-file .agents/skills/spec/scripts/spec-run.ts --artifact spec-reports)
          [ -z "$run" ] || gh run download "$run" --name spec-reports --dir .spec-last
      # only the browser tests: no test or test:spec step here; the login project (dependencies) runs in every shard by itself
      - run: |
          PLAYWRIGHT_JSON_OUTPUT_NAME=.spec-files.json pnpm exec playwright test --list --reporter=json
          files=$(bun --no-env-file .agents/skills/spec/scripts/spec-shard.ts --shard ${{ matrix.shard }}/${{ strategy.job-total }} --runner playwright --list .spec-files.json --report .spec-last/.spec-playwright.json)
          [ -n "$files" ] || { echo "shard ${{ matrix.shard }}: no files"; exit 0; }
          list=(); while IFS= read -r f; do list+=("$f"); done <<< "$files"
          pnpm exec playwright test "${list[@]}" --reporter=dot,blob
      - uses: actions/upload-artifact@v7
        with: { name: 'playwright-blob-${{ matrix.shard }}', path: blob-report/, retention-days: 1 }
      - uses: actions/upload-artifact@v7
        with: { name: 'spec-journal-e2e-${{ matrix.shard }}', path: .spec-journal/, retention-days: 1, include-hidden-files: true }

  spec:
    needs: [test-spec, unit, e2e]
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: pnpm/action-setup@v6
      - uses: actions/setup-node@v7
        with: { node-version: 24, cache: pnpm }
      - uses: oven-sh/setup-bun@v2 # the spec scripts: spec:claims, spec:doc
      - run: pnpm install --frozen-lockfile
      - uses: actions/download-artifact@v8
        with: { pattern: vitest-blob-*, path: vitest-blob, merge-multiple: true }
      - uses: actions/download-artifact@v8
        with: { pattern: playwright-blob-*, path: playwright-blob, merge-multiple: true }
      - uses: actions/download-artifact@v8
        with: { pattern: spec-journal-*, path: .spec-journal, merge-multiple: true }
      - uses: actions/download-artifact@v8
        with: { pattern: spec-meta-*, path: .spec-meta, merge-multiple: true }
      - run: pnpm spec:claims # every entry point is called by a capability test; the report goes to spec:doc
      - run: pnpm exec vitest --merge-reports=vitest-blob --reporter=json --outputFile.json=.spec-report.json
      - run: pnpm exec playwright merge-reports --reporter=json playwright-blob
        env: { PLAYWRIGHT_JSON_OUTPUT_NAME: .spec-playwright.json }
      - run: pnpm spec:doc
      - if: github.event_name == 'push'
        uses: actions/upload-artifact@v7
        with: { name: docs-spec, path: docs/spec/, retention-days: 1 }
      - if: github.event_name == 'pull_request'
        uses: actions/upload-artifact@v7
        with:
          name: spec-reports
          path: |
            .spec-*.json
            .spec-claims.xml
          retention-days: 1
          include-hidden-files: true

  spec-publish:
    if: github.event_name == 'push'
    needs: spec
    runs-on: ubuntu-latest
    permissions: { contents: write } # push to the spec branch — only here
    concurrency: { group: spec-publish, queue: max } # a pending publication isn't displaced by the next one
    steps:
      - uses: actions/checkout@v7
        with: { fetch-depth: 0 } # main runs are parallel: history for the "already newer" check
      - uses: oven-sh/setup-bun@v2
      - uses: actions/download-artifact@v8
        with: { name: docs-spec, path: docs/spec }
      - run: bun --no-env-file .agents/skills/spec/scripts/spec-publish.ts

  spec-diff:
    if: github.event_name == 'pull_request'
    needs: spec
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
        with: { fetch-depth: 0 } # merge-base with the base branch, and the spec branch
      - uses: oven-sh/setup-bun@v2
      - uses: actions/download-artifact@v8
        with: { name: spec-reports }
      - run: bun --no-env-file .agents/skills/spec/scripts/spec-diff.ts --base "origin/${{ github.base_ref }}" --report .spec-report.json --report .spec-playwright.json --report .spec-claims.xml --full >> "$GITHUB_STEP_SUMMARY"
```

The publish job is named `spec-publish` (in a reusable workflow — `<job> /
spec-publish`): by this name `github pr premerge` doesn't count its red as a
red `main`, and `ci-wait` doesn't wait for it — publishing the documentation
isn't a check (#443).

The `.spec-*` reports and logs are hidden files: `upload-artifact` skips them
without `include-hidden-files: true`, and the artifact comes out empty.

No Playwright — no `e2e` job, no steps for it in `spec` and no second report
in `spec:doc`. No shards — `unit` without the matrix and the shard steps, `pnpm test`
as is; `test-spec` stays a job
of its own: it doesn't wait for the long branch, and a broken standard is
visible in a minute. `spec-publish` stays separate as well.
ai-dev itself runs on Bun — its `.github/workflows/ci.yml` is no model for a
project on Node.

The `main` run is in its own group (`github.run_id`): the tests need no shared
resource, and `queue: max` doesn't combine with cancelling PR runs in one
workflow. Only `spec-publish` has a queue; publications don't go in merge
order, and the "already newer" check (`spec-publish` prints `already newer`) keeps
an old one from landing over a new one — hence the checkout with history. A
deploy can't do this in the same workflow — it needs merge order: a separate
workflow (`docs/ci-concurrency.md`).

## Shards by durations

A runner's `--shard` doesn't look at time: Playwright cuts the suite in a row
by the count of tests, Vitest — files by the hash of the path; the heavy tests
of one folder land in one shard, the PR waits for it. The shard step lists the
run's files with the runner (`vitest list --filesOnly`, `playwright test
--list`), `spec-shard` lays them out greedily — the longest into the lightest
shard — by the durations of the last green run and prints the shard's filters,
the runner gets them as positional arguments. Merging the blob reports and the
`spec` job don't change.

- Durations — the `spec-reports` artifact of the `spec` job (the merged
  `.spec-report.json` and `.spec-playwright.json`): `spec-run --artifact`
  finds the newest green run with it, `gh run download` fetches it — hence
  `actions: read`. It is uploaded on PRs and lives a day: no artifact (the
  first run, a day without PRs) — the files split equally by count, a new
  file gets the mean. The step is `continue-on-error`: durations are an
  optimization, not a check.
- `vitest list` doesn't run the `test` script: its `--exclude` is repeated in
  the listing — keep them equal, otherwise standards land in the unit shards'
  layout and `test` drops them.
- An empty shard (more shards than files) doesn't start the runner: without
  filters it would run everything.
- A filter is what the runner understands: Vitest — the path (a substring),
  Playwright — an escaped regular expression anchored at the end of the path.
  A filter that also takes another file (`tests/a.test.ts` in
  `packages/web/tests/a.test.ts`) — both go into one shard, a stderr line
  says so.
- A Playwright dependency project (login before the tests) runs in every
  shard: the runner adds dependencies without the filters.
- The unit is a file: a file longer than a shard's share stays the bound —
  split the file.

## No CI on `main` — publishing on PR merge

A project whose whole CI runs on PRs, with no tests run on `main`, publishes
from the PR's own run: the `spec` job hands `docs/spec` as an artifact on PRs
too, and a light workflow on merge downloads it and calls `spec-publish`. With
CI on `main` — the variant above: it builds what actually ended up in `main`.
Without it — this one; there is no need to bring back CI on `main` for the
documentation.

In the workflow above: `on` is only `pull_request`, there is no `spec-publish`
job, and in the `spec` job the artifact is uploaded on every run, named after
the tree the run checked, and lives longer than the PR waits for its merge:

```yaml
      - id: tree # the tree the run checked: the PR's merge-ref
        run: echo "tree=$(git rev-parse 'HEAD^{tree}')" >> "$GITHUB_OUTPUT"
      - uses: actions/upload-artifact@v7
        with: { name: 'docs-spec-${{ steps.tree.outputs.tree }}', path: docs/spec/, retention-days: 30 }
```

Publishing is its own workflow, `.github/workflows/spec-publish.yml`:

```yaml
on:
  pull_request:
    types: [closed]
    branches: [main]

jobs:
  spec-publish:
    if: github.event.pull_request.merged == true # a PR closed without a merge doesn't publish
    runs-on: ubuntu-latest
    permissions: { contents: write, actions: read } # push to the spec branch, the PR run's artifact
    concurrency: { group: spec-publish, queue: max } # a pending publication isn't displaced by the next one
    env:
      GH_TOKEN: ${{ github.token }}
      MERGE_SHA: ${{ github.event.pull_request.merge_commit_sha }}
    steps:
      - uses: actions/checkout@v7
        with: { ref: '${{ github.event.pull_request.merge_commit_sha }}', fetch-depth: 0 } # history for the "already newer" check
      - uses: oven-sh/setup-bun@v2
      - name: docs/spec from the run that checked the merge tree
        run: |
          tree=$(git rev-parse 'HEAD^{tree}')
          run=$(bun --no-env-file .agents/skills/spec/scripts/spec-run.ts --tree "$tree")
          [ -n "$run" ] || exit 0 # skip: the reason is in spec-run's line above
          gh run download "$run" --name "docs-spec-$tree" --dir docs/spec
          bun --no-env-file .agents/skills/spec/scripts/spec-publish.ts --source "$MERGE_SHA"
```

- Only a tree checked in full is published: the artifact is named after the
  merge-ref tree the PR run tested, and publishing looks it up by the merge
  commit's tree. Nothing was merged into `main` between the run's start and
  the merge — the trees are equal with merge, squash and rebase. A PR that
  fell behind is merged — there is no such artifact: `spec-run` writes
  `main tree … not fully checked — publishing skipped`, the job is green, the `spec` branch
  lags until the next merge with a matching tree but doesn't roll back. This
  doesn't require the PR's branch to be up to date.
- An artifact doesn't yet mean a green run: `spec-run` takes only a run of
  this repository (not a fork) with the `success` conclusion; it waits for one
  in progress (cap `--timeout`, 30 min); not finished by the cap — the job
  fails with the reason.
- `--source` is the merge SHA, not the PR head: after squash and rebase the
  head doesn't land in `main`'s history, and `spec-diff` takes the base for
  harness tests from the publication whose `Source:` is an ancestor of
  merge-base.
- `spec-publish` doesn't publish over a newer one: the published `Source:` is
  a descendant of the new source → "already newer", exit code 0; that's why
  the checkout has history.
- After a skip, the publication is older than the merge-base of the following
  PRs — `spec-diff` says so in a line under "Base".

## The host builds every branch

Vercel (and any host with git integration for all branches) also builds the
`spec` branch — by the config from its tree, which has neither code nor a
`package.json`: on every publication, a failed build and an email about it. A
config without deploys goes into `docs/spec` before `spec-publish` (in both
variants above):

```yaml
      - name: spec branch — no Vercel deploy
        run: |
          echo '{ "git": { "deploymentEnabled": false } }' > docs/spec/vercel.json
```

The main branch's `vercel.json` doesn't apply to `spec`: it has its own tree.
