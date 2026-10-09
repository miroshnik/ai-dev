#!/usr/bin/env bash
#
# wait-ci.sh — waiting for the checks of a PR or a commit with visible progress and the full set
# of outcomes. Run from the repository directory (gh resolves {owner}/{repo}) or set
# GH_REPO.
#
#   wait-ci.sh pr <N> [--interval 30] [--timeout 1800] [--expect 0] [--wait-all]
#       Waits for the checks of the PR head (like status), the base branch's required checks — by name, and the run
#       of each workflow that, by its `on:` at the head SHA, fires on the PR (needs bun).
#       A conflict with the base — ERROR right away: CI won't start on such a PR.
#
#   wait-ci.sh status <sha> [--context <name>] [--interval 20] [--timeout 1200] [--expect 0] [--wait-all]
#       Waits for all checks of a commit: commit statuses (hosting, external services) and
#       check-runs (GitHub Actions). --context — one check by name, among both.
#       The SHA is the full one, from git.
#
#   wait-ci.sh merged <N> [--context <name>] [--interval 20] [--timeout 1200] [--expect 0] [--wait-all]
#       Waits for all checks of the PR's merge commit (like status): takes the SHA from the PR itself — don't
#       look it up after the merge. PR not merged — ERROR.
#
#   wait-ci.sh issue <N> [--interval 60] [--timeout 7200]
#       Waits for an issue to close — the bug on a red main (github pr premerge, code 3):
#       PASS when it is closed; no such issue — ERROR.
#
# An Actions run at the SHA that failed without a single job (workflow not parsed, not started) — FAIL with the file path:
# it gives no check-run, and without it the outcome came down to hosting statuses alone. An unfinished run without
# check-runs (queued) — pending: there is a run at the SHA, but it has no checks yet.
# An empty list of checks — pending; PASS counts when a snapshot without pending repeats
# two polls in a row (late-registering checks don't slip through) and there are no fewer checks
# than --expect. The first failed check — FAIL right away; --wait-all — FAIL when all have finished.
# REST only: the GraphQL quota is shared by all sessions; a REST rate limit — waiting until the reset. A gh failure
# (also in requests before the first poll) — retry, ERROR after five in a row; "not found" — only on 404/422.
#
# Output: stdout — only events ("CHECK <name>: <bucket>") and the final line
#         "RESULT: PASS|FAIL|TIMEOUT|ERROR …"; stderr — a heartbeat on every poll.
# Exit:  0 PASS · 1 FAIL · 2 TIMEOUT · 3 ERROR or a wrong call.
set -uo pipefail

usage() { awk 'NR > 2 && !/^#/ { exit } NR > 2' "$0" >&2; exit 3; }

mode=${1:-}; target=${2:-}
[ -n "$mode" ] && [ -n "$target" ] || usage
shift 2
interval=""; timeout=""; expect=0; context=""; wait_all=""
while [ $# -gt 0 ]; do
  case "$1" in
    --interval) interval=$2; shift 2 ;;
    --timeout)  timeout=$2;  shift 2 ;;
    --expect)   expect=$2;   shift 2 ;;
    --context)  context=$2;  shift 2 ;;
    --wait-all) wait_all=1;  shift ;;
    *) echo "unknown arg: $1" >&2; usage ;;
  esac
done
ts() { date +%H:%M:%S; }
finish() { echo "RESULT: $1"; exit "$2"; }
rate_limited() { grep -qi 'rate limit' <<<"$1"; }

# checks <sha>: the commit's checks into $out — a JSON array {name, bucket}; bucket as in `gh pr checks`:
# pending | pass | fail | cancel | skipping; paths of the workflows that produced a run at the SHA — into $ran. Code 1 — a gh
# error, the text in $out.
# The API already reduces statuses to the latest per context, but not check-runs: the SHA holds check-runs of all
# runs (one cancelled by a new push when the head went back to an earlier commit; a job rerun), and the outcome is
# the last check-run of a name from the same app (the id grows with creation). An Actions run that failed without jobs
# gives no check-run: the workflow wasn't parsed (the run's name is the file path) or didn't start (its check suite has
# no check-runs); such a run is a failed check with the file path and a link. An unfinished run without check-runs
# (queued) — pending with the path: there is a run at the SHA, and without this line the outcome came down to hosting
# statuses (#360).
ran='[]'
checks() {
  local statuses runs wruns
  statuses=$(gh api "repos/{owner}/{repo}/commits/$1/status" 2>&1) || { out=$statuses; return 1; }
  runs=$(gh api "repos/{owner}/{repo}/commits/$1/check-runs?per_page=100" 2>&1) || { out=$runs; return 1; }
  wruns=$(gh api "repos/{owner}/{repo}/actions/runs?head_sha=$1&per_page=100" 2>&1) || { out=$wruns; return 1; }
  ran=$(jq -c '[(.workflow_runs // [])[].path] | unique' <<<"$wruns")
  out=$(jq -n --argjson s "$statuses" --argjson r "$runs" --argjson w "$wruns" --arg ctx "$context" '
    [ $s.statuses[] | { name: .context,
        bucket: (if .state == "success" then "pass" elif .state == "pending" then "pending" else "fail" end) } ]
    + [ $r.check_runs | group_by([.name, .app.id]) | map(max_by(.id)) | .[] | { name,
        bucket: (if .status != "completed" then "pending"
                 elif .conclusion == "success" or .conclusion == "neutral" then "pass"
                 elif .conclusion == "skipped" then "skipping"
                 elif .conclusion == "cancelled" then "cancel"
                 else "fail" end) } ]
    + [ [$r.check_runs[].check_suite.id] as $suites
        | ($w.workflow_runs // []) | group_by([.path, .event]) | map(max_by(.id)) | .[]
        | (.check_suite_id as $id | any($suites[]; . == $id) | not) as $nojobs
        | if .status != "completed" then
            select($nojobs) | { name: "workflow \(.status): \(.path) \(.html_url)", bucket: "pending" }
          else
            select((.conclusion == "failure" or .conclusion == "startup_failure") and (.name == .path or $nojobs))
            | { name: "workflow \(if .name == .path then "not parsed" else "failed without jobs" end): \(.path) \(.html_url)",
                bucket: "fail" }
          end ]
    | if $ctx == "" then . else map(select(.name == $ctx)) end' 2>&1)
}

# required: names of the base branch's required checks — a ruleset and classic protection. No rules
# or no right to read them (a private repo on Free answers 403, no branch — 404) — no required checks;
# a rate limit or another failure — code 1, like a poll error: a one-off failure must not erase the required checks.
required='[]'; required_loaded=""
absent() { [[ "$1" == *"HTTP 403"* || "$1" == *"HTTP 404"* ]] && ! rate_limited "$1"; }
load_required() {
  local rules branch
  rules=$(gh api "repos/{owner}/{repo}/rules/branches/$1" 2>&1) || { absent "$rules" || { out=$rules; return 1; }; rules='[]'; }
  branch=$(gh api "repos/{owner}/{repo}/branches/$1" 2>&1) || { absent "$branch" || { out=$branch; return 1; }; branch='{}'; }
  required=$(jq -nc --argjson r "$rules" --argjson b "$branch" '
    [ ($r | arrays | .[] | select(.type == "required_status_checks") | .parameters.required_status_checks[].context),
      ($b | objects | .protection.required_status_checks // {} | select(.enforcement_level != "off") | (.contexts // [])[]) ]
    | unique' 2>/dev/null) || required='[]'
  required_loaded=1
  [ "$required" != '[]' ] && echo "$(ts) required on $1: $(jq -r 'join(", ")' <<<"$required")" >&2
  return 0
}

# expected: paths of the workflows that should produce a run at the head on a PR event — by the `on:` of their files at
# its SHA (#356). We wait for `pull_request` without filters or with branches that let the base in; a path filter, `types`
# without `synchronize`, negation and other special characters in branches can't be decided without the PR diff — we
# don't wait: a false TIMEOUT is worse. A file that doesn't parse — we wait: a "dummy" run will give FAIL, and a PR from a
# fork has none at all. Active workflows only.
expected='[]'; expected_for=""; workflows=""
pr_expects() {  # stdin — a workflow as JSON (null — not parsed); code 0 — wait for its run on a PR into branch $1
  jq -e --arg base "$1" '
    def list: if type == "array" then . else [.] end;
    def rx: "^" + (split("**") | map(split("*") | map(gsub("(?<c>[.^$(){}|\\\\])"; "\\\(.c)")) | join("[^/]*")) | join(".*")) + "$";
    def match_base: list | if any(.[]; tostring | test("[?+\\[!]")) then null else any(.[]; tostring | rx as $r | $base | test($r)) end;
    if type != "object" then true
    else .on
      | if type == "string" then (if . == "pull_request" then {} else null end)
        elif type == "array" then (if any(.[]; . == "pull_request") then {} else null end)
        elif type == "object" and has("pull_request") then (.pull_request // {})
        else null end
      | if type != "object" then false
        elif has("paths") or has("paths-ignore") then false
        elif has("types") and (.types | list | any(.[]; . == "synchronize") | not) then false
        elif has("branches") then (.branches | match_base) == true
        elif has("branches-ignore") then (.["branches-ignore"] | match_base) == false
        else true end
    end' >/dev/null
}
load_expected() {  # <sha> <base>
  local list path raw doc exp='[]'
  if [ -z "$workflows" ]; then
    list=$(gh api "repos/{owner}/{repo}/actions/workflows?per_page=100" 2>&1) || { absent "$list" || { out=$list; return 1; }; list='{}'; }
    workflows=$(jq -c '[(.workflows // [])[] | select(.state == "active" and (.path | startswith(".github/workflows/"))) | .path]' <<<"$list")
  fi
  if [ "$workflows" != '[]' ] && ! command -v bun >/dev/null; then
    echo "$(ts) bun not found — workflows due on PR are not checked" >&2; workflows='[]'
  fi
  while IFS= read -r path; do
    [ -n "$path" ] || continue
    raw=$(gh api "repos/{owner}/{repo}/contents/$path?ref=$1" 2>&1) || { [[ "$raw" == *"HTTP 404"* ]] && continue; out=$raw; return 1; }
    # not parsed — null; bun itself failing is a poll error, not "not parsed": retry
    doc=$(jq -r '.content // "" | gsub("\n"; "") | @base64d' <<<"$raw" | bun -e '
      const t = await Bun.stdin.text();
      let d = null; try { d = Bun.YAML.parse(t) ?? null } catch {}
      process.stdout.write(JSON.stringify(d))') || { out="bun failed on $path"; return 1; }
    pr_expects "$2" <<<"$doc" && exp=$(jq -c --arg p "$path" '. + [$p]' <<<"$exp")
  done < <(jq -r '.[]' <<<"$workflows")
  expected=$exp; expected_for=$1
  [ "$expected" != '[]' ] && echo "$(ts) workflows due on PR: $(jq -r 'join(", ")' <<<"$expected")" >&2
  return 0
}

# poll: checks into $out (see checks). Code 1 — a gh error, 2 — waiting is pointless (ERROR); the text in $out.
case "$mode" in
  pr)
    [[ "$target" =~ ^[0-9]+$ ]] || finish "ERROR PR number expected, got: $target" 3
    : "${interval:=30}" "${timeout:=1800}"
    label="pr#$target"
    poll() {
      local pull base
      pull=$(gh api "repos/{owner}/{repo}/pulls/$target" 2>&1) || {
        out=$pull; [[ "$pull" == *"HTTP 404"* ]] && { out="PR #$target not found: $pull"; return 2; }; return 1; }
      base=$(jq -r .base.ref <<<"$pull")
      # GitHub computes mergeable in the background: null — doesn't know yet, false — a conflict, there is no
      # merge-ref, and workflows on pull_request won't start at all
      if [ "$(jq -r .mergeable <<<"$pull")" == false ]; then
        out="conflict with base $base — CI will not run; rebase onto origin/$base"; return 2
      fi
      [ -n "$required_loaded" ] || load_required "$base" || return 1
      # the head — on every poll: a new push changes the SHA, we must wait for the checks of the current one
      head_sha=$(jq -r .head.sha <<<"$pull")
      label="pr#$target@${head_sha:0:7}"
      [ "$expected_for" == "$head_sha" ] || load_expected "$head_sha" "$base" || return 1
      checks "$head_sha"
    }
    ;;
  status)
    [[ "$target" =~ ^[0-9a-f]{40}$ ]] || finish "ERROR sha must be full 40-hex (take it from git: git rev-parse origin/main)" 3
    : "${interval:=20}" "${timeout:=1200}"
    label="${context:-commit}@${target:0:7}"; commit_found=""
    poll() {
      local commit
      # for a nonexistent SHA the API silently returns an empty status — the commit is checked before the checks. "Not
      # found" — only 422 "No commit found" or 404; another failure is a poll error: a one-off API failure is not an outcome
      if [ -z "$commit_found" ]; then
        commit=$(gh api "repos/{owner}/{repo}/commits/$target" --jq .sha 2>&1) || {
          out=$commit; [[ "$commit" == *"HTTP 422"* || "$commit" == *"HTTP 404"* ]] && { out="commit $target not found in repository: $commit"; return 2; }; return 1; }
        commit_found=1
      fi
      checks "$target"
    }
    ;;
  merged)
    [[ "$target" =~ ^[0-9]+$ ]] || finish "ERROR PR number expected, got: $target" 3
    : "${interval:=20}" "${timeout:=1200}"
    label="merge#$target"; merge_sha=""
    poll() {
      local pull
      if [ -z "$merge_sha" ]; then
        pull=$(gh api "repos/{owner}/{repo}/pulls/$target" 2>&1) || {
          out=$pull; [[ "$pull" == *"HTTP 404"* ]] && { out="PR #$target not found: $pull"; return 2; }; return 1; }
        [ "$(jq -r .merged <<<"$pull")" == true ] || { out="PR #$target not merged (state $(jq -r .state <<<"$pull")) — nothing to wait for"; return 2; }
        # the SHA of our own merge — from the PR: with parallel merges git rev-parse origin/main returns someone else's commit
        merge_sha=$(jq -r .merge_commit_sha <<<"$pull")
        label="${context:-merge#$target}@${merge_sha:0:7}"
      fi
      checks "$merge_sha"
    }
    ;;
  issue)
    [[ "$target" =~ ^[0-9]+$ ]] || finish "ERROR issue number expected, got: $target" 3
    : "${interval:=60}" "${timeout:=7200}"
    label="issue#$target"
    poll() {
      local issue
      issue=$(gh api "repos/{owner}/{repo}/issues/$target" 2>&1) || {
        out=$issue; [[ "$issue" == *"HTTP 404"* ]] && { out="issue #$target not found: $issue"; return 2; }; return 1; }
      # closed — the outcome is known right away: a repeated poll, as for checks, is needed for late-registering checks, not for an issue
      [ "$(jq -r .state <<<"$issue")" == closed ] && finish "PASS issue #$target closed ($(jq -r '.state_reason // "closed"' <<<"$issue"))" 0
      out=$(jq -nc --arg n "issue #$target" '[{ name: $n, bucket: "pending" }]')
    }
    ;;
  *) usage ;;
esac

# rate_limit_wait: seconds until the core quota resets; a secondary limit (the quota isn't exhausted) — a minute
rate_limit_wait() {
  local core w=60
  core=$(gh api rate_limit 2>/dev/null | jq -c .resources.core 2>/dev/null)
  if [ "$(jq -r .remaining <<<"$core" 2>/dev/null)" == 0 ]; then
    w=$(( $(jq -r .reset <<<"$core") - $(date +%s) + 1 ))
  fi
  [ "$w" -lt "$interval" ] && w=$interval
  echo "$w"
}

deadline=$(( $(date +%s) + timeout ))
prev_snapshot=""; prev_terminal=""; errors=0; pending=""; missing=""; unrun=""
while :; do
  nap=$interval
  poll; rc=$?
  if [ "$rc" -eq 0 ]; then
    errors=0
    snapshot=$(printf '%s' "$out" | jq -r 'sort_by(.name) | .[] | "\(.name)\t\(.bucket)"')
    total=$(printf '%s' "$out" | jq 'length')
    pending=$(printf '%s' "$out" | jq '[.[] | select(.bucket=="pending")] | length')
    failed=$(printf '%s' "$out" | jq -r '[.[] | select(.bucket=="fail" or .bucket=="cancel") | .name] | join(", ")')
    missing=$(printf '%s' "$out" | jq -r --argjson req "$required" '$req - map(.name) | join(", ")')
    # a workflow that by its `on:` fires on the PR but produced no run at the head is not final, like a required check
    unrun=$(jq -rn --argjson e "$expected" --argjson r "$ran" '$e - $r | join(", ")')
    if [ "$snapshot" != "$prev_snapshot" ]; then
      comm -13 <(printf '%s\n' "$prev_snapshot") <(printf '%s\n' "$snapshot") \
        | awk -F'\t' 'NF==2 { print "CHECK " $1 ": " $2 }'
      prev_snapshot=$snapshot
    fi
    echo "$(ts) $label total=$total pending=$pending failed=[${failed}]${missing:+ missing=[$missing]}${unrun:+ no-run=[$unrun]}" >&2
    # a failed check — the outcome is known: long checks alongside it (a preview deploy) won't change it
    [ -n "$failed" ] && [ -z "$wait_all" ] && finish "FAIL $failed" 1
    if [ "$total" -gt 0 ] && [ "$total" -ge "$expect" ] && [ "$pending" -eq 0 ] && [ -z "$missing" ] && [ -z "$unrun" ]; then
      if [ "$snapshot" == "$prev_terminal" ]; then
        [ -n "$failed" ] && finish "FAIL $failed" 1
        finish "PASS ($total checks)" 0
      fi
      prev_terminal=$snapshot
    else
      prev_terminal=""
    fi
  elif [ "$rc" -eq 2 ]; then
    finish "ERROR $out" 3
  elif rate_limited "$out"; then
    # a rate limit is not a call error: the checks go on by themselves, we wait for the quota
    nap=$(rate_limit_wait)
    echo "$(ts) $label: rate limit, next poll in ${nap}s" >&2
  else
    errors=$((errors + 1))
    echo "$(ts) $label: gh error ($errors): ${out:0:200}" >&2
    [ "$errors" -ge 5 ] && finish "ERROR gh: ${out:0:200}" 3
  fi
  now=$(date +%s)
  [ "$now" -ge "$deadline" ] && finish "TIMEOUT after ${timeout}s (pending=${pending:-?}${missing:+, missing required: $missing}${unrun:+, no run of workflow: $unrun})" 2
  [ "$nap" -gt $((deadline - now)) ] && nap=$((deadline - now))
  sleep "$nap"
done
