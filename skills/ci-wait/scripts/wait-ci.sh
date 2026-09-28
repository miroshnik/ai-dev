#!/usr/bin/env bash
#
# wait-ci.sh — ожидание чеков PR или коммита с видимым прогрессом и полным набором
# исходов. Запускать из каталога репозитория (gh резолвит {owner}/{repo}) или задать
# GH_REPO.
#
#   wait-ci.sh pr <N> [--interval 30] [--timeout 1800] [--expect 0]
#       Ждёт, пока ВСЕ чеки PR станут терминальными.
#
#   wait-ci.sh status <sha> [--context <имя>] [--interval 20] [--timeout 1200] [--expect 0]
#       Ждёт все чеки коммита: commit statuses (хостинг, внешние сервисы) и
#       check-runs (GitHub Actions). --context — один чек по имени, среди обоих.
#       SHA — полный, из git.
#
# Пустой список чеков и «no checks reported» — pending; финал засчитывается, когда
# снимок без pending повторился два опроса подряд (поздно регистрирующиеся чеки не
# проскакивают) и чеков не меньше --expect.
#
# Вывод: stdout — только события («CHECK <имя>: <bucket>») и финальная строка
#        «RESULT: PASS|FAIL|TIMEOUT|ERROR …»; stderr — heartbeat каждый опрос.
# Exit:  0 PASS · 1 FAIL · 2 TIMEOUT · 3 ERROR или неверный вызов.
set -uo pipefail

usage() { sed -n '3,21p' "$0" >&2; exit 3; }

mode=${1:-}; target=${2:-}
[ -n "$mode" ] && [ -n "$target" ] || usage
shift 2
interval=""; timeout=""; expect=0; context=""
while [ $# -gt 0 ]; do
  case "$1" in
    --interval) interval=$2; shift 2 ;;
    --timeout)  timeout=$2;  shift 2 ;;
    --expect)   expect=$2;   shift 2 ;;
    --context)  context=$2;  shift 2 ;;
    *) echo "unknown arg: $1" >&2; usage ;;
  esac
done
ts() { date +%H:%M:%S; }
finish() { echo "RESULT: $1"; exit "$2"; }

# poll: чеки в $out — JSON-массив {name, bucket}; bucket как у `gh pr checks`:
# pending | pass | fail | cancel | skipping. Код 1 — ошибка gh, текст в $out.
case "$mode" in
  pr)
    : "${interval:=30}" "${timeout:=1800}"
    label="pr#$target"
    poll() {
      out=$(gh pr checks "$target" --json name,bucket 2>&1)
      [[ "$out" == \[* ]] && return 0
      [[ "$out" == *"no checks reported"* ]] && { out='[]'; return 0; }
      return 1
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
    poll() {
      local statuses runs
      statuses=$(gh api "repos/{owner}/{repo}/commits/$target/status" 2>&1) || { out=$statuses; return 1; }
      runs=$(gh api "repos/{owner}/{repo}/commits/$target/check-runs?per_page=100" 2>&1) || { out=$runs; return 1; }
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
    ;;
  *) usage ;;
esac

deadline=$(( $(date +%s) + timeout ))
prev_snapshot=""; prev_terminal=""; errors=0; pending=""
while :; do
  if poll; then
    errors=0
    snapshot=$(printf '%s' "$out" | jq -r 'sort_by(.name) | .[] | "\(.name)\t\(.bucket)"')
    total=$(printf '%s' "$out" | jq 'length')
    pending=$(printf '%s' "$out" | jq '[.[] | select(.bucket=="pending")] | length')
    failed=$(printf '%s' "$out" | jq -r '[.[] | select(.bucket=="fail" or .bucket=="cancel") | .name] | join(", ")')
    if [ "$snapshot" != "$prev_snapshot" ]; then
      comm -13 <(printf '%s\n' "$prev_snapshot") <(printf '%s\n' "$snapshot") \
        | awk -F'\t' 'NF==2 { print "CHECK " $1 ": " $2 }'
      prev_snapshot=$snapshot
    fi
    echo "$(ts) $label total=$total pending=$pending failed=[${failed}]" >&2
    if [ "$total" -gt 0 ] && [ "$total" -ge "$expect" ] && [ "$pending" -eq 0 ]; then
      if [ "$snapshot" == "$prev_terminal" ]; then
        [ -n "$failed" ] && finish "FAIL $failed" 1
        finish "PASS ($total checks)" 0
      fi
      prev_terminal=$snapshot
    else
      prev_terminal=""
    fi
  else
    errors=$((errors + 1))
    echo "$(ts) $label: gh error ($errors): ${out:0:200}" >&2
    [ "$errors" -ge 5 ] && finish "ERROR gh: ${out:0:200}" 3
  fi
  [ "$(date +%s)" -ge "$deadline" ] && finish "TIMEOUT after ${timeout}s (pending=${pending:-?})" 2
  sleep "$interval"
done
