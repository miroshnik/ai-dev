# A project's CI with the spec skill — workflow fragment

The "Wiring into a repository" section of `SKILL.md`, item 4: pnpm
(`packageManager` in `package.json`), Vitest in 3 shards, Playwright in 2;
concurrency — per `docs/ci-concurrency.md`. The shards write blob reports, the
`spec` job merges them with the runners' own tools and builds `docs/spec` with
`--strict`; on `main` it hands it as an artifact to the `spec-publish` job —
the only one with a write token (no CI on `main` — publishing on PR merge,
section at the end). `spec-diff` is its own light job after `spec`: git
history, Node and the merged reports (harness tests are visible only in the
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
  unit:
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false
      matrix: { shard: [1, 2, 3] }
    steps:
      - uses: actions/checkout@v7
      - uses: pnpm/action-setup@v6
      - uses: actions/setup-node@v7
        with: { node-version: 24, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: >-
          pnpm exec vitest run --shard=${{ matrix.shard }}/${{ strategy.job-total }}
          --reporter=default --reporter=blob --outputFile.blob=vitest-blob/${{ matrix.shard }}.json
      - uses: actions/upload-artifact@v7
        with: { name: 'vitest-blob-${{ matrix.shard }}', path: vitest-blob/, retention-days: 1 }
      - uses: actions/upload-artifact@v7 # entry-point log — for spec-claims
        with: { name: 'spec-journal-unit-${{ matrix.shard }}', path: .spec-journal/, retention-days: 1, include-hidden-files: true }
      - uses: actions/upload-artifact@v7 # example code and exception reasons — for spec-doc
        with: { name: 'spec-meta-unit-${{ matrix.shard }}', path: .spec-meta/, retention-days: 1, include-hidden-files: true }

  e2e:
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false
      matrix: { shard: [1, 2] }
    steps:
      - uses: actions/checkout@v7
      - uses: pnpm/action-setup@v6
      - uses: actions/setup-node@v7
        with: { node-version: 24, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm exec playwright install --with-deps
      - run: pnpm exec playwright test --shard=${{ matrix.shard }}/${{ strategy.job-total }} --reporter=dot,blob
      - uses: actions/upload-artifact@v7
        with: { name: 'playwright-blob-${{ matrix.shard }}', path: blob-report/, retention-days: 1 }
      - uses: actions/upload-artifact@v7
        with: { name: 'spec-journal-e2e-${{ matrix.shard }}', path: .spec-journal/, retention-days: 1, include-hidden-files: true }

  spec:
    needs: [unit, e2e]
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: pnpm/action-setup@v6
      - uses: actions/setup-node@v7
        with: { node-version: 24, cache: pnpm }
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
      - uses: actions/setup-node@v7
        with: { node-version: 24, package-manager-cache: false }
      - uses: actions/download-artifact@v8
        with: { name: docs-spec, path: docs/spec }
      - run: node .agents/skills/spec/scripts/spec-publish.ts

  spec-diff:
    if: github.event_name == 'pull_request'
    needs: spec
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
        with: { fetch-depth: 0 } # merge-base with the base branch, and the spec branch
      - uses: actions/setup-node@v7
        with: { node-version: 24, package-manager-cache: false }
      - uses: actions/download-artifact@v8
        with: { name: spec-reports }
      - run: node .agents/skills/spec/scripts/spec-diff.ts --base "origin/${{ github.base_ref }}" --report .spec-report.json --report .spec-playwright.json --report .spec-claims.xml --full >> "$GITHUB_STEP_SUMMARY"
```

The `.spec-*` reports and logs are hidden files: `upload-artifact` skips them
without `include-hidden-files: true`, and the artifact comes out empty.

No Playwright — no `e2e` job, no steps for it in `spec` and no second report
in `spec:doc`. No shards — the same steps in one job: a run with JSON reports,
`spec:doc`, the artifact on `main`; `spec-publish` stays separate as well.
ai-dev itself runs on Bun — its `.github/workflows/ci.yml` is no model for a
project on Node.

The `main` run is in its own group (`github.run_id`): the tests need no shared
resource, and `queue: max` doesn't combine with cancelling PR runs in one
workflow. Only `spec-publish` has a queue; publications don't go in merge
order, and the "already newer" check (`spec-publish` prints `already newer`) keeps
an old one from landing over a new one — hence the checkout with history. A
deploy can't do this in the same workflow — it needs merge order: a separate
workflow (`docs/ci-concurrency.md`).

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
      - uses: actions/setup-node@v7
        with: { node-version: 24, package-manager-cache: false }
      - name: docs/spec from the run that checked the merge tree
        run: |
          tree=$(git rev-parse 'HEAD^{tree}')
          run=$(node .agents/skills/spec/scripts/spec-run.ts --tree "$tree")
          [ -n "$run" ] || exit 0 # skip: the reason is in spec-run's line above
          gh run download "$run" --name "docs-spec-$tree" --dir docs/spec
          node .agents/skills/spec/scripts/spec-publish.ts --source "$MERGE_SHA"
```

- Only a tree checked in full is published: the artifact is named after the
  merge-ref tree the PR run tested, and publishing looks it up by the merge
  commit's tree. Nothing was merged into `main` between the run's start and
  the merge — the trees are equal with merge, squash and rebase. A PR that
  fell behind is merged — there is no such artifact: `spec-run` writes
  `main tree not checked in full — publication skipped`, the job is green, the `spec` branch
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
