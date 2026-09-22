#!/usr/bin/env bash
#
# wait-ci.sh — ожидание чеков PR или статуса коммита с видимым прогрессом и полным
# набором исходов. Запускать из каталога репозитория (gh резолвит {owner}/{repo})
# или задать GH_REPO.
#
#   wait-ci.sh pr <N> [--interval 30] [--timeout 1800] [--expect 0]
#       Ждёт, пока ВСЕ чеки PR станут терминальными. Пустой список чеков и
#       «no checks reported» считаются pending; финал засчитывается, когда снимок
#       без pending повторился два опроса подряд (поздно регистрирующиеся чеки не
#       проскакивают) и чеков не меньше --expect.
#
#   wait-ci.sh status <sha> --context <имя> [--interval 20] [--timeout 1200]
#       Ждёт commit-status с заданным контекстом (деплой хостинга, внешний чек):
#       pending → success | failure | error. SHA — полный, из git.
#
# Вывод: stdout — только события («CHECK <имя>: <bucket>») и финальная строка
#        «RESULT: PASS|FAIL|TIMEOUT|ERROR …»; stderr — heartbeat каждый опрос.
# Exit:  0 PASS · 1 FAIL · 2 TIMEOUT · 3 ERROR или неверный вызов.
set -uo pipefail

usage() { sed -n '3,22p' "$0" >&2; exit 3; }

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

case "$mode" in
  pr)
    : "${interval:=30}" "${timeout:=1800}"
    deadline=$(( $(date +%s) + timeout ))
    prev_snapshot=""; prev_terminal=""; errors=0; pending=""
    while :; do
      out=$(gh pr checks "$target" --json name,bucket 2>&1)
      if [[ "$out" == \[* ]]; then
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
        echo "$(ts) pr#$target total=$total pending=$pending failed=[${failed}]" >&2
        if [ "$total" -gt 0 ] && [ "$total" -ge "$expect" ] && [ "$pending" -eq 0 ]; then
          if [ "$snapshot" == "$prev_terminal" ]; then
            [ -n "$failed" ] && finish "FAIL $failed" 1
            finish "PASS ($total checks)" 0
          fi
          prev_terminal=$snapshot
        else
          prev_terminal=""
        fi
      elif [[ "$out" == *"no checks reported"* ]]; then
        errors=0; prev_terminal=""
        echo "$(ts) pr#$target: no checks registered yet" >&2
      else
        errors=$((errors + 1))
        echo "$(ts) pr#$target: gh error ($errors): ${out:0:200}" >&2
        [ "$errors" -ge 5 ] && finish "ERROR gh pr checks: ${out:0:200}" 3
      fi
      [ "$(date +%s)" -ge "$deadline" ] && finish "TIMEOUT after ${timeout}s (pending=${pending:-?})" 2
      sleep "$interval"
    done
    ;;
  status)
    [ -n "$context" ] || { echo "status: нужен --context <имя>" >&2; usage; }
    [[ "$target" =~ ^[0-9a-f]{40}$ ]] || finish "ERROR sha must be full 40-hex (take it from git: git rev-parse origin/main)" 3
    # по несуществующему SHA API молча отдаёт пустой статус — проверяем коммит заранее
    if ! gh api "repos/{owner}/{repo}/commits/$target" --jq .sha >/dev/null 2>&1; then
      finish "ERROR commit $target not found in repository" 3
    fi
    : "${interval:=20}" "${timeout:=1200}"
    deadline=$(( $(date +%s) + timeout ))
    prev_state=""; errors=0
    while :; do
      out=$(gh api "repos/{owner}/{repo}/commits/$target/status" \
              --jq ".statuses[] | select(.context==\"$context\") | \"\(.state)\t\(.target_url // \"\")\"" 2>&1)
      rc=$?
      if [ $rc -ne 0 ]; then
        errors=$((errors + 1))
        echo "$(ts) $context@$target: gh api error ($errors): ${out:0:200}" >&2
        [ "$errors" -ge 5 ] && finish "ERROR gh api commit status: ${out:0:200}" 3
      else
        errors=0
        state=$(printf '%s' "$out" | head -1 | cut -f1)
        url=$(printf '%s' "$out" | head -1 | cut -f2)
        [ -z "$state" ] && state="(no status yet)"
        echo "$(ts) $context@$target state=$state" >&2
        if [ "$state" != "$prev_state" ]; then
          echo "CHECK $context ${target:0:7}: $state ${url}"
          prev_state=$state
        fi
        case "$state" in
          success) finish "PASS $context for $target READY $url" 0 ;;
          failure|error) finish "FAIL $context for $target: $state $url" 1 ;;
        esac
      fi
      [ "$(date +%s)" -ge "$deadline" ] && finish "TIMEOUT after ${timeout}s (state=${prev_state:-none})" 2
      sleep "$interval"
    done
    ;;
  *) usage ;;
esac
