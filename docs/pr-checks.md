# Waiting for PR checks and merging — for "Git, PRs and merging"

The principle is in `AGENTS.md` ("Git, PRs and merging": merge only with all
checks green); the `ci-wait` skill does the waiting with a script. Here are the
waiting and merging rules in full, then the polling mechanics. Rebase, the
check before a push and cleaning up the merged branch — the `github` skill,
section "Git, PRs and merging — mechanics".

## Rules

- **The full SHA:** I don't dig up the SHA of my merge — `wait-ci.sh merged
  <N>` takes it from the PR itself (`git rev-parse origin/main` returns
  someone else's, later commit during parallel merges); of my commit — `git
  log -1 --format=%H`; I don't complete a short one or take a "similar" one
  from memory: for a nonexistent SHA the API silently returns an empty status.
- **Merge only with all checks green**, including the preview deploy; "a
  known red first build" is no exception: I re-run my failed run (`gh run
  rerun <id> --failed`) and wait for green; red for another reason — I fix it
  before merging. I wait with a polling loop over the API: a PR — by its head
  SHA, a commit — by the full SHA (mechanics and traps below; the `ci-wait`
  skill). Green — then also `github pr premerge <N>`: if `main` moved after
  CI — fast checks on the merge with a fresh `main`; `main` is red by
  itself — exit code 3, I don't merge: one bug for it, and I wait for it to
  close (the `github` skill).
  An empty list or `no checks reported` means "not registered yet", not
  "passed"; a failed check means "red" at once, without waiting for the rest.
- **Actions jobs didn't start** with the annotation "The job was not started
  because recent account payments have failed or your spending limit needs
  to be increased" — this is the account owner's billing: neither a rerun nor
  a code change will help. I don't re-run or fix — I tell the owner; the merge
  waits.
- **A merge that deploys** (deploy from `main`) isn't the end of the task yet:
  before reporting "done" I wait for the statuses on the merge SHA — the
  deploy and the checks after it (the `ci-wait` skill, `merged <N>`). A
  production smoke test is a check in the project's CI, not a manual agent
  step. Failed — logs and a fix at once: it blocks the report and closing the
  task.
- **Deploy — by the commit status, not by polling the site.** Whether the
  merge rolled out is told by the host's status on the merge SHA (`ci-wait
  merged <N>`), not by the page: frequent requests to the live site turn on
  the host's bot protection, and from then on the site answers with a
  challenge instead of the page — to the agent, or even to everyone from the
  same address. Need to see the page — one request after a green status, not
  a loop.

## Polling mechanics

- Decide only by `bucket` (`pending`, `fail`, `cancel`, `pass`, `skipping`).
  The list is empty or has `pending` → wait. Merge — when the list is
  non-empty, there is no `pending` and the snapshot repeated two polls in a
  row (checks register with a delay). `fail` or `cancel` — the outcome is
  known at once: a long check alongside (a preview deploy) won't change it.
- By a commit's full SHA (deploy, an external check, a run on `main`) checks
  live in two places: statuses of hosts and external services —
  `gh api repos/{owner}/{repo}/commits/<sha>/status` (the `statuses` list by
  context), GitHub Actions — `commits/<sha>/check-runs` (`status`,
  `conclusion`). Wait for both: on a commit where all CI is Actions there are
  no statuses at all. `gh pr checks` doesn't accept a SHA.
- By PR number — on every poll `gh api repos/{owner}/{repo}/pulls/<N>`
  (`head.sha`, `mergeable`, `base.ref`), checks — by the head SHA, as for a
  commit: a new push changes the head. `gh pr checks` goes to GraphQL, whose
  quota (5000 points per hour) is shared by all the user's sessions — with
  parallel sessions it runs out before REST does.
- `mergeable: false` — a conflict with the base: there is no merge ref,
  workflows on `pull_request` don't start, and a non-empty snapshot of host
  statuses alone gives a false outcome. Nothing to wait for — rebase. `null` —
  GitHub is still computing: wait.
- The base branch's required checks — `rules/branches/<base>` (ruleset, rule
  `required_status_checks`) and `branches/<base>`
  (`protection.required_status_checks`, if `enforcement_level` isn't `off`):
  while any of them is missing from the snapshot — wait.
- Actions runs on a SHA — `actions/runs?head_sha=<sha>`: a run that failed
  without a single job gives no check run — the workflow wasn't parsed (the
  run's name is the file path, event `push`) or didn't start. That is "red",
  not an empty spot: without it a snapshot of host statuses alone gives a
  false "green". A workflow whose `on:` fires on the PR at the head SHA but
  which produced no run — wait.
- A response with `rate limit` isn't an error: wait until `reset` from `gh api
  rate_limit` (that request doesn't spend quota), a secondary limit — a
  minute.
- Right after a push `gh pr checks` answers `no checks reported` with exit 1 —
  that means "not registered yet", not "failed" and not "passed". Exit codes
  0 / 1 (failed) / 8 (`pending`) are set only **without** `--json`; with
  `--json` it exits 0 on both `pending` and `fail`.
- Without branch protection `gh pr merge --auto` merges without waiting for
  CI.
