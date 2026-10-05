#!/usr/bin/env bash
#
# wait-ci.sh — ожидание чеков PR или коммита с видимым прогрессом и полным набором
# исходов. Запускать из каталога репозитория (gh резолвит {owner}/{repo}) или задать
# GH_REPO.
#
#   wait-ci.sh pr <N> [--interval 30] [--timeout 1800] [--expect 0] [--wait-all]
#       Ждёт чеки головы PR (как status) и обязательные чеки базовой ветки — по именам.
#       Конфликт с базой — сразу ERROR: CI на таком PR не запустится.
#
#   wait-ci.sh status <sha> [--context <имя>] [--interval 20] [--timeout 1200] [--expect 0] [--wait-all]
#       Ждёт все чеки коммита: commit statuses (хостинг, внешние сервисы) и
#       check-runs (GitHub Actions). --context — один чек по имени, среди обоих.
#       SHA — полный, из git.
#
#   wait-ci.sh issue <N> [--interval 60] [--timeout 7200]
#       Ждёт закрытия issue — бага на красный main (github pr premerge, код 3):
#       PASS, когда закрыт; нет такого issue — ERROR.
#
# Пустой список чеков — pending; PASS засчитывается, когда снимок без pending повторился
# два опроса подряд (поздно регистрирующиеся чеки не проскакивают) и чеков не меньше
# --expect. Первый упавший чек — сразу FAIL; --wait-all — FAIL, когда завершились все.
# Только REST: квота GraphQL общая на все сессии; лимит REST — ожидание до сброса.
#
# Вывод: stdout — только события («CHECK <имя>: <bucket>») и финальная строка
#        «RESULT: PASS|FAIL|TIMEOUT|ERROR …»; stderr — heartbeat каждый опрос.
# Exit:  0 PASS · 1 FAIL · 2 TIMEOUT · 3 ERROR или неверный вызов.
set -uo pipefail

usage() { sed -n '3,27p' "$0" >&2; exit 3; }

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

# checks <sha>: чеки коммита в $out — JSON-массив {name, bucket}; bucket как у `gh pr checks`:
# pending | pass | fail | cancel | skipping. Код 1 — ошибка gh, текст в $out.
checks() {
  local statuses runs
  statuses=$(gh api "repos/{owner}/{repo}/commits/$1/status" 2>&1) || { out=$statuses; return 1; }
  runs=$(gh api "repos/{owner}/{repo}/commits/$1/check-runs?per_page=100" 2>&1) || { out=$runs; return 1; }
  out=$(jq -n --argjson s "$statuses" --argjson r "$runs" --arg ctx "$context" '
    [ $s.statuses[] | { name: .context,
        bucket: (if .state == "success" then "pass" elif .state == "pending" then "pending" else "fail" end) } ]
    + [ $r.check_runs[] | { name,
        bucket: (if .status != "completed" then "pending"
                 elif .conclusion == "success" or .conclusion == "neutral" then "pass"
                 elif .conclusion == "skipped" then "skipping"
                 elif .conclusion == "cancelled" then "cancel"
                 else "fail" end) } ]
    | if $ctx == "" then . else map(select(.name == $ctx)) end' 2>&1)
}

# required: имена обязательных чеков базовой ветки — ruleset и классическая защита. Нет
# правил или прав их читать (приватный репо на Free отвечает 403) — обязательных нет;
# лимит — код 1, как ошибка опроса.
required='[]'; required_loaded=""
load_required() {
  local rules branch
  rules=$(gh api "repos/{owner}/{repo}/rules/branches/$1" 2>&1) || { rate_limited "$rules" && { out=$rules; return 1; }; rules='[]'; }
  branch=$(gh api "repos/{owner}/{repo}/branches/$1" 2>&1) || { rate_limited "$branch" && { out=$branch; return 1; }; branch='{}'; }
  required=$(jq -nc --argjson r "$rules" --argjson b "$branch" '
    [ ($r | arrays | .[] | select(.type == "required_status_checks") | .parameters.required_status_checks[].context),
      ($b | objects | .protection.required_status_checks // {} | select(.enforcement_level != "off") | (.contexts // [])[]) ]
    | unique' 2>/dev/null) || required='[]'
  required_loaded=1
  [ "$required" != '[]' ] && echo "$(ts) required on $1: $(jq -r 'join(", ")' <<<"$required")" >&2
  return 0
}

# poll: чеки в $out (см. checks). Код 1 — ошибка gh, 2 — ждать бессмысленно (ERROR); текст в $out.
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
      # mergeable GitHub вычисляет в фоне: null — ещё не знает, false — конфликт, merge-ref
      # нет, и workflow на pull_request не запустятся вовсе
      if [ "$(jq -r .mergeable <<<"$pull")" == false ]; then
        out="conflict with base $base — CI will not run; rebase onto origin/$base"; return 2
      fi
      [ -n "$required_loaded" ] || load_required "$base" || return 1
      # голова — каждый опрос: новый push меняет SHA, ждать надо чеки текущей
      head_sha=$(jq -r .head.sha <<<"$pull")
      label="pr#$target@${head_sha:0:7}"
      checks "$head_sha"
    }
    ;;
  status)
    [[ "$target" =~ ^[0-9a-f]{40}$ ]] || finish "ERROR sha must be full 40-hex (take it from git: git rev-parse origin/main)" 3
    # по несуществующему SHA API молча отдаёт пустой статус — проверяем коммит заранее
    if ! gh api "repos/{owner}/{repo}/commits/$target" --jq .sha >/dev/null 2>&1; then
      finish "ERROR commit $target not found in repository" 3
    fi
    : "${interval:=20}" "${timeout:=1200}"
    label="${context:-commit}@${target:0:7}"
    poll() { checks "$target"; }
    ;;
  issue)
    [[ "$target" =~ ^[0-9]+$ ]] || finish "ERROR issue number expected, got: $target" 3
    : "${interval:=60}" "${timeout:=7200}"
    label="issue#$target"
    poll() {
      local issue
      issue=$(gh api "repos/{owner}/{repo}/issues/$target" 2>&1) || {
        out=$issue; [[ "$issue" == *"HTTP 404"* ]] && { out="issue #$target not found: $issue"; return 2; }; return 1; }
      # закрыт — исход известен сразу: повторный опрос, как у чеков, нужен поздно регистрирующимся, а не issue
      [ "$(jq -r .state <<<"$issue")" == closed ] && finish "PASS issue #$target closed ($(jq -r '.state_reason // "closed"' <<<"$issue"))" 0
      out=$(jq -nc --arg n "issue #$target" '[{ name: $n, bucket: "pending" }]')
    }
    ;;
  *) usage ;;
esac

# rate_limit_wait: секунды до сброса квоты core; вторичный лимит (квота не исчерпана) — минута
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
prev_snapshot=""; prev_terminal=""; errors=0; pending=""; missing=""
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
    if [ "$snapshot" != "$prev_snapshot" ]; then
      comm -13 <(printf '%s\n' "$prev_snapshot") <(printf '%s\n' "$snapshot") \
        | awk -F'\t' 'NF==2 { print "CHECK " $1 ": " $2 }'
      prev_snapshot=$snapshot
    fi
    echo "$(ts) $label total=$total pending=$pending failed=[${failed}]${missing:+ missing=[$missing]}" >&2
    # упавший чек — исход известен: долгие чеки рядом (превью-деплой) его не изменят
    [ -n "$failed" ] && [ -z "$wait_all" ] && finish "FAIL $failed" 1
    if [ "$total" -gt 0 ] && [ "$total" -ge "$expect" ] && [ "$pending" -eq 0 ] && [ -z "$missing" ]; then
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
    # лимит — не ошибка вызова: чеки идут своим ходом, ждём квоту
    nap=$(rate_limit_wait)
    echo "$(ts) $label: rate limit, next poll in ${nap}s" >&2
  else
    errors=$((errors + 1))
    echo "$(ts) $label: gh error ($errors): ${out:0:200}" >&2
    [ "$errors" -ge 5 ] && finish "ERROR gh: ${out:0:200}" 3
  fi
  now=$(date +%s)
  [ "$now" -ge "$deadline" ] && finish "TIMEOUT after ${timeout}s (pending=${pending:-?}${missing:+, missing required: $missing})" 2
  [ "$nap" -gt $((deadline - now)) ] && nap=$((deadline - now))
  sleep "$nap"
done
