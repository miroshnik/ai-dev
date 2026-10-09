# CI: parallel tasks — the rule and workflow fragments

A reference for the "CI: parallel tasks" section of `AGENTS.md`: here is the
full rule and ready-made fragments to copy.

## Rule

Every branch and every PR runs independently; only the branch's own stale run
is cancelled. Serialization — only where there is a shared resource (a deploy
environment, a shared database, an external service with limits). One queue
for all of CI is not a solution: it slows down every task, and without
`queue: max` it also cancels pending runs. Workflow fragments — below.

- **Branches and PRs run in parallel:** a `concurrency` group by PR number or
  branch, `cancel-in-progress: true`.
- **`main`, tags and manual runs are never cancelled:** their runs deploy, and
  an interrupted deploy is worse than an extra run. Instead of cancelling —
  `queue: max` (by default GitHub keeps one pending run and evicts it with the
  next one: a third merge in a row would cancel the second).
- **Deploy — a queue per environment:** the deploy job has the group
  `deploy-<env>`, shared by all workflows of the repository, and `queue: max`.
  Without it the job queue evicts pending jobs, just as at the workflow level:
  at run time the environment's third deploy job cancels the waiting second
  one, and a manual run cancels a waiting tag deploy.
- **CI and deploy — in different workflows:** `queue: max` is incompatible
  with `cancel-in-progress: true`. In one workflow —
  `cancel-in-progress: ${{ github.event_name == 'pull_request' }}` without
  `queue: max`: the deploy won't be interrupted, but a pending run may be
  evicted.
- **The agent doesn't cancel or re-run others' runs** (`gh run cancel` and
  `gh run rerun` — only its own run on its own branch). Waiting for its own
  checks and merging — the "Git, PRs and merging" section of `AGENTS.md`.

## Workflow fragments

Checked against the GitHub Actions documentation ("Control the concurrency of
workflows and jobs"): `queue: max` allows up to 100 pending runs (beyond that
they are cancelled) and is incompatible with `cancel-in-progress: true`;
`false` is the default; `queue` also works on `jobs.<id>.concurrency`, which
is supported on a job with `uses:` (reusable workflow) too;
`cancel-in-progress` accepts expressions; a deploy job's group is shared
across the repository, so the same name in different workflows gives one
queue.

```yaml
# ci.yml — branches and PRs in parallel; a branch's stale run is cancelled
on:
  pull_request:
concurrency:
  group: ci-${{ github.event.pull_request.number || github.ref }}
  cancel-in-progress: true
```

```yaml
# cd.yml — main, tags, manual runs: nothing is cancelled, runs wait in a queue
on:
  push:
    branches: [main]
    tags: ['v*']
  workflow_dispatch:
concurrency:
  group: cd-${{ github.ref }}
  queue: max
jobs:
  deploy-dev:
    concurrency:
      group: deploy-dev          # environment = queue, shared by all workflows
      queue: max                 # the next deploy doesn't evict a pending one
```

If CI and deploy are in one workflow (they can't be split right now):

```yaml
concurrency:
  group: ${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}
  cancel-in-progress: ${{ github.event_name == 'pull_request' }}
```

A running deploy on `main` won't be interrupted this way, but of three merges
in a row the third run evicts the pending second one — the third deploys
everything together, and the second commit is left without a CI status on
`main`.
