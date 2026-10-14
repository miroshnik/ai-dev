#!/usr/bin/env bash
#
# wait-ci.sh — waiting for the checks of a PR or a commit with visible progress and the full set
# of outcomes. Run from the repository directory (gh resolves {owner}/{repo}), with --repo owner/repo or GH_REPO.
#
#   wait-ci.sh pr <N> | status <sha> | merged <N> | issue <N> [options] — the modes and options: wait-ci.sh --help,
#   a mode's — wait-ci.sh <mode> --help (the help() function below).
#
# An Actions run at the SHA that failed without a single job (workflow not parsed, not started) — FAIL with the file path:
# it gives no check-run, and without it the outcome came down to hosting statuses alone. An unfinished run without
# check-runs (queued) — pending: there is a run at the SHA, but it has no checks yet.
# The spec publish job (spec-publish) is not a check: neither awaited nor a FAIL — only by --context.
# An empty list of checks — pending; PASS counts when a snapshot without pending repeats
# two polls in a row (late-registering checks don't slip through) and there are no fewer checks
# than --expect. The first failed check — FAIL right away; --wait-all — FAIL when all have finished.
# --interval is the first interval: it grows with the wait — a tenth of the elapsed time, up to 5 min.
# REST only: the GraphQL quota is shared by all sessions; a REST rate limit — waiting until the reset, and that wait
# doesn't count toward --timeout (up to an hour). A gh failure (also in requests before the first poll) — retry, ERROR
# after five in a row; "not found" — only on 404/422.
#
# Output: stdout — a state line only when the state changes ("<time> +<elapsed> <what>: 3/5 done; waiting: …")
#         and the final line "RESULT: PASS|FAIL|TIMEOUT|ERROR …"; stderr — gh errors and notes.
# Exit:  0 PASS · 1 FAIL · 2 TIMEOUT · 3 ERROR or a wrong call. The outcome is the exit code.
set -uo pipefail

# help [mode]: the mode's synopsis, what it does and examples, otherwise the overview (tests/standards/cli-help);
# printf is a builtin — help runs no commands. The overview takes a mode's first line by command substitution, not a
# pipeline (#495): `help "$m" | { read -r line; … }` — the reader leaves after one line, bash writes stdout line by line,
# and the writer got SIGPIPE under load; with pipefail the last mode's 141 broke the && chain, and the tail was lost
help() {
  local m synopsis exits=("Exit: 0 PASS · 1 FAIL · 2 TIMEOUT · 3 ERROR or a wrong call — the outcome is the exit code; stdout — a state" \
    "line when the state changes and the final line RESULT: PASS|FAIL|TIMEOUT|ERROR …, stderr — gh errors and notes.")
  case "${1:-}" in
    pr) printf '%s\n' \
      "wait-ci pr <N> [--repo owner/repo] [--interval 30] [--timeout 1800] [--expect 0] [--wait-all]" "" \
      "Waits for the checks of the PR head (like status), the base branch's required checks — by name, and the run of each" \
      "workflow that, by its on: at the head SHA, fires on the PR (needs bun). A conflict with the base — ERROR once the next" \
      "poll of the same head confirms it: CI won't start on such a PR; right after a push GitHub still reports the previous" \
      "head's conflict. The first failed check — FAIL right away; --wait-all — FAIL when all have finished." \
      "${exits[@]}" "" "Examples:" "  wait-ci pr 57" "  wait-ci pr 57 --repo octo/app --timeout 3600 --wait-all" ;;
    status) printf '%s\n' \
      "wait-ci status <sha> [--repo owner/repo] [--context <name>] [--interval 20] [--timeout 1200] [--expect 0] [--wait-all]" "" \
      "Waits for all checks of a commit: commit statuses (hosting, external services) and check-runs (GitHub Actions)." \
      "--context — one check by name, among both. The SHA is the full one, from git." \
      "${exits[@]}" "" "Examples:" "  wait-ci status \"\$(git rev-parse HEAD)\"" "  wait-ci status \"\$(git rev-parse HEAD)\" --context Vercel --timeout 600" ;;
    merged) printf '%s\n' \
      "wait-ci merged <N> [--repo owner/repo] [--context <name>] [--interval 20] [--timeout 1200] [--expect 0] [--wait-all]" "" \
      "Waits for all checks of the PR's merge commit (like status): takes the SHA from the PR itself — don't look it up" \
      "after the merge. PR not merged — ERROR." \
      "${exits[@]}" "" "Examples:" "  wait-ci merged 57" "  wait-ci merged 57 --context Vercel" ;;
    issue) printf '%s\n' \
      "wait-ci issue <N> [--repo owner/repo] [--interval 60] [--timeout 7200]" "" \
      "Waits for an issue to close — the bug on a red main (github pr premerge, code 3): PASS when it is closed; no such" \
      "issue — ERROR." \
      "${exits[@]}" "" "Examples:" "  wait-ci issue 61" ;;
    *) printf '%s\n' \
      "wait-ci — waiting for the checks of a PR or a commit with visible progress and the full set of outcomes; the" \
      "repository — --repo owner/repo (as in the github scripts), otherwise GH_REPO or the current directory's." ""
      for m in pr status merged issue; do synopsis=$(help "$m"); printf '  %s\n' "${synopsis%%$'\n'*}"; done
      printf '%s\n' "" "wait-ci <command> --help — the command's details and examples" ;;
  esac
}
usage() { help "${mode:-}" >&2; exit 3; }

for arg in "$@"; do
  case "$arg" in --help|-h) help "${1:-}"; exit 0 ;; esac
done

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
    # the repository for gh, as --repo of the github scripts (#514): gh api resolves {owner}/{repo} from GH_REPO
    --repo) [[ "${2:-}" == [!-]*/?* ]] || { echo "--repo expects owner/repo, got: ${2:-}" >&2; usage; }
            export GH_REPO=$2; shift 2 ;;
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
# runs (one cancelled by a new push when the head went back to an earlier commit; a job rerun) — CHECK_STATES below
# reads them. An Actions run that failed without jobs gives no check-run: the workflow wasn't parsed (the run's name is
# the file path) or didn't start (its check suite has no check-runs); such a run is a failed check with the file path
# and a link. An unfinished run without check-runs (queued) — pending with the path: there is a run at the SHA, and
# without this line the outcome came down to hosting statuses (#360).
# The spec publish job (the spec skill, ci.md; "<job> / spec-publish" — the same job in a reusable workflow) — publishing
# the documentation, not a check: it is neither awaited nor a FAIL, only by --context (#443). A copy — in the github
# skill's premerge (SPEC_PUBLISH): its red isn't a red main; both answer by one table, tests/standards/spec-publish-job.
SPEC_PUBLISH='^(.+ / )?spec-publish$'
# The state of each check-run name (jq check_states over REST check-runs): not completed — pending; success — pass;
# neutral, skipped — skipping; cancelled — cancel; any other conclusion — fail. Reruns of one name — the last check-run
# of each app (the id grows with creation), not the best one and not the order of the response; several apps — the
# worst of their states. A copy — in the github skill (checkStates: task show, project check): both answer by one table,
# tests/standards/check-run-state.
CHECK_STATES='def check_states:
  group_by([.name, .app.id]) | map(max_by(.id))
  | map({ name, bucket: (if .status != "completed" then "pending"
                         elif .conclusion == "success" then "pass"
                         elif .conclusion == "neutral" or .conclusion == "skipped" then "skipping"
                         elif .conclusion == "cancelled" then "cancel"
                         else "fail" end) })
  | group_by(.name) | map(min_by(.bucket as $b | ["fail", "cancel", "pending", "skipping", "pass"] | index($b)));'
ran='[]'
checks() {
  local statuses runs wruns
  statuses=$(gh api "repos/{owner}/{repo}/commits/$1/status" 2>&1) || { out=$statuses; return 1; }
  runs=$(gh api "repos/{owner}/{repo}/commits/$1/check-runs?per_page=100" 2>&1) || { out=$runs; return 1; }
  wruns=$(gh api "repos/{owner}/{repo}/actions/runs?head_sha=$1&per_page=100" 2>&1) || { out=$wruns; return 1; }
  ran=$(jq -c '[(.workflow_runs // [])[].path] | unique' <<<"$wruns")
  out=$(jq -n --argjson s "$statuses" --argjson r "$runs" --argjson w "$wruns" --arg ctx "$context" --arg publish "$SPEC_PUBLISH" "$CHECK_STATES"'
    [ $s.statuses[] | { name: .context,
        bucket: (if .state == "success" then "pass" elif .state == "pending" then "pending" else "fail" end) } ]
    + ($r.check_runs | check_states)
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
    | if $ctx != "" then map(select(.name == $ctx)) else map(select(.name | test($publish) | not)) end' 2>&1)
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
    label="pr#$target"; conflict_head=""
    poll() {
      local pull base mergeable
      pull=$(gh api "repos/{owner}/{repo}/pulls/$target" 2>&1) || {
        out=$pull; [[ "$pull" == *"HTTP 404"* ]] && { out="PR #$target not found: $pull"; return 2; }; return 1; }
      base=$(jq -r .base.ref <<<"$pull")
      # the head — on every poll: a new push changes the SHA, we must wait for the checks of the current one
      head_sha=$(jq -r .head.sha <<<"$pull")
      label="pr#$target@${head_sha:0:7}"
      # GitHub computes mergeable in the background: null — doesn't know yet, false — a conflict, there is no
      # merge-ref, and workflows on pull_request won't start at all. Right after a push it still gives the false of the
      # previous head, whose conflict was the reason for the rebase (#472): a conflict is the current head's only when
      # the next poll of the same head repeats it; until then — pending, not a PASS
      mergeable=$(jq -r .mergeable <<<"$pull")
      if [ "$mergeable" == false ] && [ "$conflict_head" == "$head_sha" ]; then
        out="conflict with base $base — CI will not run; rebase onto origin/$base"; return 2
      fi
      [ "$mergeable" == false ] && conflict_head=$head_sha || conflict_head=""
      [ -n "$required_loaded" ] || load_required "$base" || return 1
      [ "$expected_for" == "$head_sha" ] || load_expected "$head_sha" "$base" || return 1
      checks "$head_sha" || return 1
      [ -z "$conflict_head" ] || out=$(jq -c --arg n "conflict with base $base: rechecking" '. + [{ name: $n, bucket: "pending" }]' <<<"$out")
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

# state <max>: the last poll's checks ($out) in words — how many are done and what we wait for: pending ones, required
# ones not registered yet, workflows due on the PR without a run at the head; failed ones (--wait-all). A list longer
# than <max> names is cut ("+N more"), 0 — the whole list.
state() {
  jq -r --argjson req "$required" --argjson due "$expected" --argjson ran "$ran" --argjson max "$1" '
    def names: sort | if $max > 0 and length > $max then .[:$max] + ["+\(length - $max) more"] else . end | join(", ");
    map(select(.bucket == "pending") | .name) as $wait
    | [ if length == 0 then "no checks yet" else "\(length - ($wait | length))/\(length) done" end,
        ($wait | select(. != []) | "waiting: \(names)"),
        ($req - map(.name) | select(. != []) | "missing required: \(names)"),
        ($due - $ran | select(. != []) | "no run of workflow: \(names)"),
        (map(select(.bucket == "fail" or .bucket == "cancel") | .name) | select(. != []) | "failed: \(names)") ]
    | join("; ")' <<<"$out"
}

# dur <seconds>: 45s, 3m05s, 1h20m
dur() {
  if [ "$1" -lt 60 ]; then echo "${1}s"
  elif [ "$1" -lt 3600 ]; then printf '%dm%02ds\n' $(($1 / 60)) $(($1 % 60))
  else printf '%dh%02dm\n' $(($1 / 3600)) $(($1 % 3600 / 60)); fi
}

# say <state>: a state line — only when it differs from the previous one: the output file of a background wait shows
# what we wait for and since when, not a heartbeat per poll (#432)
said=""
say() {
  [ "$label: $1" == "$said" ] && return
  said="$label: $1"
  echo "$(ts) +$(dur $(( $(date +%s) - start ))) $label: $1"
}

start=$(date +%s); deadline=$(( start + timeout ))
prev_terminal=""; errors=0; quota_wait=0; full="no checks yet"
while :; do
  poll; rc=$?
  # the interval grows with the wait — a tenth of the elapsed time, up to 5 min: a long deploy is polled several times
  # less often, the REST quota shared by parallel sessions lasts, and the outcome comes at most a tenth of the wait late
  nap=$(( ($(date +%s) - start) / 10 )); [ "$nap" -gt 300 ] && nap=300; [ "$nap" -lt "$interval" ] && nap=$interval
  if [ "$rc" -eq 0 ]; then
    errors=0
    snapshot=$(printf '%s' "$out" | jq -r 'sort_by(.name) | .[] | "\(.name)\t\(.bucket)"')
    total=$(printf '%s' "$out" | jq 'length')
    pending=$(printf '%s' "$out" | jq '[.[] | select(.bucket=="pending")] | length')
    failed=$(printf '%s' "$out" | jq -r '[.[] | select(.bucket=="fail" or .bucket=="cancel") | .name] | join(", ")')
    missing=$(printf '%s' "$out" | jq -r --argjson req "$required" '$req - map(.name) | join(", ")')
    # a workflow that by its `on:` fires on the PR but produced no run at the head is not final, like a required check
    unrun=$(jq -rn --argjson e "$expected" --argjson r "$ran" '$e - $r | join(", ")')
    full=$(state 0)
    say "$(state 5)"
    # a failed check — the outcome is known: long checks alongside it (a preview deploy) won't change it
    [ -n "$failed" ] && [ -z "$wait_all" ] && finish "FAIL $failed" 1
    if [ "$total" -gt 0 ] && [ "$total" -ge "$expect" ] && [ "$pending" -eq 0 ] && [ -z "$missing" ] && [ -z "$unrun" ]; then
      if [ "$snapshot" == "$prev_terminal" ]; then
        [ -n "$failed" ] && finish "FAIL $failed" 1
        finish "PASS ($total checks)" 0
      fi
      prev_terminal=$snapshot
      # the confirming poll — at the first interval: everything has finished, a grown interval would only delay PASS
      nap=$interval
    else
      prev_terminal=""
    fi
  elif [ "$rc" -eq 2 ]; then
    finish "ERROR $out" 3
  elif rate_limited "$out"; then
    # a rate limit is not a call error: the checks go on by themselves, we wait for the quota. That wait doesn't count
    # toward --timeout — the quota resets within an hour, and a reset 40 min away under a 30 min timeout gave TIMEOUT
    # without a single poll after it; at most an hour in total, so a limit that never lifts still ends the wait
    nap=$(rate_limit_wait)
    extra=$nap; [ $((quota_wait + extra)) -gt 3600 ] && extra=$((3600 - quota_wait))
    quota_wait=$((quota_wait + extra)); deadline=$((deadline + extra))
    say "API rate limit — next poll in $(dur "$nap")"
  else
    errors=$((errors + 1))
    echo "$(ts) $label: gh error ($errors): ${out:0:200}" >&2
    [ "$errors" -ge 5 ] && finish "ERROR gh: ${out:0:200}" 3
  fi
  now=$(date +%s)
  [ "$now" -ge "$deadline" ] && finish "TIMEOUT after $(dur $((now - start))) ($full)" 2
  [ "$nap" -gt $((deadline - now)) ] && nap=$((deadline - now))
  sleep "$nap"
done
