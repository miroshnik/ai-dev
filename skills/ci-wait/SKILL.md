---
name: ci-wait
description: Waiting for all checks of a PR or commit (CI in GitHub Actions, the host's deploy, an external check) with a script that shows progress and has the outcomes PASS / FAIL / TIMEOUT / ERROR. When — after a push, before merging a PR; after a merge, before reporting "done", if the merge triggers a deploy (`merged <N>` — the script takes the merge SHA itself); whenever you need to wait for CI or a deploy, instead of `gh pr checks --watch`, `sleep` in a loop and manual polling; `issue <N>` — for the closing of the bug on a red main (`github pr premerge`, exit code 3).
allowed-tools: Bash(bash *skills/ci-wait/scripts/wait-ci.sh *) Bash(gh pr checks *) Bash(gh pr view *) Bash(git rev-parse *)
---

# ci-wait — wait for checks, don't guess

Waiting for CI and deploys must be observable, time-bounded and complete in
its outcomes. `gh pr checks --watch` right after a push confuses "checks not
registered yet" with "passed", `sleep` in a loop doesn't show what is
happening, and manual polling gets forgotten. The `scripts/wait-ci.sh` script
next to this file does it all deterministically; the agent only reads the
outcome.

Run it from the repository directory (or with `GH_REPO=owner/repo`); in the
background — from a directory that will outlive the wait (the main checkout,
not a worktree that will be removed earlier): a directory removed meanwhile
gives `ERROR getcwd`. As a background command — **without `| tail` or other
filters**: the result is the `RESULT:` line in the output file, and the
heartbeat from stderr is the only way to peek at progress there; a filter
holds the output back until the end.

```bash
bash <skill dir>/scripts/wait-ci.sh pr <N> [--interval 30] [--timeout 1800] [--expect 0] [--wait-all]
bash <skill dir>/scripts/wait-ci.sh status <sha> [--context <name>] [--interval 20] [--timeout 1200] [--expect 0] [--wait-all]
bash <skill dir>/scripts/wait-ci.sh merged <N> [--context <name>] [--interval 20] [--timeout 1200] [--expect 0] [--wait-all]
bash <skill dir>/scripts/wait-ci.sh issue <N> [--interval 60] [--timeout 7200]
```

## What to run when

| Moment | Command |
|---|---|
| Pushed the PR branch, before merging | `pr <N>` — waits for the PR head's checks, the base branch's required checks and a run of every workflow whose `on:` fires on the PR; a conflict with the base — ERROR at once |
| Merged, and the merge triggers a deploy or CI on `main` | `merged <N>` as a background command in the same turn as `github task actualize` — waits for all checks of the PR's merge commit: GitHub Actions check-runs and the statuses of the host and external services; takes the SHA from the PR itself, an unmerged PR — ERROR |
| A commit's checks by SHA (my own commit without a PR) | `status <sha>` — the same as `merged`, by the full SHA |
| One check of a commit is needed (the deploy among others) | `merged <N> --context <name>` or `status <sha> --context <name>` |
| `github pr premerge` — exit code 3, `main` is red | `issue <N>` as a background command — waits for the bug on the red `main` to close: PASS when it is closed (with the reason: `completed`, `not_planned`); no such issue — ERROR; then `premerge` again |

Don't fetch the SHA of your own merge — `merged <N>` takes it from the PR
itself: separate `gh pr view` turns for it were the main source of extra turns
after a merge (#285), and `git rev-parse origin/main` with parallel merges
returns someone else's later commit. The `<sha>` for `status` is the full one;
don't fill in a short one: for a nonexistent SHA the API silently returns an
empty status, and the wait hangs until the timeout with a false "not ready".

The name for `--context` is a status context or a check-run name (an Actions
job); the `CHECK` lines of a run without `--context` print them.

## How to read the result

- stdout — events only: `CHECK <name>: <bucket>` when a check changes state
  and the final line `RESULT: PASS|FAIL|TIMEOUT|ERROR …`.
- stderr — a heartbeat on every poll (how many checks, how many pending, the
  failed ones, `missing=[…]` — required ones not registered yet); in a
  background run it lands in the output file, don't drag it into the chat.
- Exit code: `0` PASS · `1` FAIL (the failed ones are listed) · `2` TIMEOUT ·
  `3` ERROR (a conflict with the base, PR or SHA not found, five `gh` errors
  in a row, a wrong invocation).

What to do next:

- **PASS** — before merging a PR, `github pr premerge <N>` (if `main` moved
  after CI — a check of the merge with a fresh one), exit code `0` — merge;
  after the merge — `github task close` (the epic refresh ran in parallel with
  the wait — the `github` skill, `task actualize`) and the "done" report. A
  background wait finished with exit code `0` — that is PASS: the next step
  right away, don't read the output file in a separate turn.
- **PASS only on the host's checks, without Actions** (the `CHECK` lines are
  only preview and comment statuses) in a repository with CI in Actions —
  suspicious: `gh run list --commit <sha>` — was there a run and how did it
  end.
- **FAIL `workflow not parsed: <path> <link>`** — the workflow file on this
  SHA doesn't parse (YAML), a run without a single job; `workflow failed
  without jobs` — it didn't start (a reference to a nonexistent reusable
  workflow, a policy ban). Fix the file; the reason is on the run's page at
  the link.
- **FAIL** — came on the first failed check, the others may still have been
  running (a full snapshot — `--wait-all`). Read the failed check's logs
  (`gh run view <id> --log-failed`), fix the cause; a "known red first
  build" — re-run your own run (`gh run rerun <id> --failed`) and `ci-wait`
  again. Don't merge. Jobs didn't start, with the annotation "recent account
  payments have failed…" — the owner's billing, not the code
  (`docs/pr-checks.md`).
- **TIMEOUT** — count it neither as a success nor as a failure: check whether
  the checks registered at all (`gh pr checks <N>`), whether the runner is
  stuck; `missing required` in the result — a required check never appeared
  (the workflow didn't start or was renamed); `no run of workflow: <path>` —
  by its `on:` the workflow should have fired on the PR, but there is no run
  on the head (Actions disabled, a GitHub incident, a PR from a fork with a
  file that doesn't parse); a last line `CHECK workflow queued: <path>` — the
  runner never picked up the run. If needed, repeat with a larger
  `--timeout`.
- **ERROR `conflict with base`** — nothing to wait for: rebase onto
  `origin/<base>`, `git push --force-with-lease`, `ci-wait` again. Any other
  ERROR is an access or invocation problem: the repository, `gh` permissions,
  the PR number, the SHA.

## Details the script exists for

- An empty check list is pending, not "passed": checks register with a delay
  after a push.
- A commit has checks in two places: statuses (`commits/<sha>/status`) are
  written by hosts and external services, check-runs
  (`commits/<sha>/check-runs`) by GitHub Actions. Waiting for statuses alone
  on a commit whose whole CI is Actions hangs until the timeout; `status`
  waits for both. `pr` waits the same way, by the PR head's SHA.
- One SHA holds the check-runs of all runs: one cancelled by a new push stays
  when the head is moved back to the earlier commit, and re-running a job
  adds a new one. The result follows the latest check-run of a name from the
  same app, otherwise an early `cancelled` gives a false FAIL while the latest
  one is green.
- REST only: `gh pr checks` goes to GraphQL, whose quota (5000 points per
  hour) is shared by all of the user's sessions — with parallel sessions it
  runs out. The PR head (`pulls/<N>`) is read on every poll: a new push
  changes the SHA. A REST rate limit means waiting until the quota resets
  (`gh api rate_limit`), not ERROR.
- A `gh` failure isn't an outcome, in the requests before the first poll too
  (the commit for `status`, the required checks for `pr`): a retry, ERROR
  after five in a row. "Commit not found" is only the API's answer "no" (422,
  404); otherwise a one-off failure during a GitHub incident ended the wait
  with a false "not found".
- A PR with a conflict with the base (`mergeable: false`): there is no
  merge-ref, and workflows on `pull_request` don't start at all — without
  this check the wait ended with a result from the host's statuses alone.
  `mergeable: null` — GitHub is still computing; keep waiting.
- The base branch's required checks (ruleset and classic protection) are
  awaited by name: while any one is missing there is no final result, even if
  the rest have finished.
- An Actions run that failed without a single job gives no check-run: when
  the workflow isn't parsed, GitHub leaves a "dummy" run (the name is the
  file path, event `push`, `conclusion: failure`), and the result came down
  to the host's statuses alone — PASS without a single test run. So every
  poll also reads the Actions runs on the SHA (`actions/runs?head_sha=`).
- A queued run hasn't produced check-runs yet — without it the result also
  came down to the host's statuses (#360). An unfinished run without
  check-runs is pending `workflow queued: <path>` (or `in_progress`) until
  the checks of its jobs appear.
- `pr` waits for a run of every active workflow that, by its `on:` on the
  head SHA, fires on the PR (`bun` parses the YAML; without it the check is
  skipped with a note in stderr): `pull_request` without filters or with
  branches that let the base through. A paths filter, `types` without
  `synchronize`, a negation in branches can't be decided without the diff —
  such a workflow isn't awaited; a file that doesn't parse is awaited: a PR
  from a fork doesn't even get the "dummy".
- A failed check means the result is already known: a long check next to it
  (a preview deploy) won't change it, so FAIL comes at once.
- PASS counts only when a snapshot without pending repeats for two polls in
  a row; `--expect N` — the minimum number of checks, below which we keep
  waiting.
- Without branch protection `gh pr merge --auto` merges without waiting for
  CI — so `--auto` doesn't replace waiting.
- One wait at a time: don't start a second `ci-wait` on the same PR in
  parallel.
